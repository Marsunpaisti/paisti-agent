import { Database } from "bun:sqlite";
import type { AgentMessage, IAgentMessageStore, StoredAgentMessage } from "@paisti/core";

export class SqliteAgentMessageWriter implements IAgentMessageStore {
	private db: Database;

	constructor(path = ":memory:") {
		this.db = new Database(path);
		this.db.run("PRAGMA journal_mode=WAL");
		this.migrate();
	}

	private migrate(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS session_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				message TEXT NOT NULL
			)
		`);
	}

	async writeMessage(sessionId: string, sequence: number, message: AgentMessage): Promise<void> {
		this.db.run(`INSERT INTO session_messages (session_id, sequence, message) VALUES (?, ?, ?)`, [
			sessionId,
			sequence,
			JSON.stringify(message)
		]);
	}

	async getMessages(sessionId: string): Promise<StoredAgentMessage[]> {
		const rows = this.db
			.query<{ session_id: string; sequence: number; message: string }, string>(
				`SELECT session_id, sequence, message FROM session_messages WHERE session_id = ? ORDER BY sequence ASC`
			)
			.all(sessionId);
		return rows.map((row) => ({
			sessionId: row.session_id,
			sequence: row.sequence,
			message: JSON.parse(row.message) as AgentMessage
		}));
	}
}
