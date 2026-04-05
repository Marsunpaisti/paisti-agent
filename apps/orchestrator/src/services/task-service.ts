import type { ITaskStore, OrchestrationTask } from "@paisti/core";
import type { TaskRef } from "../types/inbound-event.js";

const CLI_PLATFORM = "cli";

export class TaskService {
	constructor(private readonly taskStore: ITaskStore) {}

	/**
	 * Resolves a TaskRef to an OrchestrationTask in three steps:
	 *  1. getTask(id)                → found: use it (CLI events)
	 *  2. findTaskByBinding(...)     → found: use it (known platform events)
	 *  3. createTask + addBinding    → new task (first-seen platform events)
	 */
	async resolveOrCreate(taskRef: TaskRef, title: string): Promise<OrchestrationTask> {
		if (taskRef.platform === CLI_PLATFORM) {
			const task = await this.taskStore.getTask(taskRef.id);
			if (task) return task;
		}

		const byBinding = await this.taskStore.findTaskByBinding(taskRef.platform, taskRef.id);
		if (byBinding) return byBinding;

		const task = await this.taskStore.createTask({
			title,
			...(taskRef.platform === CLI_PLATFORM ? { id: taskRef.id } : {})
		});
		if (taskRef.platform !== CLI_PLATFORM) {
			await this.taskStore.addBinding({
				taskId: task.id,
				platform: taskRef.platform,
				externalId: taskRef.id,
				role: "source"
			});
		}
		return task;
	}

	async resolve(taskRef: TaskRef): Promise<OrchestrationTask | null> {
		if (taskRef.platform === CLI_PLATFORM) {
			return this.taskStore.getTask(taskRef.id);
		}
		return this.taskStore.findTaskByBinding(taskRef.platform, taskRef.id);
	}
}
