import { beforeEach, describe, expect, it } from "bun:test";
import type { OrchestrationTask } from "@paisti/core";
import { SqliteSessionStore } from "../stores/sqlite-session-store.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { LocalTaskContextProvider } from "./local-task-context-provider.js";

let taskStore: SqliteTaskStore;
let sessionStore: SqliteSessionStore;
let provider: LocalTaskContextProvider;
let task: OrchestrationTask;

beforeEach(async () => {
	taskStore = new SqliteTaskStore(":memory:");
	sessionStore = new SqliteSessionStore(":memory:");
	provider = new LocalTaskContextProvider(taskStore, sessionStore);
	task = await taskStore.createTask({ title: "Fix auth bug" });
});

describe("assembleContext", () => {
	it("returns only the header and title for a bare task", async () => {
		const ctx = await provider.assembleContext(task);
		expect(ctx).toBe("## Task context\n\nTask: Fix auth bug");
	});

	it("includes External references section when bindings exist", async () => {
		await taskStore.addBinding({
			taskId: task.id,
			platform: "linear",
			externalId: "ENG-42",
			externalUrl: "https://linear.app/team/ENG-42",
			role: "source"
		});
		const ctx = await provider.assembleContext(task);
		expect(ctx).toContain("External references:");
		expect(ctx).toContain("- linear ENG-42 [source]: https://linear.app/team/ENG-42");
	});

	it("omits url segment when binding has no externalUrl", async () => {
		await taskStore.addBinding({
			taskId: task.id,
			platform: "linear",
			externalId: "ENG-42",
			role: "source"
		});
		const ctx = await provider.assembleContext(task);
		expect(ctx).toContain("- linear ENG-42 [source]");
		expect(ctx).not.toContain(": http");
	});

	it("omits External references section when no bindings", async () => {
		const ctx = await provider.assembleContext(task);
		expect(ctx).not.toContain("External references:");
	});

	it("includes Past sessions section for a completed session with role", async () => {
		const session = await sessionStore.createSession({ taskId: task.id, role: "discussion" });
		await sessionStore.updateSession(session.id, {
			status: "completed",
			completedAt: "2026-04-03T10:00:00.000Z"
		});
		const ctx = await provider.assembleContext(task);
		expect(ctx).toContain("Past sessions:");
		expect(ctx).toContain("- discussion (completed, 2026-04-03)");
	});

	it("includes stopped and failed sessions, omits role when absent", async () => {
		const s1 = await sessionStore.createSession({ taskId: task.id });
		await sessionStore.updateSession(s1.id, {
			status: "stopped",
			completedAt: "2026-04-03T09:00:00.000Z"
		});
		const s2 = await sessionStore.createSession({ taskId: task.id });
		await sessionStore.updateSession(s2.id, {
			status: "failed",
			completedAt: "2026-04-03T10:00:00.000Z"
		});
		const ctx = await provider.assembleContext(task);
		expect(ctx).toContain("- (stopped, 2026-04-03)");
		expect(ctx).toContain("- (failed, 2026-04-03)");
	});

	it("omits active sessions from Past sessions", async () => {
		await sessionStore.createSession({ taskId: task.id }); // stays active
		const ctx = await provider.assembleContext(task);
		expect(ctx).not.toContain("Past sessions:");
	});

	it("shows completed sessions but not active ones when both exist", async () => {
		const completed = await sessionStore.createSession({ taskId: task.id, role: "discussion" });
		await sessionStore.updateSession(completed.id, {
			status: "completed",
			completedAt: "2026-04-03T10:00:00.000Z"
		});
		await sessionStore.createSession({ taskId: task.id }); // stays active
		const ctx = await provider.assembleContext(task);
		expect(ctx).toContain("Past sessions:");
		expect(ctx).toContain("- discussion (completed, 2026-04-03)");
		// The active session should not appear
		expect(ctx).not.toContain("active");
	});

	it("omits Past sessions section when no past sessions", async () => {
		const ctx = await provider.assembleContext(task);
		expect(ctx).not.toContain("Past sessions:");
	});

	it("includes Messages section with numbered entries when messages exist", async () => {
		await taskStore.addTaskMessage({
			taskId: task.id,
			content: "First message",
			author: "user",
			source: { type: "cli" }
		});
		await taskStore.addTaskMessage({
			taskId: task.id,
			content: "Second message",
			author: "agent",
			source: { type: "agent", sessionId: "ses_1" }
		});
		const ctx = await provider.assembleContext(task);
		expect(ctx).toContain("Messages:");
		expect(ctx).toContain("1. [user,");
		expect(ctx).toContain("First message");
		expect(ctx).toContain("2. [agent,");
		expect(ctx).toContain("Second message");
		expect(ctx.indexOf("1. [user,")).toBeLessThan(ctx.indexOf("2. [agent,"));
	});

	it("omits Messages section when no messages", async () => {
		const ctx = await provider.assembleContext(task);
		expect(ctx).not.toContain("Messages:");
	});

	it("renders all sections in correct order when task has bindings, past sessions, and messages", async () => {
		await taskStore.addBinding({
			taskId: task.id,
			platform: "github",
			externalId: "PR #123",
			externalUrl: "https://github.com/org/repo/pull/123",
			role: "artifact"
		});
		const session = await sessionStore.createSession({ taskId: task.id, role: "implementation" });
		await sessionStore.updateSession(session.id, {
			status: "completed",
			completedAt: "2026-04-04T08:00:00.000Z"
		});
		await taskStore.addTaskMessage({
			taskId: task.id,
			content: "Also fix the error message",
			author: "user",
			source: { type: "cli" }
		});
		const ctx = await provider.assembleContext(task);
		expect(ctx).toContain("## Task context");
		expect(ctx).toContain("Task: Fix auth bug");
		expect(ctx).toContain("External references:");
		expect(ctx).toContain("Past sessions:");
		expect(ctx).toContain("Messages:");
		const titleIdx = ctx.indexOf("Task: Fix auth bug");
		const bindingsIdx = ctx.indexOf("External references:");
		const sessionsIdx = ctx.indexOf("Past sessions:");
		const messagesIdx = ctx.indexOf("Messages:");
		expect(titleIdx).toBeLessThan(bindingsIdx);
		expect(bindingsIdx).toBeLessThan(sessionsIdx);
		expect(sessionsIdx).toBeLessThan(messagesIdx);
	});
});
