import { describe, expect, it } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
	AssistantMessage,
	SessionResultMessage,
	SystemInfoMessage,
	ToolResultMessage,
	ToolUseMessage,
	UserMessage,
} from "@paisti/core";
import { toAgentMessages } from "./message-map.js";

// Casting helpers — we only provide the fields toAgentMessages() actually reads.
// Unused required fields (uuid, etc.) are intentionally omitted via cast.
function sdk(partial: Record<string, unknown>): SDKMessage {
	return partial as unknown as SDKMessage;
}

const PROVIDER = "claude";
const SESSION = "ses_abc";

// ─── system ───────────────────────────────────────────────────────────────────

describe("system messages", () => {
	it("maps init message to SystemInfoMessage", () => {
		const raw = sdk({
			type: "system",
			subtype: "init",
			session_id: SESSION,
			model: "claude-opus-4-6",
			tools: ["Read", "Write", "Bash"],
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		expect(msgs).toHaveLength(1);
		const msg = msgs[0] as SystemInfoMessage;
		expect(msg.type).toBe("system");
		expect(msg.provider).toBe(PROVIDER);
		expect(msg.sessionId).toBe(SESSION);
		expect(msg.model).toBe("claude-opus-4-6");
		expect(msg.tools).toEqual(["Read", "Write", "Bash"]);
	});

	it("ignores non-init system subtypes", () => {
		const raw = sdk({ type: "system", subtype: "task_notification", session_id: SESSION });
		expect(toAgentMessages(raw, PROVIDER)).toEqual([]);
	});
});

// ─── assistant ────────────────────────────────────────────────────────────────

describe("assistant messages", () => {
	it("maps text block to AssistantMessage with text part", () => {
		const raw = sdk({
			type: "assistant",
			session_id: SESSION,
			message: {
				content: [{ type: "text", text: "I will help you." }],
			},
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		expect(msgs).toHaveLength(1);
		const msg = msgs[0] as AssistantMessage;
		expect(msg.type).toBe("assistant");
		expect(msg.provider).toBe(PROVIDER);
		expect(msg.sessionId).toBe(SESSION);
		expect(msg.parts).toHaveLength(1);
		expect(msg.parts[0]).toEqual({ type: "text", text: "I will help you." });
	});

	it("maps thinking block using the .thinking field (not .text)", () => {
		const raw = sdk({
			type: "assistant",
			session_id: SESSION,
			message: {
				content: [{ type: "thinking", thinking: "internal reasoning here" }],
			},
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		const msg = msgs[0] as AssistantMessage;
		expect(msg.parts[0]).toEqual({ type: "thinking", text: "internal reasoning here" });
	});

	it("maps tool_use block to both AssistantMessage part and standalone ToolUseMessage", () => {
		const raw = sdk({
			type: "assistant",
			session_id: SESSION,
			message: {
				content: [
					{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "src/auth.ts" } },
				],
			},
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		expect(msgs).toHaveLength(2);

		const assistant = msgs[0] as AssistantMessage;
		expect(assistant.type).toBe("assistant");
		expect(assistant.parts[0]).toEqual({
			type: "tool_call",
			callId: "tu_1",
			toolName: "Read",
			input: { file_path: "src/auth.ts" },
		});

		const toolUse = msgs[1] as ToolUseMessage;
		expect(toolUse.type).toBe("tool_use");
		expect(toolUse.callId).toBe("tu_1");
		expect(toolUse.toolName).toBe("Read");
		expect(toolUse.input).toEqual({ file_path: "src/auth.ts" });
		expect(toolUse.sessionId).toBe(SESSION);
	});

	it("handles multiple blocks in one turn — text + tool_use", () => {
		const raw = sdk({
			type: "assistant",
			session_id: SESSION,
			message: {
				content: [
					{ type: "text", text: "Let me read the file." },
					{ type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "src/auth.ts" } },
				],
			},
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		// AssistantMessage + ToolUseMessage
		expect(msgs).toHaveLength(2);
		const assistant = msgs[0] as AssistantMessage;
		expect(assistant.parts).toHaveLength(2);
		expect(assistant.parts[0].type).toBe("text");
		expect(assistant.parts[1].type).toBe("tool_call");
	});

	it("includes usage when present", () => {
		const raw = sdk({
			type: "assistant",
			session_id: SESSION,
			message: {
				content: [{ type: "text", text: "hi" }],
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		});
		const msg = toAgentMessages(raw, PROVIDER)[0] as AssistantMessage;
		expect(msg.usage).toMatchObject({ input: 100, output: 50 });
	});

	it("omits cacheRead when cache_read_input_tokens is 0", () => {
		const raw = sdk({
			type: "assistant",
			session_id: SESSION,
			message: {
				content: [{ type: "text", text: "hi" }],
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		});
		const msg = toAgentMessages(raw, PROVIDER)[0] as AssistantMessage;
		expect(msg.usage?.cacheRead).toBeUndefined();
	});

	it("includes cacheRead when non-zero", () => {
		const raw = sdk({
			type: "assistant",
			session_id: SESSION,
			message: {
				content: [{ type: "text", text: "hi" }],
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_read_input_tokens: 200,
					cache_creation_input_tokens: 0,
				},
			},
		});
		const msg = toAgentMessages(raw, PROVIDER)[0] as AssistantMessage;
		expect(msg.usage?.cacheRead).toBe(200);
	});

	it("includes cacheWrite when non-zero", () => {
		const raw = sdk({
			type: "assistant",
			session_id: SESSION,
			message: {
				content: [{ type: "text", text: "hi" }],
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 50,
				},
			},
		});
		const msg = toAgentMessages(raw, PROVIDER)[0] as AssistantMessage;
		expect(msg.usage?.cacheWrite).toBe(50);
	});

	it("omits usage entirely when not present on message", () => {
		const raw = sdk({
			type: "assistant",
			session_id: SESSION,
			message: { content: [{ type: "text", text: "hi" }] },
		});
		const msg = toAgentMessages(raw, PROVIDER)[0] as AssistantMessage;
		expect(msg.usage).toBeUndefined();
	});

	it("attaches raw message for debugging", () => {
		const content = [{ type: "text", text: "hi" }];
		const raw = sdk({ type: "assistant", session_id: SESSION, message: { content } });
		const msg = toAgentMessages(raw, PROVIDER)[0] as AssistantMessage;
		expect(msg.raw).toBeDefined();
	});

	it("ignores unknown block types", () => {
		const raw = sdk({
			type: "assistant",
			session_id: SESSION,
			message: {
				content: [
					{ type: "server_tool_use", id: "x", name: "WebSearch", input: {} },
					{ type: "text", text: "result" },
				],
			},
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		const assistant = msgs[0] as AssistantMessage;
		// Only the text part should be in parts — unknown block types are ignored
		expect(assistant.parts.filter((p) => p.type === "text")).toHaveLength(1);
		expect(assistant.parts.filter((p) => p.type === ("server_tool_use" as string))).toHaveLength(0);
	});
});

// ─── user ─────────────────────────────────────────────────────────────────────

describe("user messages", () => {
	it("maps string content to UserMessage (injected message)", () => {
		const raw = sdk({
			type: "user",
			session_id: SESSION,
			message: { role: "user", content: "Please also check the tests" },
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		expect(msgs).toHaveLength(1);
		const msg = msgs[0] as UserMessage;
		expect(msg.type).toBe("user");
		expect(msg.content).toBe("Please also check the tests");
		expect(msg.sessionId).toBe(SESSION);
	});

	it("maps tool_result array to ToolResultMessage[] — success result", () => {
		const raw = sdk({
			type: "user",
			session_id: SESSION,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tu_1",
						content: "file contents here",
						is_error: false,
					},
				],
			},
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		expect(msgs).toHaveLength(1);
		const msg = msgs[0] as ToolResultMessage;
		expect(msg.type).toBe("tool_result");
		expect(msg.callId).toBe("tu_1");
		expect(msg.output).toBe("file contents here");
		expect(msg.isError).toBe(false);
		expect(msg.sessionId).toBe(SESSION);
	});

	it("maps tool_result with is_error: true to isError: true", () => {
		const raw = sdk({
			type: "user",
			session_id: SESSION,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tu_2",
						content: "command not found",
						is_error: true,
					},
				],
			},
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		expect((msgs[0] as ToolResultMessage).isError).toBe(true);
	});

	it("extracts text from content-array tool_result output", () => {
		const raw = sdk({
			type: "user",
			session_id: SESSION,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tu_3",
						content: [
							{ type: "text", text: "line one" },
							{ type: "text", text: "line two" },
						],
						is_error: false,
					},
				],
			},
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		expect((msgs[0] as ToolResultMessage).output).toBe("line oneline two");
	});

	it("maps multiple tool_result blocks to multiple ToolResultMessages", () => {
		const raw = sdk({
			type: "user",
			session_id: SESSION,
			message: {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "tu_1", content: "out1", is_error: false },
					{ type: "tool_result", tool_use_id: "tu_2", content: "out2", is_error: true },
				],
			},
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		expect(msgs).toHaveLength(2);
		expect((msgs[0] as ToolResultMessage).callId).toBe("tu_1");
		expect((msgs[1] as ToolResultMessage).callId).toBe("tu_2");
	});

	it("falls back to empty sessionId when session_id is absent", () => {
		const raw = sdk({
			type: "user",
			// no session_id
			message: { role: "user", content: "hello" },
		});
		const msgs = toAgentMessages(raw, PROVIDER);
		expect((msgs[0] as UserMessage).sessionId).toBe("");
	});
});

// ─── result ───────────────────────────────────────────────────────────────────

describe("result messages", () => {
	function resultMsg(subtype: string, extra: Record<string, unknown> = {}): SDKMessage {
		return sdk({
			type: "result",
			subtype,
			session_id: SESSION,
			duration_ms: 1500,
			usage: {
				input_tokens: 100,
				output_tokens: 40,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			...extra,
		});
	}

	it("maps success subtype to end_turn finishReason", () => {
		const msgs = toAgentMessages(resultMsg("success", { result: "All done." }), PROVIDER);
		const msg = msgs[0] as SessionResultMessage;
		expect(msg.type).toBe("result");
		expect(msg.finishReason).toBe("end_turn");
	});

	it("maps error_max_turns to max_turns", () => {
		const msg = toAgentMessages(resultMsg("error_max_turns"), PROVIDER)[0] as SessionResultMessage;
		expect(msg.finishReason).toBe("max_turns");
	});

	it("maps interrupted to stopped", () => {
		const msg = toAgentMessages(resultMsg("interrupted"), PROVIDER)[0] as SessionResultMessage;
		expect(msg.finishReason).toBe("stopped");
	});

	it("maps unknown subtype to error", () => {
		const msg = toAgentMessages(
			resultMsg("error_during_execution"),
			PROVIDER,
		)[0] as SessionResultMessage;
		expect(msg.finishReason).toBe("error");
	});

	it("carries durationMs", () => {
		const msg = toAgentMessages(
			resultMsg("success", { result: "" }),
			PROVIDER,
		)[0] as SessionResultMessage;
		expect(msg.durationMs).toBe(1500);
	});

	it("carries summary from result field on success", () => {
		const msg = toAgentMessages(
			resultMsg("success", { result: "Fixed the bug." }),
			PROVIDER,
		)[0] as SessionResultMessage;
		expect(msg.summary).toBe("Fixed the bug.");
	});

	it("omits summary for non-success subtypes", () => {
		const msg = toAgentMessages(resultMsg("error_max_turns"), PROVIDER)[0] as SessionResultMessage;
		expect(msg.summary).toBeUndefined();
	});

	it("carries session id", () => {
		const msg = toAgentMessages(
			resultMsg("success", { result: "" }),
			PROVIDER,
		)[0] as SessionResultMessage;
		expect(msg.sessionId).toBe(SESSION);
	});
});

// ─── unknown message types ────────────────────────────────────────────────────

describe("unknown / unsurfaced message types", () => {
	it("returns [] for status messages", () => {
		const raw = sdk({ type: "status", subtype: "some_status" });
		expect(toAgentMessages(raw, PROVIDER)).toEqual([]);
	});

	it("returns [] for rate_limit events", () => {
		const raw = sdk({ type: "rate_limit_event" });
		expect(toAgentMessages(raw, PROVIDER)).toEqual([]);
	});

	it("returns [] for completely unknown types — never throws", () => {
		const raw = sdk({ type: "future_message_type_v99" });
		expect(() => toAgentMessages(raw, PROVIDER)).not.toThrow();
		expect(toAgentMessages(raw, PROVIDER)).toEqual([]);
	});
});
