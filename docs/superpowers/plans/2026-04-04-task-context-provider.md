# ITaskContextProvider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble task context (bindings, past sessions, messages) into a string prepended to the system prompt at each new session start.

**Architecture:** A new `ITaskContextProvider` port lives in `packages/core`; `LocalTaskContextProvider` implements it in the orchestrator, reading from `ITaskStore` and `ISessionStore`. `OrchestratorAPI` accepts it as an optional dep and prepends the result to `systemPrompt` in `handleTaskAssigned`.

**Tech Stack:** TypeScript, Bun, bun:test, bun-sqlite (via existing SqliteTaskStore/SqliteSessionStore)

---

## File map

| Action | Path | Responsibility |
|---|---|---|
| Create | `packages/core/src/task-context.ts` | `ITaskContextProvider` interface |
| Modify | `packages/core/src/index.ts` | export `ITaskContextProvider` |
| Create | `apps/orchestrator/src/services/local-task-context-provider.ts` | reads local SQLite, formats markdown |
| Create | `apps/orchestrator/src/services/local-task-context-provider.test.ts` | 11 unit tests against real in-memory stores |
| Modify | `apps/orchestrator/src/orchestrator-api.ts` | add `contextProvider?` dep, update `handleTaskAssigned` |
| Modify | `apps/orchestrator/src/orchestrator-api.test.ts` | 3 new tests using `CapturingRunner` |
| Modify | `apps/orchestrator/src/main.ts` | instantiate `LocalTaskContextProvider`, pass to orchestrator |

---

### Task 1: ITaskContextProvider core port

**Files:**
- Create: `packages/core/src/task-context.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Create the interface file**

```typescript
// packages/core/src/task-context.ts
import type { OrchestrationTask } from "./orchestration-task.js";

export interface ITaskContextProvider {
  /**
   * Assemble a context string for a new session on the given task.
   * The caller already holds the task object — no need to re-fetch it.
   */
  assembleContext(task: OrchestrationTask): Promise<string>;
}
```

- [ ] **Step 2: Export from core index**

In `packages/core/src/index.ts`, add after the `orchestration-task.js` export block:

```typescript
export type { ITaskContextProvider } from "./task-context.js";
```

The full file after the change:

```typescript
export type { ActionActivity, Activity, IActivityWriter, ThoughtActivity } from "./activity.js";
export type {
	AgentMessage,
	AssistantMessage,
	AssistantPart,
	FinishReason,
	SessionResultMessage,
	SystemInfoMessage,
	TokenUsage,
	ToolResultMessage,
	ToolUseMessage,
	UserMessage
} from "./agent-messages.js";
export type {
	IAgentRunner,
	McpServerConfig,
	RunConfig
} from "./agent-runner.js";
export type {
	AgentSession,
	AgentSessionRole,
	AgentSessionStatus,
	CreateSessionInput,
	ISessionStore
} from "./agent-session.js";
export type {
	CreateBindingInput,
	CreateTaskInput,
	CreateTaskMessageInput,
	ExternalBinding,
	ExternalBindingRole,
	ITaskStore,
	OrchestrationTask,
	TaskMessage,
	TaskMessageSource,
	TaskStatus
} from "./orchestration-task.js";
export type { ITaskContextProvider } from "./task-context.js";
```

- [ ] **Step 3: Verify core package builds**

```bash
cd packages/core && bun run tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/task-context.ts packages/core/src/index.ts
git commit -m "Add ITaskContextProvider port to core"
```

---

### Task 2: LocalTaskContextProvider

**Files:**
- Create: `apps/orchestrator/src/services/local-task-context-provider.test.ts`
- Create: `apps/orchestrator/src/services/local-task-context-provider.ts`

Context: `ITaskStore.getBindings(taskId)` returns `ExternalBinding[]`. `ITaskStore.getTaskMessages(taskId)` returns `TaskMessage[]` in insertion order. `ISessionStore.listSessions(taskId)` returns `AgentSession[]` ordered by `started_at ASC, rowid ASC`. The output format is compact markdown — sections omitted when empty.

- [ ] **Step 1: Write failing tests**

```typescript
// apps/orchestrator/src/services/local-task-context-provider.test.ts
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
	sessionStore = new SqliteSessionStore();
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/orchestrator && bun test src/services/local-task-context-provider.test.ts
```

Expected: FAIL — `Cannot find module './local-task-context-provider.js'`

- [ ] **Step 3: Implement LocalTaskContextProvider**

```typescript
// apps/orchestrator/src/services/local-task-context-provider.ts
import type {
	ISessionStore,
	ITaskContextProvider,
	ITaskStore,
	OrchestrationTask
} from "@paisti/core";

