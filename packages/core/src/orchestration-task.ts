export type TaskStatus = "open" | "active" | "completed" | "failed" | "archived";

export interface OrchestrationTask {
	id: string;
	slug?: string;
	title: string;
	status: TaskStatus;
	createdAt: string;
	updatedAt: string;
}

export type ExternalBindingRole = "source" | "context" | "artifact";

export interface ExternalBinding {
	id: string;
	taskId: string;
	platform: string;
	externalId: string;
	externalUrl?: string;
	role: ExternalBindingRole;
	boundAt: string;
}

export type TaskMessageSource = { type: "cli" } | { type: "agent"; sessionId: string };

export interface TaskMessage {
	id: string;
	taskId: string;
	content: string;
	author: string;
	timestamp: string;
	source: TaskMessageSource;
}

export interface CreateTaskInput {
	/** When provided, used as the task's local UUID. Callers must ensure uniqueness. */
	id?: string;
	title: string;
	slug?: string;
}

export interface CreateBindingInput {
	taskId: string;
	platform: string;
	externalId: string;
	externalUrl?: string;
	role: ExternalBindingRole;
}

export interface CreateTaskMessageInput {
	taskId: string;
	content: string;
	author: string;
	source: TaskMessageSource;
}

export interface ITaskStore {
	createTask(input: CreateTaskInput): Promise<OrchestrationTask>;
	getTask(id: string): Promise<OrchestrationTask | null>;
	getTaskBySlug(slug: string): Promise<OrchestrationTask | null>;
	updateTask(
		id: string,
		patch: Partial<Pick<OrchestrationTask, "title" | "status">>
	): Promise<OrchestrationTask>;
	listTasks(filter?: { status?: TaskStatus }): Promise<OrchestrationTask[]>;

	addBinding(input: CreateBindingInput): Promise<ExternalBinding>;
	getBindings(taskId: string): Promise<ExternalBinding[]>;
	findTaskByBinding(platform: string, externalId: string): Promise<OrchestrationTask | null>;

	addTaskMessage(input: CreateTaskMessageInput): Promise<TaskMessage>;
	getTaskMessages(taskId: string): Promise<TaskMessage[]>;
}
