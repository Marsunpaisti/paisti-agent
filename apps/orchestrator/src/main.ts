import { ClaudeRunner } from "@paisti/claude-adapter";
import { ConsoleActivityWriter } from "./console-activity-writer.js";
import { OrchestratorAPI } from "./orchestrator-api.js";
import { SqliteTaskStore } from "./sqlite-task-store.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "paisti.db";

const taskStore = new SqliteTaskStore(DB_PATH);
const activityWriter = new ConsoleActivityWriter();

const orchestrator = new OrchestratorAPI({
	runnerFactory: () => new ClaudeRunner(),
	taskStore,
	activityWriter,
	workingDirectory: process.cwd(),
	...(process.env.MODEL ? { defaultModel: process.env.MODEL } : {}),
	...(process.env.SYSTEM_PROMPT ? { systemPrompt: process.env.SYSTEM_PROMPT } : {})
});

await orchestrator.start(PORT);
