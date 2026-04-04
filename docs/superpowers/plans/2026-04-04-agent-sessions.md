# Agent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote `AgentSession` to a first-class persisted entity with its own `ISessionStore` port, so session history is durable and the data model is ready for multi-session tasks.

**Architecture:** New types (`AgentSession`, `ISessionStore`) land in `@paisti/core`. `SqliteSessionStore` implements the port in `apps/orchestrator/src/stores/`. `OrchestratorAPI` gains a `sessionStore` dep; its `activeSessions` map shifts key from `taskId` to `sessionId`; `handleTaskAssigned` creates/finalises a session record around each runner loop.

**Tech Stack:** TypeScript, Bun, bun:sqlite, bun:test

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/agent-session.ts` | Create | `AgentSession`, `AgentSessionStatus`, `AgentSessionRole`, `CreateSessionInput`, `ISessionStore` |
| `packages/core/src/index.ts` | Modify | Re-export new types from `agent-session.ts` |
| `apps/orchestrator/src/stores/sqlite-session-store.ts` | Create | `SqliteSessionStore` — SQLite implementation of `ISessionStore` |
| `apps/orchestrator/src/stores/sqlite-session-store.test.ts` | Create | Unit tests for `SqliteSessionStore` |
| `apps/orchestrator/src/orchestrator-api.ts` | Modify | Add `sessionStore` dep, shift map key, update `handleTaskAssigned`, add `getActiveSessionForTask` |
| `apps/orchestrator/src/orchestrator-api.test.ts` | Modify | Add `sessionStore` to `buildApi()`, add session lifecycle test cases |
| `apps/orchestrator/src/main.ts` | Modify | Instantiate `SqliteSessionStore` and pass to `OrchestratorAPI` |

---

## Task 1: Define `AgentSession` types and `ISessionStore` in `@paisti/core`

**Files:**
- Create: `packages/core/src/agent-session.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Create `packages/core/src/agent-session.ts`**

```typescript
export type AgentSessionStatus = "active" | "completed" | "failed" | "stopped";

// Extensible — new roles added as orchestrator routing logic grows
export type AgentSessionRole = "discussion" | "implementation" | "review";

export interface AgentSession {
	id: string; // local UUID
	taskId: string;
	role?: AgentSessionRole; // undefined in Phase 1
	status: AgentSessionStatus;
	providerSessionId?: string; // SDK session ID, captured from SystemInfoMessage
	startedAt: string; // ISO 8601
	completedAt?: string; // ISO 8601; absent while active
}

export interface CreateSessionInput {
	taskId: string;
	role?: AgentSessionRole;
}

export interface ISessionStore {
	createSession(input: CreateSessionInput): Promise<AgentSession>;
	getSession(id: string): Promise<AgentSession | null>;
	updateSession(
		id: string,
		patch: Partial<Pick<AgentSession, "status" | "providerSessionId" | "completedAt">>
	): Promise<AgentSession>;
	/** Returns all sessions for the task ordered by startedAt ascending. */
	listSessions(taskId: string): Promise<AgentSession[]>;
	/** Returns the single active session for the task, or null if none. */
	getActiveSession(taskId: string): Promise<AgentSession | null>;
}
```

- [ ] **Step 2: Export new types from `packages/core/src/index.ts`**

Add after the existing `orchestration-task.js` export block:

```typescript
export type {
	AgentSession,
	AgentSessionRole,
	AgentSessionStatus,
	CreateSessionInput,
	ISessionStore
} from "./agent-session.js";
```

- [ ] **Step 3: Verify the package compiles**

```bash
cd packages/core && bun run tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/agent-session.ts packages/core/src/index.ts
git commit -m "feat(core): add AgentSession types and ISessionStore port"
```

---

## Task 2: Implement `SqliteSessionStore` (TDD)

**Files:**
- Create: `apps/orchestrator/src/stores/sqlite-session-store.test.ts`
- Create: `apps/orchestrator/src/stores/sqlite-session-store.ts`

- [ ] **Step 1: Write the failing tests in `apps/orchestrator/src/stores/sqlite-session-store.test.ts`**

```typescript
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
		await expect(
			store.updateSession("nonexistent", { status: "completed" })
		).rejects.toThrow("Session not found: nonexistent");
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
```

- [ ] **Step 2: Run tests — verify they fail with import error**

```bash
cd apps/orchestrator && bun test stores/sqlite-session-store.test.ts
```

Expected: error — `Cannot find module './sqlite-session-store.js'`

- [ ] **Step 3: Create `apps/orchestrator/src/stores/sqlite-session-store.ts`**

