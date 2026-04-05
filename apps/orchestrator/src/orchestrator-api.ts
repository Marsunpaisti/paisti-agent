import type {
	AgentSessionStatus,
	IAgentMessageStore,
	IAgentRunner,
	ISessionStore,
	ITaskContextProvider,
	ITaskStore,
	OrchestrationTask,
	RunConfig
} from "@paisti/core";
import { Hono } from "hono";
import { messageToActivities } from "./message-to-activities.js";
import type { ActivityService } from "./services/activity-service.js";
import type { MessageService } from "./services/message-service.js";
import type { SseBroadcaster } from "./services/sse-broadcaster.js";
import type { InboundEvent, TaskAssignedEvent, TaskRef } from "./types/inbound-event.js";

const CLI_PLATFORM = "cli";

export interface OrchestratorDeps {
	/** Called once per task to produce an isolated runner instance. */
	runnerFactory: () => IAgentRunner;
	taskStore: ITaskStore;
	sessionStore: ISessionStore;
	activityService: ActivityService;
	agentMessageStore?: IAgentMessageStore;
	messageService?: MessageService;
	sseBroadcaster?: SseBroadcaster;
	contextProvider?: ITaskContextProvider;
	/** Defaults to process.cwd(). Per-task worktrees are added in Phase 2. */
	workingDirectory?: string;
	defaultModel?: string;
	systemPrompt?: string;
	serveUiFrom?: string;
}

interface ActiveSession {
	taskId: string;
	sessionId: string; // AgentSession.id
	/** Provider-native session ID, captured from the first SystemInfoMessage. */
	providerSessionId?: string;
	runner: IAgentRunner;
	status: "running";
}

export class OrchestratorAPI {
	private readonly deps: OrchestratorDeps;
	/** Keyed by AgentSession.id (not taskId) to support multiple sessions per task later. */
	private readonly activeSessions = new Map<string, ActiveSession>();
	private readonly pendingEvents = new Set<Promise<void>>();
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly app: Hono;
	private sseBroadcaster?: SseBroadcaster;

	constructor(deps: OrchestratorDeps) {
		this.deps = deps;
		this.sseBroadcaster = deps.sseBroadcaster;
		this.app = new Hono();
		this.setupRoutes();
	}

	/**
	 * Awaitable entry point for in-process use (CLI, tests).
	 * Runs the full task lifecycle and resolves when the agent session finishes.
	 * Does NOT require the HTTP server to be running.
	 */
	async runTask(event: TaskAssignedEvent): Promise<void> {
		await this.handleTaskAssigned(event.taskRef, event.title, event.initialMessage);
	}

	/**
	 * Receive an event from any source (webhook adapter, CLI, test harness).
	 * Non-blocking — dispatches async handling and returns immediately.
	 */
	handleEvent(event: InboundEvent): void {
		const p = this.processEvent(event).catch((err) => {
			console.error("[orchestrator] unhandled error in event handler:", err);
		});
		this.pendingEvents.add(p);
		void p.finally(() => this.pendingEvents.delete(p));
	}

	/** Wait for all in-flight fire-and-forget events to settle. */
	async flush(): Promise<void> {
		await Promise.all([...this.pendingEvents]);
	}

