import { describe, expect, it } from "bun:test";
import type { AgentMessage, IAgentMessageWriter } from "@paisti/core";
import { MessageService } from "./message-service.js";

class SpyMessageWriter implements IAgentMessageWriter {
	calls: Array<{ sessionId: string; sequence: number; message: AgentMessage }> = [];
	async writeMessage(sessionId: string, sequence: number, message: AgentMessage): Promise<void> {
		this.calls.push({ sessionId, sequence, message });
	}
}

const msg: AgentMessage = {
	type: "system",
	provider: "claude",
	sessionId: "ses-1",
	model: "claude-opus-4-6",
	tools: []
};

describe("MessageService", () => {
	it("fans out to all writers", async () => {
		const a = new SpyMessageWriter();
		const b = new SpyMessageWriter();
		const svc = new MessageService([a, b]);
		await svc.writeMessage("ses-1", msg);
		expect(a.calls).toHaveLength(1);
		expect(b.calls).toHaveLength(1);
	});

	it("assigns sequence 1 to the first message", async () => {
		const spy = new SpyMessageWriter();
		const svc = new MessageService([spy]);
		await svc.writeMessage("ses-1", msg);
		expect(spy.calls[0].sequence).toBe(1);
	});

	it("increments sequence per session", async () => {
		const spy = new SpyMessageWriter();
		const svc = new MessageService([spy]);
		await svc.writeMessage("ses-1", msg);
		await svc.writeMessage("ses-1", msg);
		expect(spy.calls[0].sequence).toBe(1);
		expect(spy.calls[1].sequence).toBe(2);
	});

	it("sequences are independent per session", async () => {
		const spy = new SpyMessageWriter();
		const svc = new MessageService([spy]);
		await svc.writeMessage("ses-1", msg);
		await svc.writeMessage("ses-2", msg);
		expect(spy.calls.find((c) => c.sessionId === "ses-1")?.sequence).toBe(1);
		expect(spy.calls.find((c) => c.sessionId === "ses-2")?.sequence).toBe(1);
	});
});
