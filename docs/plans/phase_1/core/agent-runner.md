# Spec: IAgentRunner — Agent Execution Port

## Purpose

The single interface through which the engine starts, injects into, and stops AI sessions. All runner implementations (Claude, Gemini, Codex, Cursor, etc.) satisfy this interface. The engine never imports a provider SDK.

## Interface

```typescript
interface IAgentRunner {
  run(config: RunConfig): AsyncIterable<AgentMessage>;
  inject?(content: string): void;
  readonly supportsInjection: boolean;
  stop(): Promise<void>;
}
```

### `run(config)`

Starts a session and streams `AgentMessage`s until completion. The iterable always terminates with a `SessionResultMessage` — including on error — so the caller's `for await` loop always completes cleanly.

Throws synchronously only for configuration errors (missing working directory, invalid model name). Runtime errors are emitted as `SessionResultMessage { finishReason: "error" }`.

### `inject(content)`

Injects a message into the currently active session. Only valid while `run()` is in progress. Defined as optional on the interface; callers check `supportsInjection` before calling.

### `supportsInjection`

`true` if the runner supports mid-run injection. `false` for batch-only providers (e.g. a Gemini runner that doesn't implement streaming input). The orchestrator handles both cases:

- `true`: call `inject()` directly
- `false`: queue the message and include it in the next session's prompt

### `stop()`

Gracefully aborts the active session. The `run()` iterable emits a final `SessionResultMessage { finishReason: "stopped" }` and completes.

## RunConfig

```typescript
interface RunConfig {
  workingDirectory: string;
  systemPrompt?: string;
  userPrompt: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  resumeSessionId?: string;
  providerOptions?: Record<string, unknown>;
}
```

### `resumeSessionId`

The provider-native session ID captured from a prior `SystemInfoMessage.sessionId`. When present, the runner attempts to restore context from the provider's server (Strategy A recovery). Falls back to a new session if expired.

### `providerOptions`

Keyed by provider name. Adapters consume only their own key and ignore the rest. Used for provider-specific settings that don't belong in the shared contract:

```typescript
providerOptions: {
  claude: {
    settingSources: ["project", "local"],  // exclude user hooks
    permissionMode: "bypassPermissions",
  },
  gemini: {
    safetySettings: [...],
  }
}
```

## McpServerConfig

```typescript
interface McpServerConfig {
  type?: "stdio" | "http";
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http
  url?: string;
  headers?: Record<string, string>;
}
```

## Design Decisions

**`AsyncIterable<AgentMessage>` over callbacks** — natural `for await` composition, backpressure built in, no EventEmitter cleanup, works identically for streaming and batch providers.

**`inject` is optional on the interface** — avoids forcing batch-only providers to implement a no-op. `supportsInjection: boolean` communicates capability explicitly so the orchestrator degrades gracefully.

**`providerOptions` escape hatch** — new provider-specific settings don't require an interface change. The tradeoff is type safety; document expected keys per provider in the adapter spec.

**One runner instance per session** — runners are not shared across concurrent sessions. The orchestrator creates a new runner instance per task. This keeps session state isolated and avoids cross-session injection bugs.
