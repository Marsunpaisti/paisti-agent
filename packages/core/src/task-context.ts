import type { OrchestrationTask } from "./orchestration-task.js";

export interface ITaskContextProvider {
	/**
	 * Assemble a context string for a new session on the given task.
	 * The caller already holds the task object — no need to re-fetch it.
	 */
	assembleContext(task: OrchestrationTask): Promise<string>;
}
