import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@paisti/core";
import { SseBroadcaster } from "./sse-broadcaster.js";

const msg: AgentMessage = {
	type: "system",
	provider: "claude",
	sessionId: "ses-1",
	model: "claude-opus-4-6",
	tools: []
};

describe("SseBroadcaster", () => {
	it("is a no-op when no controllers are registered", async () => {
		const broadcaster = new SseBroadcaster();
		// Should not throw
		await broadcaster.writeMessage("ses-1", 1, msg);
	});

	it("encodes and pushes the message to a registered controller", async () => {
		const broadcaster = new SseBroadcaster();

		const stream = new ReadableStream<Uint8Array>({
			start(ctrl) {
				broadcaster.register("ses-1", ctrl);
			}
		});

		await broadcaster.writeMessage("ses-1", 1, msg);

		const reader = stream.getReader();
		const { value } = await reader.read();
		reader.releaseLock();

		const text = new TextDecoder().decode(value);
		expect(text).toBe(`data: ${JSON.stringify(msg)}\n\n`);
	});

	it("does not push to unregistered session", async () => {
		const broadcaster = new SseBroadcaster();

		const stream = new ReadableStream<Uint8Array>({
			start(ctrl) {
				broadcaster.register("ses-1", ctrl);
			}
		});

		await broadcaster.writeMessage("ses-2", 1, msg);

		// Read with a timeout — nothing should arrive
		const reader = stream.getReader();
		const result = await Promise.race([
			reader.read(),
			new Promise<{ value: undefined; done: false }>((res) =>
				setTimeout(() => res({ value: undefined, done: false }), 50)
			)
		]);
		reader.releaseLock();
		expect(result.value).toBeUndefined();
	});

	it("closeSession closes all controllers for the session", async () => {
		const broadcaster = new SseBroadcaster();

		const stream = new ReadableStream<Uint8Array>({
			start(ctrl) {
				broadcaster.register("ses-1", ctrl);
			}
		});

		broadcaster.closeSession("ses-1");

		const reader = stream.getReader();
		const { done } = await reader.read();
		reader.releaseLock();
		expect(done).toBe(true);
	});
});
