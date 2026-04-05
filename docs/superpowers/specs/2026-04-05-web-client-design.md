# Web Client Design

**Date:** 2026-04-05
**Scope:** React-based web UI for inspecting tasks, sessions, and agent output; submitting new tasks; served optionally by the orchestrator.

---

## Overview

A Vite + React SPA (`apps/web`) served by the orchestrator when `SERVE_UI=true`. The orchestrator gains a Hono router, a REST API, an SSE stream for live agent output, and a persistent agent message log. No auth — local dev tool only.

---

## Architecture

Two new pieces added to the monorepo:

- **`apps/web`** — Vite + React + TypeScript SPA
- **Hono router** — replaces the manual `if/else` fetch handler in `OrchestratorAPI`

The orchestrator serves `apps/web/dist` as static files when `SERVE_UI=true`. In development, Vite's dev server proxies `/api` and `/events` to the orchestrator.

A new `MessageService` (same fan-out pattern as `ActivityService`) is wired into the orchestrator loop alongside the existing activity flow. It has two writers:

- **`SqliteAgentMessageWriter`** — persists each `AgentMessage` to a `session_messages` table
- **`SseBroadcaster`** — holds open SSE connections and pushes messages to connected clients

`OrchestratorAPI` gains an optional `messageService?: MessageService` dep so existing tests and scripts need no changes.

---

## Backend

### Hono router

`OrchestratorAPI.fetch()` is replaced by a Hono app. Existing routes move over unchanged.

New routes:

```
GET  /api/tasks                      — list all tasks
GET  /api/tasks/:id                  — task + its sessions
GET  /api/tasks/:id/messages         — stored TaskMessages (user comments)
GET  /api/sessions/:id/messages      — stored AgentMessages for a session
GET  /api/sessions/:id/stream        — SSE stream (404 if session not active)
```

Static files are served from `apps/web/dist` with an `index.html` catch-all fallback for client-side routing.

### Persistent message log

`SqliteSessionStore` gains a `session_messages` table and two methods:

- `addMessage(sessionId, sequence, message)` — JSON-serializes the `AgentMessage` with a sequence number
- `getMessages(sessionId)` — returns rows ordered by sequence

The assembled system prompt (context + static, as built in `handleTaskAssigned`) is stored as a `system_prompt` column on the `agent_sessions` table, populated before the runner starts. It is returned as part of `GET /api/sessions/:id` and displayed by the UI as a pinned collapsible panel — not mixed into the message stream.

### IAgentMessageWriter + MessageService

```ts
interface IAgentMessageWriter {
  writeMessage(sessionId: string, sequence: number, message: AgentMessage): Promise<void>;
}
```

`MessageService` accepts an array of writers and fans out — identical pattern to `ActivityService`. Wired in `main.ts` with `SqliteAgentMessageWriter` and `SseBroadcaster`.

### SseBroadcaster

In-memory map of `sessionId → Set<SSE controller>`. The Hono SSE route registers a controller on connect and removes it on disconnect. `broadcast(sessionId, message)` serializes the message as JSON and pushes to all registered controllers for that session.

---

## Frontend

### Stack

- Vite + React + TypeScript
- React Router — client-side navigation
- TanStack Query — REST data fetching and caching
- Tailwind CSS — styling

### Layout

Two-panel:

- **Left sidebar** — task list with status badges; "New task" button at top
- **Right panel** — selected task detail: session selector (tabs), chat view below

### Chat view

The system prompt is displayed as a collapsible panel pinned above the message stream, sourced from the session record (not the message log).

Renders `session_messages` in chronological order. Each message type is styled distinctly:

| Type | Rendering |
|------|-----------|
| `user` message | Chat bubble, right-aligned |
| `assistant` text | Chat bubble, left-aligned |
| `tool_use` | Collapsible block — tool name + full input JSON |
| `tool_result` | Collapsible block — output content, red-tinted on error |
| `system` info | Small metadata line (session ID, model) |
| `result` | Summary card — finish reason, duration, token counts |

For **live sessions**: opens `EventSource` to `/api/sessions/:id/stream` and appends messages as they arrive.

For **completed sessions**: fetches `/api/sessions/:id/messages` once and renders statically.

### New task form

Modal triggered by the sidebar button. Two fields: title and initial message. Submits `POST /events` with a `task_assigned` event using `platform: "cli"` and a fresh UUID.

---

## Data Flow

**Submit a task:**
The client generates the task UUID before submitting. Browser → `POST /events` (`task_assigned`, UUID included in `taskRef.id`) → `202` returned immediately → browser navigates to `/tasks/:id`. TanStack Query fetches the task and its sessions; once the session record appears, the chat view opens the SSE stream.

**Live session:**
Runner yields `AgentMessage` → `MessageService` fans out to `SqliteAgentMessageWriter` (persist) + `SseBroadcaster` (push to EventSource clients). Chat view appends each message in real-time.

**Historical session:**
Browser opens completed task → `GET /api/sessions/:id/messages` → full log rendered at once. No SSE.

---

## File Layout

```
apps/
  web/
    package.json
    vite.config.ts
    index.html
    src/
      main.tsx
      App.tsx
      components/
        TaskList.tsx
        TaskDetail.tsx
        ChatView.tsx
        MessageItem.tsx
        NewTaskForm.tsx
      hooks/
        useTasks.ts
        useSession.ts
        useSessionStream.ts   ← EventSource hook
      api/
        client.ts             ← typed fetch wrappers

apps/orchestrator/src/
  services/
    message-service.ts        ← MessageService (fan-out)
    sse-broadcaster.ts        ← SseBroadcaster
  stores/
    sqlite-session-store.ts   ← extended with session_messages table
  stores/
    sqlite-agent-message-writer.ts
```

---

## Out of Scope

- Authentication
- Multi-user support
- Injecting user comments into live sessions from the UI (follow-up)
- Per-task worktrees (Phase 2)
