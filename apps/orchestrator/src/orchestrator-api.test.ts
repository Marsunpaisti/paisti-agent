import { beforeEach, describe, expect, it } from "bun:test";
import type {
	Activity,
	AgentMessage,
	IActivityWriter,
	IAgentRunner,
	ITaskContextProvider,
	RunConfig
} from "@paisti/core";
import { OrchestratorAPI } from "./orchestrator-api.js";
import { ActivityService } from "./services/activity-service.js";
import { SqliteSessionStore } from "./stores/sqlite-session-store.js";
import { SqliteTaskStore } from "./stores/sqlite-task-store.js";
import type { TaskAssignedEvent } from "./types/inbound-event.js";

// ─── test doubles ─────────────────────────────────────────────────────────────

class StoppedRunner implements IAgentRunner {
	readonly supportsInjection = false;
	async *run(_config: RunConfig): AsyncIterable<AgentMessage> {
		yield {
			type: "system",
			provider: "claude",
			sessionId: "ses_stopped",
			model: "claude-opus-4-6",
			tools: []
		};
		yield {
			type: "result",
			provider: "claude",
			sessionId: "ses_stopped",
			finishReason: "stopped",
			durationMs: 100
		};
	}
	async stop(): Promise<void> {}
}

class ThrowingRunner implements IAgentRunner {
	readonly supportsInjection = false;
	// biome-ignore lint/correctness/useYield: intentionally throws without yielding to simulate a runner error
	async *run(_config: RunConfig): AsyncIterable<AgentMessage> {
		throw new Error("simulated runner failure");
	}
	async stop(): Promise<void> {}
}

class MockRunner implements IAgentRunner {
	readonly supportsInjection = false;
	injected: string[] = [];
	stopped = false;

	constructor(private readonly messages: AgentMessage[]) {}

	async *run(_config: RunConfig): AsyncIterable<AgentMessage> {
		for (const msg of this.messages) {
			yield msg;
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
	}
}

class SpyWriter implements IActivityWriter {
	activities: Array<{ taskId: string; activity: Activity }> = [];
	responses: Array<{ taskId: string; summary: string }> = [];

	async postActivity(taskId: string, activity: Activity): Promise<void> {
		this.activities.push({ taskId, activity });
	}

