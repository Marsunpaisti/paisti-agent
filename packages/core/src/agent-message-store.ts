import type { AgentMessage } from "./agent-messages.js";

export interface StoredAgentMessage {
	sessionId: string;
	sequence: number;
	message: AgentMessage;
}

export interface IAgentMessageWriter {
	writeMessage(sessionId: string, sequence: number, message: AgentMessage): Promise<void>;
	/** Optional lifecycle hook — called when a session ends. */
	closeSession?(sessionId: string): void;
}

export interface IAgentMessageReader {
	getMessages(sessionId: string): Promise<StoredAgentMessage[]>;
}

export interface IAgentMessageStore extends IAgentMessageWriter, IAgentMessageReader {}

export interface ISessionMessageWriter {
	writeMessage(sessionId: string, message: AgentMessage): Promise<void>;
	closeSession(sessionId: string): void;
}
