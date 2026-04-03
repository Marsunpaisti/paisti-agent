# Spec: Claude Adapter — @anthropic-ai/claude-agent-sdk

## Purpose

Adapts `@anthropic-ai/claude-agent-sdk` to the `IAgentRunner` interface. This is the boundary where Claude SDK types (`SDKMessage`) are consumed and converted to our normalized `AgentMessage` format. SDK types never cross this boundary outward.

## SDK Facts (v0.2.89)

`query()` accepts:
- `prompt: string | AsyncIterable<SDKUserMessage>` — string for single-turn, iterable for streaming/injection
- `options.resume: string` — provider-native session ID for resuming prior sessions
- `options.settingSources: Array<"user" | "project" | "local">` — which config files to load
- `options.mcpServers: Record<string, McpServerConfig>` — inline MCP server config
- `options.permissionMode: "bypassPermissions" | ...`

Returns `AsyncIterable<SDKMessage>` where `SDKMessage` is:

```typescript
type SDKMessage =
  | SDKSystemMessage    // { type: "system"; session_id: string; ... }
  | SDKAssistantMessage // { type: "assistant"; message: { content: ContentBlock[] }; session_id }
  | SDKUserMessage      // { type: "user"; message: { content: string | ToolResultBlock[] }; session_id }
  | SDKResultMessage    // { type: "result"; message: { content: TextBlock[] }; session_id; subtype; duration_ms; usage }
  | SDKStatusMessage    // { type: "status"; ... } — not surfaced
  | SDKRateLimitEvent   // { type: "rate_limit"; ... } — not surfaced
```

`session_id` is present on all message types and is the ID used with `options.resume`.

## Components

### ClaudeRunner

Implements `IAgentRunner`. One instance per session — not shared across concurrent tasks.

**Key behaviors:**
- Uses `StreamingPrompt` (below) as the `query()` prompt so injection works via `prompt.write()`
- Defaults `settingSources: ["project", "local"]` — intentionally excludes `"user"` to prevent user-level hooks (Superpowers, custom slash commands, `~/.claude/hooks/`) from interfering with automated headless runs
- Merges `providerOptions.claude` onto SDK options last, allowing full override including restoring `"user"` for interactive dev mode
- Stores no session state beyond the active `StreamingPrompt` and `AbortController`

**RunConfig → SDK options mapping:**

| RunConfig field | SDK option |
|---|---|
| `userPrompt` | Written to `StreamingPrompt` as first message |
| `systemPrompt` | `options.systemPrompt` |
| `model` | `options.model` |
| `maxTurns` | `options.maxTurns` |
| `allowedTools` | `options.allowedTools` |
| `disallowedTools` | `options.disallowedTools` |
| `mcpServers` | `options.mcpServers` |
| `resumeSessionId` | `options.resume` |
| `workingDirectory` | `options.cwd` |
| `providerOptions.claude` | spread onto options (last, can override any of the above) |

**Session lifecycle:**

```
run(config) called
  → create StreamingPrompt(config.userPrompt)
  → create AbortController
  → call query({ prompt, options, abortSignal })
  → for each SDKMessage: yield toAgentMessages(raw)
  → StreamingPrompt and AbortController cleared on finally

inject(content) called mid-run
  → streamingPrompt.write(content)

stop() called
  → abortController.abort()
  → streamingPrompt.close()
  → run() loop completes with SessionResultMessage { finishReason: "stopped" }
```

### StreamingPrompt

`AsyncIterable<SDKUserMessage>` that can be written to after creation. Passed as the `prompt` to `query()` so the SDK reads messages from it as they arrive.

```
new StreamingPrompt(initialMessage)
  → buffers initialMessage immediately

.write(content)
  → if a consumer is waiting: resolves the pending iterator next() call immediately
  → otherwise: pushes to internal queue

.close()
  → signals iterator done to any waiting consumers
  → no-op on further write() calls

[Symbol.asyncIterator]
  → if queue has messages: return next from queue
  → if queue is empty and not closed: suspend until write() or close()
  → if closed: return { done: true }
```

### Message Map

`toAgentMessages(SDKMessage): AgentMessage[]` — returns an array because one SDK message may produce multiple `AgentMessage`s.

**Mapping rules:**

| SDKMessage type | AgentMessage(s) produced |
|---|---|
| `system` | `[SystemInfoMessage]` — `session_id` becomes `sessionId` |
| `assistant` with text block | `[AssistantMessage]` with `{ type: "text" }` part |
| `assistant` with thinking block | `AssistantMessage` with `{ type: "thinking" }` part (field: `block.thinking`, not `block.text`) |
| `assistant` with tool_use block | `AssistantMessage` with `{ type: "tool_call" }` part **+** `ToolUseMessage` |
| `user` with string content | `[UserMessage]` — injected message |
| `user` with tool_result array | `[ToolResultMessage, ...]` — one per result block |
| `result` | `[SessionResultMessage]` — `subtype` maps to `FinishReason` |
| `status`, `rate_limit` | `[]` — not surfaced |

**FinishReason mapping:**

| SDK `result.subtype` | `FinishReason` |
|---|---|
| `"success"` | `"end_turn"` |
| `"error_max_turns"` | `"max_turns"` |
| `"interrupted"` | `"stopped"` |
| anything else | `"error"` |

**TokenUsage:** Cache fields (`cache_read_input_tokens`, `cache_creation_input_tokens`) are included only when present and non-zero. Never fabricated as 0.

**Unknown message types:** Return `[]`. Never throw. The SDK may add new message types in future versions; silent discard is safer than crashing.

## settingSources Decision

Cyrus uses `["user", "project", "local"]` — explicitly restoring the `"user"` source after a regression removed it. This means user-level hooks (Superpowers, custom slash commands, `~/.claude/hooks/`) load in every session.

This fork defaults to `["project", "local"]` for automated runs. Rationale:
- User hooks are designed for interactive sessions, not headless automation
- Hooks like Superpowers inject their own behavior that conflicts with tightly controlled agent workflows
- Per-role `WorkspaceProfile` (future) will write the appropriate project-level settings before each session

To restore user-level settings for a specific session, pass via `providerOptions`:
```typescript
providerOptions: {
  claude: { settingSources: ["user", "project", "local"] }
}
```
