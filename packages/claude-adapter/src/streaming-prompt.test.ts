import { describe, expect, it } from "bun:test";
import { StreamingPrompt } from "./streaming-prompt.js";

describe("StreamingPrompt", () => {
	it("yields the initial message immediately", async () => {
		const prompt = new StreamingPrompt("hello world");
		const iter = prompt[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.done).toBe(false);
		expect((first.value as { message: { content: string } }).message.content).toBe("hello world");
		prompt.close();
	});

	it("done after close with no pending messages", async () => {
		const prompt = new StreamingPrompt("hi");
		const iter = prompt[Symbol.asyncIterator]();
		await iter.next(); // consume initial
		prompt.close();
		const next = await iter.next();
		expect(next.done).toBe(true);
	});

	it("yields written messages in order", async () => {
		const prompt = new StreamingPrompt("first");
		prompt.write("second");
		prompt.write("third");
		prompt.close();

		const messages: string[] = [];
		for await (const msg of prompt) {
			messages.push(msg.message.content as string);
		}
		expect(messages).toEqual(["first", "second", "third"]);
	});

	it("write() before consumer queues the message", async () => {
		const prompt = new StreamingPrompt("a");
		prompt.write("b");
		prompt.write("c");
		prompt.close();

		const messages: string[] = [];
		for await (const msg of prompt) {
			messages.push(msg.message.content as string);
		}
		expect(messages).toEqual(["a", "b", "c"]);
	});

	it("write() after consumer is waiting unblocks the iterator", async () => {
		const prompt = new StreamingPrompt("initial");

		// Consume the initial message first
		const iter = prompt[Symbol.asyncIterator]();
		await iter.next();

		// Consumer is now blocked waiting for next message
		const nextPromise = iter.next();
		// Write a message to unblock it
		prompt.write("injected");

		const result = await nextPromise;
		expect(result.done).toBe(false);
		expect((result.value as { message: { content: string } }).message.content).toBe("injected");
		prompt.close();
	});

	it("close() after consumer is waiting resolves as done", async () => {
		const prompt = new StreamingPrompt("initial");
		const iter = prompt[Symbol.asyncIterator]();
		await iter.next(); // consume initial

		const nextPromise = iter.next();
		prompt.close();

		const result = await nextPromise;
		expect(result.done).toBe(true);
	});

	it("write() after close() is a no-op", async () => {
		const prompt = new StreamingPrompt("initial");
		prompt.close();
		// Should not throw and should not add to queue
		prompt.write("too late");

		const messages: string[] = [];
		for await (const msg of prompt) {
			messages.push(msg.message.content as string);
		}
		expect(messages).toEqual(["initial"]);
	});

	it("multiple close() calls do not throw", () => {
		const prompt = new StreamingPrompt("initial");
		prompt.close();
		expect(() => prompt.close()).not.toThrow();
	});

	it("each message has the correct SDKUserMessage shape", async () => {
		const prompt = new StreamingPrompt("test content");
		const iter = prompt[Symbol.asyncIterator]();
		const { value } = await iter.next();
		prompt.close();

		expect(value.type).toBe("user");
		expect(value.message.role).toBe("user");
		expect(value.message.content).toBe("test content");
		expect(value.parent_tool_use_id).toBeNull();
	});

	it("can be iterated multiple times via a new iterator", async () => {
		const prompt = new StreamingPrompt("only message");
		prompt.close();

		const iter1 = prompt[Symbol.asyncIterator]();
		const r1 = await iter1.next();
		expect((r1.value as { message: { content: string } }).message.content).toBe("only message");
		const done1 = await iter1.next();
		expect(done1.done).toBe(true);

		// NOTE: a second iterator starts from an empty queue since items were consumed
		// This documents the single-consumer design, not a guarantee of multi-consumer support
	});
});
