export interface TaskRef {
	/** "cli" for local tasks; platform name ("linear", "github", etc.) for external */
	platform: string;
	/** Local UUID for CLI tasks; platform-native ID for external tasks */
	id: string;
}

export interface TaskAssignedEvent {
	type: "task_assigned";
	taskRef: TaskRef;
	/** Display label captured at creation time */
	title: string;
	/** The initial user prompt for the agent session */
	initialMessage: string;
}

export interface UserCommentEvent {
	type: "user_comment";
	taskRef: TaskRef;
	content: string;
}

export interface StopRequestedEvent {
	type: "stop_requested";
	taskRef: TaskRef;
}

export type InboundEvent = TaskAssignedEvent | UserCommentEvent | StopRequestedEvent;
