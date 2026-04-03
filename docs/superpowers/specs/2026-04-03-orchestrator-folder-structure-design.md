# Orchestrator Folder Structure Design

**Date:** 2026-04-03  
**Scope:** `apps/orchestrator/src/`

## Problem

All files inside `apps/orchestrator/src/` are flat — types, logic, infrastructure implementations, and tests sit side by side. This works at POC scale but does not scale to the planned growth: multiple `ITaskStore` implementations, multiple `IActivityWriter` implementations registered per-config, and additional HTTP routes.

## Non-Goals

- Reorganizing `packages/core` or `packages/claude-adapter` — those are already well-structured.
- Moving platform integration code (Linear, GitHub) into the orchestrator — those live in separate packages.
- Splitting `OrchestratorAPI` into multiple services — only the activity dispatch responsibility is extracted in this design.

## Target Structure

```
apps/orchestrator/src/
  types/
    activity.ts              # Activity union type + IActivityWriter port interface
    inbound-event.ts         # InboundEvent union + TaskRef
  stores/
    sqlite-task-store.ts     # Concrete ITaskStore backed by SQLite
    sqlite-task-store.test.ts
  services/
    activity-service.ts      # Manages registered IActivityWriter instances; dispatches activities and responses
    activity-service.test.ts
  orchestrator-api.ts        # Event routing, runner session management, HTTP server
  orchestrator-api.test.ts
  message-to-activities.ts   # Pure function: AgentMessage → Activity[]
  message-to-activities.test.ts
  main.ts                    # Wires dependencies together; starts HTTP server
  index.ts                   # Package public exports
```

## Rationale for Each Decision

### `types/`
Groups app-local port interfaces and their associated types. `IActivityWriter` lives here (not in `packages/core`) because it is defined and owned by the orchestrator, not shared across packages. As new inbound event types are added, `inbound-event.ts` grows naturally without touching anything else.

### `stores/`
Contains `ITaskStore` implementations that belong to the orchestrator runtime. `SqliteTaskStore` is not a shareable package — it is infrastructure local to this app. When a second store implementation is added (e.g. Postgres), it drops in here alongside the existing one.

### `services/activity-service.ts`
Single responsibility: hold a list of registered `IActivityWriter` instances (injected at startup via `main.ts`) and expose `postActivity(taskId, activity)` and `postResponse(taskId, summary)`. Per-writer configuration (e.g. filter by activity type, filter by task) lives here. `OrchestratorAPI` calls `ActivityService` instead of a single hardcoded writer.

Writer *implementations* (`ConsoleActivityWriter`, future `LinearActivityWriter`, etc.) live in separate packages (e.g. `packages/console-adapter`). The orchestrator never owns them — it only receives them as registered dependencies.

### `orchestrator-api.ts` (root level)
Stays at root because it is the application core — event routing, session lifecycle, HTTP server. It is not a detail to tuck into a subfolder. It depends on `ActivityService`, `ITaskStore`, and `IAgentRunner` (via factory).

### `message-to-activities.ts` (root level)
Pure function with no side effects. Stays at root alongside `orchestrator-api.ts` because it is directly part of the application's processing pipeline, not an interchangeable implementation.

### Tests
Tests remain co-located with their source files (e.g. `sqlite-task-store.test.ts` next to `sqlite-task-store.ts`).

## Migration: `ConsoleActivityWriter`

`ConsoleActivityWriter` currently lives in `apps/orchestrator/src/`. It must move to a package (e.g. `packages/console-adapter`) since writer implementations do not belong in the app. For the migration it can be a minimal package in the monorepo. `main.ts` instantiates it and passes it to `ActivityService` like any other writer.

## `ActivityService` Interface

```ts
// services/activity-service.ts
export class ActivityService {
  constructor(writers: IActivityWriter[]) { ... }

  async postActivity(taskId: string, activity: Activity): Promise<void> { ... }
  async postResponse(taskId: string, summary: string): Promise<void> { ... }
}
```

`OrchestratorAPI` receives `ActivityService` (or its interface) via `OrchestratorDeps` instead of a single `IActivityWriter`.

## What Does Not Change

- `packages/core` — untouched
- `packages/claude-adapter` — untouched
- The hexagonal boundary: SDK types never cross outward from the adapter layer
- All existing public interfaces (`ITaskStore`, `IAgentRunner`, `RunConfig`, etc.)
- Test co-location