export class LocalTaskContextProvider implements ITaskContextProvider {
	constructor(
		private readonly taskStore: ITaskStore,
		private readonly sessionStore: ISessionStore
	) {}

	async assembleContext(task: OrchestrationTask): Promise<string> {
		const [bindings, allSessions, messages] = await Promise.all([
			this.taskStore.getBindings(task.id),
			this.sessionStore.listSessions(task.id),
			this.taskStore.getTaskMessages(task.id)
		]);

		const pastSessions = allSessions.filter(
			(s) => s.status === "completed" || s.status === "stopped" || s.status === "failed"
		);

		const lines: string[] = ["## Task context", "", `Task: ${task.title}`];

		if (bindings.length > 0) {
			lines.push("", "External references:");
			for (const b of bindings) {
				const urlSuffix = b.externalUrl ? `: ${b.externalUrl}` : "";
				lines.push(`- ${b.platform} ${b.externalId} [${b.role}]${urlSuffix}`);
			}
		}

		if (pastSessions.length > 0) {
			lines.push("", "Past sessions:");
			for (const s of pastSessions) {
				const date = (s.completedAt ?? s.startedAt).split("T")[0];
				const rolePrefix = s.role ? `${s.role} ` : "";
				lines.push(`- ${rolePrefix}(${s.status}, ${date})`);
			}
		}

		if (messages.length > 0) {
			lines.push("", "Messages:");
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				const ts = m.timestamp.slice(0, 16);
				lines.push(`${i + 1}. [${m.author}, ${ts}] ${m.content}`);
			}
		}

