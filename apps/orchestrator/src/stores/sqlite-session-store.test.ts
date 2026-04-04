import { beforeEach, describe, expect, it } from "bun:test";
import { SqliteSessionStore } from "./sqlite-session-store.js";

let store: SqliteSessionStore;

beforeEach(() => {
	store = new SqliteSessionStore();
});

describe("createSession", () => {
	it("creates a session with active status and no role", async () => {
		const session = await store.createSession({ taskId: "task-1" });
		expect(session.id).toBeString();
		expect(session.taskId).toBe("task-1");
		expect(session.status).toBe("active");
		expect(session.startedAt).toBeString();
		expect(session.role).toBeUndefined();
		expect(session.completedAt).toBeUndefined();
		expect(session.providerSessionId).toBeUndefined();
	});

	it("stores role when provided", async () => {
		const session = await store.createSession({ taskId: "task-1", role: "implementation" });
		expect(session.role).toBe("implementation");
	});
});

describe("getSession", () => {
	it("returns the session by id", async () => {
		const created = await store.createSession({ taskId: "task-1" });
		const fetched = await store.getSession(created.id);
		expect(fetched).toEqual(created);
	});

	it("returns null for unknown id", async () => {
		expect(await store.getSession("nonexistent")).toBeNull();
	});
});

describe("updateSession", () => {
	it("updates status", async () => {
		const session = await store.createSession({ taskId: "task-1" });
		const updated = await store.updateSession(session.id, { status: "completed" });
		expect(updated.status).toBe("completed");
	});

	it("updates providerSessionId", async () => {
		const session = await store.createSession({ taskId: "task-1" });
		const updated = await store.updateSession(session.id, { providerSessionId: "ses_abc" });
		expect(updated.providerSessionId).toBe("ses_abc");
	});

	it("updates completedAt", async () => {
		const session = await store.createSession({ taskId: "task-1" });
		const ts = new Date().toISOString();
		const updated = await store.updateSession(session.id, { completedAt: ts });
		expect(updated.completedAt).toBe(ts);
	});

	it("can update multiple fields at once", async () => {
		const session = await store.createSession({ taskId: "task-1" });
		const ts = new Date().toISOString();
		const updated = await store.updateSession(session.id, { status: "failed", completedAt: ts });
		expect(updated.status).toBe("failed");
		expect(updated.completedAt).toBe(ts);
	});

	it("preserves untouched fields", async () => {
		const session = await store.createSession({ taskId: "task-1", role: "review" });
		const updated = await store.updateSession(session.id, { status: "completed" });
		expect(updated.role).toBe("review");
		expect(updated.taskId).toBe("task-1");
	});

	it("throws when session not found", async () => {
		await expect(store.updateSession("nonexistent", { status: "completed" })).rejects.toThrow(
			"Session not found: nonexistent"
		);
	});
});

describe("listSessions", () => {
	it("returns all sessions for a task in chronological order", async () => {
		const s1 = await store.createSession({ taskId: "task-1" });
		const s2 = await store.createSession({ taskId: "task-1" });
		const sessions = await store.listSessions("task-1");
		expect(sessions).toHaveLength(2);
		expect(sessions[0].id).toBe(s1.id);
		expect(sessions[1].id).toBe(s2.id);
	});

	it("returns empty array when task has no sessions", async () => {
		expect(await store.listSessions("unknown-task")).toHaveLength(0);
	});

	it("does not return sessions from other tasks", async () => {
		await store.createSession({ taskId: "task-1" });
		await store.createSession({ taskId: "task-2" });
		expect(await store.listSessions("task-1")).toHaveLength(1);
	});
});

describe("getActiveSession", () => {
	it("returns the active session for a task", async () => {
		const session = await store.createSession({ taskId: "task-1" });
		const active = await store.getActiveSession("task-1");
		expect(active?.id).toBe(session.id);
	});

	it("returns null after the session is completed", async () => {
		const session = await store.createSession({ taskId: "task-1" });
		await store.updateSession(session.id, {
			status: "completed",
			completedAt: new Date().toISOString()
		});
		expect(await store.getActiveSession("task-1")).toBeNull();
	});

	it("returns null for unknown task", async () => {
		expect(await store.getActiveSession("unknown-task")).toBeNull();
	});
});
