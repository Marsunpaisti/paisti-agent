# Design: ITaskContextProvider (Phase 2)

**Date:** 2026-04-04
**Status:** Approved

## Problem

When a new agent session starts, its prompt is assembled from only the task title and the caller-supplied `initialMessage`. No task history is included — no prior user comments, no external references (Linear issues, branches, PRs), no record of past sessions. This means every session starts completely blind to the task's context.

Phase 2 introduces `ITaskContextProvider`: a port that assembles a context string from all locally-owned task data before each session. This replaces the original "injection queue" framing — replaying unread messages is just one part of a broader context assembly step that any session benefits from.

Phase 3 will extend this port with live-fetched external data (Linear issue body, Slack thread, etc.) via `ITaskContextProvider` adapters. The Phase 2 implementation only reads local SQLite data.

## What Does Not Change

- `IAgentRunner`, `RunConfig`, and the runner loop are unchanged.
- `ITaskStore`, `ISessionStore`, `TaskMessage`, and `ExternalBinding` are unchanged.
- `OrchestratorAPI` event handling logic is unchanged.
- Existing setups without a `contextProvider` continue to work identically — the dep is optional.

## New Port: `ITaskContextProvider`

```typescript
// packages/core/src/task-context.ts

export interface ITaskContextProvider {
  /**
   * Assemble a context string for a new session on the given task.
   * The caller already holds the task object — no need to re-fetch it.
   */
  assembleContext(task: OrchestrationTask): Promise<string>;
}
```

A single-method interface. Takes the already-resolved `OrchestrationTask` (the caller has it); internally fetches bindings, sessions, and messages from its injected stores. Returns a formatted string ready to prepend to the system prompt.

`OrchestrationTask` is a core type — no layering violation.

## New Implementation: `LocalTaskContextProvider`

```typescript
// apps/orchestrator/src/services/local-task-context-provider.ts

export class LocalTaskContextProvider implements ITaskContextProvider {
  constructor(
    private readonly taskStore: ITaskStore,
    private readonly sessionStore: ISessionStore
  ) {}

  async assembleContext(task: OrchestrationTask): Promise<string> { ... }
}
```

Reads four data sources from local SQLite and formats them into compact markdown. Sections are omitted when empty to keep context lean for fresh tasks.

### Output format

```
## Task context

Task: Fix auth bug

External references:
- linear ENG-42 [source]: https://linear.app/team/ENG-42
- github PR #123 [artifact]: https://github.com/org/repo/pull/123

Past sessions:
- discussion (completed, 2026-04-03)
- implementation (completed, 2026-04-04)

Messages:
1. [user, 2026-04-04T10:00] Also fix the error message
2. [agent, 2026-04-04T10:01] Fixed the null check in src/auth.ts
```

**Sections included:**
- `Task:` — always present (task title)
- `External references:` — present when `ExternalBinding[]` is non-empty; each binding shows platform, externalId, role, and URL if available
- `Past sessions:` — present when `AgentSession[]` has any completed/stopped/failed sessions; shows role (if set), status, and date
- `Messages:` — present when `TaskMessage[]` is non-empty; chronological, author and timestamp on each line

A task with no bindings, no past sessions, and no messages returns:
```
## Task context

Task: Fix auth bug
```

Messages are always included in full — no "consumed" marking, no truncation. Future phases can add summarisation or selective inclusion.

## OrchestratorAPI Changes

### Dependency

```typescript
interface OrchestratorDeps {
  runnerFactory: () => IAgentRunner;
  taskStore: ITaskStore;
  sessionStore: ISessionStore;
  activityService: ActivityService;
  contextProvider?: ITaskContextProvider;   // new, optional
  workingDirectory?: string;
  defaultModel?: string;
  systemPrompt?: string;
}
```

### Prompt assembly in `handleTaskAssigned`

After resolving the task, before building `RunConfig`:

```typescript
const context = this.deps.contextProvider
  ? await this.deps.contextProvider.assembleContext(task)
  : undefined;

const config: RunConfig = {
  workingDirectory: this.deps.workingDirectory ?? process.cwd(),
  userPrompt: initialMessage,
  systemPrompt: [context, this.deps.systemPrompt].filter(Boolean).join("\n\n") || undefined,
  ...(this.deps.defaultModel ? { model: this.deps.defaultModel } : {})
};
```

Context is prepended before any static `systemPrompt` — dynamic task context first, static operator instructions after. The `|| undefined` ensures the field is absent (not `""`) when neither is set.

### `main.ts`

```typescript
const contextProvider = new LocalTaskContextProvider(taskStore, sessionStore);

const orchestrator = new OrchestratorAPI({
  ...
  contextProvider,
});
```

## Testing

### `LocalTaskContextProvider` unit tests

File: `apps/orchestrator/src/services/local-task-context-provider.test.ts`

Uses real in-memory `SqliteTaskStore` and `SqliteSessionStore` — no mocks.

| Scenario | Assertion |
|---|---|
| Task with no bindings, sessions, or messages | Output contains title, no other sections |
| Task with bindings | Output contains `External references:` section with platform, id, role, URL |
| Task with no bindings | No `External references:` section |
| Task with past sessions | Output contains `Past sessions:` section with role, status, date |
| Task with no past sessions | No `Past sessions:` section |
| Task with messages | Output contains `Messages:` section in chronological order |
| Task with no messages | No `Messages:` section |
| Task with all three | All sections present in correct order |

### `OrchestratorAPI` additions

Uses a `CapturingRunner` test double that records the `RunConfig` it receives:

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

| Scenario | Assertion |
|---|---|
| `contextProvider` set | `capturedConfig.systemPrompt` contains context string |
| `contextProvider` absent | `capturedConfig.systemPrompt` is unchanged from `deps.systemPrompt` |
| Both `contextProvider` and `deps.systemPrompt` set | Context prepended, separated by blank line, static prompt follows |

## Phase Limitations

- **No live external fetching** — bindings show `externalId` and `externalUrl` only. Actual issue body, branch state, and PR diff are Phase 3 (`ITaskContextProvider` adapters for Linear, GitHub, etc.).
- **No message truncation** — all messages included in full. Summarisation and selective inclusion are Phase 3+ concerns.
- **No active session context** — the current session's own messages are not retroactively added during the run. Context is assembled once at session start.