	async postResponse(taskId: string, summary: string): Promise<void> {
		this.responses.push({ taskId, summary });
	}
}

class CapturingRunner implements IAgentRunner {
	capturedConfig?: RunConfig;
	readonly supportsInjection = false;
	async *run(config: RunConfig): AsyncIterable<AgentMessage> {
		this.capturedConfig = config;
		yield* minimalMessages();
	}
	async stop(): Promise<void> {}
}

// Minimal valid message sequence: system init → result
function minimalMessages(sessionId = "ses_1"): AgentMessage[] {
	return [
		{
			type: "system",
			provider: "claude",
			sessionId,
			model: "claude-opus-4-6",
			tools: []
		},
		{
			type: "result",
			provider: "claude",
			sessionId,
			finishReason: "end_turn",
			durationMs: 500
		}
	];
}

// ─── setup ────────────────────────────────────────────────────────────────────

let store: SqliteTaskStore;
let sessionStore: SqliteSessionStore;
let writer: SpyWriter;
let api: OrchestratorAPI;

function buildApi(messages: AgentMessage[] = minimalMessages()): OrchestratorAPI {
	return new OrchestratorAPI({
		runnerFactory: () => new MockRunner(messages),
		taskStore: store,
		sessionStore,
		activityService: new ActivityService([writer]),
		workingDirectory: "/tmp"
	});
}

beforeEach(() => {
	store = new SqliteTaskStore(":memory:");
	sessionStore = new SqliteSessionStore();
	writer = new SpyWriter();
	api = buildApi();
});

// ─── HTTP handler ─────────────────────────────────────────────────────────────

describe("fetch — GET /health", () => {
	it("returns 200 with status ok", async () => {
		const res = await api.fetch(new Request("http://localhost/health"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

	it("reports zero active sessions initially", async () => {
		const res = await api.fetch(new Request("http://localhost/health"));
		const body = (await res.json()) as { activeSessions: number };
		expect(body.activeSessions).toBe(0);
	});

	it("is case-insensitive on method — GET only", async () => {
		const res = await api.fetch(new Request("http://localhost/health", { method: "POST" }));
		expect(res.status).toBe(404);
	});
});

describe("fetch — unknown routes", () => {
	it("returns 404 for arbitrary paths", async () => {
		const res = await api.fetch(new Request("http://localhost/unknown"));
		expect(res.status).toBe(404);
	});

	it("returns 404 for root path", async () => {
		const res = await api.fetch(new Request("http://localhost/"));
		expect(res.status).toBe(404);
	});
});

// ─── runTask — task lifecycle ─────────────────────────────────────────────────

describe("runTask — task resolution", () => {
	it("creates a new task for a CLI event", async () => {
		const event: TaskAssignedEvent = {
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix auth bug",
			initialMessage: "Fix the authentication bug"
		};
		await api.runTask(event);
		const tasks = await store.listTasks();
		expect(tasks).toHaveLength(1);
		expect(tasks[0].title).toBe("Fix auth bug");
	});

	it("creates a new task and binding for a platform event", async () => {
		const event: TaskAssignedEvent = {
			type: "task_assigned",
			taskRef: { platform: "linear", id: "ENG-42" },
			title: "Fix auth bug",
			initialMessage: "Fix the authentication bug"
		};
		await api.runTask(event);
		const tasks = await store.listTasks();
		expect(tasks).toHaveLength(1);
		const bindings = await store.getBindings(tasks[0].id);
		expect(bindings).toHaveLength(1);
		expect(bindings[0].platform).toBe("linear");
		expect(bindings[0].externalId).toBe("ENG-42");
	});

	it("resolves existing task by platform binding on repeat event", async () => {
		const event: TaskAssignedEvent = {
			type: "task_assigned",
			taskRef: { platform: "linear", id: "ENG-42" },
			title: "Fix auth bug",
			initialMessage: "Fix the authentication bug"
		};
		// First run creates the task
		await api.runTask(event);
		// Rebuild api with fresh runner so second call can run
		api = buildApi();
		await api.runTask(event);

		// Should still be only one task
		const tasks = await store.listTasks();
		expect(tasks).toHaveLength(1);
	});
});

describe("runTask — task status transitions", () => {
	it("marks task completed after session ends", async () => {
		const event: TaskAssignedEvent = {
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix auth bug",
			initialMessage: "Fix the authentication bug"
		};
		await api.runTask(event);
		const tasks = await store.listTasks({ status: "completed" });
		expect(tasks).toHaveLength(1);
	});

	it("marks task completed even when session ends with error finish reason", async () => {
		api = buildApi([
			{ type: "result", provider: "claude", sessionId: "s1", finishReason: "error", durationMs: 0 }
		]);
		const event: TaskAssignedEvent = {
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix auth bug",
			initialMessage: "Fix the authentication bug"
		};
		await api.runTask(event);
		const tasks = await store.listTasks({ status: "completed" });
		expect(tasks).toHaveLength(1);
	});

	it("marks task as failed when runner throws", async () => {
		api = new OrchestratorAPI({
			runnerFactory: () => new ThrowingRunner(),
			taskStore: store,
			sessionStore,
			activityService: new ActivityService([writer]),
			workingDirectory: "/tmp"
		});
		await api.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix auth bug",
			initialMessage: "Fix the authentication bug"
		});
		const tasks = await store.listTasks({ status: "failed" });
		expect(tasks).toHaveLength(1);
	});
});

describe("runTask — activity writing", () => {
	it("posts ThoughtActivity for assistant text parts", async () => {
		api = buildApi([
			{ type: "system", provider: "claude", sessionId: "s1", model: "claude-opus-4-6", tools: [] },
			{
				type: "assistant",
				provider: "claude",
				sessionId: "s1",
				parts: [{ type: "text", text: "I will fix the bug." }]
			},
			{
				type: "result",
				provider: "claude",
				sessionId: "s1",
				finishReason: "end_turn",
				durationMs: 100
			}
		]);
		const event: TaskAssignedEvent = {
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		};
		await api.runTask(event);
		const thoughts = writer.activities.filter((a) => a.activity.type === "thought");
		expect(thoughts).toHaveLength(1);
		expect(thoughts[0].activity).toMatchObject({ type: "thought", text: "I will fix the bug." });
	});

	it("posts ActionActivity for tool use", async () => {
		api = buildApi([
			{ type: "system", provider: "claude", sessionId: "s1", model: "claude-opus-4-6", tools: [] },
			{
				type: "tool_use",
				provider: "claude",
				sessionId: "s1",
				callId: "c1",
				toolName: "Read",
				input: { file_path: "src/auth.ts" }
			},
			{
				type: "result",
				provider: "claude",
				sessionId: "s1",
				finishReason: "end_turn",
				durationMs: 100
			}
		]);
		const event: TaskAssignedEvent = {
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		};
		await api.runTask(event);
		const actions = writer.activities.filter((a) => a.activity.type === "action");
		expect(actions).toHaveLength(1);
		expect(actions[0].activity).toMatchObject({
			type: "action",
			description: "Read: src/auth.ts",
			isError: false
		});
	});

	it("calls postResponse when result has a summary", async () => {
		api = buildApi([
			{ type: "system", provider: "claude", sessionId: "s1", model: "claude-opus-4-6", tools: [] },
			{
				type: "result",
				provider: "claude",
				sessionId: "s1",
				finishReason: "end_turn",
				durationMs: 300,
				summary: "I fixed the authentication bug in src/auth.ts"
			}
		]);
		const taskId = crypto.randomUUID();
		const event: TaskAssignedEvent = {
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		};
		await api.runTask(event);
		expect(writer.responses).toHaveLength(1);
		expect(writer.responses[0].summary).toBe("I fixed the authentication bug in src/auth.ts");
	});

	it("does not call postResponse when result has no summary", async () => {
		await api.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		});
		expect(writer.responses).toHaveLength(0);
	});

	it("activities are tagged with the correct taskId", async () => {
		api = buildApi([
			{ type: "system", provider: "claude", sessionId: "s1", model: "claude-opus-4-6", tools: [] },
			{
				type: "assistant",
				provider: "claude",
				sessionId: "s1",
				parts: [{ type: "text", text: "Working on it." }]
			},
			{
				type: "result",
				provider: "claude",
				sessionId: "s1",
				finishReason: "end_turn",
				durationMs: 100
			}
		]);
		const event: TaskAssignedEvent = {
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		};
		await api.runTask(event);
		const tasks = await store.listTasks();
		const taskId = tasks[0].id;
		for (const { taskId: tid } of writer.activities) {
			expect(tid).toBe(taskId);
		}
	});
});

describe("runTask — session tracking", () => {
	it("active session is removed after task completes", async () => {
		const event: TaskAssignedEvent = {
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		};
		await api.runTask(event);
		// After completion, health should report 0 active sessions
		const res = await api.fetch(new Request("http://localhost/health"));
		const body = (await res.json()) as { activeSessions: number };
		expect(body.activeSessions).toBe(0);
	});
});

// ─── handleEvent — user_comment ───────────────────────────────────────────────

describe("handleEvent — user_comment with no active session", () => {
	it("stores the comment as a TaskMessage", async () => {
		// First create a task by running it to completion
		const taskId = crypto.randomUUID();
		await api.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		});
		const tasks = await store.listTasks();
		const dbTaskId = tasks[0].id;

		// Now send a comment — no active session, should be stored
		api.handleEvent({
			type: "user_comment",
			taskRef: { platform: "cli", id: taskId },
			content: "Also fix the error message"
		});
		await api.flush();

		const messages = await store.getTaskMessages(dbTaskId);
		expect(messages).toHaveLength(1);
		expect(messages[0].content).toBe("Also fix the error message");
		expect(messages[0].source).toEqual({ type: "cli" });
	});
});

