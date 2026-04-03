import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@paisti/core";
import type { ActionActivity, ThoughtActivity } from "./activity.js";
import { messageToActivities } from "./message-to-activities.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

const PROVIDER = "claude";
const SESSION = "ses_1";

function toolUse(toolName: string, input: unknown): AgentMessage {
	return {
		type: "tool_use",
		provider: PROVIDER,
		sessionId: SESSION,
		callId: "c1",
		toolName,
		input,
	};
}

function toolResult(toolName: string, isError: boolean): AgentMessage {
	return {
		type: "tool_result",
		provider: PROVIDER,
		sessionId: SESSION,
		callId: "c1",
		toolName,
		output: "out",
		isError,
	};
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("messageToActivities", () => {
	describe("silent message types", () => {
		it("SystemInfoMessage → []", () => {
			const msg: AgentMessage = {
				type: "system",
				provider: PROVIDER,
				sessionId: SESSION,
				model: "claude-opus-4-6",
				tools: ["Read", "Write"],
			};
			expect(messageToActivities(msg)).toEqual([]);
		});

		it("UserMessage → []", () => {
			const msg: AgentMessage = {
				type: "user",
				provider: PROVIDER,
				sessionId: SESSION,
				content: "hello",
			};
			expect(messageToActivities(msg)).toEqual([]);
		});

		it("SessionResultMessage → []", () => {
			const msg: AgentMessage = {
				type: "result",
				provider: PROVIDER,
				sessionId: SESSION,
				finishReason: "end_turn",
				durationMs: 1200,
			};
			expect(messageToActivities(msg)).toEqual([]);
		});
	});

	describe("AssistantMessage", () => {
		it("produces a ThoughtActivity for each non-empty text part", () => {
			const msg: AgentMessage = {
				type: "assistant",
				provider: PROVIDER,
				sessionId: SESSION,
				parts: [
					{ type: "text", text: "I'll look at the file first." },
					{ type: "text", text: "Then fix the bug." },
				],
			};
			const activities = messageToActivities(msg);
			expect(activities).toHaveLength(2);
			expect(activities[0]).toEqual<ThoughtActivity>({
				type: "thought",
				text: "I'll look at the file first.",
				ephemeral: true,
			});
			expect(activities[1]).toEqual<ThoughtActivity>({
				type: "thought",
				text: "Then fix the bug.",
				ephemeral: true,
			});
		});

		it("skips whitespace-only text parts", () => {
			const msg: AgentMessage = {
				type: "assistant",
				provider: PROVIDER,
				sessionId: SESSION,
				parts: [{ type: "text", text: "   \n\t  " }],
			};
			expect(messageToActivities(msg)).toEqual([]);
		});

		it("skips thinking parts", () => {
			const msg: AgentMessage = {
				type: "assistant",
				provider: PROVIDER,
				sessionId: SESSION,
				parts: [{ type: "thinking", text: "internal reasoning..." }],
			};
			expect(messageToActivities(msg)).toEqual([]);
		});

		it("skips tool_call parts (those surface as ToolUseMessage instead)", () => {
			const msg: AgentMessage = {
				type: "assistant",
				provider: PROVIDER,
				sessionId: SESSION,
				parts: [{ type: "tool_call", callId: "c1", toolName: "Bash", input: { command: "ls" } }],
			};
			expect(messageToActivities(msg)).toEqual([]);
		});

		it("mixes text and non-text parts — only text produces activities", () => {
			const msg: AgentMessage = {
				type: "assistant",
				provider: PROVIDER,
				sessionId: SESSION,
				parts: [
					{ type: "thinking", text: "hm..." },
					{ type: "text", text: "Let me check the logs." },
					{ type: "tool_call", callId: "c1", toolName: "Read", input: { file_path: "log.txt" } },
				],
			};
			const activities = messageToActivities(msg);
			expect(activities).toHaveLength(1);
			expect(activities[0]).toMatchObject({ type: "thought", text: "Let me check the logs." });
		});

		it("returns [] for an assistant message with no parts", () => {
			const msg: AgentMessage = {
				type: "assistant",
				provider: PROVIDER,
				sessionId: SESSION,
				parts: [],
			};
			expect(messageToActivities(msg)).toEqual([]);
		});
	});

	describe("ToolUseMessage — description formatting", () => {
		it("Read: uses file_path", () => {
			const activity = messageToActivities(toolUse("Read", { file_path: "src/auth.ts" }))[0];
			expect((activity as ActionActivity).description).toBe("Read: src/auth.ts");
		});

		it("Write: uses file_path", () => {
			const activity = messageToActivities(toolUse("Write", { file_path: "src/auth.ts" }))[0];
			expect((activity as ActionActivity).description).toBe("Write: src/auth.ts");
		});

		it("Edit: uses file_path", () => {
			const activity = messageToActivities(toolUse("Edit", { file_path: "src/auth.ts" }))[0];
			expect((activity as ActionActivity).description).toBe("Edit: src/auth.ts");
		});

		it("Glob: uses pattern", () => {
			const activity = messageToActivities(toolUse("Glob", { pattern: "**/*.ts" }))[0];
			expect((activity as ActionActivity).description).toBe("Glob: **/*.ts");
		});

		it("Grep: uses pattern", () => {
			const activity = messageToActivities(toolUse("Grep", { pattern: "import.*auth" }))[0];
			expect((activity as ActionActivity).description).toBe("Grep: import.*auth");
		});

		it("Bash: uses command", () => {
			const activity = messageToActivities(toolUse("Bash", { command: "npm test" }))[0];
			expect((activity as ActionActivity).description).toBe("Bash: npm test");
		});

		it("Bash: truncates command at 80 chars", () => {
			const longCmd = "a".repeat(100);
			const activity = messageToActivities(toolUse("Bash", { command: longCmd }))[0];
			const desc = (activity as ActionActivity).description;
			expect(desc.length).toBe(80);
			expect(desc.endsWith("...")).toBe(true);
		});

		it("Bash: does not truncate a 80-char command", () => {
			// "Bash: " (6) + 74 chars = 80 exactly — no truncation
			const cmd = "b".repeat(74);
			const activity = messageToActivities(toolUse("Bash", { command: cmd }))[0];
			expect((activity as ActionActivity).description).toBe(`Bash: ${cmd}`);
		});

		it("unknown tool with string-valued property: uses first string value", () => {
			const activity = messageToActivities(
				toolUse("CustomTool", { url: "https://example.com" }),
			)[0];
			expect((activity as ActionActivity).description).toBe("CustomTool: https://example.com");
		});

		it("unknown tool with no string values: returns tool name only", () => {
			const activity = messageToActivities(toolUse("CustomTool", { count: 5, enabled: true }))[0];
			expect((activity as ActionActivity).description).toBe("CustomTool");
		});

		it("tool with null input: returns tool name only", () => {
			const activity = messageToActivities(toolUse("CustomTool", null))[0];
			expect((activity as ActionActivity).description).toBe("CustomTool");
		});

		it("tool with non-object input (number): returns tool name only", () => {
			const activity = messageToActivities(toolUse("CustomTool", 42))[0];
			expect((activity as ActionActivity).description).toBe("CustomTool");
		});

		it("always produces isError: false", () => {
			const activity = messageToActivities(toolUse("Bash", { command: "ls" }))[0];
			expect((activity as ActionActivity).isError).toBe(false);
		});
	});

	describe("ToolResultMessage", () => {
		it("success result → [] (silent)", () => {
			expect(messageToActivities(toolResult("Bash", false))).toEqual([]);
		});

		it("error result → ActionActivity with isError: true", () => {
			const activities = messageToActivities(toolResult("Bash", true));
			expect(activities).toHaveLength(1);
			expect((activities[0] as ActionActivity).type).toBe("action");
			expect((activities[0] as ActionActivity).isError).toBe(true);
		});
	});
});
