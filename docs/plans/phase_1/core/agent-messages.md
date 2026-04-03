# Spec: AgentMessage — Provider-Agnostic Message Format

## Purpose

Defines the canonical message format produced by any `IAgentRunner` implementation. Every provider adapter (Claude, Gemini, Codex, etc.) maps its native event stream to these types at the adapter boundary. Nothing above the adapter layer ever imports a provider SDK.

## Type Definition

```typescript
export type AgentMessage =
  | SystemInfoMessage
  | UserMessage
  | AssistantMessage
  | ToolUseMessage
  | ToolResultMessage
  | SessionResultMessage;
```

### SystemInfoMessage

Emitted at session start. Signals that the provider accepted the run and carries the resolved model and available tools.

```typescript
interface SystemInfoMessage {
  type: "system";
  provider: string;
  sessionId: string;   // provider-native ID — store for resume
  model: string;
  tools: string[];
}
```

### UserMessage

A message from the user — either the initial prompt or an injected mid-session message.

```typescript
interface UserMessage {
  type: "user";
  provider: string;
  sessionId: string;
  content: string;
}
```

### AssistantMessage

One complete assistant turn. Content is represented as an ordered list of `AssistantPart` rather than a monolithic string so callers can distinguish text from tool calls and thinking blocks without parsing.

Tool calls are also emitted as standalone `ToolUseMessage`s (see below) so consumers that only care about tool lifecycle don't need to scan parts.

```typescript
interface AssistantMessage {
  type: "assistant";
  provider: string;
  sessionId: string;
  parts: AssistantPart[];
  usage?: TokenUsage;
  raw?: unknown;        // original provider event — debug only, never branch on
}

type AssistantPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; callId: string; toolName: string; input: unknown };
```

### ToolUseMessage / ToolResultMessage

Standalone messages for each tool invocation and its result. Mirror the `tool_call` parts in `AssistantMessage` but as first-class messages so the orchestrator can post activity without scanning assistant parts.

```typescript
interface ToolUseMessage {
  type: "tool_use";
  provider: string;
  sessionId: string;
  callId: string;
  toolName: string;
  input: unknown;
}

interface ToolResultMessage {
  type: "tool_result";
  provider: string;
  sessionId: string;
  callId: string;
  toolName: string;
  output: string;
  isError: boolean;
}
```

### SessionResultMessage

Terminal message — always the last item in a `run()` iterable. The iterable completes after this is yielded.

```typescript
interface SessionResultMessage {
  type: "result";
  provider: string;
  sessionId: string;
  finishReason: FinishReason;
  durationMs: number;
  summary?: string;
  usage?: TokenUsage;
}

type FinishReason =
  | "end_turn"    // agent completed normally
  | "max_turns"   // turn limit reached
  | "stopped"     // explicitly stopped by caller
  | "error";      // unrecoverable error
```

### TokenUsage

Cache fields are optional rather than 0 when absent. Fabricating zeroes would mislead cost tracking.

```typescript
interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
```

## Design Decisions

**`provider: string` on every message** — consumers can filter by provider without inspecting `raw`. Avoids `instanceof` checks.

**`raw?: unknown` escape hatch** — present on `AssistantMessage` for debugging. Never used in business logic. Any field worth acting on gets a first-class field.

**Polymorphic `AssistantPart[]`** — preserves the original turn structure (text, thinking, tool calls in order) without a monolithic content object. Adapters for new providers only add new part types; existing consumers ignore unknown parts.

**Dual emission for tool calls** — `AssistantMessage.parts` contains `tool_call` parts for consumers that need the full turn. `ToolUseMessage` is emitted separately for consumers (activity writers) that only react to tool lifecycle events. No duplication in storage — the orchestrator decides which to persist.

**`SessionResultMessage` always terminates** — the `run()` contract guarantees a result message even on error. The caller's `for await` loop always completes cleanly; no special error handling required around the loop.