// ─── session lifecycle ────────────────────────────────────────────────────────

describe("runTask — session lifecycle", () => {
	it("creates a session record after task_assigned", async () => {
		const taskId = crypto.randomUUID();
		await api.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		});
		const task = await store.getTask(taskId);
		const sessions = await sessionStore.listSessions(task!.id);
		expect(sessions).toHaveLength(1);
	});

	it("transitions session to completed after successful run", async () => {
		const taskId = crypto.randomUUID();
		await api.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		});
		const task = await store.getTask(taskId);
		const sessions = await sessionStore.listSessions(task!.id);
		expect(sessions[0].status).toBe("completed");
		expect(sessions[0].completedAt).toBeString();
	});

	it("captures providerSessionId from SystemInfoMessage", async () => {
		const taskId = crypto.randomUUID();
		await api.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		});
		// minimalMessages() uses sessionId "ses_1"
		const task = await store.getTask(taskId);
		const sessions = await sessionStore.listSessions(task!.id);
		expect(sessions[0].providerSessionId).toBe("ses_1");
	});

	it("transitions session to failed when runner throws", async () => {
		const failingApi = new OrchestratorAPI({
			runnerFactory: () => new ThrowingRunner(),
			taskStore: store,
			sessionStore,
			activityService: new ActivityService([writer]),
			workingDirectory: "/tmp"
		});
		const taskId = crypto.randomUUID();
		await failingApi.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		});
		const task = await store.getTask(taskId);
		const sessions = await sessionStore.listSessions(task!.id);
		expect(sessions[0].status).toBe("failed");
	});

	it("transitions session to stopped when runner finishes with stopped reason", async () => {
		const stoppedApi = new OrchestratorAPI({
			runnerFactory: () => new StoppedRunner(),
			taskStore: store,
			sessionStore,
			activityService: new ActivityService([writer]),
			workingDirectory: "/tmp"
		});
		const taskId = crypto.randomUUID();
		await stoppedApi.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		});
		const task = await store.getTask(taskId);
		const sessions = await sessionStore.listSessions(task!.id);
		expect(sessions[0].status).toBe("stopped");
	});

	it("getActiveSession returns null after session completes", async () => {
		const taskId = crypto.randomUUID();
		await api.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "Fix bug",
			initialMessage: "Fix the bug"
		});
		const task = await store.getTask(taskId);
		expect(await sessionStore.getActiveSession(task!.id)).toBeNull();
	});
});

