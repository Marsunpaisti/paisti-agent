import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
	AgentSession,
	AgentSessionStatus,
	CreateSessionInput,
	ISessionStore
} from "@paisti/core";

export class SqliteSessionStore implements ISessionStore {
	private db: Database;

	constructor(path = ":memory:") {
		this.db = new Database(path);
		this.db.run("PRAGMA journal_mode=WAL");
		this.migrate();
	}

	private migrate(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS agent_sessions (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				role TEXT,
				status TEXT NOT NULL DEFAULT 'active',
				provider_session_id TEXT,
				started_at TEXT NOT NULL,
				completed_at TEXT
			)
		`);
	}

	async createSession(input: CreateSessionInput): Promise<AgentSession> {
		const id = randomUUID();
		const now = new Date().toISOString();
		this.db.run(
			`INSERT INTO agent_sessions (id, task_id, role, status, started_at)
			 VALUES (?, ?, ?, 'active', ?)`,
			[id, input.taskId, input.role ?? null, now]
		);
		return {
			id,
			taskId: input.taskId,
			...(input.role ? { role: input.role } : {}),
			status: "active",
			startedAt: now
		};
	}

	async getSession(id: string): Promise<AgentSession | null> {
		const row = this.db
			.query<RawSession, string>(`SELECT * FROM agent_sessions WHERE id = ?`)
			.get(id);
		return row ? toSession(row) : null;
	}

	async updateSession(
		id: string,
		patch: Partial<Pick<AgentSession, "status" | "providerSessionId" | "completedAt">>
	): Promise<AgentSession> {
		const setClauses: string[] = [];
		const values: unknown[] = [];

		if (patch.status !== undefined) {
			setClauses.push("status = ?");
			values.push(patch.status);
		}
		if (patch.providerSessionId !== undefined) {
			setClauses.push("provider_session_id = ?");
			values.push(patch.providerSessionId);
		}
		if (patch.completedAt !== undefined) {
			setClauses.push("completed_at = ?");
			values.push(patch.completedAt);
		}

		if (setClauses.length > 0) {
			values.push(id);
			this.db.run(
				`UPDATE agent_sessions SET ${setClauses.join(", ")} WHERE id = ?`,
				values as string[]
			);
		}

		const updated = await this.getSession(id);
		if (!updated) throw new Error(`Session not found: ${id}`);
		return updated;
	}

	async listSessions(taskId: string): Promise<AgentSession[]> {
		const rows = this.db
			.query<RawSession, string>(
				`SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY started_at ASC, rowid ASC`
			)
			.all(taskId);
		return rows.map(toSession);
	}

	async getActiveSession(taskId: string): Promise<AgentSession | null> {
		const row = this.db
			.query<RawSession, [string, string]>(
				`SELECT * FROM agent_sessions WHERE task_id = ? AND status = ? ORDER BY rowid ASC LIMIT 1`
			)
			.get(taskId, "active");
		return row ? toSession(row) : null;
	}
}

// ─── raw row type ─────────────────────────────────────────────────────────────

interface RawSession {
	id: string;
	task_id: string;
	role: string | null;
	status: string;
	provider_session_id: string | null;
	started_at: string;
	completed_at: string | null;
}

function toSession(row: RawSession): AgentSession {
	return {
		id: row.id,
		taskId: row.task_id,
		...(row.role ? { role: row.role as AgentSession["role"] } : {}),
		status: row.status as AgentSessionStatus,
		...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
		startedAt: row.started_at,
		...(row.completed_at ? { completedAt: row.completed_at } : {})
	};
}
