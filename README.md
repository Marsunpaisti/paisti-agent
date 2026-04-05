# Paisti Agent

A headless AI orchestration engine. Paisti manages Claude agent sessions triggered by external events, persists all activity to SQLite, and exposes a REST + SSE API. An optional React web client lets you inspect tasks, watch sessions stream in real time, and submit new tasks.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- An Anthropic API key (for the Claude adapter)

## Install

```bash
bun install
```

## Running

### Orchestrator only (headless)

```bash
cd apps/orchestrator
bun start
```

The server starts on port 3000 by default.

### Orchestrator + web client

Build the UI first, then start the server with `SERVE_UI=true`:

```bash
bun run --filter '@paisti/web' build
SERVE_UI=true bun run --filter '@paisti/orchestrator' start
```

Open [http://localhost:3000](http://localhost:3000).

### Web client in dev mode

Run the orchestrator and the Vite dev server side by side. Vite proxies `/api` and `/events` to the orchestrator automatically.

```bash
# terminal 1
cd apps/orchestrator && bun start

# terminal 2
cd apps/web && bun run dev   # http://localhost:5173
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `DB_PATH` | `paisti.db` | SQLite database path |
| `SERVE_UI` | — | Set to `true` to serve the built web UI. Can also be an explicit path to a `dist/` directory. |
| `MODEL` | — | Default Claude model (e.g. `claude-opus-4-6`) |
| `SYSTEM_PROMPT` | — | Extra system prompt prepended to every task's context |

## Sending tasks

Tasks are submitted by posting an event to `POST /events`:

```bash
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -d '{
    "type": "task_assigned",
    "taskRef": { "platform": "cli", "id": "'$(uuidgen)'" },
    "title": "Fix the auth bug",
    "initialMessage": "The login flow throws a 500 when the session expires. Please investigate and fix."
  }'
```

The response is `202 Accepted` with `{ "taskId": "..." }`. You can watch the session at `GET /api/sessions/:id/stream` (SSE) or in the web client.

### Other event types

```jsonc
// Inject a follow-up message into an active session
{ "type": "user_comment", "taskRef": { "platform": "cli", "id": "<task-id>" }, "content": "Also update the tests." }

// Stop an active session
{ "type": "stop_requested", "taskRef": { "platform": "cli", "id": "<task-id>" } }
```

## REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{ status: "ok", activeSessions: N }` |
| `POST` | `/events` | Submit an event (see above) |
| `GET` | `/api/tasks` | List all tasks |
| `GET` | `/api/tasks/:id` | Task + its sessions |
| `GET` | `/api/tasks/:id/messages` | User messages / comments on a task |
| `GET` | `/api/sessions/:id/messages` | All agent messages for a session |
| `GET` | `/api/sessions/:id/stream` | SSE stream of live agent messages (active sessions only) |

## Web client

The web client is a two-panel dashboard:

- **Left panel** — task list with live status badges, polling every 3 seconds. Click **+ New** to open the new-task form.
- **Right panel** — task detail with session tabs. Each session shows the full conversation: system prompt (collapsible), user messages, assistant replies, tool calls/results, and the final result summary. Active sessions stream in real time via SSE.

## Development

```bash
# Run all tests
bun test

# Type-check all packages
bun run typecheck

# Lint / auto-fix
bun run lint:fix
```

Tests use Bun's built-in test runner. The orchestrator suite covers the full HTTP API, event lifecycle, session transitions, and store behaviour.

## Architecture

Paisti uses **Ports & Adapters (hexagonal architecture)**. Core logic in `packages/core` defines only interfaces — no provider SDKs. Adapters live in `packages/claude-adapter` and `packages/console-adapter`.

```
packages/core            — shared interfaces & domain types
packages/claude-adapter  — IAgentRunner implementation (Claude Agent SDK)
packages/console-adapter — IActivityWriter implementation (stdout)
apps/orchestrator        — HTTP server, SQLite stores, SSE broadcaster
apps/web                 — React + Vite dashboard
```