		return lines.join("\n");
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/orchestrator && bun test src/services/local-task-context-provider.test.ts
```

Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/services/local-task-context-provider.ts apps/orchestrator/src/services/local-task-context-provider.test.ts
git commit -m "Add LocalTaskContextProvider with unit tests"
```

---

### Task 3: Wire contextProvider into OrchestratorAPI

**Files:**
- Modify: `apps/orchestrator/src/orchestrator-api.ts`
- Modify: `apps/orchestrator/src/orchestrator-api.test.ts`

Context: `handleTaskAssigned` currently builds `RunConfig` with an optional spread for `systemPrompt`. The new logic: if `contextProvider` is set, call `assembleContext(task)` before building the config, then join context and static systemPrompt with `"\n\n"`, omitting absent values.

- [ ] **Step 1: Write failing tests**

Add this import to the top of `apps/orchestrator/src/orchestrator-api.test.ts` (after existing imports):

```typescript
import type { ITaskContextProvider, RunConfig } from "@paisti/core";
```

Add this test double after `SpyWriter` in `orchestrator-api.test.ts`:

```typescript
class CapturingRunner implements IAgentRunner {
	capturedConfig?: RunConfig;
	readonly supportsInjection = false;
	async *run(config: RunConfig): AsyncIterable<AgentMessage> {
		this.capturedConfig = config;
		yield* minimalMessages();
	}
	async stop(): Promise<void> {}
}
```

Add this describe block at the end of `orchestrator-api.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/orchestrator && bun test src/orchestrator-api.test.ts
```

Expected: 3 new tests FAIL — `contextProvider` does not exist on `OrchestratorDeps`.

- [ ] **Step 3: Update OrchestratorDeps and the import**

In `apps/orchestrator/src/orchestrator-api.ts`, update the import at the top:

```typescript
import type {
	AgentSessionStatus,
	IAgentRunner,
	ISessionStore,
	ITaskContextProvider,
	ITaskStore,
	OrchestrationTask,
	RunConfig
} from "@paisti/core";
```

Update `OrchestratorDeps` to add the optional dep:

```typescript
export interface OrchestratorDeps {
	/** Called once per task to produce an isolated runner instance. */
	runnerFactory: () => IAgentRunner;
	taskStore: ITaskStore;
	sessionStore: ISessionStore;
	activityService: ActivityService;
	contextProvider?: ITaskContextProvider;
	/** Defaults to process.cwd(). Per-task worktrees are added in Phase 2. */
	workingDirectory?: string;
	defaultModel?: string;
	systemPrompt?: string;
}
```

- [ ] **Step 4: Update handleTaskAssigned to assemble context**

In `apps/orchestrator/src/orchestrator-api.ts`, replace the `config` block in `handleTaskAssigned` (currently lines 162–167):

```typescript
		// Before:
		const config: RunConfig = {
			workingDirectory: this.deps.workingDirectory ?? process.cwd(),
			userPrompt: initialMessage,
			...(this.deps.systemPrompt ? { systemPrompt: this.deps.systemPrompt } : {}),
			...(this.deps.defaultModel ? { model: this.deps.defaultModel } : {})
		};
```

Replace with:

```typescript
		const context = this.deps.contextProvider
			? await this.deps.contextProvider.assembleContext(task)
			: undefined;

		const systemPrompt =
			[context, this.deps.systemPrompt].filter((s): s is string => s !== undefined).join("\n\n") ||
			undefined;

		const config: RunConfig = {
			workingDirectory: this.deps.workingDirectory ?? process.cwd(),
			userPrompt: initialMessage,
			...(systemPrompt ? { systemPrompt } : {}),
			...(this.deps.defaultModel ? { model: this.deps.defaultModel } : {})
		};
```

- [ ] **Step 5: Run all orchestrator tests**

```bash
cd apps/orchestrator && bun test src/orchestrator-api.test.ts
```

Expected: all tests PASS (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/orchestrator-api.ts apps/orchestrator/src/orchestrator-api.test.ts
git commit -m "Wire contextProvider into OrchestratorAPI"
```

---

### Task 4: Wire LocalTaskContextProvider in main.ts

**Files:**
- Modify: `apps/orchestrator/src/main.ts`

- [ ] **Step 1: Update main.ts**

Replace the current contents of `apps/orchestrator/src/main.ts`:

```typescript
import { ClaudeRunner } from "@paisti/claude-adapter";
import { ConsoleActivityWriter } from "@paisti/console-adapter";
import { OrchestratorAPI } from "./orchestrator-api.js";
import { ActivityService } from "./services/activity-service.js";
import { LocalTaskContextProvider } from "./services/local-task-context-provider.js";
import { SqliteSessionStore } from "./stores/sqlite-session-store.js";
import { SqliteTaskStore } from "./stores/sqlite-task-store.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "paisti.db";

const taskStore = new SqliteTaskStore(DB_PATH);
const sessionStore = new SqliteSessionStore(DB_PATH);
const activityService = new ActivityService([new ConsoleActivityWriter()]);
const contextProvider = new LocalTaskContextProvider(taskStore, sessionStore);

const orchestrator = new OrchestratorAPI({
	runnerFactory: () => new ClaudeRunner(),
	taskStore,
	sessionStore,
	activityService,
	contextProvider,
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

- [ ] **Step 2: Run full test suite to verify nothing regressed**

```bash
cd apps/orchestrator && bun test
```

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/orchestrator/src/main.ts
git commit -m "Wire LocalTaskContextProvider into orchestrator main"
```