	private setupRoutes(): void {
		this.app.get("/health", (c) =>
			c.json({ status: "ok", activeSessions: this.activeSessions.size })
		);

		this.app.post("/events", async (c) => {
			const body = (await c.req.json()) as InboundEvent;
			this.handleEvent(body);
			return c.body(null, 202);
		});

		this.app.get("/api/tasks", async (c) => {
			const tasks = await this.deps.taskStore.listTasks();
			return c.json(tasks);
		});

		this.app.get("/api/tasks/:id", async (c) => {
			const id = c.req.param("id");
			const task = await this.deps.taskStore.getTask(id);
			if (!task) return c.json({ error: "Not found" }, 404);
			const sessions = await this.deps.sessionStore.listSessions(id);
			return c.json({ task, sessions });
		});

		this.app.get("/api/tasks/:id/messages", async (c) => {
			const id = c.req.param("id");
			const messages = await this.deps.taskStore.getTaskMessages(id);
			return c.json(messages);
		});

		this.app.get("/api/sessions/:id/messages", async (c) => {
			const sessionId = c.req.param("id");
			if (!this.deps.agentMessageStore) return c.json([]);
			const messages = await this.deps.agentMessageStore.getMessages(sessionId);
			return c.json(messages);
		});

		this.app.get("/api/sessions/:id/stream", (c) => {
			const sessionId = c.req.param("id");
			const isActive = [...this.activeSessions.values()].some((s) => s.sessionId === sessionId);
			if (!isActive) return c.json({ error: "Session not active" }, 404);

			let ctrl: ReadableStreamDefaultController<Uint8Array>;
			const stream = new ReadableStream<Uint8Array>({
				start: (controller) => {
					ctrl = controller;
					this.sseBroadcaster?.register(sessionId, controller);
				},
				cancel: () => {
					this.sseBroadcaster?.unregister(sessionId, ctrl);
				}
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive"
				}
			});
		});
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
		const stops = Array.from(this.activeSessions.values()).map((s) => {
			console.log(`[orchestrator] stopping session for task ${s.taskId}`);
			return s.runner.stop();
		});
		await Promise.all(stops);
		// Wait for all runner loops to drain their finally blocks (DB writes, session cleanup)
		await this.flush();