```typescript
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
	AgentSession,
	AgentSessionStatus,
	CreateSessionInput,
	ISessionStore
} from "@paisti/core";

export class SqliteSessionStore implements ISessionStore {
	private db: Database;

	constructor(path = ":memory:") {
		this.db = new Database(path);
		this.db.run("PRAGMA journal_mode=WAL");
		this.migrate();
	}

	private migrate(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS agent_sessions (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				role TEXT,
				status TEXT NOT NULL DEFAULT 'active',
				provider_session_id TEXT,
				started_at TEXT NOT NULL,
				completed_at TEXT
			)
		`);
	}

	async createSession(input: CreateSessionInput): Promise<AgentSession> {
		const id = randomUUID();
		const now = new Date().toISOString();
		this.db.run(
			`INSERT INTO agent_sessions (id, task_id, role, status, started_at)
			 VALUES (?, ?, ?, 'active', ?)`,
			[id, input.taskId, input.role ?? null, now]
		);
		return {
			id,
			taskId: input.taskId,
			...(input.role ? { role: input.role } : {}),
			status: "active",
			startedAt: now
		};
	}

	async getSession(id: string): Promise<AgentSession | null> {
		const row = this.db
			.query<RawSession, string>(`SELECT * FROM agent_sessions WHERE id = ?`)
			.get(id);
		return row ? toSession(row) : null;
	}

	async updateSession(
		id: string,
		patch: Partial<Pick<AgentSession, "status" | "providerSessionId" | "completedAt">>
	): Promise<AgentSession> {
		const setClauses: string[] = [];
		const values: unknown[] = [];

		if (patch.status !== undefined) {
			setClauses.push("status = ?");
			values.push(patch.status);
		}
		if (patch.providerSessionId !== undefined) {
			setClauses.push("provider_session_id = ?");
			values.push(patch.providerSessionId);
		}
		if (patch.completedAt !== undefined) {
			setClauses.push("completed_at = ?");
			values.push(patch.completedAt);
		}

		if (setClauses.length > 0) {
			values.push(id);
			this.db.run(
				`UPDATE agent_sessions SET ${setClauses.join(", ")} WHERE id = ?`,
				values as string[]
			);
		}

		const updated = await this.getSession(id);
		if (!updated) throw new Error(`Session not found: ${id}`);
		return updated;
	}

	async listSessions(taskId: string): Promise<AgentSession[]> {
		const rows = this.db
			.query<RawSession, string>(
				`SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY started_at ASC`
			)
			.all(taskId);
		return rows.map(toSession);
	}

	async getActiveSession(taskId: string): Promise<AgentSession | null> {
		const row = this.db
			.query<RawSession, [string, string]>(
				`SELECT * FROM agent_sessions WHERE task_id = ? AND status = ? LIMIT 1`
			)
			.get(taskId, "active");
		return row ? toSession(row) : null;
	}
}

// ─── raw row type ─────────────────────────────────────────────────────────────

interface RawSession {
	id: string;
	task_id: string;
	role: string | null;
	status: string;
	provider_session_id: string | null;
	started_at: string;
	completed_at: string | null;
}

function toSession(row: RawSession): AgentSession {
	return {
		id: row.id,
		taskId: row.task_id,
		...(row.role ? { role: row.role as AgentSession["role"] } : {}),
		status: row.status as AgentSessionStatus,
		...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
		startedAt: row.started_at,
		...(row.completed_at ? { completedAt: row.completed_at } : {})
	};
}
```

- [ ] **Step 4: Run tests — verify they all pass**

```bash
cd apps/orchestrator && bun test stores/sqlite-session-store.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/stores/sqlite-session-store.ts apps/orchestrator/src/stores/sqlite-session-store.test.ts
git commit -m "feat(orchestrator): add SqliteSessionStore implementing ISessionStore"
```

---

## Task 3: Wire `SqliteSessionStore` into `OrchestratorAPI`

**Files:**
- Modify: `apps/orchestrator/src/orchestrator-api.ts`
- Modify: `apps/orchestrator/src/orchestrator-api.test.ts`
- Modify: `apps/orchestrator/src/main.ts`

### Step 1: Add session lifecycle tests (failing)

- [ ] **Step 1a: Add `StoppedRunner` test double and session store to test setup**

In `apps/orchestrator/src/orchestrator-api.test.ts`, after the existing `ThrowingRunner` class (around line 16) add:

```typescript
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
```

Replace the imports block at the top of the test file — add `ISessionStore` and the new store import:

```typescript
import { beforeEach, describe, expect, it } from "bun:test";
import type {
	Activity,
	AgentMessage,
	IActivityWriter,
	IAgentRunner,
	RunConfig
} from "@paisti/core";
import { OrchestratorAPI } from "./orchestrator-api.js";
import { ActivityService } from "./services/activity-service.js";
import { SqliteSessionStore } from "./stores/sqlite-session-store.js";
import { SqliteTaskStore } from "./stores/sqlite-task-store.js";
import type { TaskAssignedEvent } from "./types/inbound-event.js";
```

Replace the setup variables and `buildApi` function:

```typescript
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
```

- [ ] **Step 1b: Add the session lifecycle `describe` block**

Append to `apps/orchestrator/src/orchestrator-api.test.ts` (after the last existing `describe` block):

```typescript
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
```

- [ ] **Step 2: Run tests — verify new tests fail, existing tests fail to compile**

```bash
cd apps/orchestrator && bun test orchestrator-api.test.ts 2>&1 | head -30
```

Expected: TypeScript error — `sessionStore` is not a known property of `OrchestratorDeps`.

### Step 2: Update `OrchestratorAPI`

- [ ] **Step 3: Replace `apps/orchestrator/src/orchestrator-api.ts` with the updated implementation**

```typescript
import type {
	AgentSessionStatus,
	IAgentRunner,
	ISessionStore,
	ITaskStore,
	OrchestrationTask,
	RunConfig
} from "@paisti/core";
import { messageToActivities } from "./message-to-activities.js";
import type { ActivityService } from "./services/activity-service.js";
import type { InboundEvent, TaskAssignedEvent, TaskRef } from "./types/inbound-event.js";

