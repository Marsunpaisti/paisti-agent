import type {
	McpHttpServerConfig,
	McpStdioServerConfig,
	Options
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
	AgentMessage,
	IAgentRunner,
	McpServerConfig,
	RunConfig,
	SessionResultMessage
} from "@paisti/core";
import { toAgentMessages } from "./message-map.js";
import { StreamingPrompt } from "./streaming-prompt.js";

const PROVIDER = "claude";

/**
 * Implements IAgentRunner for the @anthropic-ai/claude-agent-sdk.
 *
 * One instance per session — never shared across concurrent tasks.
 *
 * Key behaviors (from adapter spec):
 * - settingSources defaults to ["project", "local"] — excludes "user" to prevent
 *   interactive hooks (Superpowers, ~/.claude/hooks/) from interfering with headless runs.
 *   Override per-session via providerOptions.claude.settingSources.
 * - Uses StreamingPrompt as the query() prompt so injection works via write().
 * - Stores no session state beyond the active StreamingPrompt and AbortController.
 */
export class ClaudeRunner implements IAgentRunner {
	readonly supportsInjection = true;

	private streamingPrompt: StreamingPrompt | null = null;
	private abortController: AbortController | null = null;

	async *run(config: RunConfig): AsyncIterable<AgentMessage> {
		const prompt = new StreamingPrompt(config.userPrompt);
		const abortController = new AbortController();
		this.streamingPrompt = prompt;
		this.abortController = abortController;

		const options = this.buildOptions(config, abortController);

		let emittedResult = false;
		let stopped = false;

		try {
			const q = query({ prompt, options });
			for await (const raw of q) {
				const messages = toAgentMessages(raw, PROVIDER);
				for (const msg of messages) {
					yield msg;
					if (msg.type === "result") emittedResult = true;
				}
			}
		} catch (err) {
			if (isAbortError(err)) {
				stopped = true;
			} else {
				if (!emittedResult) {
					yield this.errorResult(config);
					emittedResult = true;
				}
				throw err;
			}
		} finally {
			this.streamingPrompt = null;
			this.abortController = null;
		}

		// Guarantee: run() always terminates with a SessionResultMessage.
		// If the SDK emitted one (success/error subtypes), we're done.
		// If the loop ended via abort (stop() called), emit a synthetic "stopped" result.
		if (!emittedResult) {
			yield this.stoppedResult(stopped);
		}
	}

	inject(content: string): void {
		this.streamingPrompt?.write(content);
	}

	async stop(): Promise<void> {
		this.streamingPrompt?.close();
		this.abortController?.abort();
	}

	// ─── private ─────────────────────────────────────────────────────────────

	private buildOptions(config: RunConfig, abortController: AbortController): Options {
		const claudeDefaults: Record<string, unknown> = {
			settingSources: ["project", "local"],
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true
		};

		const claudeOverrides =
			(config.providerOptions?.claude as Record<string, unknown> | undefined) ?? {};

		const base: Options = {
			abortController,
			cwd: config.workingDirectory,
			...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
			...(config.model ? { model: config.model } : {}),
			...(config.maxTurns ? { maxTurns: config.maxTurns } : {}),
			...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
			...(config.disallowedTools ? { disallowedTools: config.disallowedTools } : {}),
			...(config.mcpServers ? { mcpServers: mapMcpServers(config.mcpServers) } : {}),
			...(config.resumeSessionId ? { resume: config.resumeSessionId } : {})
		};

		return { ...base, ...claudeDefaults, ...claudeOverrides } as Options;
	}

	private stoppedResult(stopped: boolean): SessionResultMessage {
		return {
			type: "result",
			provider: PROVIDER,
			sessionId: "",
			finishReason: stopped ? "stopped" : "error",
			durationMs: 0
		};
	}

	private errorResult(_config: RunConfig): SessionResultMessage {
		return {
			type: "result",
			provider: PROVIDER,
			sessionId: "",
			finishReason: "error",
			durationMs: 0
		};
	}
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function isAbortError(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === "AbortError" || err.message.toLowerCase().includes("abort"))
	);
}

/**
 * Maps our McpServerConfig to the format expected by the Claude SDK.
 * Uses McpStdioServerConfig for command-based servers and McpHttpServerConfig for URL-based.
 */
function mapMcpServers(
	servers: Record<string, McpServerConfig>
): Record<string, McpStdioServerConfig | McpHttpServerConfig> {
	const result: Record<string, McpStdioServerConfig | McpHttpServerConfig> = {};
	for (const [name, cfg] of Object.entries(servers)) {
		if (cfg.command) {
			const entry: McpStdioServerConfig = {
				command: cfg.command,
				...(cfg.args ? { args: cfg.args } : {}),
				...(cfg.env ? { env: cfg.env } : {})
			};
			result[name] = entry;
		} else if (cfg.url) {
			const entry: McpHttpServerConfig = {
				type: "http",
				url: cfg.url,
				...(cfg.headers ? { headers: cfg.headers } : {})
			};
			result[name] = entry;
		}
	}
	return result;
}