		if (this.server) {
			this.server.stop(true);
			this.server = null;
		}
	}

	// ─── event handlers ────────────────────────────────────────────────────────

	private async processEvent(event: InboundEvent): Promise<void> {
		switch (event.type) {
			case "task_assigned":
				await this.handleTaskAssigned(event.taskRef, event.title, event.initialMessage);
				break;
			case "user_comment":
				await this.handleUserComment(event.taskRef, event.content);
				break;
			case "stop_requested":
				await this.handleStopRequested(event.taskRef);
				break;
		}
	}

	private async handleTaskAssigned(
		taskRef: TaskRef,
		title: string,
		initialMessage: string
	): Promise<void> {
		const task = await this.resolveOrCreateTask(taskRef, title);

		// Guard uses in-memory map (not store) to avoid race with a finishing finally block
		if (this.getActiveSessionForTask(task.id)) {
			console.log(`[orchestrator] task ${task.id} already active — ignoring duplicate event`);
			return;
		}

		await this.deps.taskStore.updateTask(task.id, { status: "active" });

		const agentSession = await this.deps.sessionStore.createSession({ taskId: task.id });
		const runner = this.deps.runnerFactory();
		const inMemorySession: ActiveSession = {
			taskId: task.id,
			sessionId: agentSession.id,
			runner,
			status: "running"
		};
		this.activeSessions.set(agentSession.id, inMemorySession);

		let finalStatus: AgentSessionStatus = "completed";
		try {
			const context = this.deps.contextProvider
				? await this.deps.contextProvider.assembleContext(task)
				: undefined;

			// filter(Boolean) drops undefined and ""; || undefined ensures field absent (not "") when both are missing
			const systemPrompt =
				[context, this.deps.systemPrompt].filter(Boolean).join("\n\n") || undefined;

			// Store systemPrompt on the session record before runner starts
			if (systemPrompt) {
				await this.deps.sessionStore.updateSession(agentSession.id, { systemPrompt });
			}

			const config: RunConfig = {
				workingDirectory: this.deps.workingDirectory ?? process.cwd(),
				userPrompt: initialMessage,
				...(systemPrompt ? { systemPrompt } : {}),
				...(this.deps.defaultModel ? { model: this.deps.defaultModel } : {})
			};

			for await (const msg of runner.run(config)) {
				if (msg.type === "system" && !inMemorySession.providerSessionId) {
					inMemorySession.providerSessionId = msg.sessionId;
					await this.deps.sessionStore.updateSession(agentSession.id, {
						providerSessionId: msg.sessionId
					});
				}

				if (msg.type === "result" && msg.finishReason === "stopped") {
					finalStatus = "stopped";
				}

				const activities = messageToActivities(msg);
				for (const activity of activities) {
					await this.deps.activityService.postActivity(task.id, activity);
				}

				if (this.deps.messageService) {
					await this.deps.messageService.writeMessage(agentSession.id, msg);
				}

				if (msg.type === "result" && msg.summary) {
					await this.deps.activityService.postResponse(task.id, msg.summary);
				}
			}
		} catch (err) {
			finalStatus = "failed";
			console.error(`[orchestrator] task ${task.id} runner error:`, err);
		} finally {
			this.activeSessions.delete(agentSession.id);
			this.deps.messageService?.closeSession(agentSession.id);
			await this.deps.sessionStore.updateSession(agentSession.id, {
				status: finalStatus,
				completedAt: new Date().toISOString()
			});
			await this.deps.taskStore.updateTask(task.id, {
				status: finalStatus === "failed" ? "failed" : "completed"
			});
		}
	}

	private async handleUserComment(taskRef: TaskRef, content: string): Promise<void> {
		const task = await this.resolveTask(taskRef);
		if (!task) {
			console.log("[orchestrator] user_comment: task not found for ref", taskRef);
			return;
		}

		const session = this.getActiveSessionForTask(task.id);
		// biome-ignore lint/complexity/useOptionalChain: optional chain would break TypeScript narrowing needed for inject! below
		if (session && session.runner.supportsInjection) {
			session.runner.inject!(content);
		} else {
			// No active session — store as TaskMessage for context in the next session
			await this.deps.taskStore.addTaskMessage({
				taskId: task.id,
				content,
				author: "user",
				source: { type: "cli" }
			});
		}
	}

	private async handleStopRequested(taskRef: TaskRef): Promise<void> {
		const task = await this.resolveTask(taskRef);
		if (!task) return;

		const session = this.getActiveSessionForTask(task.id);
		if (session) {
			await session.runner.stop();
			// Cleanup is handled by the finally block in handleTaskAssigned
		}
	}

	// ─── session helpers ────────────────────────────────────────────────────────

	/** Find the in-memory active session for a given task. */
	private getActiveSessionForTask(taskId: string): ActiveSession | undefined {
		return [...this.activeSessions.values()].find((s) => s.taskId === taskId);
	}

	// ─── task resolution ────────────────────────────────────────────────────────

	/**
	 * Resolves a TaskRef to an OrchestrationTask in three steps:
	 *  1. getTask(id)                → found: use it (CLI events)
	 *  2. findTaskByBinding(...)     → found: use it (known platform events)
	 *  3. createTask + addBinding    → new task (first-seen platform events)
	 */
	private async resolveOrCreateTask(taskRef: TaskRef, title: string): Promise<OrchestrationTask> {
		// Step 1: direct ID lookup (CLI tasks carry the local UUID as the ref ID)
		if (taskRef.platform === CLI_PLATFORM) {
			const task = await this.deps.taskStore.getTask(taskRef.id);
			if (task) return task;
		}

		// Step 2: binding lookup (platform tasks)
		const byBinding = await this.deps.taskStore.findTaskByBinding(taskRef.platform, taskRef.id);
		if (byBinding) return byBinding;

		// Step 3: create new task (and binding for platform tasks)
		// For CLI tasks, use taskRef.id as the task's local UUID so step 1 resolves on future calls.
		const task = await this.deps.taskStore.createTask({
			title,
			...(taskRef.platform === CLI_PLATFORM ? { id: taskRef.id } : {})
		});
		if (taskRef.platform !== CLI_PLATFORM) {
			await this.deps.taskStore.addBinding({
				taskId: task.id,
				platform: taskRef.platform,
				externalId: taskRef.id,
				role: "source"
			});
		}
		return task;
	}

	private async resolveTask(taskRef: TaskRef): Promise<OrchestrationTask | null> {
		if (taskRef.platform === CLI_PLATFORM) {
			return this.deps.taskStore.getTask(taskRef.id);
		}
		return this.deps.taskStore.findTaskByBinding(taskRef.platform, taskRef.id);
	}
}
