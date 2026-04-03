export interface TokenUsage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface SystemInfoMessage {
	type: "system";
	provider: string;
	sessionId: string;
	model: string;
	tools: string[];
}

export interface UserMessage {
	type: "user";
	provider: string;
	sessionId: string;
	content: string;
}

export type AssistantPart =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool_call"; callId: string; toolName: string; input: unknown };

export interface AssistantMessage {
	type: "assistant";
	provider: string;
	sessionId: string;
	parts: AssistantPart[];
	usage?: TokenUsage;
	raw?: unknown;
}

export interface ToolUseMessage {
	type: "tool_use";
	provider: string;
	sessionId: string;
	callId: string;
	toolName: string;
	input: unknown;
}

export interface ToolResultMessage {
	type: "tool_result";
	provider: string;
	sessionId: string;
	callId: string;
	toolName: string;
	output: string;
	isError: boolean;
}

export type FinishReason = "end_turn" | "max_turns" | "stopped" | "error";

export interface SessionResultMessage {
	type: "result";
	provider: string;
	sessionId: string;
	finishReason: FinishReason;
	durationMs: number;
	summary?: string;
	usage?: TokenUsage;
}

export type AgentMessage =
	| SystemInfoMessage
	| UserMessage
	| AssistantMessage
	| ToolUseMessage
	| ToolResultMessage
	| SessionResultMessage;
