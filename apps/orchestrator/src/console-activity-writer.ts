import type { Activity, IActivityWriter } from "@paisti/core";

/**
 * Simple IActivityWriter that prints activities to stdout.
 * Suitable for development and CLI use.
 */
export class ConsoleActivityWriter implements IActivityWriter {
	async postActivity(taskId: string, activity: Activity): Promise<void> {
		if (activity.type === "thought") {
			const preview =
				activity.text.length > 120 ? `${activity.text.slice(0, 117)}...` : activity.text;
			console.log(`[${taskId}] thought: ${preview}`);
		} else {
			const marker = activity.isError ? "error" : "action";
			console.log(`[${taskId}] ${marker}: ${activity.description}`);
		}
	}

	async postResponse(taskId: string, summary: string): Promise<void> {
		console.log(`[${taskId}] response: ${summary}`);
	}
}
