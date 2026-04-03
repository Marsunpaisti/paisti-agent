# Spec: OrchestratorAPI — Main Entry Point

## Purpose

The central wiring layer. Receives `InboundEvent`s from any source, resolves or creates the corresponding `OrchestrationTask`, runs the agent, and fans activities out to registered writers. Also exposes an HTTP endpoint for webhook delivery.

The orchestrator depends only on core ports. It never imports a provider SDK or platform SDK directly.

## Dependencies (Injected)

```typescript
interface OrchestratorDeps {
  runner: IAgentRunner;
  taskStore: ITaskStore;
  activityWriter: IActivityWriter;
  workingDirectory?: string;   // defaults to process.cwd(); per-task worktrees added later
  defaultModel?: string;
  systemPrompt?: string;
}
```

Additional ports are added in later phases:
- `IWorkspace` (Phase 2) — per-task worktree creation/destruction
- `ITaskContextProvider` (Phase 3) — live-fetch issue/comment context for prompt assembly
- `IEventSource[]` (Phase 3) — register webhook routes (Linear, Slack, etc.)
- `ISessionStore` (Phase 2) — persist session state for crash recovery

## Public Interface

```typescript
class OrchestratorAPI {
  constructor(deps: OrchestratorDeps)

  // Receive an event from any source (webhook adapter, CLI, test harness)
  handleEvent(event: InboundEvent): void

  // Bun.serve-compatible HTTP handler
  fetch(request: Request): Promise<Response>

  // Start HTTP server
  start(port?: number): Promise<void>

  // Stop all active sessions and the HTTP server
  stop(): Promise<void>
}
```

`handleEvent()` is non-blocking — dispatches async handling and returns immediately so webhook handlers can respond `200 OK` before the agent run begins.

## HTTP Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Returns `{ status: "ok", activeSessions: number }` |
| `POST` | `/webhook/:platform` | Delegated to registered `IEventSource` adapters (Phase 3+) |

In Phase 1, only `/health` exists. Platform webhooks are handled by `IEventSource` adapters that register their own routes when wired in.

## Event Handling

### `task_assigned`

1. **Resolve task** — look up `OrchestrationTask` by:
   - Local UUID (for CLI events where `taskRef.platform === "cli"`)
   - `findTaskByBinding(platform, externalId)` (for platform events)
   - Create new task + binding if neither exists
2. **Guard** — if the task already has an active session, log and return (duplicate webhook)
3. **Mark active** — `taskStore.updateTask(id, { status: "active" })`
4. **Build `RunConfig`** — from task title + `initialMessage` + deps config
5. **Run** — `for await (msg of runner.run(config))`:
   - Capture `sessionId` from first `SystemInfoMessage` (needed for resume)
   - Convert each message to `Activity[]` via `messageToActivities()`
   - Post each activity via `activityWriter.postActivity()`
   - On `SessionResultMessage` with summary: call `activityWriter.postResponse()`
6. **Cleanup** — remove from active sessions, mark task `completed`

### `user_comment`

- If task has an active session and `runner.supportsInjection`: call `runner.inject(content)`
- If no active session: store as `TaskMessage { source: { type: "cli" } }` for context in the next session

### `stop_requested`

- If task has an active session: call `runner.stop()`
- The `run()` loop completes normally, cleanup runs in the assignment handler's finally block

## messageToActivities()

Pure function — no I/O. Converts a normalized `AgentMessage` to zero or more `Activity` objects.

```
SystemInfoMessage     → []
UserMessage           → []
AssistantMessage      → [ThoughtActivity] for non-empty text parts (ephemeral: true)
ToolUseMessage        → [ActionActivity] with human-readable tool description
ToolResultMessage     → [ActionActivity { isError: true }] only on error; silent on success
SessionResultMessage  → []  (response posted separately via postResponse())
```

Tool description formatting examples:
- `Read` with `file_path` → `"Read: src/auth.ts"`
- `Bash` with `command` → `"Bash: npm test"` (truncated at 80 chars)
- Unknown tool → tool name only

## Task Resolution

The orchestrator resolves a `TaskRef` to an `OrchestrationTask` in three steps:

```
1. taskStore.getTask(taskRef.id)           → found: use it
2. taskStore.findTaskByBinding(            → found: use it
     taskRef.platform, taskRef.id)
3. taskStore.createTask(...)               → create + addBinding
   + taskStore.addBinding(...)
```

This handles:
- **CLI events**: `taskRef.id` is the UUID, step 1 resolves immediately
- **Platform events (new)**: step 2 misses, step 3 creates task and binding
- **Platform events (existing)**: step 2 resolves via `ExternalBinding` table
- **Missed webhooks**: if assignment was missed during downtime, startup reconciliation creates the task before the next webhook arrives (Phase 3+)

## Session Tracking

```typescript
interface ActiveSession {
  taskId: string;
  providerSessionId?: string;  // captured from SystemInfoMessage.sessionId
  runner: IAgentRunner;
  status: "running";
}

// Map<taskId, ActiveSession>
private activeSessions: Map<string, ActiveSession>
```

`providerSessionId` is set when the first `SystemInfoMessage` arrives. It is used in Phase 2 for crash recovery (stored in `ISessionStore`, passed as `resumeSessionId` on restart).

## Phase 1 Limitations

- **No worktree isolation** — all sessions run in `workingDirectory` (default: `process.cwd()`). Concurrent tasks would conflict. Worktree creation (`IWorkspace`) is added in Phase 2.
- **No prompt context** — user prompt is assembled from task title only. Real issue description + comments are assembled by `ITaskContextProvider` in Phase 3.
- **No session persistence** — `providerSessionId` is held in memory only. Crash recovery via `ISessionStore` is added in Phase 2.
- **No injection queue** — comments arriving when no session is active are stored as `TaskMessage`s but not automatically replayed into the next session. Queue-and-replay is a Phase 2 concern.
- **One session per task** — no parallel sub-sessions, no routing classifier. Multi-session support and intelligent routing are Phase 2+ features.
