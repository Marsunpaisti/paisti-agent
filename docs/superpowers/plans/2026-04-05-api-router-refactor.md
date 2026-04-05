# API Router Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract business logic from `OrchestratorAPI` into `TaskService` and `RunnerService`, and split HTTP routes into per-entity Hono sub-apps.

**Architecture:** `TaskService` owns task resolution (resolveOrCreate, resolve). `RunnerService` owns the runner/session lifecycle, active session map, and event dispatching. Three Hono router factory functions (`tasksRouter`, `sessionsRouter`, `eventsRouter`) return sub-apps mounted via `app.route()`. `OrchestratorAPI` shrinks to construction + HTTP wiring only.

**Tech Stack:** TypeScript, Bun, Hono

---

## File Map

**Create:**
- `apps/orchestrator/src/services/task-service.ts` — task resolution (resolveOrCreate, resolve)
- `apps/orchestrator/src/services/runner-service.ts` — activeSessions map, run loop, event handlers, flush/stop
- `apps/orchestrator/src/routers/tasks-router.ts` — `GET /api/tasks/**`
- `apps/orchestrator/src/routers/sessions-router.ts` — `GET /api/sessions/**`, `ISseRegistrar` type
- `apps/orchestrator/src/routers/events-router.ts` — `POST /api/events`

**Modify:**
- `apps/orchestrator/src/orchestrator-api.ts` — gut business logic; wire up services and routers
- `apps/orchestrator/src/orchestrator-api.test.ts` — update three `/events` paths to `/api/events`
- `apps/web/src/api/client.ts` — update `fetch("/events", ...)` to `fetch("/api/events", ...)`; remove stale comment
- `apps/web/vite.config.ts` — rename proxy key `"/events"` → `"/api/events"`

---

### Task 1: Create TaskService

**Files:**
- Create: `apps/orchestrator/src/services/task-service.ts`

- [ ] **Step 1: Create the file**

```typescript
// apps/orchestrator/src/services/task-service.ts
import type { ITaskStore, OrchestrationTask } from "@paisti/core";
import type { TaskRef } from "../types/inbound-event.js";

const CLI_PLATFORM = "cli";

export class TaskService {
	constructor(private readonly taskStore: ITaskStore) {}

	/**
	 * Resolves a TaskRef to an OrchestrationTask in three steps:
	 *  1. getTask(id)                → found: use it (CLI events)
	 *  2. findTaskByBinding(...)     → found: use it (known platform events)
	 *  3. createTask + addBinding    → new task (first-seen platform events)
	 */
	async resolveOrCreate(taskRef: TaskRef, title: string): Promise<OrchestrationTask> {
		if (taskRef.platform === CLI_PLATFORM) {
			const task = await this.taskStore.getTask(taskRef.id);
			if (task) return task;
		}

		const byBinding = await this.taskStore.findTaskByBinding(taskRef.platform, taskRef.id);
		if (byBinding) return byBinding;

		const task = await this.taskStore.createTask({
			title,
			...(taskRef.platform === CLI_PLATFORM ? { id: taskRef.id } : {})
		});
		if (taskRef.platform !== CLI_PLATFORM) {
			await this.taskStore.addBinding({
				taskId: task.id,
				platform: taskRef.platform,
				externalId: taskRef.id,
				role: "source"
			});
		}
		return task;
	}

	async resolve(taskRef: TaskRef): Promise<OrchestrationTask | null> {
		if (taskRef.platform === CLI_PLATFORM) {
			return this.taskStore.getTask(taskRef.id);
		}
		return this.taskStore.findTaskByBinding(taskRef.platform, taskRef.id);
	}
}
```

- [ ] **Step 2: Verify tests still pass**

```bash
cd apps/orchestrator && bun test
```

Expected: all tests pass (file is not yet wired in).

- [ ] **Step 3: Commit**

```bash
git add apps/orchestrator/src/services/task-service.ts
git commit -m "feat(orchestrator): add TaskService for task resolution"
```

---

### Task 2: Create RunnerService

**Files:**
- Create: `apps/orchestrator/src/services/runner-service.ts`

Note: The spec listed `RunnerServiceDeps` without `taskStore`, but `handleTaskAssigned` and `handleUserComment` need it directly for `updateTask` and `addTaskMessage`. It is included here.

- [ ] **Step 1: Create the file**

```typescript
// apps/orchestrator/src/services/runner-service.ts
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
import type { ActivityService } from "./activity-service.js";
import type { TaskService } from "./task-service.js";
import type { InboundEvent, TaskAssignedEvent, TaskRef } from "../types/inbound-event.js";

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
```

- [ ] **Step 2: Verify tests still pass**

```bash
cd apps/orchestrator && bun test
```

Expected: all tests pass (file is not yet wired in).

- [ ] **Step 3: Commit**

```bash
git add apps/orchestrator/src/services/runner-service.ts
git commit -m "feat(orchestrator): add RunnerService for session lifecycle and event handling"
```

---

### Task 3: Create the three Hono routers

**Files:**
- Create: `apps/orchestrator/src/routers/tasks-router.ts`
- Create: `apps/orchestrator/src/routers/sessions-router.ts`
- Create: `apps/orchestrator/src/routers/events-router.ts`

