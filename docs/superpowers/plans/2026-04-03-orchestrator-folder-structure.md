# Orchestrator Folder Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `apps/orchestrator/src/` into `types/`, `stores/`, and `services/` layers; introduce `ActivityService` to manage registered `IActivityWriter` instances; extract `ConsoleActivityWriter` into `packages/console-adapter`.

**Architecture:** `Activity` types and `IActivityWriter` move to `@paisti/core` so both the orchestrator and external writer packages can import them without circular dependencies. `ActivityService` lives in `services/` and replaces the single `activityWriter` dep on `OrchestratorAPI`. `ConsoleActivityWriter` becomes a standalone package that `main.ts` wires in at startup.

**Tech Stack:** TypeScript, Bun, bun:test, Bun workspaces

---

## File Map

### New files
| Path | Purpose |
|---|---|
| `packages/core/src/activity.ts` | `Activity`, `ThoughtActivity`, `ActionActivity`, `IActivityWriter` |
| `packages/console-adapter/package.json` | New workspace package manifest |
| `packages/console-adapter/tsconfig.json` | TypeScript config for the package |
| `packages/console-adapter/src/index.ts` | `ConsoleActivityWriter` implementation |
| `apps/orchestrator/src/types/inbound-event.ts` | Moved from root |
| `apps/orchestrator/src/stores/sqlite-task-store.ts` | Moved from root |
| `apps/orchestrator/src/stores/sqlite-task-store.test.ts` | Moved from root |
| `apps/orchestrator/src/services/activity-service.ts` | New — manages writers, dispatches |
| `apps/orchestrator/src/services/activity-service.test.ts` | New — tests for ActivityService |

### Modified files
| Path | Change |
|---|---|
| `packages/core/src/index.ts` | Export Activity types + IActivityWriter |
| `apps/orchestrator/src/orchestrator-api.ts` | `activityWriter` → `activityService`; update import paths |
| `apps/orchestrator/src/orchestrator-api.test.ts` | Update imports; wrap writer in `ActivityService` |
| `apps/orchestrator/src/message-to-activities.ts` | Import `Activity` from `@paisti/core` |
| `apps/orchestrator/src/message-to-activities.test.ts` | Import activity types from `@paisti/core` |
| `apps/orchestrator/src/main.ts` | Use `@paisti/console-adapter`; create `ActivityService`; update store import path |
| `apps/orchestrator/src/index.ts` | Update all import paths; add `ActivityService`; drop `ConsoleActivityWriter` |
| `apps/orchestrator/package.json` | Add `@paisti/console-adapter` workspace dependency |

### Deleted files
- `apps/orchestrator/src/activity.ts`
- `apps/orchestrator/src/inbound-event.ts`
- `apps/orchestrator/src/sqlite-task-store.ts`
- `apps/orchestrator/src/sqlite-task-store.test.ts`
- `apps/orchestrator/src/console-activity-writer.ts`

---

## Task 1: Add Activity types and IActivityWriter to @paisti/core

`IActivityWriter` must live in `@paisti/core` so that external writer packages (like the upcoming `console-adapter`) can implement it without creating circular dependencies with the orchestrator.

**Files:**
- Create: `packages/core/src/activity.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Create `packages/core/src/activity.ts`**

```ts
/** Represents an agent thought (assistant text turn). Always ephemeral. */
export interface ThoughtActivity {
	type: "thought";
	text: string;
	ephemeral: true;
}

/** Represents a tool invocation or its error result. */
export interface ActionActivity {
	type: "action";
	description: string;
	isError: boolean;
}

export type Activity = ThoughtActivity | ActionActivity;

