import { beforeEach, describe, expect, it } from "bun:test";
import type {
	Activity,
	AgentMessage,
	IActivityWriter,
	IAgentRunner,
	RunConfig
} from "@paisti/core";
import { OrchestratorAPI } from "./orchestrator-api.js";
import { SqliteTaskStore } from "./sqlite-task-store.js";
import type { TaskAssignedEvent } from "./types/inbound-event.js";

// ─── test doubles ─────────────────────────────────────────────────────────────

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
let writer: SpyWriter;
let api: OrchestratorAPI;

function buildApi(messages: AgentMessage[] = minimalMessages()): OrchestratorAPI {
	return new OrchestratorAPI({
		runnerFactory: () => new MockRunner(messages),
		taskStore: store,
		activityWriter: writer,
		workingDirectory: "/tmp"
	});
}

beforeEach(() => {
	store = new SqliteTaskStore(":memory:");
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
			activityWriter: writer,
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
