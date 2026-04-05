export interface Task {
	id: string;
	title: string;
	status: "open" | "active" | "completed" | "failed" | "stopped";
	createdAt: string;
	updatedAt: string;
}

export interface Session {
	id: string;
	taskId: string;
	status: "active" | "completed" | "failed" | "stopped";
	systemPrompt?: string;
	providerSessionId?: string;
	startedAt: string;
	completedAt?: string;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export type AssistantPart =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool_call"; callId: string; toolName: string; input: unknown };

export type AgentMessage =
	| { type: "system"; provider: string; sessionId: string; model: string; tools: string[] }
	| { type: "user"; provider: string; sessionId: string; content: string }
	| {
			type: "assistant";
			provider: string;
			sessionId: string;
			parts: AssistantPart[];
			usage?: TokenUsage;
	  }
	| {
			type: "tool_use";
			provider: string;
			sessionId: string;
			callId: string;
			toolName: string;
			input: unknown;
	  }
	| {
			type: "tool_result";
			provider: string;
			sessionId: string;
			callId: string;
			toolName?: string;
			output: string;
			isError: boolean;
	  }
	| {
			type: "result";
			provider: string;
			sessionId: string;
			finishReason: string;
			durationMs: number;
			summary?: string;
			usage?: TokenUsage;
	  };

export interface StoredAgentMessage {
	sessionId: string;
	sequence: number;
	message: AgentMessage;
}

export interface TaskAssignedEvent {
	type: "task_assigned";
	taskRef: { platform: string; id: string };
	title: string;
	initialMessage: string;
}
