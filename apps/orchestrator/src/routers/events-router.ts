import { Hono } from "hono";
import type { RunnerService } from "../services/runner-service.js";
import type { TaskService } from "../services/task-service.js";
import type { InboundEvent } from "../types/inbound-event.js";

export function eventsRouter(taskService: TaskService, runnerService: RunnerService): Hono {
	const router = new Hono();
	const validTypes = new Set(["task_assigned", "user_comment", "stop_requested"]);

	router.post("/", async (c) => {
		let body: InboundEvent;
		try {
			body = (await c.req.json()) as InboundEvent;
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}

		if (!body || typeof body !== "object" || !validTypes.has(body.type)) {
			return c.json({ error: "Unknown event type" }, 400);
		}

		if (body.type === "task_assigned") {
			// Eagerly create task so GET /api/tasks/:id resolves immediately after the 202
			const task = await taskService.resolveOrCreate(body.taskRef, body.title);
			runnerService.handleEvent(body);
			return c.json({ taskId: task.id }, 202);
		}

		runnerService.handleEvent(body);
		return c.body(null, 202);
	});

	return router;
}
