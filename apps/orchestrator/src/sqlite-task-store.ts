import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
	CreateBindingInput,
	CreateTaskInput,
	CreateTaskMessageInput,
	ExternalBinding,
	ITaskStore,
	OrchestrationTask,
	TaskMessage,
	TaskStatus
} from "@paisti/core";

export class SqliteTaskStore implements ITaskStore {
	private db: Database;

	constructor(path = ":memory:") {
		this.db = new Database(path);
		this.db.run("PRAGMA journal_mode=WAL");
		this.db.run("PRAGMA foreign_keys=ON");
		this.migrate();
	}

	private migrate(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS orchestration_tasks (
				id TEXT PRIMARY KEY,
				slug TEXT UNIQUE,
				title TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'open',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS external_bindings (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL REFERENCES orchestration_tasks(id),
				platform TEXT NOT NULL,
				external_id TEXT NOT NULL,
				external_url TEXT,
				role TEXT NOT NULL,
				bound_at TEXT NOT NULL,
				UNIQUE(platform, external_id)
			)
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS task_messages (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL REFERENCES orchestration_tasks(id),
				content TEXT NOT NULL,
				author TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				source_type TEXT NOT NULL,
				source_session_id TEXT
			)
		`);
	}

	async createTask(input: CreateTaskInput): Promise<OrchestrationTask> {
		const id = input.id ?? randomUUID();
		const now = new Date().toISOString();
		this.db.run(
			`INSERT INTO orchestration_tasks (id, slug, title, status, created_at, updated_at)
			 VALUES (?, ?, ?, 'open', ?, ?)`,
			[id, input.slug ?? null, input.title, now, now]
		);
		return {
			id,
			...(input.slug ? { slug: input.slug } : {}),
			title: input.title,
			status: "open",
			createdAt: now,
			updatedAt: now
		};
	}

	async getTask(id: string): Promise<OrchestrationTask | null> {
		const row = this.db
			.query<RawTask, string>(`SELECT * FROM orchestration_tasks WHERE id = ?`)
			.get(id);
		return row ? toTask(row) : null;
	}

	async getTaskBySlug(slug: string): Promise<OrchestrationTask | null> {
		const row = this.db
			.query<RawTask, string>(`SELECT * FROM orchestration_tasks WHERE slug = ?`)
			.get(slug);
		return row ? toTask(row) : null;
	}

	async updateTask(
		id: string,
		patch: Partial<Pick<OrchestrationTask, "title" | "status">>
	): Promise<OrchestrationTask> {
		const now = new Date().toISOString();
		if (patch.title !== undefined) {
			this.db.run(`UPDATE orchestration_tasks SET title = ?, updated_at = ? WHERE id = ?`, [
				patch.title,
				now,
				id
			]);
		}
		if (patch.status !== undefined) {
			this.db.run(`UPDATE orchestration_tasks SET status = ?, updated_at = ? WHERE id = ?`, [
				patch.status,
				now,
				id
			]);
		}
		const updated = await this.getTask(id);
		if (!updated) throw new Error(`Task not found: ${id}`);
		return updated;
	}

	async listTasks(filter?: { status?: TaskStatus }): Promise<OrchestrationTask[]> {
		if (filter?.status) {
			const rows = this.db
				.query<RawTask, string>(
					`SELECT * FROM orchestration_tasks WHERE status = ? ORDER BY created_at DESC`
				)
				.all(filter.status);
			return rows.map(toTask);
		}
		const rows = this.db
			.query<RawTask, []>(`SELECT * FROM orchestration_tasks ORDER BY created_at DESC`)
			.all();
		return rows.map(toTask);
	}

	async addBinding(input: CreateBindingInput): Promise<ExternalBinding> {
		const id = randomUUID();
		const now = new Date().toISOString();
		// INSERT OR IGNORE — duplicate (platform, external_id) is silently dropped
		this.db.run(
			`INSERT OR IGNORE INTO external_bindings
			 (id, task_id, platform, external_id, external_url, role, bound_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.taskId,
				input.platform,
				input.externalId,
				input.externalUrl ?? null,
				input.role,
				now
			]
		);
		return {
			id,
			taskId: input.taskId,
			platform: input.platform,
			externalId: input.externalId,
			...(input.externalUrl ? { externalUrl: input.externalUrl } : {}),
			role: input.role,
			boundAt: now
		};
	}

	async getBindings(taskId: string): Promise<ExternalBinding[]> {
		const rows = this.db
			.query<RawBinding, string>(
				`SELECT * FROM external_bindings WHERE task_id = ? ORDER BY bound_at ASC`
			)
			.all(taskId);
		return rows.map(toBinding);
	}

	async findTaskByBinding(platform: string, externalId: string): Promise<OrchestrationTask | null> {
		const row = this.db
			.query<RawTask, [string, string]>(
				`SELECT t.* FROM orchestration_tasks t
				 JOIN external_bindings b ON t.id = b.task_id
				 WHERE b.platform = ? AND b.external_id = ?`
			)
			.get(platform, externalId);
		return row ? toTask(row) : null;
	}

	async addTaskMessage(input: CreateTaskMessageInput): Promise<TaskMessage> {
		const id = randomUUID();
		const now = new Date().toISOString();
		const sessionId = input.source.type === "agent" ? input.source.sessionId : null;
		this.db.run(
			`INSERT INTO task_messages
			 (id, task_id, content, author, timestamp, source_type, source_session_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[id, input.taskId, input.content, input.author, now, input.source.type, sessionId]
		);
		return {
			id,
			taskId: input.taskId,
			content: input.content,
			author: input.author,
			timestamp: now,
			source: input.source
		};
	}

	async getTaskMessages(taskId: string): Promise<TaskMessage[]> {
		const rows = this.db
			.query<RawMessage, string>(
				`SELECT * FROM task_messages WHERE task_id = ? ORDER BY timestamp ASC`
			)
			.all(taskId);
		return rows.map(toMessage);
	}
}

// ─── raw row types ────────────────────────────────────────────────────────────

interface RawTask {
	id: string;
	slug: string | null;
	title: string;
	status: string;
	created_at: string;
	updated_at: string;
}

interface RawBinding {
	id: string;
	task_id: string;
	platform: string;
	external_id: string;
	external_url: string | null;
	role: string;
	bound_at: string;
}

interface RawMessage {
	id: string;
	task_id: string;
	content: string;
	author: string;
	timestamp: string;
	source_type: string;
	source_session_id: string | null;
}

// ─── row mappers ──────────────────────────────────────────────────────────────

function toTask(row: RawTask): OrchestrationTask {
	return {
		id: row.id,
		...(row.slug ? { slug: row.slug } : {}),
		title: row.title,
		status: row.status as TaskStatus,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function toBinding(row: RawBinding): ExternalBinding {
	return {
		id: row.id,
		taskId: row.task_id,
		platform: row.platform,
		externalId: row.external_id,
		...(row.external_url ? { externalUrl: row.external_url } : {}),
		role: row.role as ExternalBinding["role"],
		boundAt: row.bound_at
	};
}

function toMessage(row: RawMessage): TaskMessage {
	const source: TaskMessage["source"] =
		row.source_type === "agent"
			? { type: "agent", sessionId: row.source_session_id ?? "" }
			: { type: "cli" };
	return {
		id: row.id,
		taskId: row.task_id,
		content: row.content,
		author: row.author,
		timestamp: row.timestamp,
		source
	};
}
