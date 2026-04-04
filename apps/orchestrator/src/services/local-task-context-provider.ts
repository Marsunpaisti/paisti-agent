import type {
	ISessionStore,
	ITaskContextProvider,
	ITaskStore,
	OrchestrationTask
} from "@paisti/core";

export class LocalTaskContextProvider implements ITaskContextProvider {
	constructor(
		private readonly taskStore: ITaskStore,
		private readonly sessionStore: ISessionStore
	) {}

	async assembleContext(task: OrchestrationTask): Promise<string> {
		const [bindings, allSessions, messages] = await Promise.all([
			this.taskStore.getBindings(task.id),
			this.sessionStore.listSessions(task.id),
			this.taskStore.getTaskMessages(task.id)
		]);

		const pastSessions = allSessions.filter(
			(s) => s.status === "completed" || s.status === "stopped" || s.status === "failed"
		);

		const lines: string[] = ["## Task context", "", `Task: ${task.title}`];

		if (bindings.length > 0) {
			lines.push("", "External references:");
			for (const b of bindings) {
				const urlSuffix = b.externalUrl ? `: ${b.externalUrl}` : "";
				lines.push(`- ${b.platform} ${b.externalId} [${b.role}]${urlSuffix}`);
			}
		}

		if (pastSessions.length > 0) {
			lines.push("", "Past sessions:");
			for (const s of pastSessions) {
				// completedAt is always set for terminal sessions; startedAt is a safe fallback if not
				const date = (s.completedAt ?? s.startedAt).split("T")[0];
				const rolePrefix = s.role ? `${s.role} ` : "";
				lines.push(`- ${rolePrefix}(${s.status}, ${date})`);
			}
		}

		if (messages.length > 0) {
			lines.push("", "Messages:");
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				const ts = m.timestamp.slice(0, 16);
				// TODO: truncate long message content before injecting into system prompts (Phase 3+)
				lines.push(`${i + 1}. [${m.author}, ${ts}] ${m.content}`);
			}
		}

		return lines.join("\n");
	}
}