export interface IActivityWriter {
	postActivity(taskId: string, activity: Activity): Promise<void>;
	postResponse(taskId: string, summary: string): Promise<void>;
}
```

- [ ] **Step 2: Export from `packages/core/src/index.ts`**

Add at the bottom of the file:

```ts
export type { ActionActivity, Activity, IActivityWriter, ThoughtActivity } from "./activity.js";
```

- [ ] **Step 3: Run core typecheck to verify the new types compile**

```bash
cd packages/core && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/activity.ts packages/core/src/index.ts
git commit -m "feat(core): add Activity types and IActivityWriter to @paisti/core"
```

---

## Task 2: Update orchestrator imports; move `inbound-event.ts`; delete `activity.ts`

Now that `@paisti/core` owns the Activity types, the orchestrator's local `activity.ts` is redundant. We also move `inbound-event.ts` into `types/`.

**Files:**
- Create: `apps/orchestrator/src/types/inbound-event.ts`
- Modify: `apps/orchestrator/src/message-to-activities.ts`
- Modify: `apps/orchestrator/src/message-to-activities.test.ts`
- Modify: `apps/orchestrator/src/orchestrator-api.ts` (imports only, not the API shape yet)
- Modify: `apps/orchestrator/src/orchestrator-api.test.ts` (imports only)
- Modify: `apps/orchestrator/src/console-activity-writer.ts`
- Modify: `apps/orchestrator/src/index.ts`
- Delete: `apps/orchestrator/src/activity.ts`
- Delete: `apps/orchestrator/src/inbound-event.ts`

- [ ] **Step 1: Create `apps/orchestrator/src/types/inbound-event.ts`**

Copy the existing content verbatim:

```ts
export interface TaskRef {
	/** "cli" for local tasks; platform name ("linear", "github", etc.) for external */
	platform: string;
	/** Local UUID for CLI tasks; platform-native ID for external tasks */
	id: string;
}

export interface TaskAssignedEvent {
	type: "task_assigned";
	taskRef: TaskRef;
	/** Display label captured at creation time */
	title: string;
	/** The initial user prompt for the agent session */
	initialMessage: string;
}

export interface UserCommentEvent {
	type: "user_comment";
	taskRef: TaskRef;
	content: string;
}

export interface StopRequestedEvent {
	type: "stop_requested";
	taskRef: TaskRef;
}

export type InboundEvent = TaskAssignedEvent | UserCommentEvent | StopRequestedEvent;
```

- [ ] **Step 2: Update `apps/orchestrator/src/message-to-activities.ts`**

Change the Activity import from the local file to `@paisti/core`:

```ts
import type { AgentMessage } from "@paisti/core";
import type { Activity } from "@paisti/core";
```

(Or combine into one line: `import type { AgentMessage, Activity } from "@paisti/core";`)

Full updated top of file:

```ts
import type { AgentMessage, Activity } from "@paisti/core";
```

- [ ] **Step 3: Update `apps/orchestrator/src/message-to-activities.test.ts`**

Change the activity type imports:

```ts
import { describe, expect, it } from "bun:test";
import type { ActionActivity, AgentMessage, ThoughtActivity } from "@paisti/core";
import { messageToActivities } from "./message-to-activities.js";
```

(Remove the old `import type { ActionActivity, ThoughtActivity } from "./activity.js"` line.)

- [ ] **Step 4: Update `apps/orchestrator/src/orchestrator-api.ts` — imports only**

Change:
```ts
import type { IActivityWriter } from "./activity.js";
import type { InboundEvent, TaskAssignedEvent, TaskRef } from "./inbound-event.js";
```

To:
```ts
import type { IActivityWriter } from "@paisti/core";
import type { InboundEvent, TaskAssignedEvent, TaskRef } from "./types/inbound-event.js";
```

(Leave the rest of the file unchanged for now — `activityWriter` stays in `OrchestratorDeps` until Task 6.)

- [ ] **Step 5: Update `apps/orchestrator/src/orchestrator-api.test.ts` — imports only**

Change:
```ts
import type { Activity, IActivityWriter } from "./activity.js";
import type { TaskAssignedEvent } from "./inbound-event.js";
```

To:
```ts
import type { Activity, IActivityWriter } from "@paisti/core";
import type { TaskAssignedEvent } from "./types/inbound-event.js";
```

- [ ] **Step 6: Update `apps/orchestrator/src/console-activity-writer.ts`**

Change:
```ts
import type { Activity, IActivityWriter } from "./activity.js";
```

To:
```ts
import type { Activity, IActivityWriter } from "@paisti/core";
```

- [ ] **Step 7: Update `apps/orchestrator/src/index.ts`**

Replace the entire file:

```ts
export type { ActionActivity, Activity, IActivityWriter, ThoughtActivity } from "@paisti/core";
export { ConsoleActivityWriter } from "./console-activity-writer.js";
export type {
	InboundEvent,
	StopRequestedEvent,
	TaskAssignedEvent,
	TaskRef,
	UserCommentEvent
} from "./types/inbound-event.js";
export { messageToActivities } from "./message-to-activities.js";
export type { OrchestratorDeps } from "./orchestrator-api.js";
export { OrchestratorAPI } from "./orchestrator-api.js";
export { SqliteTaskStore } from "./sqlite-task-store.js";
```

- [ ] **Step 8: Delete the old files**

```bash
rm apps/orchestrator/src/activity.ts apps/orchestrator/src/inbound-event.ts
```

- [ ] **Step 9: Run all tests to verify nothing broke**

```bash
bun test
```

Expected: all tests pass (same count as before).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(orchestrator): import Activity types from @paisti/core; move inbound-event to types/"
```

