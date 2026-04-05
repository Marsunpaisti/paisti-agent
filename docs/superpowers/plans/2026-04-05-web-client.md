# Web Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Hono-based REST/SSE API and a Vite + React SPA to the orchestrator for real-time task and session inspection.

**Architecture:** Hono replaces the manual `if/else` fetch handler in `OrchestratorAPI`. A new `MessageService` (same fan-out pattern as `ActivityService`) writes `AgentMessage` records to SQLite and pushes them over SSE to connected browser clients. A React SPA in `apps/web` is served statically by the orchestrator when `SERVE_UI=true`.

**Tech Stack:** Bun, Hono 4.x, Vite 5.x, React 18.x, React Router 6.x, TanStack Query 5.x, Tailwind CSS 3.x

---

## File Map

### Core (packages/core)
| File | Change |
|------|--------|
| `packages/core/src/agent-message-store.ts` | **NEW** — `IAgentMessageWriter`, `IAgentMessageStore`, `StoredAgentMessage` |
| `packages/core/src/agent-session.ts` | **MODIFY** — add `systemPrompt?: string` to `AgentSession` and `updateSession` patch |
| `packages/core/src/index.ts` | **MODIFY** — export new types |

### Orchestrator stores
| File | Change |
|------|--------|
| `apps/orchestrator/src/stores/sqlite-session-store.ts` | **MODIFY** — add `system_prompt` column, handle in `updateSession` |
| `apps/orchestrator/src/stores/sqlite-session-store.test.ts` | **MODIFY** — add `systemPrompt` tests |
| `apps/orchestrator/src/stores/sqlite-agent-message-writer.ts` | **NEW** — implements `IAgentMessageStore` |
| `apps/orchestrator/src/stores/sqlite-agent-message-writer.test.ts` | **NEW** |

### Orchestrator services
| File | Change |
|------|--------|
| `apps/orchestrator/src/services/message-service.ts` | **NEW** — fan-out `MessageService` |
| `apps/orchestrator/src/services/message-service.test.ts` | **NEW** |
| `apps/orchestrator/src/services/sse-broadcaster.ts` | **NEW** — SSE connection manager |
| `apps/orchestrator/src/services/sse-broadcaster.test.ts` | **NEW** |

### Orchestrator API
| File | Change |
|------|--------|
| `apps/orchestrator/package.json` | **MODIFY** — add `hono` |
| `apps/orchestrator/src/orchestrator-api.ts` | **MODIFY** — Hono router, new deps, new routes, systemPrompt, messages |
| `apps/orchestrator/src/orchestrator-api.test.ts` | **MODIFY** — new route tests |
| `apps/orchestrator/src/main.ts` | **MODIFY** — wire everything, `SERVE_UI` |

### Web app (apps/web)
| File | Change |
|------|--------|
| `apps/web/package.json` | **NEW** |
| `apps/web/index.html` | **NEW** |
| `apps/web/vite.config.ts` | **NEW** |
| `apps/web/tsconfig.json` | **NEW** |
| `apps/web/src/index.css` | **NEW** |
| `apps/web/src/main.tsx` | **NEW** |
| `apps/web/src/App.tsx` | **NEW** |
| `apps/web/src/api/types.ts` | **NEW** — frontend-local type mirror of core types |
| `apps/web/src/api/client.ts` | **NEW** — typed fetch wrappers |
| `apps/web/src/hooks/useTasks.ts` | **NEW** |
| `apps/web/src/hooks/useSession.ts` | **NEW** |
| `apps/web/src/hooks/useSessionStream.ts` | **NEW** — `EventSource` hook |
| `apps/web/src/components/TaskList.tsx` | **NEW** |
| `apps/web/src/components/TaskDetail.tsx` | **NEW** |
| `apps/web/src/components/ChatView.tsx` | **NEW** |
| `apps/web/src/components/MessageItem.tsx` | **NEW** |
| `apps/web/src/components/NewTaskForm.tsx` | **NEW** |

---

## Task 1: Core types — IAgentMessageStore + AgentSession.systemPrompt

**Files:**
- Create: `packages/core/src/agent-message-store.ts`
- Modify: `packages/core/src/agent-session.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Create `packages/core/src/agent-message-store.ts`**

```ts
import type { AgentMessage } from "./agent-messages.js";

export interface StoredAgentMessage {
	sessionId: string;
	sequence: number;
	message: AgentMessage;
}

export interface IAgentMessageWriter {
	writeMessage(sessionId: string, sequence: number, message: AgentMessage): Promise<void>;
}

export interface IAgentMessageStore extends IAgentMessageWriter {
	getMessages(sessionId: string): Promise<StoredAgentMessage[]>;
}
```

- [ ] **Step 2: Add `systemPrompt` to `AgentSession` and `ISessionStore`**

In `packages/core/src/agent-session.ts`, add `systemPrompt?: string` to `AgentSession` and to the `updateSession` patch type:

```ts
export interface AgentSession {
	id: string;
	taskId: string;
	role?: AgentSessionRole;
	status: AgentSessionStatus;
	providerSessionId?: string;
	systemPrompt?: string;        // ← add this
	startedAt: string;
	completedAt?: string;
}

export interface ISessionStore {
	createSession(input: CreateSessionInput): Promise<AgentSession>;
	getSession(id: string): Promise<AgentSession | null>;
	updateSession(
		id: string,
		patch: Partial<Pick<AgentSession, "status" | "providerSessionId" | "completedAt" | "systemPrompt">>
	): Promise<AgentSession>;
	listSessions(taskId: string): Promise<AgentSession[]>;
	getActiveSession(taskId: string): Promise<AgentSession | null>;
}
```

- [ ] **Step 3: Export new types from `packages/core/src/index.ts`**

Add to the exports:

```ts
export type {
	IAgentMessageStore,
	IAgentMessageWriter,
	StoredAgentMessage
} from "./agent-message-store.js";
```

- [ ] **Step 4: Typecheck**

```bash
cd packages/core && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-message-store.ts packages/core/src/agent-session.ts packages/core/src/index.ts
git commit -m "feat(core): add IAgentMessageStore types and AgentSession.systemPrompt"
```

---

## Task 2: SqliteSessionStore — add systemPrompt

**Files:**
- Modify: `apps/orchestrator/src/stores/sqlite-session-store.ts`
- Modify: `apps/orchestrator/src/stores/sqlite-session-store.test.ts`

- [ ] **Step 1: Write failing test**

In `sqlite-session-store.test.ts`, add inside the existing `describe("updateSession")` block:

```ts
it("updates systemPrompt", async () => {
	const session = await store.createSession({ taskId: "task-1" });
	const updated = await store.updateSession(session.id, {
		systemPrompt: "You are a helpful assistant."
	});
	expect(updated.systemPrompt).toBe("You are a helpful assistant.");
});

