// apps/orchestrator/src/orchestrator-api.ts
import type {
	IAgentMessageReader,
	IAgentRunner,
	ISessionMessageWriter,
	ISessionStore,
	ITaskContextProvider,
	ITaskStore
} from "@paisti/core";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { eventsRouter } from "./routers/events-router.js";
import { type ISseRegistrar, sessionsRouter } from "./routers/sessions-router.js";
import { tasksRouter } from "./routers/tasks-router.js";
import type { ActivityService } from "./services/activity-service.js";
import { RunnerService } from "./services/runner-service.js";
import { TaskService } from "./services/task-service.js";
import type { InboundEvent, TaskAssignedEvent } from "./types/inbound-event.js";

export interface OrchestratorDeps {
	/** Called once per task to produce an isolated runner instance. */
	runnerFactory: () => IAgentRunner;
	taskStore: ITaskStore;
	sessionStore: ISessionStore;
	activityService: ActivityService;
	agentMessageStore?: IAgentMessageReader;
	messageService?: ISessionMessageWriter;
	sseBroadcaster?: ISseRegistrar;
	contextProvider?: ITaskContextProvider;
	/** Defaults to process.cwd(). Per-task worktrees are added in Phase 2. */
	workingDirectory?: string;
	defaultModel?: string;
	systemPrompt?: string;
	serveUiFrom?: string;
}

export class OrchestratorAPI {
	private readonly runnerService: RunnerService;
	private readonly app: Hono;
	private server: ReturnType<typeof Bun.serve> | null = null;

	constructor(deps: OrchestratorDeps) {
		const taskService = new TaskService(deps.taskStore);
		this.runnerService = new RunnerService({
			taskService,
			taskStore: deps.taskStore,
			runnerFactory: deps.runnerFactory,
			sessionStore: deps.sessionStore,
			activityService: deps.activityService,
			messageService: deps.messageService,
			contextProvider: deps.contextProvider,
			workingDirectory: deps.workingDirectory,
			defaultModel: deps.defaultModel,
			systemPrompt: deps.systemPrompt
		});

		this.app = new Hono();
		this.app.get("/health", (c) =>
			c.json({ status: "ok", activeSessions: this.runnerService.activeSessionCount })
		);
		this.app.route("/api/tasks", tasksRouter(deps.taskStore, deps.sessionStore));
		this.app.route(
			"/api/sessions",
			sessionsRouter(deps.agentMessageStore, deps.sseBroadcaster, this.runnerService)
		);
		this.app.route("/api/events", eventsRouter(taskService, this.runnerService));

		if (deps.serveUiFrom) {
			const root = deps.serveUiFrom;
			this.app.use("/*", serveStatic({ root }));
			this.app.get("/*", serveStatic({ root, path: "index.html" }));
		}
	}

	/**
	 * Awaitable entry point for in-process use (CLI, tests).
	 * Runs the full task lifecycle and resolves when the agent session finishes.
	 * Does NOT require the HTTP server to be running.
	 */
	async runTask(event: TaskAssignedEvent): Promise<void> {
		return this.runnerService.runTask(event);
	}

	/**
	 * Receive an event from any source (webhook adapter, CLI, test harness).
	 * Non-blocking — dispatches async handling and returns immediately.
	 */
	handleEvent(event: InboundEvent): void {
		this.runnerService.handleEvent(event);
	}

	/** Wait for all in-flight fire-and-forget events to settle. */
	async flush(): Promise<void> {
		return this.runnerService.flush();
	}

	/** Bun.serve-compatible HTTP handler. */
	async fetch(request: Request): Promise<Response> {
		return this.app.fetch(request);
	}

	/** Start HTTP server. */
	async start(port = 3000): Promise<void> {
		const self = this;
		this.server = Bun.serve({
			port,
			fetch(req) {
				return self.fetch(req);
			}
		});
		console.log(`[orchestrator] listening on port ${port}`);
	}

	/** Stop all active sessions and the HTTP server. */
	async stop(): Promise<void> {
		await this.runnerService.stop();
		if (this.server) {
			this.server.stop(true);
			this.server = null;
		}
	}
}