---

## Task 3: Move SqliteTaskStore to `stores/`

**Files:**
- Create: `apps/orchestrator/src/stores/sqlite-task-store.ts`
- Create: `apps/orchestrator/src/stores/sqlite-task-store.test.ts`
- Modify: `apps/orchestrator/src/orchestrator-api.test.ts`
- Modify: `apps/orchestrator/src/index.ts`
- Delete: `apps/orchestrator/src/sqlite-task-store.ts`
- Delete: `apps/orchestrator/src/sqlite-task-store.test.ts`

- [ ] **Step 1: Create `apps/orchestrator/src/stores/sqlite-task-store.ts`**

Copy the full content of `apps/orchestrator/src/sqlite-task-store.ts` verbatim — no changes needed (all its imports are from `@paisti/core` and `bun:sqlite`, which remain valid regardless of folder).

- [ ] **Step 2: Create `apps/orchestrator/src/stores/sqlite-task-store.test.ts`**

Copy the full content of `apps/orchestrator/src/sqlite-task-store.test.ts`, then update the import:

```ts
import { SqliteTaskStore } from "./sqlite-task-store.js";
```

(The `./` path is unchanged because the test and implementation are now siblings in `stores/`.)

- [ ] **Step 3: Update `apps/orchestrator/src/orchestrator-api.test.ts`**

Change:
```ts
import { SqliteTaskStore } from "./sqlite-task-store.js";
```

To:
```ts
import { SqliteTaskStore } from "./stores/sqlite-task-store.js";
```

- [ ] **Step 4: Update `apps/orchestrator/src/index.ts`**

Change:
```ts
export { SqliteTaskStore } from "./sqlite-task-store.js";
```

To:
```ts
export { SqliteTaskStore } from "./stores/sqlite-task-store.js";
```

- [ ] **Step 5: Update `apps/orchestrator/src/main.ts`**

Change:
```ts
import { SqliteTaskStore } from "./sqlite-task-store.js";
```

To:
```ts
import { SqliteTaskStore } from "./stores/sqlite-task-store.js";
```

- [ ] **Step 6: Delete old files**

```bash
rm apps/orchestrator/src/sqlite-task-store.ts apps/orchestrator/src/sqlite-task-store.test.ts
```

- [ ] **Step 7: Run all tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(orchestrator): move SqliteTaskStore to stores/"
```

---

## Task 4: Create `ActivityService` (TDD)

`ActivityService` owns the list of registered `IActivityWriter` instances and fans out `postActivity` / `postResponse` calls to all of them concurrently.

**Files:**
- Create: `apps/orchestrator/src/services/activity-service.test.ts`
- Create: `apps/orchestrator/src/services/activity-service.ts`

- [ ] **Step 1: Write the failing tests in `apps/orchestrator/src/services/activity-service.test.ts`**

```ts
import { describe, expect, it } from "bun:test";
import type { Activity, IActivityWriter } from "@paisti/core";
import { ActivityService } from "./activity-service.js";

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

const thought: Activity = { type: "thought", text: "thinking", ephemeral: true };

describe("ActivityService — postActivity", () => {
	it("dispatches to a single writer", async () => {
		const spy = new SpyWriter();
		const svc = new ActivityService([spy]);
		await svc.postActivity("task-1", thought);
		expect(spy.activities).toHaveLength(1);
		expect(spy.activities[0]).toEqual({ taskId: "task-1", activity: thought });
	});

	it("dispatches to all writers", async () => {
		const a = new SpyWriter();
		const b = new SpyWriter();
		const svc = new ActivityService([a, b]);
		await svc.postActivity("task-1", thought);
		expect(a.activities).toHaveLength(1);
		expect(b.activities).toHaveLength(1);
	});

	it("is a no-op with zero writers", async () => {
		const svc = new ActivityService([]);
		await expect(svc.postActivity("task-1", thought)).resolves.toBeUndefined();
	});
});

