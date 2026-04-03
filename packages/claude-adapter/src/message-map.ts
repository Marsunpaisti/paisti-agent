import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKSystemMessage,
	SDKUserMessage,
	SDKUserMessageReplay
} from "@anthropic-ai/claude-agent-sdk";
import type {
	AgentMessage,
	AssistantMessage,
	AssistantPart,
	FinishReason,
	SessionResultMessage,
	SystemInfoMessage,
	ToolResultMessage,
	ToolUseMessage,
	UserMessage
} from "@paisti/core";

/**
 * Maps a single SDKMessage to zero or more normalized AgentMessages.
 * Returns an array because one SDK message may produce multiple outputs
 * (e.g. an assistant turn with a tool_use block → AssistantMessage + ToolUseMessage).
 *
 * SDK types never escape this function — only AgentMessage types are returned.
 */
export function toAgentMessages(raw: SDKMessage, provider: string): AgentMessage[] {
	switch (raw.type) {
		case "system":
			return fromSystem(raw, provider);
		case "assistant":
			return fromAssistant(raw, provider);
		case "user":
			return fromUser(raw as SDKUserMessage | SDKUserMessageReplay, provider);
		case "result":
			return [fromResult(raw, provider)];
		default:
			// status, rate_limit_event, stream_event, and all other system subtypes
			return [];
	}
}

// ─── system ──────────────────────────────────────────────────────────────────

function fromSystem(
	raw: Extract<SDKMessage, { type: "system" }>,
	provider: string
): AgentMessage[] {
	if (raw.subtype !== "init") return [];
	const msg = raw as SDKSystemMessage;
	const out: SystemInfoMessage = {
		type: "system",
		provider,
		sessionId: msg.session_id,
		model: msg.model,
		tools: msg.tools
	};
	return [out];
}

// ─── assistant ───────────────────────────────────────────────────────────────

function fromAssistant(raw: SDKAssistantMessage, provider: string): AgentMessage[] {
	const { message, session_id } = raw;
	const parts: AssistantPart[] = [];
	const toolUseMessages: ToolUseMessage[] = [];

	for (const block of message.content) {
		if (block.type === "text") {
			parts.push({ type: "text", text: block.text });
		} else if (block.type === "thinking") {
			// BetaThinkingBlock uses `.thinking` field (not `.text`)
			parts.push({ type: "thinking", text: block.thinking });
		} else if (block.type === "tool_use") {
			parts.push({ type: "tool_call", callId: block.id, toolName: block.name, input: block.input });
			toolUseMessages.push({
				type: "tool_use",
				provider,
				sessionId: session_id,
				callId: block.id,
				toolName: block.name,
				input: block.input
			});
		}
		// Ignore server_tool_use, redacted_thinking, and any future block types
	}

	const usage = message.usage
		? {
				input: message.usage.input_tokens,
				output: message.usage.output_tokens,
				...(message.usage.cache_read_input_tokens
					? { cacheRead: message.usage.cache_read_input_tokens }
					: {}),
				...(message.usage.cache_creation_input_tokens
					? { cacheWrite: message.usage.cache_creation_input_tokens }
					: {})
			}
		: undefined;

	const assistantMsg: AssistantMessage = {
		type: "assistant",
		provider,
		sessionId: session_id,
		parts,
		...(usage ? { usage } : {}),
		raw: message
	};

	return [assistantMsg, ...toolUseMessages];
}

// ─── user ─────────────────────────────────────────────────────────────────────

function fromUser(raw: SDKUserMessage | SDKUserMessageReplay, provider: string): AgentMessage[] {
	const { message, session_id } = raw;
	const sessionId = session_id ?? "";

	// String content = injected user message
	if (typeof message.content === "string") {
		const out: UserMessage = {
			type: "user",
			provider,
			sessionId,
			content: message.content
		};
		return [out];
	}

	// Array content — scan for tool_result blocks
	const toolResults: ToolResultMessage[] = [];
	for (const block of message.content as unknown as Array<{
		type: string;
		[key: string]: unknown;
	}>) {
		if (block.type === "tool_result") {
			const content =
				typeof block.content === "string"
					? block.content
					: Array.isArray(block.content)
						? (block.content as Array<{ type: string; text?: string }>)
								.filter((b) => b.type === "text")
								.map((b) => b.text ?? "")
								.join("")
						: "";
			toolResults.push({
				type: "tool_result",
				provider,
				sessionId,
				callId: block.tool_use_id as string,
				output: content,
				isError: Boolean(block.is_error)
			});
		}
	}

	return toolResults;
}

// ─── result ───────────────────────────────────────────────────────────────────

function fromResult(raw: SDKResultMessage, provider: string): SessionResultMessage {
	const finishReason = resolveFinishReason(raw.subtype);
	const usage = raw.usage
		? {
				input: raw.usage.input_tokens,
				output: raw.usage.output_tokens,
				...(raw.usage.cache_read_input_tokens
					? { cacheRead: raw.usage.cache_read_input_tokens }
					: {}),
				...(raw.usage.cache_creation_input_tokens
					? { cacheWrite: raw.usage.cache_creation_input_tokens }
					: {})
			}
		: undefined;

	return {
		type: "result",
		provider,
		sessionId: raw.session_id,
		finishReason,
		durationMs: raw.duration_ms,
		summary: raw.subtype === "success" ? raw.result : undefined,
		...(usage ? { usage } : {})
	};
}

function resolveFinishReason(subtype: string): FinishReason {
	switch (subtype) {
		case "success":
			return "end_turn";
		case "error_max_turns":
			return "max_turns";
		case "interrupted":
			return "stopped";
		default:
			return "error";
	}
}
