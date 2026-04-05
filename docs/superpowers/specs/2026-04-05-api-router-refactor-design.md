# API Router Refactor Design

**Date:** 2026-04-05  
**Status:** Approved

## Problem

`orchestrator-api.ts` mixes three unrelated concerns:

1. HTTP route declarations
2. Task resolution logic (`resolveOrCreateTask`, `resolveTask`)
3. Runner/session lifecycle (`activeSessions`, run loop, event handlers, `flush`)

This makes the file hard to navigate and violates the ports-and-adapters boundary: business logic should live in services, not in the HTTP layer.

## Approach

Extract two services from `OrchestratorAPI`, then move route declarations into per-entity Hono sub-apps mounted via `app.route()`.

## New File Structure

```
apps/orchestrator/src/
  services/
    task-service.ts          ← task resolution (new)
    runner-service.ts        ← session lifecycle + event handling (new)
    activity-service.ts      (unchanged)
    message-service.ts       (unchanged)
    sse-broadcaster.ts       (unchanged)
  routers/
    tasks-router.ts          ← GET /api/tasks/**
    sessions-router.ts       ← GET /api/sessions/**
    events-router.ts         ← POST /api/events
  orchestrator-api.ts        ← HTTP wiring only (shrunk)
```

## Services

### TaskService

Owns task resolution. No other service dependencies.

```ts
class TaskService {
  constructor(private readonly taskStore: ITaskStore) {}

  resolveOrCreate(taskRef: TaskRef, title: string): Promise<OrchestrationTask>
  resolve(taskRef: TaskRef): Promise<OrchestrationTask | null>
}
```

The logic currently in `resolveOrCreateTask` and `resolveTask` moves here verbatim.

### RunnerService

Owns the runner/session lifecycle and event dispatching. Depends on `TaskService`.

```ts
class RunnerService {
  constructor(deps: RunnerServiceDeps) {}

  // Public interface (mirrors current OrchestratorAPI methods)
  runTask(event: TaskAssignedEvent): Promise<void>
  handleEvent(event: InboundEvent): void
  flush(): Promise<void>
  stop(): Promise<void>

  // Used by sessions-router
  isSessionActive(sessionId: string): boolean
  get activeSessionCount(): number
}
```

`RunnerServiceDeps` receives: `taskService`, `sessionStore`, `activityService`, `messageService?`, `contextProvider?`, `runnerFactory`, `workingDirectory?`, `defaultModel?`, `systemPrompt?`.

The `activeSessions` map, `pendingEvents` set, and all private event handlers (`handleTaskAssigned`, `handleUserComment`, `handleStopRequested`) move into this class.

## Routers

Each router is a factory function returning a `Hono` instance, mounted by `OrchestratorAPI` via `app.route()`.

### tasks-router.ts

```ts
export function tasksRouter(taskStore: ITaskStore, sessionStore: ISessionStore): Hono
```

Routes: `GET /`, `GET /:id`, `GET /:id/messages`

### sessions-router.ts

```ts
export function sessionsRouter(
  agentMessageStore: IAgentMessageReader | undefined,
  sseBroadcaster: ISseRegistrar | undefined,
  runnerService: RunnerService
): Hono
```

Routes: `GET /:id/messages`, `GET /:id/stream`

`ISseRegistrar` moves from `orchestrator-api.ts` to this file (its only consumer).

### events-router.ts

```ts
export function eventsRouter(taskService: TaskService, runnerService: RunnerService): Hono
```

Routes: `POST /`

The eager task creation before the 202 response (`resolveOrCreate` + `handleEvent`) stays here, delegating to the two services.

## OrchestratorAPI (after)

Responsibilities: construct services, mount routers, register `/health`, serve static UI, own `Bun.serve`.

Public interface **unchanged**: `runTask`, `handleEvent`, `flush`, `fetch`, `start`, `stop` all remain — delegating to `RunnerService`. `OrchestratorDeps` type is unchanged.

```ts
constructor(deps: OrchestratorDeps) {
  const taskService = new TaskService(deps.taskStore)
  const runnerService = new RunnerService({ taskService, ...relevantDeps })

  this.app.get('/health', ...)
  this.app.route('/api/tasks', tasksRouter(deps.taskStore, deps.sessionStore))
  this.app.route('/api/sessions', sessionsRouter(deps.agentMessageStore, deps.sseBroadcaster, runnerService))
  this.app.route('/api/events', eventsRouter(taskService, runnerService))
  // static UI if configured
}
```

## Breaking Change: /events → /api/events

`POST /events` is renamed to `POST /api/events`. The following callers must be updated as part of this refactor:

- `apps/web/src/api/client.ts` — update `fetch("/events", ...)` to `fetch("/api/events", ...)` and remove the comment justifying the old path
- `apps/web/vite.config.ts` — update the dev proxy key from `"/events"` to `"/api/events"`
- `apps/orchestrator/src/orchestrator-api.test.ts` — update all three test requests from `/events` to `/api/events`

## Testing

No new tests required. The existing `orchestrator-api.test.ts` exercises the full stack through the public `OrchestratorAPI` interface and continues to serve as the integration test suite. The refactor is purely structural.
