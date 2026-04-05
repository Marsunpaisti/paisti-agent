import type { AgentMessage, IAgentMessageWriter } from "@paisti/core";

export class MessageService {
	private readonly writers: IAgentMessageWriter[];
	private readonly sequences = new Map<string, number>();

	constructor(writers: IAgentMessageWriter[]) {
		this.writers = writers;
	}

	async writeMessage(sessionId: string, message: AgentMessage): Promise<void> {
		const seq = (this.sequences.get(sessionId) ?? 0) + 1;
		this.sequences.set(sessionId, seq);
		await Promise.all(this.writers.map((w) => w.writeMessage(sessionId, seq, message)));
	}

	closeSession(sessionId: string): void {
		this.sequences.delete(sessionId);
		for (const writer of this.writers) {
			writer.closeSession?.(sessionId);
		}
	}
}
