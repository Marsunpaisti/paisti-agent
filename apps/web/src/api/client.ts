import type { Session, StoredAgentMessage, Task, TaskAssignedEvent } from "./types.js";

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`);
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${path}`);
	return res.json() as Promise<T>;
}

export const client = {
	getTasks: () => get<Task[]>("/tasks"),

	getTask: (id: string) => get<{ task: Task; sessions: Session[] }>(`/tasks/${id}`),

	getSessionMessages: (id: string) => get<StoredAgentMessage[]>(`/sessions/${id}/messages`),

	// POST /events is an inbound-event endpoint, not a REST resource — it lives outside /api
	async submitTask(event: TaskAssignedEvent): Promise<string> {
		const res = await fetch("/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(event)
		});
		if (!res.ok) throw new Error(`Failed to submit task: HTTP ${res.status}`);
		const { taskId } = (await res.json()) as { taskId: string };
		return taskId;
	}
};
