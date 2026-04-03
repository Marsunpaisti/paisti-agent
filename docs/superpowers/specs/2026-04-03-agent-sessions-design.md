# Design: First-Class Agent Sessions

**Date:** 2026-04-03
**Status:** Approved

## Problem

An `OrchestrationTask` is a single persistent context for work — like an issue, but with no inherent tie to version control or code deliverables. A task can originate from a Slack message, a CLI prompt, a Linear issue, or anything else. Platform identity lives in `ExternalBinding`, not on the task.

The current design treats sessions as ephemeral: the orchestrator holds one runner per task in `Map<taskId, ActiveSession>` with no persistence. This works for Phase 1 (one session per task) but blocks the intended long-term model: a task that begins as a discussion, spawns an implementation session, then spawns a review session — all tracked under one task, with each new session fed context from the task's external bindings (Linear issue, branch, PR).

This design promotes `AgentSession` to a first-class entity with its own port, without changing Phase 1 behavior.

## What Does Not Change

- `OrchestrationTask` remains the primary container. Its status (`open → active → completed`) still reflects whether any session is currently running.
- `ExternalBinding` and `TaskMessage` are unchanged. `TaskMessage.source.sessionId` already carried a session ID — it now becomes a real foreign key.
- Phase 1 behavior: one session per task in practice. The routing logic for multi-session dispatch is a Phase 2 concern.
- `ITaskStore` is unchanged.

## New Type: `AgentSession`

```typescript
// packages/core/src/agent-session.ts

interface AgentSession {
  id: string;                  // local UUID
  taskId: string;
  role?: AgentSessionRole;     // null in Phase 1; populated when orchestrator assigns a purpose
  status: AgentSessionStatus;
  providerSessionId?: string;  // SDK session ID, captured from SystemInfoMessage
  startedAt: string;           // ISO 8601
  completedAt?: string;        // ISO 8601; absent while active
}

type AgentSessionStatus = "active" | "completed" | "failed" | "stopped";

// Extensible — new roles added here as orchestrator routing logic grows
type AgentSessionRole = "discussion" | "implementation" | "review";

interface CreateSessionInput {
  taskId: string;
  role?: AgentSessionRole;
}
```

## New Port: `ISessionStore`

```typescript
// packages/core/src/agent-session.ts

interface ISessionStore {
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  getSession(id: string): Promise<AgentSession | null>;
  updateSession(
    id: string,
    patch: Partial<Pick<AgentSession, "status" | "providerSessionId" | "completedAt">>
  ): Promise<AgentSession>;
  listSessions(taskId: string): Promise<AgentSession[]>;
  getActiveSession(taskId: string): Promise<AgentSession | null>;
}
```

`getActiveSession(taskId)` is the routing primitive. For Phase 1 it returns the single active session for a task (or `null`). In Phase 2+ it becomes the hook for intelligent routing — deciding whether to inject into an existing session or start a new one of a different role.

## SQLite Schema

```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES orchestration_tasks(id),
  role TEXT,                    -- NULL | "discussion" | "implementation" | "review"
  status TEXT NOT NULL DEFAULT 'active',
  provider_session_id TEXT,     -- populated when first SystemInfoMessage arrives
  started_at TEXT NOT NULL,
  completed_at TEXT             -- NULL while active
);
```

Implemented by `SqliteSessionStore` in `apps/orchestrator/src/sqlite-session-store.ts`, following the same in-memory-safe constructor pattern as `SqliteTaskStore`.

## OrchestratorAPI Changes

### Dependency

```typescript
interface OrchestratorDeps {
  runnerFactory: () => IAgentRunner;
  taskStore: ITaskStore;
  sessionStore: ISessionStore;   // new
  activityWriter: IActivityWriter;
  workingDirectory?: string;
  defaultModel?: string;
  systemPrompt?: string;
}
```

### `activeSessions` map

Shifts key from `taskId` to `sessionId`:

```typescript
private readonly activeSessions = new Map<string, ActiveSession>();
```

`ActiveSession` gains a `sessionId` field:

```typescript
interface ActiveSession {
  taskId: string;
  sessionId: string;             // AgentSession.id
  providerSessionId?: string;
  runner: IAgentRunner;
  status: "running";
}
```

A helper replaces direct `activeSessions.get(taskId)` lookups:

```typescript
private getActiveSessionForTask(taskId: string): ActiveSession | undefined {
  return [...this.activeSessions.values()].find(s => s.taskId === taskId);
}
```

### `handleTaskAssigned`

```typescript
// After resolving the task:
const session = await this.deps.sessionStore.createSession({ taskId: task.id });
const runner = this.deps.runnerFactory();
this.activeSessions.set(session.id, {
  taskId: task.id,
  sessionId: session.id,
  runner,
  status: "running"
});

// Track final status throughout the loop:
let finalStatus: AgentSessionStatus = "completed";

try {
  for await (const msg of runner.run(config)) {
    // Capture provider session ID from the first system message
    if (msg.type === "system" && !session.providerSessionId) {
      await this.deps.sessionStore.updateSession(session.id, {
        providerSessionId: msg.sessionId
      });
    }
    // Capture stop/error outcome from the result message
    if (msg.type === "result" && msg.finishReason === "stopped") {
      finalStatus = "stopped";
    }
    // ... activity fan-out unchanged
  }
} catch (err) {
  finalStatus = "failed";
} finally {
  this.activeSessions.delete(session.id);
  await this.deps.sessionStore.updateSession(session.id, {
    status: finalStatus,
    completedAt: new Date().toISOString()
  });
}
```

The `finalStatus` variable is the single source of truth for session outcome. `"stopped"` is detected from `SessionResultMessage.finishReason`, not from a separate flag, so no extra coordination with `handleStopRequested` is needed.

### `handleUserComment` and `handleStopRequested`

Both call `getActiveSessionForTask(taskId)` instead of `activeSessions.get(taskId)`. No other changes.

## Testing

`SqliteSessionStore` is tested in isolation against in-memory SQLite (`:memory:`), matching the `SqliteTaskStore` pattern.

Additional cases in `orchestrator-api.test.ts`:

| Scenario | Assertion |
|---|---|
| `task_assigned` | Session created with `status: "active"` before runner starts |
| Successful run | Session transitions to `status: "completed"`, `completedAt` set |
| Runner error | Session transitions to `status: "failed"` |
| `stop_requested` | Session transitions to `status: "stopped"` |
| `SystemInfoMessage` arrives | `providerSessionId` written to session |
| `user_comment` with active session | Routes to `session.runner.inject`, no new session created |
| `listSessions(taskId)` after completion | Returns historical session with correct final status |
| `getActiveSession(taskId)` after completion | Returns `null` |

## Phase Limitations

- **No session routing logic** — Phase 1 always creates a new session per `task_assigned` event. The duplicate guard uses `getActiveSessionForTask(taskId)` (the in-memory map, not the store) to avoid a race between an arriving event and the `finally` block that hasn't finished writing to the DB yet.
- **No session role assignment** — `role` is always `undefined` in Phase 1. Role assignment (deciding whether to start a `"discussion"` vs `"implementation"` session) is Phase 2.
- **No context assembly from bindings** — the `ITaskContextProvider` port (Phase 3) is what feeds session prompts with Linear issue content, branch state, etc. For now the prompt is assembled from the task title and initial message only.
