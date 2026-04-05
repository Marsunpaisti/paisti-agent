import type { ISessionStore, ITaskStore } from "@paisti/core";
import { Hono } from "hono";

export function tasksRouter(taskStore: ITaskStore, sessionStore: ISessionStore): Hono {
	const router = new Hono();

	router.get("/", async (c) => {
		const tasks = await taskStore.listTasks();
		return c.json(tasks);
	});

	router.get("/:id", async (c) => {
		const id = c.req.param("id");
		const task = await taskStore.getTask(id);
		if (!task) return c.json({ error: "Not found" }, 404);
		const sessions = await sessionStore.listSessions(id);
		return c.json({ task, sessions });
	});

	router.get("/:id/messages", async (c) => {
		const id = c.req.param("id");
		const task = await taskStore.getTask(id);
		if (!task) return c.json({ error: "Not found" }, 404);
		const messages = await taskStore.getTaskMessages(id);
		return c.json(messages);
	});

	return router;
}
