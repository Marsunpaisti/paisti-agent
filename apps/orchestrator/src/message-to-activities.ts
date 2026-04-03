import type { AgentMessage } from "@paisti/core";
import type { Activity } from "./activity.js";

/**
 * Pure function — no I/O. Converts a normalized AgentMessage to zero or more Activity objects.
 *
 * Mapping rules (from orchestrator spec):
 *   SystemInfoMessage     → []
 *   UserMessage           → []
 *   AssistantMessage      → [ThoughtActivity] for each non-empty text part (ephemeral: true)
 *   ToolUseMessage        → [ActionActivity] with human-readable tool description
 *   ToolResultMessage     → [ActionActivity { isError: true }] only on error; silent on success
 *   SessionResultMessage  → []  (response posted separately via postResponse())
 */
export function messageToActivities(message: AgentMessage): Activity[] {
	switch (message.type) {
		case "system":
		case "user":
		case "result":
			return [];

		case "assistant": {
			const activities: Activity[] = [];
			for (const part of message.parts) {
				if (part.type === "text" && part.text.trim().length > 0) {
					activities.push({ type: "thought", text: part.text, ephemeral: true });
				}
			}
			return activities;
		}

		case "tool_use":
			return [
				{
					type: "action",
					description: formatToolDescription(message.toolName, message.input),
					isError: false
				}
			];

		case "tool_result":
			if (!message.isError) return [];
			return [
				{
					type: "action",
					description: formatToolDescription(message.toolName ?? "", {}),
					isError: true
				}
			];
	}
}

/**
 * Formats a tool call into a human-readable description.
 * Named tool branches cover Claude Code built-ins (Phase 1 is Claude-only).
 * Other providers will fall through to the generic first-string-value path.
 */
function formatToolDescription(toolName: string, input: unknown): string {
	if (typeof input !== "object" || input === null) {
		return toolName;
	}

	const inp = input as Record<string, unknown>;

	// Well-known tools with a single primary argument
	if (toolName === "Read" && typeof inp.file_path === "string") {
		return `Read: ${inp.file_path}`;
	}
	if (toolName === "Bash" && typeof inp.command === "string") {
		return truncate(`Bash: ${inp.command}`, 80);
	}
	if (toolName === "Write" && typeof inp.file_path === "string") {
		return `Write: ${inp.file_path}`;
	}
	if (toolName === "Edit" && typeof inp.file_path === "string") {
		return `Edit: ${inp.file_path}`;
	}
	if (toolName === "Glob" && typeof inp.pattern === "string") {
		return `Glob: ${inp.pattern}`;
	}
	if (toolName === "Grep" && typeof inp.pattern === "string") {
		return `Grep: ${inp.pattern}`;
	}

	// Fallback: use the first string-valued property as the argument label
	for (const val of Object.values(inp)) {
		if (typeof val === "string" && val.length > 0) {
			return truncate(`${toolName}: ${val}`, 80);
		}
	}

	return toolName;
}

function truncate(s: string, maxLen: number): string {
	return s.length > maxLen ? `${s.slice(0, maxLen - 3)}...` : s;
}