// ─── contextProvider ─────────────────────────────────────────────────────────

describe("runTask — contextProvider", () => {
	it("prepends context to systemPrompt when contextProvider is set", async () => {
		const capturing = new CapturingRunner();
		const contextProvider: ITaskContextProvider = {
			assembleContext: async () => "## Task context\n\nTask: Fix auth bug"
		};
		const contextApi = new OrchestratorAPI({
			runnerFactory: () => capturing,
			taskStore: store,
			sessionStore,
			activityService: new ActivityService([writer]),
			workingDirectory: "/tmp",
			contextProvider
		});
		await contextApi.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix auth bug",
			initialMessage: "Fix the bug"
		});
		expect(capturing.capturedConfig?.systemPrompt).toContain("## Task context");
	});

	it("systemPrompt is absent when contextProvider is not set and no static systemPrompt", async () => {
		const capturing = new CapturingRunner();
		const noContextApi = new OrchestratorAPI({
			runnerFactory: () => capturing,
			taskStore: store,
			sessionStore,
			activityService: new ActivityService([writer]),
			workingDirectory: "/tmp"
		});
		await noContextApi.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix auth bug",
			initialMessage: "Fix the bug"
		});
		expect(capturing.capturedConfig?.systemPrompt).toBeUndefined();
	});

	it("prepends context before static systemPrompt with blank line separator", async () => {
		const capturing = new CapturingRunner();
		const contextProvider: ITaskContextProvider = {
			assembleContext: async () => "## Task context\n\nTask: Fix auth bug"
		};
		const bothApi = new OrchestratorAPI({
			runnerFactory: () => capturing,
			taskStore: store,
			sessionStore,
			activityService: new ActivityService([writer]),
			workingDirectory: "/tmp",
			systemPrompt: "You are a helpful assistant.",
			contextProvider
		});
		await bothApi.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix auth bug",
			initialMessage: "Fix the bug"
		});
		expect(capturing.capturedConfig?.systemPrompt).toBe(
			"## Task context\n\nTask: Fix auth bug\n\nYou are a helpful assistant."
		);
	});

	it("transitions session to failed when contextProvider throws", async () => {
		const failingContextApi = new OrchestratorAPI({
			runnerFactory: () => new MockRunner(minimalMessages()),
			taskStore: store,
			sessionStore,
			activityService: new ActivityService([writer]),
			workingDirectory: "/tmp",
			contextProvider: {
				assembleContext: async () => {
					throw new Error("context assembly failed");
				}
			}
		});
		const taskId = crypto.randomUUID();
		await failingContextApi.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "Fix auth bug",
			initialMessage: "Fix the bug"
		});
		const task = await store.getTask(taskId);
		const sessions = await sessionStore.listSessions(task!.id);
		expect(sessions[0].status).toBe("failed");
		expect(task!.status).toBe("failed");
		// Task and session should not be stuck as active
		const res = await failingContextApi.fetch(new Request("http://localhost/health"));
		const body = (await res.json()) as { activeSessions: number };
		expect(body.activeSessions).toBe(0);
	});

	it("treats empty-string context as absent — systemPrompt falls through to static only", async () => {
		const capturing = new CapturingRunner();
		const emptyContextApi = new OrchestratorAPI({
			runnerFactory: () => capturing,
			taskStore: store,
			sessionStore,
			activityService: new ActivityService([writer]),
			workingDirectory: "/tmp",
			systemPrompt: "You are a helpful assistant.",
			contextProvider: {
				assembleContext: async () => ""
			}
		});
		await emptyContextApi.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "Fix auth bug",
			initialMessage: "Fix the bug"
		});
		// filter(Boolean) drops "", so only the static systemPrompt remains
		expect(capturing.capturedConfig?.systemPrompt).toBe("You are a helpful assistant.");
	});
});

