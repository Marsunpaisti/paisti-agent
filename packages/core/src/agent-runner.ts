import type { AgentMessage } from "./agent-messages.js";

export type McpServerConfig =
	| { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
	| { type: "http"; url: string; headers?: Record<string, string> };

export interface RunConfig {
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

export interface IAgentRunner {
	run(config: RunConfig): AsyncIterable<AgentMessage>;
	inject?(content: string): void;
	readonly supportsInjection: boolean;
	stop(): Promise<void>;
}
