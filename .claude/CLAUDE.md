This project is a **headless AI orchestration engine** currently in its specification / early implementation phase. 

## Important rules
- dependencies must be version pinned

## Stack
- **Language:** TypeScript
- **Runtime:** Bun

## Architecture

Paisti uses **Ports & Adapters (hexagonal architecture)**. Core logic depends only on interfaces — never on provider SDKs. The adapter boundary is strict: SDK types (`SDKMessage` etc.) never cross outward from the adapter layer.
