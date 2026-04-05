import type { AgentMessage } from "./agent-messages.js";

export interface StoredAgentMessage {
	sessionId: string;
	sequence: number;
	message: AgentMessage;
}

export interface IAgentMessageWriter {
	writeMessage(sessionId: string, sequence: number, message: AgentMessage): Promise<void>;
}

export interface IAgentMessageStore extends IAgentMessageWriter {
	getMessages(sessionId: string): Promise<StoredAgentMessage[]>;
}
