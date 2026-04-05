import type { IAgentMessageReader } from "@paisti/core";
import { Hono } from "hono";
import type { RunnerService } from "../services/runner-service.js";

export interface ISseRegistrar {
	register(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array>): void;
	unregister(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array>): void;
}

export function sessionsRouter(
	agentMessageStore: IAgentMessageReader | undefined,
	sseBroadcaster: ISseRegistrar | undefined,
	runnerService: RunnerService
): Hono {
	const router = new Hono();

	router.get("/:id/messages", async (c) => {
		const sessionId = c.req.param("id");
		if (!agentMessageStore) return c.json([]);
		const messages = await agentMessageStore.getMessages(sessionId);
		return c.json(messages);
	});

	router.get("/:id/stream", (c) => {
		const sessionId = c.req.param("id");
		if (!runnerService.isSessionActive(sessionId)) {
			return c.json({ error: "Session not active" }, 404);
		}

		let ctrl: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				ctrl = controller;
				sseBroadcaster?.register(sessionId, controller);
			},
			cancel: () => {
				sseBroadcaster?.unregister(sessionId, ctrl);
			}
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive"
			}
		});
	});

	return router;
}