- [ ] **Step 1: Create tasks-router.ts**

```typescript
// apps/orchestrator/src/routers/tasks-router.ts
import type { ISessionStore, ITaskStore } from "@paisti/core";
import { Hono } from "hono";

export function tasksRouter(taskStore: ITaskStore, sessionStore: ISessionStore): Hono {
	const router = new Hono();

	router.get("/", async (c) => {
		const tasks = await taskStore.listTasks();
		return c.json(tasks);
	});

	router.get("/:id", async (c) => {
		const id = c.req.param("id");
		const task = await taskStore.getTask(id);
		if (!task) return c.json({ error: "Not found" }, 404);
		const sessions = await sessionStore.listSessions(id);
		return c.json({ task, sessions });
	});

	router.get("/:id/messages", async (c) => {
		const id = c.req.param("id");
		const messages = await taskStore.getTaskMessages(id);
		return c.json(messages);
	});

	return router;
}
```

- [ ] **Step 2: Create sessions-router.ts**

`ISseRegistrar` moves here from `orchestrator-api.ts` — it is only consumed by this router.

```typescript
// apps/orchestrator/src/routers/sessions-router.ts
import type { IAgentMessageReader } from "@paisti/core";
import { Hono } from "hono";
import type { RunnerService } from "../services/runner-service.js";

export interface ISseRegistrar {
	register(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array>): void;
	unregister(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array>): void;
}

export function sessionsRouter(
	agentMessageStore: IAgentMessageReader | undefined,
	sseBroadcaster: ISseRegistrar | undefined,
	runnerService: RunnerService
): Hono {
	const router = new Hono();

	router.get("/:id/messages", async (c) => {
		const sessionId = c.req.param("id");
		if (!agentMessageStore) return c.json([]);
		const messages = await agentMessageStore.getMessages(sessionId);
		return c.json(messages);
	});

	router.get("/:id/stream", (c) => {
		const sessionId = c.req.param("id");
		if (!runnerService.isSessionActive(sessionId)) {
			return c.json({ error: "Session not active" }, 404);
		}

		let ctrl: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				ctrl = controller;
				sseBroadcaster?.register(sessionId, controller);
			},
			cancel: () => {
				sseBroadcaster?.unregister(sessionId, ctrl);
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

	return router;
}
```

- [ ] **Step 3: Create events-router.ts**

```typescript
// apps/orchestrator/src/routers/events-router.ts
import { Hono } from "hono";
import type { RunnerService } from "../services/runner-service.js";
import type { TaskService } from "../services/task-service.js";
import type { InboundEvent } from "../types/inbound-event.js";

export function eventsRouter(taskService: TaskService, runnerService: RunnerService): Hono {
	const router = new Hono();
	const validTypes = new Set(["task_assigned", "user_comment", "stop_requested"]);

	router.post("/", async (c) => {
		let body: InboundEvent;
		try {
			body = (await c.req.json()) as InboundEvent;
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}

		if (!body || typeof body !== "object" || !validTypes.has(body.type)) {
			return c.json({ error: "Unknown event type" }, 400);
		}

		if (body.type === "task_assigned") {
			// Eagerly create task so GET /api/tasks/:id resolves immediately after the 202
			const task = await taskService.resolveOrCreate(body.taskRef, body.title);
			runnerService.handleEvent(body);
			return c.json({ taskId: task.id }, 202);
		}

		runnerService.handleEvent(body);
		return c.body(null, 202);
	});

	return router;
}
```

- [ ] **Step 4: Verify tests still pass**

```bash
cd apps/orchestrator && bun test
```

Expected: all tests pass (routers are not yet wired in).

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/routers/
git commit -m "feat(orchestrator): add tasks, sessions, and events Hono routers"
```

---

### Task 4: Wire up OrchestratorAPI

Replace all business logic in `orchestrator-api.ts` with construction of services + router mounting. The public interface (`runTask`, `handleEvent`, `flush`, `fetch`, `start`, `stop`) and `OrchestratorDeps` type are unchanged.

**Files:**
- Modify: `apps/orchestrator/src/orchestrator-api.ts`

- [ ] **Step 1: Replace the file contents**

```typescript
// apps/orchestrator/src/orchestrator-api.ts
import type {
	IAgentMessageReader,
	IAgentRunner,
	ISessionMessageWriter,
	ISessionStore,
	ITaskContextProvider,
	ITaskStore
} from "@paisti/core";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { eventsRouter } from "./routers/events-router.js";
import { sessionsRouter, type ISseRegistrar } from "./routers/sessions-router.js";
import { tasksRouter } from "./routers/tasks-router.js";
import type { ActivityService } from "./services/activity-service.js";
import { RunnerService } from "./services/runner-service.js";
import { TaskService } from "./services/task-service.js";
import type { InboundEvent, TaskAssignedEvent } from "./types/inbound-event.js";

