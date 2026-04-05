import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@paisti/core";
import { SqliteAgentMessageWriter } from "./sqlite-agent-message-writer.js";

const systemMsg: AgentMessage = {
	type: "system",
	provider: "claude",
	sessionId: "ses-1",
	model: "claude-opus-4-6",
	tools: []
};

const resultMsg: AgentMessage = {
	type: "result",
	provider: "claude",
	sessionId: "ses-1",
	finishReason: "end_turn",
	durationMs: 500
};

let writer: SqliteAgentMessageWriter;

beforeEach(() => {
	writer = new SqliteAgentMessageWriter(":memory:");
});

describe("writeMessage + getMessages", () => {
	it("returns empty array for unknown session", async () => {
		expect(await writer.getMessages("unknown")).toEqual([]);
	});

	it("persists a message and returns it", async () => {
		await writer.writeMessage("ses-1", 1, systemMsg);
		const stored = await writer.getMessages("ses-1");
		expect(stored).toHaveLength(1);
		expect(stored[0].sessionId).toBe("ses-1");
		expect(stored[0].sequence).toBe(1);
		expect(stored[0].message).toEqual(systemMsg);
	});

	it("returns messages in sequence order", async () => {
		await writer.writeMessage("ses-1", 2, resultMsg);
		await writer.writeMessage("ses-1", 1, systemMsg);
		const stored = await writer.getMessages("ses-1");
		expect(stored[0].sequence).toBe(1);
		expect(stored[1].sequence).toBe(2);
	});

	it("isolates messages by session", async () => {
		await writer.writeMessage("ses-1", 1, systemMsg);
		await writer.writeMessage("ses-2", 1, resultMsg);
		expect(await writer.getMessages("ses-1")).toHaveLength(1);
		expect(await writer.getMessages("ses-2")).toHaveLength(1);
	});
});
