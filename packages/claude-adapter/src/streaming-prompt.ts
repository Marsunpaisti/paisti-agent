import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * An AsyncIterable<SDKUserMessage> that can be written to after creation.
 * Passed as the `prompt` to query() so the SDK reads messages as they arrive.
 *
 * Implements the streaming injection pattern from the adapter spec:
 * - Buffers the initial user prompt immediately on construction
 * - write() enqueues additional messages mid-session (injection)
 * - close() signals the iterator as done
 */
export class StreamingPrompt implements AsyncIterable<SDKUserMessage> {
	private readonly queue: SDKUserMessage[] = [];
	private pendingResolve: (() => void) | null = null;
	private closed = false;

	constructor(initialMessage: string) {
		this.queue.push(this.makeUserMessage(initialMessage));
	}

	write(content: string): void {
		if (this.closed) return;
		this.queue.push(this.makeUserMessage(content));
		if (this.pendingResolve) {
			const resolve = this.pendingResolve;
			this.pendingResolve = null;
			resolve();
		}
	}

	close(): void {
		this.closed = true;
		if (this.pendingResolve) {
			const resolve = this.pendingResolve;
			this.pendingResolve = null;
			resolve();
		}
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.closed) {
				return;
			} else {
				await new Promise<void>((resolve) => {
					this.pendingResolve = resolve;
				});
			}
		}
	}

	private makeUserMessage(content: string): SDKUserMessage {
		return {
			type: "user",
			message: { role: "user", content },
			parent_tool_use_id: null
		};
	}
}
