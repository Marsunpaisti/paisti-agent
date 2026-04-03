import { describe, expect, it } from "bun:test";
import type { Activity, IActivityWriter } from "@paisti/core";
import { ActivityService } from "./activity-service.js";

class SpyWriter implements IActivityWriter {
	activities: Array<{ taskId: string; activity: Activity }> = [];
	responses: Array<{ taskId: string; summary: string }> = [];

	async postActivity(taskId: string, activity: Activity): Promise<void> {
		this.activities.push({ taskId, activity });
	}

	async postResponse(taskId: string, summary: string): Promise<void> {
		this.responses.push({ taskId, summary });
	}
}

const thought: Activity = { type: "thought", text: "thinking", ephemeral: true };

describe("ActivityService — postActivity", () => {
	it("dispatches to a single writer", async () => {
		const spy = new SpyWriter();
		const svc = new ActivityService([spy]);
		await svc.postActivity("task-1", thought);
		expect(spy.activities).toHaveLength(1);
		expect(spy.activities[0]).toEqual({ taskId: "task-1", activity: thought });
	});

	it("dispatches to all writers", async () => {
		const a = new SpyWriter();
		const b = new SpyWriter();
		const svc = new ActivityService([a, b]);
		await svc.postActivity("task-1", thought);
		expect(a.activities).toHaveLength(1);
		expect(b.activities).toHaveLength(1);
	});

	it("is a no-op with zero writers", async () => {
		const svc = new ActivityService([]);
		await expect(svc.postActivity("task-1", thought)).resolves.toBeUndefined();
	});
});

describe("ActivityService — postResponse", () => {
	it("dispatches to a single writer", async () => {
		const spy = new SpyWriter();
		const svc = new ActivityService([spy]);
		await svc.postResponse("task-1", "Done.");
		expect(spy.responses).toHaveLength(1);
		expect(spy.responses[0]).toEqual({ taskId: "task-1", summary: "Done." });
	});

	it("dispatches to all writers", async () => {
		const a = new SpyWriter();
		const b = new SpyWriter();
		const svc = new ActivityService([a, b]);
		await svc.postResponse("task-1", "Done.");
		expect(a.responses).toHaveLength(1);
		expect(b.responses).toHaveLength(1);
	});

	it("is a no-op with zero writers", async () => {
		const svc = new ActivityService([]);
		await expect(svc.postResponse("task-1", "Done.")).resolves.toBeUndefined();
	});
});
