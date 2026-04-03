import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SqliteTaskStore } from "./sqlite-task-store.js";

// Each test gets a fresh in-memory database so there is no state leakage.
let store: SqliteTaskStore;

beforeEach(() => {
	store = new SqliteTaskStore(":memory:");
});

afterEach(() => {
	// SqliteTaskStore holds the DB open; GC handles cleanup for :memory:,
	// but reassigning triggers disposal on the next tick.
	store = undefined as unknown as SqliteTaskStore;
});

// ─── createTask ───────────────────────────────────────────────────────────────

describe("createTask", () => {
	it("returns a task with status 'open'", async () => {
		const task = await store.createTask({ title: "Fix login" });
		expect(task.status).toBe("open");
	});

	it("assigns a UUID id", async () => {
		const task = await store.createTask({ title: "Fix login" });
		expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("stores the title", async () => {
		const task = await store.createTask({ title: "Fix login" });
		expect(task.title).toBe("Fix login");
	});

	it("stores an optional slug", async () => {
		const task = await store.createTask({ title: "Fix login", slug: "fix-login" });
		expect(task.slug).toBe("fix-login");
	});

	it("omits slug when not provided", async () => {
		const task = await store.createTask({ title: "Fix login" });
		expect(task.slug).toBeUndefined();
	});

	it("sets createdAt and updatedAt to ISO strings", async () => {
		const task = await store.createTask({ title: "Fix login" });
		expect(() => new Date(task.createdAt)).not.toThrow();
		expect(() => new Date(task.updatedAt)).not.toThrow();
	});

	it("two tasks get distinct ids", async () => {
		const a = await store.createTask({ title: "A" });
		const b = await store.createTask({ title: "B" });
		expect(a.id).not.toBe(b.id);
	});
});

// ─── getTask ──────────────────────────────────────────────────────────────────

describe("getTask", () => {
	it("returns the task by id", async () => {
		const created = await store.createTask({ title: "Fix login" });
		const found = await store.getTask(created.id);
		expect(found).not.toBeNull();
		expect(found!.id).toBe(created.id);
	});

	it("returns null for unknown id", async () => {
		expect(await store.getTask("nonexistent-id")).toBeNull();
	});
});

// ─── getTaskBySlug ────────────────────────────────────────────────────────────

describe("getTaskBySlug", () => {
	it("returns the task by slug", async () => {
		await store.createTask({ title: "Fix login", slug: "fix-login" });
		const found = await store.getTaskBySlug("fix-login");
		expect(found).not.toBeNull();
		expect(found!.slug).toBe("fix-login");
	});

	it("returns null for unknown slug", async () => {
		expect(await store.getTaskBySlug("no-such-slug")).toBeNull();
	});
});

// ─── updateTask ───────────────────────────────────────────────────────────────

describe("updateTask", () => {
	it("updates status", async () => {
		const task = await store.createTask({ title: "Fix login" });
		const updated = await store.updateTask(task.id, { status: "active" });
		expect(updated.status).toBe("active");
	});

	it("updates title", async () => {
		const task = await store.createTask({ title: "Fix login" });
		const updated = await store.updateTask(task.id, { title: "Fix registration" });
		expect(updated.title).toBe("Fix registration");
	});

	it("bumps updatedAt", async () => {
		const task = await store.createTask({ title: "Fix login" });
		// Ensure at least 1 ms passes
		await Bun.sleep(2);
		const updated = await store.updateTask(task.id, { status: "active" });
		expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
			new Date(task.updatedAt).getTime(),
		);
	});

	it("can apply status and title together via two calls", async () => {
		const task = await store.createTask({ title: "Fix login" });
		await store.updateTask(task.id, { status: "active" });
		const final = await store.updateTask(task.id, { title: "Fix login v2" });
		expect(final.status).toBe("active");
		expect(final.title).toBe("Fix login v2");
	});

	it("throws for unknown id", async () => {
		await expect(store.updateTask("no-such-id", { status: "active" })).rejects.toThrow();
	});
});

// ─── listTasks ────────────────────────────────────────────────────────────────

describe("listTasks", () => {
	it("returns all tasks when no filter", async () => {
		await store.createTask({ title: "A" });
		await store.createTask({ title: "B" });
		const tasks = await store.listTasks();
		expect(tasks).toHaveLength(2);
	});

	it("filters by status", async () => {
		const t1 = await store.createTask({ title: "A" });
		const t2 = await store.createTask({ title: "B" });
		await store.updateTask(t1.id, { status: "active" });
		await store.updateTask(t2.id, { status: "completed" });

		const active = await store.listTasks({ status: "active" });
		expect(active).toHaveLength(1);
		expect(active[0].id).toBe(t1.id);

		const completed = await store.listTasks({ status: "completed" });
		expect(completed).toHaveLength(1);
		expect(completed[0].id).toBe(t2.id);
	});

	it("returns empty array when no tasks match filter", async () => {
		await store.createTask({ title: "A" });
		const archived = await store.listTasks({ status: "archived" });
		expect(archived).toEqual([]);
	});
});

// ─── addBinding / getBindings / findTaskByBinding ─────────────────────────────

describe("bindings", () => {
	it("addBinding returns the binding", async () => {
		const task = await store.createTask({ title: "Fix login" });
		const binding = await store.addBinding({
			taskId: task.id,
			platform: "linear",
			externalId: "ENG-123",
			role: "source",
		});
		expect(binding.platform).toBe("linear");
		expect(binding.externalId).toBe("ENG-123");
		expect(binding.role).toBe("source");
		expect(binding.taskId).toBe(task.id);
	});

	it("addBinding stores externalUrl when provided", async () => {
		const task = await store.createTask({ title: "Fix login" });
		const binding = await store.addBinding({
			taskId: task.id,
			platform: "linear",
			externalId: "ENG-123",
			externalUrl: "https://linear.app/team/ENG-123",
			role: "source",
		});
		expect(binding.externalUrl).toBe("https://linear.app/team/ENG-123");
	});

	it("addBinding omits externalUrl when not provided", async () => {
		const task = await store.createTask({ title: "Fix login" });
		const binding = await store.addBinding({
			taskId: task.id,
			platform: "linear",
			externalId: "ENG-123",
			role: "source",
		});
		expect(binding.externalUrl).toBeUndefined();
	});

	it("duplicate (platform, externalId) is silently ignored (INSERT OR IGNORE)", async () => {
		const task = await store.createTask({ title: "Fix login" });
		await store.addBinding({
			taskId: task.id,
			platform: "linear",
			externalId: "ENG-123",
			role: "source",
		});
		// Should not throw
		await store.addBinding({
			taskId: task.id,
			platform: "linear",
			externalId: "ENG-123",
			role: "source",
		});
		const bindings = await store.getBindings(task.id);
		expect(bindings).toHaveLength(1);
	});

	it("getBindings returns all bindings for a task", async () => {
		const task = await store.createTask({ title: "Fix login" });
		await store.addBinding({
			taskId: task.id,
			platform: "linear",
			externalId: "ENG-1",
			role: "source",
		});
		await store.addBinding({
			taskId: task.id,
			platform: "github",
			externalId: "PR-99",
			role: "artifact",
		});
		const bindings = await store.getBindings(task.id);
		expect(bindings).toHaveLength(2);
	});

	it("getBindings returns [] for a task with no bindings", async () => {
		const task = await store.createTask({ title: "Fix login" });
		expect(await store.getBindings(task.id)).toEqual([]);
	});

	it("findTaskByBinding returns the task", async () => {
		const task = await store.createTask({ title: "Fix login" });
		await store.addBinding({
			taskId: task.id,
			platform: "linear",
			externalId: "ENG-123",
			role: "source",
		});
		const found = await store.findTaskByBinding("linear", "ENG-123");
		expect(found).not.toBeNull();
		expect(found!.id).toBe(task.id);
	});

	it("findTaskByBinding returns null for unknown platform/id combo", async () => {
		expect(await store.findTaskByBinding("linear", "ENG-999")).toBeNull();
	});

	it("findTaskByBinding is scoped by platform", async () => {
		const task = await store.createTask({ title: "Fix login" });
		await store.addBinding({
			taskId: task.id,
			platform: "linear",
			externalId: "ENG-123",
			role: "source",
		});
		// Same externalId but different platform → not found
		expect(await store.findTaskByBinding("github", "ENG-123")).toBeNull();
	});
});

// ─── addTaskMessage / getTaskMessages ─────────────────────────────────────────

describe("task messages", () => {
	it("addTaskMessage returns the message with cli source", async () => {
		const task = await store.createTask({ title: "Fix login" });
		const msg = await store.addTaskMessage({
			taskId: task.id,
			content: "Please also fix the error handling",
			author: "user",
			source: { type: "cli" },
		});
		expect(msg.taskId).toBe(task.id);
		expect(msg.content).toBe("Please also fix the error handling");
		expect(msg.source).toEqual({ type: "cli" });
	});

	it("addTaskMessage returns the message with agent source", async () => {
		const task = await store.createTask({ title: "Fix login" });
		const msg = await store.addTaskMessage({
			taskId: task.id,
			content: "Done — I fixed the bug.",
			author: "agent",
			source: { type: "agent", sessionId: "ses_abc" },
		});
		expect(msg.source).toEqual({ type: "agent", sessionId: "ses_abc" });
	});

	it("getTaskMessages returns messages in chronological order", async () => {
		const task = await store.createTask({ title: "Fix login" });
		await store.addTaskMessage({
			taskId: task.id,
			content: "first",
			author: "user",
			source: { type: "cli" },
		});
		await store.addTaskMessage({
			taskId: task.id,
			content: "second",
			author: "user",
			source: { type: "cli" },
		});
		await store.addTaskMessage({
			taskId: task.id,
			content: "third",
			author: "user",
			source: { type: "cli" },
		});
		const messages = await store.getTaskMessages(task.id);
		expect(messages.map((m) => m.content)).toEqual(["first", "second", "third"]);
	});

	it("getTaskMessages returns [] for a task with no messages", async () => {
		const task = await store.createTask({ title: "Fix login" });
		expect(await store.getTaskMessages(task.id)).toEqual([]);
	});

	it("getTaskMessages is scoped to the task", async () => {
		const t1 = await store.createTask({ title: "Task 1" });
		const t2 = await store.createTask({ title: "Task 2" });
		await store.addTaskMessage({
			taskId: t1.id,
			content: "belongs to t1",
			author: "user",
			source: { type: "cli" },
		});
		expect(await store.getTaskMessages(t2.id)).toEqual([]);
	});
});
