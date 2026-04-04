export type AgentSessionStatus = "active" | "completed" | "failed" | "stopped";

// Extensible — new roles added as orchestrator routing logic grows
export type AgentSessionRole = "discussion" | "implementation" | "review";

export interface AgentSession {
	id: string; // local UUID
	taskId: string;
	role?: AgentSessionRole; // undefined in Phase 1
	status: AgentSessionStatus;
	providerSessionId?: string; // SDK session ID, captured from SystemInfoMessage
	startedAt: string; // ISO 8601
	completedAt?: string; // ISO 8601; absent while active
}

export interface CreateSessionInput {
	taskId: string;
	role?: AgentSessionRole;
}

export interface ISessionStore {
	createSession(input: CreateSessionInput): Promise<AgentSession>;
	getSession(id: string): Promise<AgentSession | null>;
	updateSession(
		id: string,
		patch: Partial<Pick<AgentSession, "status" | "providerSessionId" | "completedAt">>
	): Promise<AgentSession>;
	/** Returns all sessions for the task ordered by startedAt ascending. */
	listSessions(taskId: string): Promise<AgentSession[]>;
	/** Returns the single active session for the task, or null if none. */
	getActiveSession(taskId: string): Promise<AgentSession | null>;
}
