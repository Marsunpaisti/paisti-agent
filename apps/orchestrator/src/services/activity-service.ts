import type { Activity, IActivityWriter } from "@paisti/core";

export class ActivityService {
	private readonly writers: IActivityWriter[];

	constructor(writers: IActivityWriter[]) {
		this.writers = writers;
	}

	async postActivity(taskId: string, activity: Activity): Promise<void> {
		await Promise.all(this.writers.map((w) => w.postActivity(taskId, activity)));
	}

	async postResponse(taskId: string, summary: string): Promise<void> {
		await Promise.all(this.writers.map((w) => w.postResponse(taskId, summary)));
	}
}
