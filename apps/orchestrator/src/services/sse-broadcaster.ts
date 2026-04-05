import type { AgentMessage, IAgentMessageWriter } from "@paisti/core";

const encoder = new TextEncoder();

export class SseBroadcaster implements IAgentMessageWriter {
	private readonly connections = new Map<
		string,
		Set<ReadableStreamDefaultController<Uint8Array>>
	>();

	register(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
		if (!this.connections.has(sessionId)) {
			this.connections.set(sessionId, new Set());
		}
		this.connections.get(sessionId)!.add(controller);
	}

	unregister(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
		const controllers = this.connections.get(sessionId);
		if (controllers) {
			controllers.delete(controller);
			if (controllers.size === 0) {
				this.connections.delete(sessionId);
			}
		}
	}

	async writeMessage(sessionId: string, _sequence: number, message: AgentMessage): Promise<void> {
		const controllers = this.connections.get(sessionId);
		if (!controllers?.size) return;
		const chunk = encoder.encode(`data: ${JSON.stringify(message)}\n\n`);
		for (const ctrl of controllers) {
			try {
				ctrl.enqueue(chunk);
			} catch {
				// controller closed — will be cleaned up on stream cancel
			}
		}
	}

	closeSession(sessionId: string): void {
		const controllers = this.connections.get(sessionId);
		if (!controllers) return;
		for (const ctrl of controllers) {
			try {
				ctrl.close();
			} catch {
				// already closed
			}
		}
		this.connections.delete(sessionId);
	}
}