export interface OrchestratorDeps {
	/** Called once per task to produce an isolated runner instance. */
	runnerFactory: () => IAgentRunner;
	taskStore: ITaskStore;
	sessionStore: ISessionStore;
	activityService: ActivityService;
	agentMessageStore?: IAgentMessageReader;
	messageService?: ISessionMessageWriter;
	sseBroadcaster?: ISseRegistrar;
	contextProvider?: ITaskContextProvider;
	/** Defaults to process.cwd(). Per-task worktrees are added in Phase 2. */
	workingDirectory?: string;
	defaultModel?: string;
	systemPrompt?: string;
	serveUiFrom?: string;
}

export class OrchestratorAPI {
	private readonly runnerService: RunnerService;
	private readonly app: Hono;
	private server: ReturnType<typeof Bun.serve> | null = null;

	constructor(deps: OrchestratorDeps) {
		const taskService = new TaskService(deps.taskStore);
		this.runnerService = new RunnerService({
			taskService,
			taskStore: deps.taskStore,
			runnerFactory: deps.runnerFactory,
			sessionStore: deps.sessionStore,
			activityService: deps.activityService,
			messageService: deps.messageService,
			contextProvider: deps.contextProvider,
			workingDirectory: deps.workingDirectory,
			defaultModel: deps.defaultModel,
			systemPrompt: deps.systemPrompt
		});

		this.app = new Hono();
		this.app.get("/health", (c) =>
			c.json({ status: "ok", activeSessions: this.runnerService.activeSessionCount })
		);
		this.app.route("/api/tasks", tasksRouter(deps.taskStore, deps.sessionStore));
		this.app.route(
			"/api/sessions",
			sessionsRouter(deps.agentMessageStore, deps.sseBroadcaster, this.runnerService)
		);
		this.app.route("/api/events", eventsRouter(taskService, this.runnerService));

		if (deps.serveUiFrom) {
			const root = deps.serveUiFrom;
			this.app.use("/*", serveStatic({ root }));
			this.app.get("/*", serveStatic({ root, path: "index.html" }));
		}
	}

	/**
	 * Awaitable entry point for in-process use (CLI, tests).
	 * Runs the full task lifecycle and resolves when the agent session finishes.
	 * Does NOT require the HTTP server to be running.
	 */
	async runTask(event: TaskAssignedEvent): Promise<void> {
		return this.runnerService.runTask(event);
	}

	/**
	 * Receive an event from any source (webhook adapter, CLI, test harness).
	 * Non-blocking — dispatches async handling and returns immediately.
	 */
	handleEvent(event: InboundEvent): void {
		this.runnerService.handleEvent(event);
	}

	/** Wait for all in-flight fire-and-forget events to settle. */
	async flush(): Promise<void> {
		return this.runnerService.flush();
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
		await this.runnerService.stop();
		if (this.server) {
			this.server.stop(true);
			this.server = null;
		}
	}
}
```

- [ ] **Step 2: Proceed directly to Task 5**

The route is now mounted at `/api/events`, so the three `/events` tests in `orchestrator-api.test.ts` will fail until Task 5 updates them. Do not run tests or commit yet — complete Task 5 first, then return here to verify and commit.

---

### Task 5: Rename /events → /api/events across all callers

**Files:**
- Modify: `apps/orchestrator/src/orchestrator-api.test.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/vite.config.ts`

- [ ] **Step 1: Update orchestrator-api.test.ts — three occurrences**

Find all three places that reference `/events` and change them to `/api/events`:

Line 757 — change:
```typescript
new Request("http://localhost/events", {
```
to:
```typescript
new Request("http://localhost/api/events", {
```

Line 768 — change:
```typescript
new Request("http://localhost/events", {
```
to:
```typescript
new Request("http://localhost/api/events", {
```

Line 780 — change:
```typescript
new Request("http://localhost/events", {
```
to:
```typescript
new Request("http://localhost/api/events", {
```

Also update the describe block label on line 754:
```typescript
describe("fetch — POST /api/events validation", () => {
```

- [ ] **Step 2: Update web client**

In `apps/web/src/api/client.ts`, replace the `submitTask` method:

```typescript
	async submitTask(event: TaskAssignedEvent): Promise<string> {
		const res = await fetch("/api/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(event)
		});
		if (!res.ok) throw new Error(`Failed to submit task: HTTP ${res.status}`);
		const { taskId } = (await res.json()) as { taskId: string };
		return taskId;
	}
```

(Remove the comment on line 18 that justified the old path.)

- [ ] **Step 3: Update vite dev proxy**

In `apps/web/vite.config.ts`, update the proxy config:

```typescript
		proxy: {
			"/api": "http://localhost:3000"
		}
```

(The `/events` entry is removed since `/api/events` is now covered by the existing `/api` proxy rule.)

- [ ] **Step 4: Run the full test suite**

```bash
cd apps/orchestrator && bun test
```

Expected: all tests pass.

- [ ] **Step 5: Run typecheck**

```bash
cd apps/orchestrator && bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/orchestrator-api.ts \
        apps/orchestrator/src/orchestrator-api.test.ts \
        apps/web/src/api/client.ts \
        apps/web/vite.config.ts
git commit -m "refactor(orchestrator): extract TaskService and RunnerService; split routes into per-entity Hono routers; rename /events to /api/events"
```
