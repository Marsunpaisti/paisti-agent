import type {
	AgentSessionStatus,
	IAgentRunner,
	ISessionMessageWriter,
	ISessionStore,
	ITaskContextProvider,
	ITaskStore,
	RunConfig
} from "@paisti/core";
import { messageToActivities } from "../message-to-activities.js";
import type { InboundEvent, TaskAssignedEvent, TaskRef } from "../types/inbound-event.js";
import type { ActivityService } from "./activity-service.js";
import type { TaskService } from "./task-service.js";

interface ActiveSession {
	taskId: string;
	sessionId: string;
	/** Provider-native session ID, captured from the first SystemInfoMessage. */
	providerSessionId?: string;
	runner: IAgentRunner;
	status: "running";
}

export interface RunnerServiceDeps {
	taskService: TaskService;
	taskStore: ITaskStore;
	runnerFactory: () => IAgentRunner;
	sessionStore: ISessionStore;
	activityService: ActivityService;
	messageService?: ISessionMessageWriter;
	contextProvider?: ITaskContextProvider;
	workingDirectory?: string;
	defaultModel?: string;
	systemPrompt?: string;
}

export class RunnerService {
	private readonly activeSessions = new Map<string, ActiveSession>();
	private readonly pendingEvents = new Set<Promise<void>>();
	private readonly deps: RunnerServiceDeps;

	constructor(deps: RunnerServiceDeps) {
		this.deps = deps;
	}

	/**
	 * Awaitable entry point for in-process use (CLI, tests).
	 * Runs the full task lifecycle and resolves when the agent session finishes.
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

	/** Stop all active runner sessions. Does NOT stop the HTTP server. */
	async stop(): Promise<void> {
		const stops = Array.from(this.activeSessions.values()).map((s) => {
			console.log(`[orchestrator] stopping session for task ${s.taskId}`);
			return s.runner.stop();
		});
		await Promise.all(stops);
		await this.flush();
	}

	isSessionActive(sessionId: string): boolean {
		return this.activeSessions.has(sessionId);
	}

	get activeSessionCount(): number {
		return this.activeSessions.size;
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
		const task = await this.deps.taskService.resolveOrCreate(taskRef, title);

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
		const task = await this.deps.taskService.resolve(taskRef);
		if (!task) {
			console.log("[orchestrator] user_comment: task not found for ref", taskRef);
			return;
		}

		const session = this.getActiveSessionForTask(task.id);
		// biome-ignore lint/complexity/useOptionalChain: optional chain would break TypeScript narrowing needed for inject! below
		if (session && session.runner.supportsInjection) {
			session.runner.inject!(content);
		} else {
			await this.deps.taskStore.addTaskMessage({
				taskId: task.id,
				content,
				author: "user",
				source: { type: "cli" }
			});
		}
	}

	private async handleStopRequested(taskRef: TaskRef): Promise<void> {
		const task = await this.deps.taskService.resolve(taskRef);
		if (!task) return;

		const session = this.getActiveSessionForTask(task.id);
		if (session) {
			await session.runner.stop();
			// Cleanup is handled by the finally block in handleTaskAssigned
		}
	}

	// ─── session helpers ────────────────────────────────────────────────────────

	private getActiveSessionForTask(taskId: string): ActiveSession | undefined {
		return [...this.activeSessions.values()].find((s) => s.taskId === taskId);
	}
}
