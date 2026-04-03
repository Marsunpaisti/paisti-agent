This project is a **headless AI orchestration engine** currently in its specification / early implementation phase. 

All Phase 1 design documents live in `docs/plans/phase_1/`.

## Important rules
- dependencies must be version pinned

## Stack
- **Language:** TypeScript
- **Runtime:** Bun

## Architecture

Paisti uses **Ports & Adapters (hexagonal architecture)**. Core logic depends only on interfaces — never on provider SDKs. The adapter boundary is strict: SDK types (`SDKMessage` etc.) never cross outward from the adapter layer.

## Spec Documents

All implementation specs are in `docs/plans/phase_1/`:

| File | Defines |
|---|---|
| `core/agent-messages.md` | `AgentMessage` union and all sub-types |
| `core/agent-runner.md` | `IAgentRunner`, `RunConfig`, `McpServerConfig` |
| `core/orchestration-task.md` | `OrchestrationTask`, `ExternalBinding`, `ITaskStore`, SQLite schema |
| `adapters/claude-adapter.md` | `ClaudeRunner`, `StreamingPrompt`, SDK message mapping rules |
| `orchestrator/api.md` | `OrchestratorAPI`, HTTP endpoints, event handling, `messageToActivities()` |

Consult the relevant spec before implementing any component — the mapping rules, design decisions, and phase limitations are all documented there.