describe("ActivityService — postResponse", () => {
	it("dispatches to a single writer", async () => {
		const spy = new SpyWriter();
		const svc = new ActivityService([spy]);
		await svc.postResponse("task-1", "Done.");
		expect(spy.responses).toHaveLength(1);
		expect(spy.responses[0]).toEqual({ taskId: "task-1", summary: "Done." });
	});

	it("dispatches to all writers", async () => {
		const a = new SpyWriter();
		const b = new SpyWriter();
		const svc = new ActivityService([a, b]);
		await svc.postResponse("task-1", "Done.");
		expect(a.responses).toHaveLength(1);
		expect(b.responses).toHaveLength(1);
	});

	it("is a no-op with zero writers", async () => {
		const svc = new ActivityService([]);
		await expect(svc.postResponse("task-1", "Done.")).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
bun test apps/orchestrator/src/services/activity-service.test.ts
```

Expected: FAIL — `Cannot find module './activity-service.js'`

- [ ] **Step 3: Implement `apps/orchestrator/src/services/activity-service.ts`**

```ts
import type { Activity, IActivityWriter } from "@paisti/core";

export class ActivityService {
	private readonly writers: IActivityWriter[];

	constructor(writers: IActivityWriter[]) {
		this.writers = writers;
	}

	async postActivity(taskId: string, activity: Activity): Promise<void> {
		await Promise.all(this.writers.map((w) => w.postActivity(taskId, activity)));
	}

	async postResponse(taskId: string, summary: string): Promise<void> {
		await Promise.all(this.writers.map((w) => w.postResponse(taskId, summary)));
	}
}
```

- [ ] **Step 4: Run the tests — verify they pass**

```bash
bun test apps/orchestrator/src/services/activity-service.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Run full test suite to verify nothing else broke**

```bash
bun test
```

Expected: all existing tests still pass + 6 new ones.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/services/
git commit -m "feat(orchestrator): add ActivityService to fan out to registered IActivityWriter instances"
```

---

## Task 5: Wire `ActivityService` into `OrchestratorAPI`

Replace the single `activityWriter: IActivityWriter` dependency with `activityService: ActivityService`. Update the test harness to wrap the `SpyWriter` in an `ActivityService`.

**Files:**
- Modify: `apps/orchestrator/src/orchestrator-api.ts`
- Modify: `apps/orchestrator/src/orchestrator-api.test.ts`

- [ ] **Step 1: Update `OrchestratorDeps` in `orchestrator-api.ts`**

Change the import at the top:

```ts
import type { IAgentRunner, ITaskStore, OrchestrationTask, RunConfig } from "@paisti/core";
import type { ActivityService } from "./services/activity-service.js";
import type { InboundEvent, TaskAssignedEvent, TaskRef } from "./types/inbound-event.js";
import { messageToActivities } from "./message-to-activities.js";
```

Change the `OrchestratorDeps` interface:

```ts
export interface OrchestratorDeps {
	/** Called once per task to produce an isolated runner instance. */
	runnerFactory: () => IAgentRunner;
	taskStore: ITaskStore;
	activityService: ActivityService;
	/** Defaults to process.cwd(). Per-task worktrees are added in Phase 2. */
	workingDirectory?: string;
	defaultModel?: string;
	systemPrompt?: string;
}
```

- [ ] **Step 2: Update `handleTaskAssigned` in `orchestrator-api.ts`**

Replace the two `activityWriter` call sites:

```ts
// Before:
await this.deps.activityWriter.postActivity(task.id, activity);
// ...
await this.deps.activityWriter.postResponse(task.id, msg.summary);

// After:
await this.deps.activityService.postActivity(task.id, activity);
// ...
await this.deps.activityService.postResponse(task.id, msg.summary);
```

- [ ] **Step 3: Update `orchestrator-api.test.ts`**

Add import for `ActivityService`:

```ts
import { ActivityService } from "./services/activity-service.js";
```

Update `buildApi` to use `activityService`:

```ts
function buildApi(messages: AgentMessage[] = minimalMessages()): OrchestratorAPI {
	return new OrchestratorAPI({
		runnerFactory: () => new MockRunner(messages),
		taskStore: store,
		activityService: new ActivityService([writer]),
		workingDirectory: "/tmp"
	});
}
```

Update the inline `ThrowingRunner` test that constructs `OrchestratorAPI` directly:

```ts
it("marks task as failed when runner throws", async () => {
	api = new OrchestratorAPI({
		runnerFactory: () => new ThrowingRunner(),
		taskStore: store,
		activityService: new ActivityService([writer]),
		workingDirectory: "/tmp"
	});
	// ... rest of test unchanged
```

- [ ] **Step 4: Run all tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/orchestrator-api.ts apps/orchestrator/src/orchestrator-api.test.ts
git commit -m "refactor(orchestrator): replace activityWriter dep with ActivityService"
```

---

## Task 6: Create `packages/console-adapter`; update `main.ts`; clean up

Extract `ConsoleActivityWriter` into its own workspace package. Update `main.ts` and `index.ts` to reflect the new structure.

**Files:**
- Create: `packages/console-adapter/package.json`
- Create: `packages/console-adapter/tsconfig.json`
- Create: `packages/console-adapter/src/index.ts`
- Modify: `apps/orchestrator/package.json`
- Modify: `apps/orchestrator/src/main.ts`
- Modify: `apps/orchestrator/src/index.ts`
- Delete: `apps/orchestrator/src/console-activity-writer.ts`

- [ ] **Step 1: Create `packages/console-adapter/package.json`**

```json
{
	"name": "@paisti/console-adapter",
	"version": "0.0.1",
	"private": true,
	"module": "./src/index.ts",
	"types": "./src/index.ts",
	"exports": {
		".": "./src/index.ts"
	},
	"scripts": {
		"typecheck": "tsc --noEmit"
	},
	"devDependencies": {
		"bun-types": "1.3.11"
	},
	"dependencies": {
		"@paisti/core": "workspace:*"
	}
}
```

- [ ] **Step 2: Create `packages/console-adapter/tsconfig.json`**

```json
{
	"extends": "../../tsconfig.json",
	"compilerOptions": {
		"rootDir": "src",
		"types": ["bun-types"]
	},
	"include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/console-adapter/src/index.ts`**

```ts
import type { Activity, IActivityWriter } from "@paisti/core";

/**
 * Simple IActivityWriter that prints activities to stdout.
 * Suitable for development and CLI use.
 */
export class ConsoleActivityWriter implements IActivityWriter {
	async postActivity(taskId: string, activity: Activity): Promise<void> {
		if (activity.type === "thought") {
			const preview =
				activity.text.length > 120 ? `${activity.text.slice(0, 117)}...` : activity.text;
			console.log(`[${taskId}] thought: ${preview}`);
		} else {
			const marker = activity.isError ? "error" : "action";
			console.log(`[${taskId}] ${marker}: ${activity.description}`);
		}
	}

	async postResponse(taskId: string, summary: string): Promise<void> {
		console.log(`[${taskId}] response: ${summary}`);
	}
}
```

- [ ] **Step 4: Add `@paisti/console-adapter` to orchestrator's dependencies**

In `apps/orchestrator/package.json`, add to `"dependencies"`:

```json
"@paisti/console-adapter": "workspace:*"
```

- [ ] **Step 5: Install the new workspace package**

```bash
bun install
```

Expected: no errors; the new package is linked in the workspace.

- [ ] **Step 6: Run typecheck on console-adapter**

```bash
cd packages/console-adapter && bun run typecheck
```

Expected: no errors.

- [ ] **Step 7: Update `apps/orchestrator/src/main.ts`**

Replace the entire file:

```ts
import { ClaudeRunner } from "@paisti/claude-adapter";
import { ConsoleActivityWriter } from "@paisti/console-adapter";
import { ActivityService } from "./services/activity-service.js";
import { OrchestratorAPI } from "./orchestrator-api.js";
import { SqliteTaskStore } from "./stores/sqlite-task-store.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "paisti.db";

const taskStore = new SqliteTaskStore(DB_PATH);
const activityService = new ActivityService([new ConsoleActivityWriter()]);

const orchestrator = new OrchestratorAPI({
	runnerFactory: () => new ClaudeRunner(),
	taskStore,
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

- [ ] **Step 8: Update `apps/orchestrator/src/index.ts`**

Replace the entire file:

```ts
export { ActivityService } from "./services/activity-service.js";
export type {
	InboundEvent,
	StopRequestedEvent,
	TaskAssignedEvent,
	TaskRef,
	UserCommentEvent
} from "./types/inbound-event.js";
export { messageToActivities } from "./message-to-activities.js";
export type { OrchestratorDeps } from "./orchestrator-api.js";
export { OrchestratorAPI } from "./orchestrator-api.js";
export { SqliteTaskStore } from "./stores/sqlite-task-store.js";
```

Note: `Activity`, `IActivityWriter`, and `ThoughtActivity`/`ActionActivity` are no longer re-exported here — consumers should import them directly from `@paisti/core`. `ConsoleActivityWriter` is no longer part of this package.

- [ ] **Step 9: Delete `apps/orchestrator/src/console-activity-writer.ts`**

```bash
rm apps/orchestrator/src/console-activity-writer.ts
```

- [ ] **Step 10: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 11: Run typecheck across the monorepo**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: extract ConsoleActivityWriter to @paisti/console-adapter; wire ActivityService in main.ts"
```
