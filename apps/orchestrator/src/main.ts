import { ClaudeRunner } from "@paisti/claude-adapter";
import { ConsoleActivityWriter } from "@paisti/console-adapter";
import { OrchestratorAPI } from "./orchestrator-api.js";
import { ActivityService } from "./services/activity-service.js";
import { SqliteSessionStore } from "./stores/sqlite-session-store.js";
import { SqliteTaskStore } from "./stores/sqlite-task-store.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "paisti.db";

const taskStore = new SqliteTaskStore(DB_PATH);
const sessionStore = new SqliteSessionStore(DB_PATH);
const activityService = new ActivityService([new ConsoleActivityWriter()]);

const orchestrator = new OrchestratorAPI({
	runnerFactory: () => new ClaudeRunner(),
	taskStore,
	sessionStore,
	activityService,
	workingDirectory: process.cwd(),
	...(process.env.MODEL ? { defaultModel: process.env.MODEL } : {}),
	...(process.env.SYSTEM_PROMPT ? { systemPrompt: process.env.SYSTEM_PROMPT } : {})
});

await orchestrator.start(PORT);

const shutdown = async () => {
	await orchestrator.stop();
	process.exit(0);
};
process.on("SIGTERM", () => {
	void shutdown();
});
process.on("SIGINT", () => {
	void shutdown();
});