it("systemPrompt is undefined when not set", async () => {
	const session = await store.createSession({ taskId: "task-1" });
	expect(session.systemPrompt).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/orchestrator && bun test src/stores/sqlite-session-store.test.ts
```

Expected: FAIL — `updateSession` does not handle `systemPrompt`.

- [ ] **Step 3: Add `system_prompt` column and handling to `SqliteSessionStore`**

In `sqlite-session-store.ts`:

1. In `migrate()`, update the `CREATE TABLE` to include the column and add an `ALTER TABLE` guard for existing DBs:

```ts
private migrate(): void {
	this.db.run(`
		CREATE TABLE IF NOT EXISTS agent_sessions (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL,
			role TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			provider_session_id TEXT,
			system_prompt TEXT,
			started_at TEXT NOT NULL,
			completed_at TEXT
		)
	`);
	// Migration guard for DBs created before system_prompt column was added
	try {
		this.db.run("ALTER TABLE agent_sessions ADD COLUMN system_prompt TEXT");
	} catch {
		// column already exists
	}
}
```

2. In `updateSession`, add handling for `systemPrompt`:

```ts
if (patch.systemPrompt !== undefined) {
	setClauses.push("system_prompt = ?");
	values.push(patch.systemPrompt);
}
```

3. Update `RawSession` interface:

```ts
interface RawSession {
	id: string;
	task_id: string;
	role: string | null;
	status: string;
	provider_session_id: string | null;
	system_prompt: string | null;    // ← add
	started_at: string;
	completed_at: string | null;
}
```

4. Update `toSession` mapper:

```ts
function toSession(row: RawSession): AgentSession {
	return {
		id: row.id,
		taskId: row.task_id,
		...(row.role ? { role: row.role as AgentSession["role"] } : {}),
		status: row.status as AgentSessionStatus,
		...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
		...(row.system_prompt ? { systemPrompt: row.system_prompt } : {}),    // ← add
		startedAt: row.started_at,
		...(row.completed_at ? { completedAt: row.completed_at } : {})
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/orchestrator && bun test src/stores/sqlite-session-store.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/stores/sqlite-session-store.ts apps/orchestrator/src/stores/sqlite-session-store.test.ts
git commit -m "feat(orchestrator): add systemPrompt to SqliteSessionStore"
```

---

## Task 3: SqliteAgentMessageWriter

**Files:**
- Create: `apps/orchestrator/src/stores/sqlite-agent-message-writer.ts`
- Create: `apps/orchestrator/src/stores/sqlite-agent-message-writer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/orchestrator/src/stores/sqlite-agent-message-writer.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@paisti/core";
import { SqliteAgentMessageWriter } from "./sqlite-agent-message-writer.js";

const systemMsg: AgentMessage = {
	type: "system",
	provider: "claude",
	sessionId: "ses-1",
	model: "claude-opus-4-6",
	tools: []
};

const resultMsg: AgentMessage = {
	type: "result",
	provider: "claude",
	sessionId: "ses-1",
	finishReason: "end_turn",
	durationMs: 500
};

let writer: SqliteAgentMessageWriter;

beforeEach(() => {
	writer = new SqliteAgentMessageWriter(":memory:");
});

describe("writeMessage + getMessages", () => {
	it("returns empty array for unknown session", async () => {
		expect(await writer.getMessages("unknown")).toEqual([]);
	});

	it("persists a message and returns it", async () => {
		await writer.writeMessage("ses-1", 1, systemMsg);
		const stored = await writer.getMessages("ses-1");
		expect(stored).toHaveLength(1);
		expect(stored[0].sessionId).toBe("ses-1");
		expect(stored[0].sequence).toBe(1);
		expect(stored[0].message).toEqual(systemMsg);
	});

	it("returns messages in sequence order", async () => {
		await writer.writeMessage("ses-1", 2, resultMsg);
		await writer.writeMessage("ses-1", 1, systemMsg);
		const stored = await writer.getMessages("ses-1");
		expect(stored[0].sequence).toBe(1);
		expect(stored[1].sequence).toBe(2);
	});

	it("isolates messages by session", async () => {
		await writer.writeMessage("ses-1", 1, systemMsg);
		await writer.writeMessage("ses-2", 1, resultMsg);
		expect(await writer.getMessages("ses-1")).toHaveLength(1);
		expect(await writer.getMessages("ses-2")).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/orchestrator && bun test src/stores/sqlite-agent-message-writer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SqliteAgentMessageWriter`**

Create `apps/orchestrator/src/stores/sqlite-agent-message-writer.ts`:

```ts
import { Database } from "bun:sqlite";
import type { AgentMessage, IAgentMessageStore, StoredAgentMessage } from "@paisti/core";

export class SqliteAgentMessageWriter implements IAgentMessageStore {
	private db: Database;

	constructor(path = ":memory:") {
		this.db = new Database(path);
		this.db.run("PRAGMA journal_mode=WAL");
		this.migrate();
	}

	private migrate(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS session_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				message TEXT NOT NULL
			)
		`);
	}

	async writeMessage(sessionId: string, sequence: number, message: AgentMessage): Promise<void> {
		this.db.run(
			`INSERT INTO session_messages (session_id, sequence, message) VALUES (?, ?, ?)`,
			[sessionId, sequence, JSON.stringify(message)]
		);
	}

	async getMessages(sessionId: string): Promise<StoredAgentMessage[]> {
		const rows = this.db
			.query<{ session_id: string; sequence: number; message: string }, string>(
				`SELECT session_id, sequence, message FROM session_messages WHERE session_id = ? ORDER BY sequence ASC`
			)
			.all(sessionId);
		return rows.map((row) => ({
			sessionId: row.session_id,
			sequence: row.sequence,
			message: JSON.parse(row.message) as AgentMessage
		}));
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/orchestrator && bun test src/stores/sqlite-agent-message-writer.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/stores/sqlite-agent-message-writer.ts apps/orchestrator/src/stores/sqlite-agent-message-writer.test.ts
git commit -m "feat(orchestrator): add SqliteAgentMessageWriter"
```

---

## Task 4: MessageService

**Files:**
- Create: `apps/orchestrator/src/services/message-service.ts`
- Create: `apps/orchestrator/src/services/message-service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/orchestrator/src/services/message-service.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { AgentMessage, IAgentMessageWriter } from "@paisti/core";
import { MessageService } from "./message-service.js";

class SpyMessageWriter implements IAgentMessageWriter {
	calls: Array<{ sessionId: string; sequence: number; message: AgentMessage }> = [];
	async writeMessage(sessionId: string, sequence: number, message: AgentMessage): Promise<void> {
		this.calls.push({ sessionId, sequence, message });
	}
}

const msg: AgentMessage = {
	type: "system",
	provider: "claude",
	sessionId: "ses-1",
	model: "claude-opus-4-6",
	tools: []
};

describe("MessageService", () => {
	it("fans out to all writers", async () => {
		const a = new SpyMessageWriter();
		const b = new SpyMessageWriter();
		const svc = new MessageService([a, b]);
		await svc.writeMessage("ses-1", msg);
		expect(a.calls).toHaveLength(1);
		expect(b.calls).toHaveLength(1);
	});

	it("assigns sequence 1 to the first message", async () => {
		const spy = new SpyMessageWriter();
		const svc = new MessageService([spy]);
		await svc.writeMessage("ses-1", msg);
		expect(spy.calls[0].sequence).toBe(1);
	});

	it("increments sequence per session", async () => {
		const spy = new SpyMessageWriter();
		const svc = new MessageService([spy]);
		await svc.writeMessage("ses-1", msg);
		await svc.writeMessage("ses-1", msg);
		expect(spy.calls[0].sequence).toBe(1);
		expect(spy.calls[1].sequence).toBe(2);
	});

	it("sequences are independent per session", async () => {
		const spy = new SpyMessageWriter();
		const svc = new MessageService([spy]);
		await svc.writeMessage("ses-1", msg);
		await svc.writeMessage("ses-2", msg);
		expect(spy.calls.find((c) => c.sessionId === "ses-1")?.sequence).toBe(1);
		expect(spy.calls.find((c) => c.sessionId === "ses-2")?.sequence).toBe(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/orchestrator && bun test src/services/message-service.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `MessageService`**

Create `apps/orchestrator/src/services/message-service.ts`:

```ts
import type { AgentMessage, IAgentMessageWriter } from "@paisti/core";

export class MessageService {
	private readonly writers: IAgentMessageWriter[];
	private readonly sequences = new Map<string, number>();

	constructor(writers: IAgentMessageWriter[]) {
		this.writers = writers;
	}

	async writeMessage(sessionId: string, message: AgentMessage): Promise<void> {
		const seq = (this.sequences.get(sessionId) ?? 0) + 1;
		this.sequences.set(sessionId, seq);
		await Promise.all(this.writers.map((w) => w.writeMessage(sessionId, seq, message)));
	}

	closeSession(sessionId: string): void {
		this.sequences.delete(sessionId);
		for (const writer of this.writers) {
			if ("closeSession" in writer && typeof writer.closeSession === "function") {
				(writer as { closeSession: (id: string) => void }).closeSession(sessionId);
			}
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/orchestrator && bun test src/services/message-service.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/services/message-service.ts apps/orchestrator/src/services/message-service.test.ts
git commit -m "feat(orchestrator): add MessageService"
```

---

## Task 5: SseBroadcaster

**Files:**
- Create: `apps/orchestrator/src/services/sse-broadcaster.ts`
- Create: `apps/orchestrator/src/services/sse-broadcaster.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/orchestrator/src/services/sse-broadcaster.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@paisti/core";
import { SseBroadcaster } from "./sse-broadcaster.js";

const msg: AgentMessage = {
	type: "system",
	provider: "claude",
	sessionId: "ses-1",
	model: "claude-opus-4-6",
	tools: []
};

describe("SseBroadcaster", () => {
	it("is a no-op when no controllers are registered", async () => {
		const broadcaster = new SseBroadcaster();
		// Should not throw
		await broadcaster.writeMessage("ses-1", 1, msg);
	});

	it("encodes and pushes the message to a registered controller", async () => {
		const broadcaster = new SseBroadcaster();
		const chunks: Uint8Array[] = [];

		const stream = new ReadableStream<Uint8Array>({
			start(ctrl) {
				broadcaster.register("ses-1", ctrl);
			}
		});

		await broadcaster.writeMessage("ses-1", 1, msg);

		const reader = stream.getReader();
		const { value } = await reader.read();
		reader.releaseLock();

		const text = new TextDecoder().decode(value);
		expect(text).toBe(`data: ${JSON.stringify(msg)}\n\n`);
	});

	it("does not push to unregistered session", async () => {
		const broadcaster = new SseBroadcaster();
		const received: string[] = [];

		const stream = new ReadableStream<Uint8Array>({
			start(ctrl) {
				broadcaster.register("ses-1", ctrl);
			}
		});

		await broadcaster.writeMessage("ses-2", 1, msg);

		// Read with a timeout — nothing should arrive
		const reader = stream.getReader();
		const result = await Promise.race([
			reader.read(),
			new Promise<{ value: undefined; done: false }>((res) =>
				setTimeout(() => res({ value: undefined, done: false }), 50)
			)
		]);
		reader.releaseLock();
		expect(result.value).toBeUndefined();
	});

	it("closeSession closes all controllers for the session", async () => {
		const broadcaster = new SseBroadcaster();
		let closed = false;

		const stream = new ReadableStream<Uint8Array>({
			start(ctrl) {
				broadcaster.register("ses-1", ctrl);
			},
			cancel() {
				closed = true;
			}
		});

		broadcaster.closeSession("ses-1");

		const reader = stream.getReader();
		const { done } = await reader.read();
		reader.releaseLock();
		expect(done).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/orchestrator && bun test src/services/sse-broadcaster.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SseBroadcaster`**

Create `apps/orchestrator/src/services/sse-broadcaster.ts`:

```ts
import type { AgentMessage, IAgentMessageWriter } from "@paisti/core";

const encoder = new TextEncoder();

export class SseBroadcaster implements IAgentMessageWriter {
	private readonly connections = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();

	register(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
		if (!this.connections.has(sessionId)) {
			this.connections.set(sessionId, new Set());
		}
		this.connections.get(sessionId)!.add(controller);
	}

	unregister(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
		const controllers = this.connections.get(sessionId);
		if (controllers) {
			controllers.delete(controller);
			if (controllers.size === 0) {
				this.connections.delete(sessionId);
			}
		}
	}

	async writeMessage(sessionId: string, _sequence: number, message: AgentMessage): Promise<void> {
		const controllers = this.connections.get(sessionId);
		if (!controllers?.size) return;
		const chunk = encoder.encode(`data: ${JSON.stringify(message)}\n\n`);
		for (const ctrl of controllers) {
			try {
				ctrl.enqueue(chunk);
			} catch {
				// controller closed — will be cleaned up on stream cancel
			}
		}
	}

	closeSession(sessionId: string): void {
		const controllers = this.connections.get(sessionId);
		if (!controllers) return;
		const closeChunk = encoder.encode("event: close\ndata: {}\n\n");
		for (const ctrl of controllers) {
			try {
				ctrl.enqueue(closeChunk);
				ctrl.close();
			} catch {
				// already closed
			}
		}
		this.connections.delete(sessionId);
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/orchestrator && bun test src/services/sse-broadcaster.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/services/sse-broadcaster.ts apps/orchestrator/src/services/sse-broadcaster.test.ts
git commit -m "feat(orchestrator): add SseBroadcaster"
```

---

## Task 6: Hono router + REST routes

**Files:**
- Modify: `apps/orchestrator/package.json`
- Modify: `apps/orchestrator/src/orchestrator-api.ts`
- Modify: `apps/orchestrator/src/orchestrator-api.test.ts`

- [ ] **Step 1: Add Hono to orchestrator dependencies**

In `apps/orchestrator/package.json`, add to `"dependencies"`:

```json
"hono": "4.12.10"
```

Then install:

```bash
cd apps/orchestrator && bun install
```

- [ ] **Step 2: Write failing tests for new routes**

In `apps/orchestrator/src/orchestrator-api.test.ts`, add at the end (after the existing `describe` blocks):

```ts
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
		const res = await api.fetch(
			new Request("http://localhost/api/tasks/nonexistent")
		);
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
		const res = await api.fetch(
			new Request(`http://localhost/api/tasks/${taskId}`)
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { task: { id: string }; sessions: Array<{ taskId: string }> };
		expect(body.task.id).toBe(taskId);
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0].taskId).toBe(taskId);
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
		const res = await api.fetch(
			new Request("http://localhost/api/sessions/nonexistent/stream")
		);
		expect(res.status).toBe(404);
	});
});
```

- [ ] **Step 3: Run new tests to verify they fail**

```bash
cd apps/orchestrator && bun test src/orchestrator-api.test.ts --test-name-pattern "GET /api"
```

Expected: FAIL — routes return 404 (not found by Hono).

- [ ] **Step 4: Refactor `OrchestratorAPI` to use Hono**

Replace the entire `fetch` method and add Hono setup. Add the new deps to `OrchestratorDeps`. The full updated relevant sections of `orchestrator-api.ts`:

At the top, add the imports:

```ts
import { Hono } from "hono";
import type { IAgentMessageStore } from "@paisti/core";
import type { SseBroadcaster } from "./services/sse-broadcaster.js";
```

Update `OrchestratorDeps`:

```ts
export interface OrchestratorDeps {
	runnerFactory: () => IAgentRunner;
	taskStore: ITaskStore;
	sessionStore: ISessionStore;
	activityService: ActivityService;
	agentMessageStore?: IAgentMessageStore;
	contextProvider?: ITaskContextProvider;
	workingDirectory?: string;
	defaultModel?: string;
	systemPrompt?: string;
	serveUiFrom?: string;
}
```

Add private fields to the class:

```ts
private readonly app: Hono;
private sseBroadcaster?: SseBroadcaster;
```

In the constructor, initialize `app` and call `setupRoutes()`:

```ts
constructor(deps: OrchestratorDeps) {
	this.deps = deps;
	this.app = new Hono();
	this.setupRoutes();
}
```

Add `setupRoutes()` as a private method (replaces the `fetch` method's if/else):

```ts
private setupRoutes(): void {
	this.app.get("/health", (c) =>
		c.json({ status: "ok", activeSessions: this.activeSessions.size })
	);

	this.app.post("/events", async (c) => {
		const body = (await c.req.json()) as InboundEvent;
		this.handleEvent(body);
		return new Response(null, { status: 202 });
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
		const isActive = [...this.activeSessions.values()].some(
			(s) => s.sessionId === sessionId
		);
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
```

Replace the existing `fetch` method body:

```ts
async fetch(request: Request): Promise<Response> {
	return this.app.fetch(request);
}
```

- [ ] **Step 5: Run all orchestrator tests**

```bash
cd apps/orchestrator && bun test src/orchestrator-api.test.ts
```

Expected: all pass (both old and new tests).

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/package.json apps/orchestrator/src/orchestrator-api.ts apps/orchestrator/src/orchestrator-api.test.ts
git commit -m "feat(orchestrator): replace manual fetch handler with Hono router; add REST API routes"
```

---

## Task 7: Wire MessageService + systemPrompt into OrchestratorAPI + main.ts

**Files:**
- Modify: `apps/orchestrator/src/orchestrator-api.ts`
- Modify: `apps/orchestrator/src/main.ts`

- [ ] **Step 1: Add `messageService` to `OrchestratorDeps` and wire in `handleTaskAssigned`**

In `OrchestratorDeps`, add:

```ts
messageService?: MessageService;
```

Add the import at the top:

```ts
import type { MessageService } from "./services/message-service.js";
```

Update `OrchestratorDeps` to add:

```ts
messageService?: MessageService;
sseBroadcaster?: SseBroadcaster;
```

Update the constructor to assign `sseBroadcaster` from deps:

```ts
constructor(deps: OrchestratorDeps) {
	this.deps = deps;
	this.sseBroadcaster = deps.sseBroadcaster;
	this.app = new Hono();
	this.setupRoutes();
}
```

In `handleTaskAssigned`, after assembling `systemPrompt` and before starting the runner:

```ts
// Store systemPrompt on the session record before runner starts
if (systemPrompt) {
	await this.deps.sessionStore.updateSession(agentSession.id, { systemPrompt });
}
```

In the runner loop, after `messageToActivities`, add:

```ts
if (this.deps.messageService) {
	await this.deps.messageService.writeMessage(agentSession.id, msg);
}
```

In the `finally` block, after removing from `activeSessions`, add:

```ts
this.deps.messageService?.closeSession(agentSession.id);
```

- [ ] **Step 2: Update `main.ts` to wire MessageService**

Full updated `main.ts`:

```ts
import { resolve } from "node:path";
import { ClaudeRunner } from "@paisti/claude-adapter";
import { ConsoleActivityWriter } from "@paisti/console-adapter";
import { OrchestratorAPI } from "./orchestrator-api.js";
import { ActivityService } from "./services/activity-service.js";
import { MessageService } from "./services/message-service.js";
import { SseBroadcaster } from "./services/sse-broadcaster.js";
import { SqliteAgentMessageWriter } from "./stores/sqlite-agent-message-writer.js";
import { SqliteSessionStore } from "./stores/sqlite-session-store.js";
import { SqliteTaskStore } from "./stores/sqlite-task-store.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "paisti.db";

const taskStore = new SqliteTaskStore(DB_PATH);
const sessionStore = new SqliteSessionStore(DB_PATH);
const agentMessageWriter = new SqliteAgentMessageWriter(DB_PATH);
const sseBroadcaster = new SseBroadcaster();
const activityService = new ActivityService([new ConsoleActivityWriter()]);
const messageService = new MessageService([agentMessageWriter, sseBroadcaster]);

const serveUiFrom = process.env.SERVE_UI
	? resolve(import.meta.dir, "../../web/dist")
	: undefined;

const orchestrator = new OrchestratorAPI({
	runnerFactory: () => new ClaudeRunner(),
	taskStore,
	sessionStore,
	agentMessageStore: agentMessageWriter,
	activityService,
	messageService,
	sseBroadcaster,
	workingDirectory: process.cwd(),
	serveUiFrom,
	...(process.env.MODEL ? { defaultModel: process.env.MODEL } : {}),
	...(process.env.SYSTEM_PROMPT ? { systemPrompt: process.env.SYSTEM_PROMPT } : {})
});

await orchestrator.start(PORT);

const shutdown = async () => {
	await orchestrator.stop();
	process.exit(0);
};
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
```

- [ ] **Step 3: Run all orchestrator tests**

```bash
cd apps/orchestrator && bun test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/orchestrator/src/orchestrator-api.ts apps/orchestrator/src/main.ts
git commit -m "feat(orchestrator): wire MessageService and systemPrompt into OrchestratorAPI"
```

---

## Task 8: Static file serving (SERVE_UI)

**Files:**
- Modify: `apps/orchestrator/src/orchestrator-api.ts`

The `serveUiFrom` dep is already threaded through. Now add static file serving to the Hono router when it is set.

- [ ] **Step 1: Add static serving to `setupRoutes()`**

Add this import at the top of `orchestrator-api.ts`:

```ts
import { serveStatic } from "hono/bun";
```

At the **end** of `setupRoutes()`, after all other routes:

```ts
if (this.deps.serveUiFrom) {
	const root = this.deps.serveUiFrom;
	// Serve static assets
	this.app.use(
		"/*",
		serveStatic({ root })
	);
	// SPA fallback — serve index.html for any unmatched route
	this.app.get("/*", serveStatic({ path: `${root}/index.html` }));
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/orchestrator && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Manual smoke test (optional)**

```bash
cd apps/orchestrator && bun run start
# In another terminal:
curl http://localhost:3000/health
curl http://localhost:3000/api/tasks
```

Expected: `{"status":"ok","activeSessions":0}` and `[]`.

- [ ] **Step 4: Commit**

```bash
git add apps/orchestrator/src/orchestrator-api.ts
git commit -m "feat(orchestrator): serve static UI files when SERVE_UI is set"
```

---

## Task 9: apps/web scaffold

**Files:** All new in `apps/web/`

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@paisti/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tanstack/react-query": "5.56.2",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "react-router-dom": "6.26.2"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.0.0",
    "@types/react": "18.3.12",
    "@types/react-dom": "18.3.1",
    "@vitejs/plugin-react": "4.3.1",
    "tailwindcss": "4.0.0",
    "typescript": "5.5.4",
    "vite": "5.4.6"
  }
}
```

- [ ] **Step 2: Create `apps/web/vite.config.ts`**

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		proxy: {
			"/api": "http://localhost:3000",
			"/events": "http://localhost:3000"
		}
	}
});
```

- [ ] **Step 3: Create `apps/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `apps/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Paisti</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `apps/web/src/index.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 6: Create `apps/web/src/main.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: 1 } }
});

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<App />
		</QueryClientProvider>
	</StrictMode>
);
```

- [ ] **Step 7: Create `apps/web/src/App.tsx`** (placeholder — filled in Task 12)

```tsx
export function App() {
	return <div className="p-4 text-gray-700">Loading…</div>;
}
```

- [ ] **Step 8: Install dependencies and verify dev server starts**

```bash
cd apps/web && bun install
bun run dev
```

Expected: Vite dev server starts on `http://localhost:5173`, page loads without errors.

- [ ] **Step 9: Commit**

```bash
git add apps/web/
git commit -m "feat(web): scaffold Vite + React app"
```

---

## Task 10: API client + types

**Files:**
- Create: `apps/web/src/api/types.ts`
- Create: `apps/web/src/api/client.ts`

- [ ] **Step 1: Create `apps/web/src/api/types.ts`**

These are frontend-local mirrors of core types — no shared package dependency.

```ts
export interface Task {
	id: string;
	title: string;
	status: "open" | "active" | "completed" | "failed" | "stopped";
	createdAt: string;
	updatedAt: string;
}

export interface Session {
	id: string;
	taskId: string;
	status: "active" | "completed" | "failed" | "stopped";
	systemPrompt?: string;
	providerSessionId?: string;
	startedAt: string;
	completedAt?: string;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export type AssistantPart =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool_call"; callId: string; toolName: string; input: unknown };

export type AgentMessage =
	| { type: "system"; provider: string; sessionId: string; model: string; tools: string[] }
	| { type: "user"; provider: string; sessionId: string; content: string }
	| {
			type: "assistant";
			provider: string;
			sessionId: string;
			parts: AssistantPart[];
			usage?: TokenUsage;
	  }
	| {
			type: "tool_use";
			provider: string;
			sessionId: string;
			callId: string;
			toolName: string;
			input: unknown;
	  }
	| {
			type: "tool_result";
			provider: string;
			sessionId: string;
			callId: string;
			toolName?: string;
			output: string;
			isError: boolean;
	  }
	| {
			type: "result";
			provider: string;
			sessionId: string;
			finishReason: string;
			durationMs: number;
			summary?: string;
			usage?: TokenUsage;
	  };

export interface StoredAgentMessage {
	sessionId: string;
	sequence: number;
	message: AgentMessage;
}

export interface TaskAssignedEvent {
	type: "task_assigned";
	taskRef: { platform: string; id: string };
	title: string;
	initialMessage: string;
}
```

- [ ] **Step 2: Create `apps/web/src/api/client.ts`**

```ts
import type { Session, StoredAgentMessage, Task, TaskAssignedEvent } from "./types.js";

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`);
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${path}`);
	return res.json() as Promise<T>;
}

export const client = {
	getTasks: () => get<Task[]>("/tasks"),

	getTask: (id: string) => get<{ task: Task; sessions: Session[] }>(`/tasks/${id}`),

	getSessionMessages: (id: string) => get<StoredAgentMessage[]>(`/sessions/${id}/messages`),

	async submitTask(event: TaskAssignedEvent): Promise<void> {
		const res = await fetch("/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(event)
		});
		if (!res.ok) throw new Error(`Failed to submit task: HTTP ${res.status}`);
	}
};
```

- [ ] **Step 3: Typecheck**

```bash
cd apps/web && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/
git commit -m "feat(web): add API client and types"
```

---

## Task 11: TaskList + layout

**Files:**
- Create: `apps/web/src/hooks/useTasks.ts`
- Create: `apps/web/src/components/TaskList.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Create `apps/web/src/hooks/useTasks.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import { client } from "../api/client.js";

export function useTasks() {
	return useQuery({
		queryKey: ["tasks"],
		queryFn: () => client.getTasks(),
		refetchInterval: 3000
	});
}
```

- [ ] **Step 2: Create `apps/web/src/components/TaskList.tsx`**

```tsx
import { useNavigate, useParams } from "react-router-dom";
import { useTasks } from "../hooks/useTasks.js";
import type { Task } from "../api/types.js";

const STATUS_COLORS: Record<Task["status"], string> = {
	open: "bg-gray-200 text-gray-700",
	active: "bg-blue-200 text-blue-800",
	completed: "bg-green-200 text-green-800",
	failed: "bg-red-200 text-red-800",
	stopped: "bg-yellow-200 text-yellow-800"
};

interface Props {
	onNewTask: () => void;
}

export function TaskList({ onNewTask }: Props) {
	const { data: tasks = [], isLoading } = useTasks();
	const navigate = useNavigate();
	const { id: selectedId } = useParams<{ id: string }>();

	return (
		<div className="flex flex-col h-full">
			<div className="p-3 border-b flex items-center justify-between">
				<span className="font-semibold text-sm">Tasks</span>
				<button
					onClick={onNewTask}
					className="text-xs bg-black text-white px-2 py-1 rounded hover:bg-gray-800"
				>
					+ New
				</button>
			</div>
			{isLoading ? (
				<div className="p-3 text-xs text-gray-400">Loading…</div>
			) : (
				<ul className="overflow-y-auto flex-1">
					{tasks.map((task) => (
						<li key={task.id}>
							<button
								onClick={() => navigate(`/tasks/${task.id}`)}
								className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b ${
									selectedId === task.id ? "bg-gray-100" : ""
								}`}
							>
								<div className="truncate font-medium">{task.title}</div>
								<span
									className={`inline-block text-xs px-1.5 py-0.5 rounded mt-1 ${STATUS_COLORS[task.status]}`}
								>
									{task.status}
								</span>
							</button>
						</li>
					))}
					{tasks.length === 0 && (
						<li className="p-3 text-xs text-gray-400">No tasks yet.</li>
					)}
				</ul>
			)}
		</div>
	);
}
```

- [ ] **Step 3: Rewrite `apps/web/src/App.tsx`** with layout and routing (no modal yet — placeholder for NewTaskForm)

```tsx
import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { TaskList } from "./components/TaskList.js";
import { TaskDetail } from "./components/TaskDetail.js";

export function App() {
	const [showNewTask, setShowNewTask] = useState(false);

	return (
		<BrowserRouter>
			<div className="flex h-screen bg-white text-gray-900 font-sans">
				<aside className="w-64 border-r flex-shrink-0 flex flex-col">
					<TaskList onNewTask={() => setShowNewTask(true)} />
				</aside>
				<main className="flex-1 overflow-hidden">
					<Routes>
						<Route path="/tasks/:id" element={<TaskDetail />} />
						<Route
							path="/"
							element={
								<div className="flex items-center justify-center h-full text-sm text-gray-400">
									Select a task or create a new one
								</div>
							}
						/>
						<Route path="*" element={<Navigate to="/" replace />} />
					</Routes>
				</main>
			</div>
		</BrowserRouter>
	);
}
```

(`TaskDetail` is a placeholder stub — created in Task 12.)

- [ ] **Step 4: Create stub `apps/web/src/components/TaskDetail.tsx`** (real implementation in Task 12)

```tsx
export function TaskDetail() {
	return <div className="p-4 text-sm text-gray-500">Task detail placeholder</div>;
}
```

- [ ] **Step 5: Typecheck**

```bash
cd apps/web && bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/
git commit -m "feat(web): add TaskList, layout, and routing"
```

---

## Task 12: TaskDetail + ChatView + MessageItem

**Files:**
- Create: `apps/web/src/hooks/useSession.ts`
- Create: `apps/web/src/components/MessageItem.tsx`
- Create: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/TaskDetail.tsx`

- [ ] **Step 1: Create `apps/web/src/hooks/useSession.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import { client } from "../api/client.js";

export function useTaskDetail(taskId: string) {
	return useQuery({
		queryKey: ["task", taskId],
		queryFn: () => client.getTask(taskId),
		refetchInterval: (q) =>
			q.state.data?.sessions.some((s) => s.status === "active") ? 2000 : false
	});
}

export function useSessionMessages(sessionId: string) {
	return useQuery({
		queryKey: ["session", sessionId, "messages"],
		queryFn: () => client.getSessionMessages(sessionId),
		enabled: !!sessionId
	});
}
```

- [ ] **Step 2: Create `apps/web/src/components/MessageItem.tsx`**

```tsx
import type { AgentMessage, AssistantPart, StoredAgentMessage } from "../api/types.js";

function AssistantParts({ parts }: { parts: AssistantPart[] }) {
	return (
		<div className="flex flex-col gap-1">
			{parts.map((p, i) => {
				if (p.type === "text")
					return (
						<div key={i} className="bg-gray-100 rounded-lg px-4 py-3 max-w-3xl">
							<pre className="whitespace-pre-wrap text-sm font-sans">{p.text}</pre>
						</div>
					);
				if (p.type === "thinking")
					return (
						<details key={i} className="text-xs text-gray-400 pl-1">
							<summary className="cursor-pointer">Thinking…</summary>
							<pre className="whitespace-pre-wrap mt-1 pl-2">{p.text}</pre>
						</details>
					);
				return null;
			})}
		</div>
	);
}

function renderMessage(msg: AgentMessage) {
	switch (msg.type) {
		case "assistant":
			return (
				<div className="flex flex-col gap-1">
					<AssistantParts parts={msg.parts} />
					{msg.usage && (
						<div className="text-xs text-gray-400 pl-1">
							{msg.usage.input}↑ {msg.usage.output}↓ tokens
						</div>
					)}
				</div>
			);

		case "tool_use":
			return (
				<details className="bg-blue-50 border border-blue-200 rounded px-3 py-2 text-sm">
					<summary className="cursor-pointer font-mono text-xs text-blue-700">
						{msg.toolName}
					</summary>
					<pre className="mt-2 text-xs overflow-x-auto text-gray-700">
						{JSON.stringify(msg.input, null, 2)}
					</pre>
				</details>
			);

		case "tool_result":
			return (
				<details
					className={`rounded px-3 py-2 text-sm border ${
						msg.isError
							? "bg-red-50 border-red-200"
							: "bg-green-50 border-green-200"
					}`}
				>
					<summary className="cursor-pointer font-mono text-xs">
						{msg.toolName ?? "result"}{msg.isError ? " (error)" : ""}
					</summary>
					<pre className="mt-2 text-xs overflow-x-auto text-gray-700">{msg.output}</pre>
				</details>
			);

		case "result":
			return (
				<div className="bg-gray-900 text-white rounded-lg px-4 py-3 text-sm">
					<div className="font-semibold capitalize">{msg.finishReason}</div>
					{msg.summary && <p className="mt-1 text-gray-300">{msg.summary}</p>}
					<div className="mt-2 text-xs text-gray-500">
						{msg.durationMs}ms
						{msg.usage && ` · ${msg.usage.input}↑ ${msg.usage.output}↓`}
					</div>
				</div>
			);

		case "system":
			return (
				<div className="text-xs text-gray-400 py-1">
					Session {msg.sessionId} · {msg.model}
				</div>
			);

		case "user":
			return (
				<div className="flex justify-end">
					<div className="bg-black text-white rounded-lg px-4 py-3 max-w-3xl text-sm">
						{msg.content}
					</div>
				</div>
			);

		default:
			return null;
	}
}

export function MessageItem({ stored }: { stored: StoredAgentMessage }) {
	const rendered = renderMessage(stored.message);
	if (!rendered) return null;
	return <div className="py-1">{rendered}</div>;
}
```

- [ ] **Step 3: Create `apps/web/src/components/ChatView.tsx`**

```tsx
import { useEffect, useRef } from "react";
import type { Session, StoredAgentMessage } from "../api/types.js";
import { useSessionMessages } from "../hooks/useSession.js";
import { useSessionStream } from "../hooks/useSessionStream.js";
import { MessageItem } from "./MessageItem.js";
import { useQueryClient } from "@tanstack/react-query";

interface Props {
	session: Session;
}

export function ChatView({ session }: Props) {
	const queryClient = useQueryClient();
	const { data: stored = [] } = useSessionMessages(session.id);
	const bottomRef = useRef<HTMLDivElement>(null);

	// Stream live messages — only when session is active
	useSessionStream(
		session.status === "active" ? session.id : null,
		() => {
			void queryClient.invalidateQueries({ queryKey: ["session", session.id, "messages"] });
		}
	);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [stored.length]);

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{session.systemPrompt && (
				<details className="border-b bg-yellow-50 px-4 py-2 text-xs">
					<summary className="cursor-pointer font-semibold text-yellow-800">
						System prompt
					</summary>
					<pre className="mt-2 whitespace-pre-wrap text-gray-700">
						{session.systemPrompt}
					</pre>
				</details>
			)}
			<div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2">
				{stored.map((s) => (
					<MessageItem key={s.sequence} stored={s} />
				))}
				<div ref={bottomRef} />
			</div>
		</div>
	);
}
```

- [ ] **Step 4: Rewrite `apps/web/src/components/TaskDetail.tsx`**

```tsx
import { useState } from "react";
import { useParams } from "react-router-dom";
import type { Session } from "../api/types.js";
import { useTaskDetail } from "../hooks/useSession.js";
import { ChatView } from "./ChatView.js";

const STATUS_DOT: Record<Session["status"], string> = {
	active: "bg-blue-500 animate-pulse",
	completed: "bg-green-500",
	failed: "bg-red-500",
	stopped: "bg-yellow-500"
};

export function TaskDetail() {
	const { id } = useParams<{ id: string }>();
	const { data, isLoading } = useTaskDetail(id!);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

	if (isLoading) return <div className="p-4 text-sm text-gray-400">Loading…</div>;
	if (!data) return <div className="p-4 text-sm text-red-500">Task not found.</div>;

	const { task, sessions } = data;
	const activeSession = sessions.find((s) => s.status === "active");
	const currentSession: Session | undefined =
		sessions.find((s) => s.id === selectedSessionId) ?? activeSession ?? sessions[sessions.length - 1];

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="border-b px-4 py-3 flex-shrink-0">
				<div className="font-semibold truncate">{task.title}</div>
				{/* Session tabs */}
				{sessions.length > 0 && (
					<div className="flex gap-2 mt-2 overflow-x-auto">
						{sessions.map((s, i) => (
							<button
								key={s.id}
								onClick={() => setSelectedSessionId(s.id)}
								className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded border flex-shrink-0 ${
									currentSession?.id === s.id
										? "bg-black text-white border-black"
										: "border-gray-300 hover:bg-gray-50"
								}`}
							>
								<span
									className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[s.status]}`}
								/>
								Session {i + 1}
							</button>
						))}
					</div>
				)}
			</div>
			{/* Chat */}
			{currentSession ? (
				<div className="flex-1 overflow-hidden">
					<ChatView session={currentSession} />
				</div>
			) : (
				<div className="flex items-center justify-center flex-1 text-sm text-gray-400">
					No sessions yet
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 5: Typecheck**

```bash
cd apps/web && bun run typecheck
```

Expected: no errors (some may need `useSessionStream` stub — create it in Task 13).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/
git commit -m "feat(web): add TaskDetail, ChatView, and MessageItem"
```

---

## Task 13: NewTaskForm + useSessionStream

**Files:**
- Create: `apps/web/src/hooks/useSessionStream.ts`
- Create: `apps/web/src/components/NewTaskForm.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Create `apps/web/src/hooks/useSessionStream.ts`**

Use a ref for `onMessage` so the `EventSource` is only recreated when `sessionId` changes, not on every render.

```ts
import { useEffect, useRef } from "react";

export function useSessionStream(
	sessionId: string | null,
	onMessage: () => void
): void {
	const onMessageRef = useRef(onMessage);
	useEffect(() => {
		onMessageRef.current = onMessage;
	});

	useEffect(() => {
		if (!sessionId) return;

		const es = new EventSource(`/api/sessions/${sessionId}/stream`);

		es.onmessage = () => {
			onMessageRef.current();
		};

		es.addEventListener("close", () => {
			es.close();
			onMessageRef.current(); // final invalidation after session closes
		});

		es.onerror = () => {
			es.close();
		};

		return () => {
			es.close();
		};
	}, [sessionId]); // intentionally excludes onMessage — stabilised via ref
}
```

- [ ] **Step 2: Create `apps/web/src/components/NewTaskForm.tsx`**

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { client } from "../api/client.js";
import { useQueryClient } from "@tanstack/react-query";

interface Props {
	onClose: () => void;
}

export function NewTaskForm({ onClose }: Props) {
	const [title, setTitle] = useState("");
	const [message, setMessage] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!title.trim() || !message.trim()) return;
		setSubmitting(true);
		const taskId = crypto.randomUUID();
		try {
			await client.submitTask({
				type: "task_assigned",
				taskRef: { platform: "cli", id: taskId },
				title: title.trim(),
				initialMessage: message.trim()
			});
			await queryClient.invalidateQueries({ queryKey: ["tasks"] });
			navigate(`/tasks/${taskId}`);
			onClose();
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div
			className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
			onClick={(e) => e.target === e.currentTarget && onClose()}
		>
			<div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg mx-4">
				<h2 className="font-semibold text-lg mb-4">New Task</h2>
				<form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
					<div>
						<label className="block text-sm font-medium mb-1">Title</label>
						<input
							className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Fix the auth bug"
							autoFocus
						/>
					</div>
					<div>
						<label className="block text-sm font-medium mb-1">Initial message</label>
						<textarea
							className="w-full border rounded px-3 py-2 text-sm h-28 resize-none focus:outline-none focus:ring-2 focus:ring-black"
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							placeholder="Describe what the agent should do…"
						/>
					</div>
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={onClose}
							className="px-4 py-2 text-sm rounded border hover:bg-gray-50"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={submitting || !title.trim() || !message.trim()}
							className="px-4 py-2 text-sm rounded bg-black text-white hover:bg-gray-800 disabled:opacity-50"
						>
							{submitting ? "Submitting…" : "Create"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
```

- [ ] **Step 3: Wire `NewTaskForm` into `App.tsx`**

Replace the existing `App.tsx` with:

```tsx
import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { NewTaskForm } from "./components/NewTaskForm.js";
import { TaskDetail } from "./components/TaskDetail.js";
import { TaskList } from "./components/TaskList.js";

export function App() {
	const [showNewTask, setShowNewTask] = useState(false);

	return (
		<BrowserRouter>
			<div className="flex h-screen bg-white text-gray-900 font-sans">
				<aside className="w-64 border-r flex-shrink-0 flex flex-col">
					<TaskList onNewTask={() => setShowNewTask(true)} />
				</aside>
				<main className="flex-1 overflow-hidden">
					<Routes>
						<Route path="/tasks/:id" element={<TaskDetail />} />
						<Route
							path="/"
							element={
								<div className="flex items-center justify-center h-full text-sm text-gray-400">
									Select a task or create a new one
								</div>
							}
						/>
						<Route path="*" element={<Navigate to="/" replace />} />
					</Routes>
				</main>
			</div>
			{showNewTask && <NewTaskForm onClose={() => setShowNewTask(false)} />}
		</BrowserRouter>
	);
}
```

- [ ] **Step 4: Typecheck**

```bash
cd apps/web && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Full test suite**

```bash
cd apps/orchestrator && bun test
```

Expected: all pass.

- [ ] **Step 6: Build the web app**

```bash
cd apps/web && bun run build
```

Expected: `dist/` produced with no errors.

- [ ] **Step 7: Smoke test end-to-end**

In one terminal:

```bash
cd apps/orchestrator && SERVE_UI=true bun run start
```

Open `http://localhost:3000` in a browser. Verify:
- The UI loads
- "New task" button opens the modal
- Submitting a task creates it in the sidebar and navigates to the detail view

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/ apps/web/
git commit -m "feat(web): add NewTaskForm, useSessionStream, and complete app wiring"
```