// ─── REST API routes ──────────────────────────────────────────────────────────

describe("GET /api/tasks", () => {
	it("returns empty array when no tasks exist", async () => {
		const res = await api.fetch(new Request("http://localhost/api/tasks"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual([]);
	});

	it("returns tasks after one is created", async () => {
		await api.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: crypto.randomUUID() },
			title: "My task",
			initialMessage: "Do the thing"
		});
		const res = await api.fetch(new Request("http://localhost/api/tasks"));
		const body = (await res.json()) as Array<{ title: string }>;
		expect(body).toHaveLength(1);
		expect(body[0].title).toBe("My task");
	});
});

describe("GET /api/tasks/:id", () => {
	it("returns 404 for unknown task", async () => {
		const res = await api.fetch(new Request("http://localhost/api/tasks/nonexistent"));
		expect(res.status).toBe(404);
	});

	it("returns task and its sessions", async () => {
		const taskId = crypto.randomUUID();
		await api.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "My task",
			initialMessage: "Do the thing"
		});
		const res = await api.fetch(new Request(`http://localhost/api/tasks/${taskId}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			task: { id: string };
			sessions: Array<{ taskId: string }>;
		};
		expect(body.task.id).toBe(taskId);
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0].taskId).toBe(taskId);
	});
});

describe("GET /api/tasks/:id/messages", () => {
	it("returns empty array when no user comments exist", async () => {
		const taskId = crypto.randomUUID();
		await api.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "My task",
			initialMessage: "Do the thing"
		});
		const res = await api.fetch(new Request(`http://localhost/api/tasks/${taskId}/messages`));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual([]);
	});
});

describe("GET /api/sessions/:id/messages", () => {
	it("returns empty array when no messages stored", async () => {
		const taskId = crypto.randomUUID();
		await api.runTask({
			type: "task_assigned",
			taskRef: { platform: "cli", id: taskId },
			title: "My task",
			initialMessage: "Do the thing"
		});
		const task = await store.getTask(taskId);
		const sessions = await sessionStore.listSessions(task!.id);
		const res = await api.fetch(
			new Request(`http://localhost/api/sessions/${sessions[0].id}/messages`)
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual([]);
	});
});

describe("GET /api/sessions/:id/stream", () => {
	it("returns 404 for a session that is not active", async () => {
		const res = await api.fetch(new Request("http://localhost/api/sessions/nonexistent/stream"));
		expect(res.status).toBe(404);
	});
});

describe("fetch — POST /events validation", () => {
	it("returns 400 for invalid JSON", async () => {
		const res = await api.fetch(
			new Request("http://localhost/events", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not json"
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 for unknown event type", async () => {
		const res = await api.fetch(
			new Request("http://localhost/events", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "unknown_event" })
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 202 with taskId for task_assigned event", async () => {
		const taskId = crypto.randomUUID();
		const res = await api.fetch(
			new Request("http://localhost/events", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: "task_assigned",
					taskRef: { platform: "cli", id: taskId },
					title: "Test task",
					initialMessage: "Do the thing"
				})
			})
		);
		expect(res.status).toBe(202);
		const body = (await res.json()) as { taskId: string };
		expect(body.taskId).toBe(taskId);
		await api.flush();
	});
});
