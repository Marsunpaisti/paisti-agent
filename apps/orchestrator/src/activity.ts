/** Represents an agent thought (assistant text turn). Always ephemeral. */
export interface ThoughtActivity {
	type: "thought";
	text: string;
	ephemeral: true;
}

/** Represents a tool invocation or its error result. */
export interface ActionActivity {
	type: "action";
	description: string;
	isError: boolean;
}

export type Activity = ThoughtActivity | ActionActivity;

export interface IActivityWriter {
	postActivity(taskId: string, activity: Activity): Promise<void>;
	postResponse(taskId: string, summary: string): Promise<void>;
}
