import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ClaudeRunner } from "@paisti/claude-adapter";
import { ConsoleActivityWriter } from "@paisti/console-adapter";
import { OrchestratorAPI } from "./orchestrator-api.js";
import { ActivityService } from "./services/activity-service.js";
import { LocalTaskContextProvider } from "./services/local-task-context-provider.js";
import { MessageService } from "./services/message-service.js";
import { SseBroadcaster } from "./services/sse-broadcaster.js";
import { SqliteAgentMessageWriter } from "./stores/sqlite-agent-message-writer.js";
import { SqliteSessionStore } from "./stores/sqlite-session-store.js";
import { SqliteTaskStore } from "./stores/sqlite-task-store.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "paisti.db";

const taskStore = new SqliteTaskStore(DB_PATH);
const sessionStore = new SqliteSessionStore(DB_PATH);
const agentMessageWriter = new SqliteAgentMessageWriter(DB_PATH);
const sseBroadcaster = new SseBroadcaster();
const activityService = new ActivityService([new ConsoleActivityWriter()]);
const messageService = new MessageService([agentMessageWriter, sseBroadcaster]);
const contextProvider = new LocalTaskContextProvider(taskStore, sessionStore);

// SERVE_UI can be "true"/"1" (uses default dist path) or an explicit path to the web dist directory
let serveUiFrom: string | undefined;
const serveUiEnv = process.env.SERVE_UI;
if (serveUiEnv) {
	const uiPath =
		serveUiEnv === "true" || serveUiEnv === "1"
			? resolve(import.meta.dir, "../../web/dist")
			: serveUiEnv;
	if (existsSync(`${uiPath}/index.html`)) {
		serveUiFrom = uiPath;
	} else {
		console.warn(
			`[orchestrator] SERVE_UI: ${uiPath} does not contain index.html — static serving disabled. Build apps/web first or set SERVE_UI=<path-to-dist>.`
		);
	}
}

const orchestrator = new OrchestratorAPI({
	runnerFactory: () => new ClaudeRunner(),
	taskStore,
	sessionStore,
	agentMessageStore: agentMessageWriter,
	activityService,
	messageService,
	sseBroadcaster,
	contextProvider,
	workingDirectory: process.cwd(),
	serveUiFrom,
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