const CLI_PLATFORM = "cli";

export interface OrchestratorDeps {
	/** Called once per task to produce an isolated runner instance. */
	runnerFactory: () => IAgentRunner;
	taskStore: ITaskStore;
	sessionStore: ISessionStore;
	activityService: ActivityService;
	/** Defaults to process.cwd(). Per-task worktrees are added in Phase 2. */
	workingDirectory?: string;
	defaultModel?: string;
	systemPrompt?: string;
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

		const config: RunConfig = {
			workingDirectory: this.deps.workingDirectory ?? process.cwd(),
			userPrompt: initialMessage,
			...(this.deps.systemPrompt ? { systemPrompt: this.deps.systemPrompt } : {}),
			...(this.deps.defaultModel ? { model: this.deps.defaultModel } : {})
		};

		let finalStatus: AgentSessionStatus = "completed";
		try {
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

				if (msg.type === "result" && msg.summary) {
					await this.deps.activityService.postResponse(task.id, msg.summary);
				}
			}
		} catch (err) {
			finalStatus = "failed";
			console.error(`[orchestrator] task ${task.id} runner error:`, err);
		} finally {
			this.activeSessions.delete(agentSession.id);
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
```

- [ ] **Step 4: Run all orchestrator tests — verify they all pass**

```bash
cd apps/orchestrator && bun test
```

Expected: all tests pass including the new session lifecycle suite.

- [ ] **Step 5: Update `apps/orchestrator/src/main.ts` to wire `SqliteSessionStore`**

```typescript
import { ClaudeRunner } from "@paisti/claude-adapter";
import { ConsoleActivityWriter } from "@paisti/console-adapter";
import { OrchestratorAPI } from "./orchestrator-api.js";
import { ActivityService } from "./services/activity-service.js";
import { SqliteSessionStore } from "./stores/sqlite-session-store.js";
import { SqliteTaskStore } from "./stores/sqlite-task-store.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "paisti.db";

const taskStore = new SqliteTaskStore(DB_PATH);
const sessionStore = new SqliteSessionStore(DB_PATH);
const activityService = new ActivityService([new ConsoleActivityWriter()]);

const orchestrator = new OrchestratorAPI({
	runnerFactory: () => new ClaudeRunner(),
	taskStore,
	sessionStore,
	activityService,
	workingDirectory: process.cwd(),
	...(process.env.MODEL ? { defaultModel: process.env.MODEL } : {}),
	...(process.env.SYSTEM_PROMPT ? { systemPrompt: process.env.SYSTEM_PROMPT } : {})
});

await orchestrator.start(PORT);

const shutdown = async () => {
	await orchestrator.stop();
	process.exit(0);
};
process.on("SIGTERM", () => {
	void shutdown();
});
process.on("SIGINT", () => {
	void shutdown();
});
```

- [ ] **Step 6: Run all tests across the whole repo**

```bash
cd C:/Users/kytol/Desktop/Repositories/paisti-agent && bun test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator/src/orchestrator-api.ts apps/orchestrator/src/orchestrator-api.test.ts apps/orchestrator/src/main.ts
git commit -m "feat(orchestrator): wire ISessionStore into OrchestratorAPI - activeSessions keyed by sessionId instead of taskId - handleTaskAssigned creates/finalises AgentSession records - finalStatus derived from SessionResultMessage.finishReason - getActiveSessionForTask replaces direct map.get(taskId)"
```
