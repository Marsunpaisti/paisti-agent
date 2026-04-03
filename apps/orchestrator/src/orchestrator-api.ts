import type {
	IActivityWriter,
	IAgentRunner,
	ITaskStore,
	OrchestrationTask,
	RunConfig
} from "@paisti/core";
import { messageToActivities } from "./message-to-activities.js";
import type { InboundEvent, TaskAssignedEvent, TaskRef } from "./types/inbound-event.js";

const CLI_PLATFORM = "cli";

export interface OrchestratorDeps {
	/** Called once per task to produce an isolated runner instance. */
	runnerFactory: () => IAgentRunner;
	taskStore: ITaskStore;
	activityWriter: IActivityWriter;
	/** Defaults to process.cwd(). Per-task worktrees are added in Phase 2. */
	workingDirectory?: string;
	defaultModel?: string;
	systemPrompt?: string;
}

interface ActiveSession {
	taskId: string;
	/** Provider-native session ID, captured from the first SystemInfoMessage. */
	providerSessionId?: string;
	runner: IAgentRunner;
	status: "running";
}

export class OrchestratorAPI {
	private readonly deps: OrchestratorDeps;
	private readonly activeSessions = new Map<string, ActiveSession>();
	private readonly pendingEvents = new Set<Promise<void>>();
	private server: ReturnType<typeof Bun.serve> | null = null;

	constructor(deps: OrchestratorDeps) {
		this.deps = deps;
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

	/** Bun.serve-compatible HTTP handler. */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({
				status: "ok",
				activeSessions: this.activeSessions.size
			});
		}

		return new Response("Not Found", { status: 404 });
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

		if (this.activeSessions.has(task.id)) {
			console.log(`[orchestrator] task ${task.id} already active — ignoring duplicate event`);
			return;
		}

		await this.deps.taskStore.updateTask(task.id, { status: "active" });

		const runner = this.deps.runnerFactory();
		const session: ActiveSession = {
			taskId: task.id,
			runner,
			status: "running"
		};
		this.activeSessions.set(task.id, session);

		const config: RunConfig = {
			workingDirectory: this.deps.workingDirectory ?? process.cwd(),
			userPrompt: initialMessage,
			...(this.deps.systemPrompt ? { systemPrompt: this.deps.systemPrompt } : {}),
			...(this.deps.defaultModel ? { model: this.deps.defaultModel } : {})
		};

		let failed = false;
		try {
			for await (const msg of runner.run(config)) {
				// Capture provider session ID from the first system message for future resume support
				if (msg.type === "system" && !session.providerSessionId) {
					session.providerSessionId = msg.sessionId;
				}

				const activities = messageToActivities(msg);
				for (const activity of activities) {
					await this.deps.activityWriter.postActivity(task.id, activity);
				}

				if (msg.type === "result" && msg.summary) {
					await this.deps.activityWriter.postResponse(task.id, msg.summary);
				}
			}
		} catch (err) {
			failed = true;
			console.error(`[orchestrator] task ${task.id} runner error:`, err);
		} finally {
			this.activeSessions.delete(task.id);
			await this.deps.taskStore.updateTask(task.id, { status: failed ? "failed" : "completed" });
		}
	}

	private async handleUserComment(taskRef: TaskRef, content: string): Promise<void> {
		const task = await this.resolveTask(taskRef);
		if (!task) {
			console.log("[orchestrator] user_comment: task not found for ref", taskRef);
			return;
		}

		const session = this.activeSessions.get(task.id);
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

		const session = this.activeSessions.get(task.id);
		if (session) {
			await session.runner.stop();
			// Cleanup is handled by the finally block in handleTaskAssigned
		}
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
