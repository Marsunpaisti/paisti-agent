# Spec: OrchestrationTask Model

## Purpose

The local entity representing "the thing being worked on." Can be a coding task, a Q&A session, a research request, or anything in between. Has no inherent requirement for branches, PRs, or code deliverables.

Platform identity (Linear issue, Slack thread, GitHub PR) lives in `ExternalBinding` — never on the task itself. This keeps the task stable and platform-agnostic, and means it can exist without any external system at all (e.g. pure CLI use).

## Types

### OrchestrationTask

```typescript
interface OrchestrationTask {
  id: string;       // local UUID — never borrowed from a platform
  slug?: string;    // "fix-login-bug", "DEF-123", auto-generated or user-supplied
  title: string;
  status: TaskStatus;
  createdAt: string;  // ISO 8601
  updatedAt: string;  // ISO 8601
}

type TaskStatus = "open" | "active" | "completed" | "archived";
```

**`title` semantics:**
- CLI tasks: the full task description entered by the user
- Platform tasks: a display label captured at creation time (e.g. the Linear issue title)

Full content (description, comments, attachments) is never copied onto the task. It is fetched live by `ITaskContextProvider` when a session needs context — see rationale below.

### ExternalBinding

An optional pointer from an `OrchestrationTask` to an entity in an external system. A task can have zero bindings (pure CLI), one binding (originated from a Linear issue), or multiple (a Linear issue also discussed in Slack).

```typescript
interface ExternalBinding {
  id: string;
  taskId: string;
  platform: string;       // "linear" | "github" | "slack" | "jira" | ...
  externalId: string;     // platform-native ID (issue ID, message TS, PR number, etc.)
  externalUrl?: string;
  role: ExternalBindingRole;
  boundAt: string;        // ISO 8601
}

type ExternalBindingRole =
  | "source"    // task was created FROM this entity
  | "context"   // related for additional context
  | "artifact"; // output produced by the task (e.g. a PR created by the agent)
```

**No snapshot fields.** Earlier designs included `snapshotTitle` and `snapshotBody`. These were removed. External content is always fetched live — see rationale below.

### TaskMessage

Locally-owned messages: CLI notes and agent output. Platform messages (Linear comments, Slack threads) are NOT stored here; they are fetched live and normalized on the fly by `ITaskContextProvider`.

```typescript
interface TaskMessage {
  id: string;
  taskId: string;
  content: string;
  author: string;
  timestamp: string;  // ISO 8601
  source: TaskMessageSource;
}

type TaskMessageSource =
  | { type: "cli" }
  | { type: "agent"; sessionId: string };
```

## SQLite Schema

```sql
CREATE TABLE orchestration_tasks (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE external_bindings (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES orchestration_tasks(id),
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_url TEXT,
  role TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  UNIQUE(platform, external_id)
);

CREATE TABLE task_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES orchestration_tasks(id),
  content TEXT NOT NULL,
  author TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source_type TEXT NOT NULL,      -- "cli" | "agent"
  source_session_id TEXT          -- set when source_type = "agent"
);
```

## ITaskStore Port

```typescript
interface ITaskStore {
  createTask(input: CreateTaskInput): Promise<OrchestrationTask>;
  getTask(id: string): Promise<OrchestrationTask | null>;
  getTaskBySlug(slug: string): Promise<OrchestrationTask | null>;
  updateTask(id: string, patch: Partial<Pick<OrchestrationTask, "title" | "status">>): Promise<OrchestrationTask>;
  listTasks(filter?: { status?: TaskStatus }): Promise<OrchestrationTask[]>;

  addBinding(input: CreateBindingInput): Promise<ExternalBinding>;
  getBindings(taskId: string): Promise<ExternalBinding[]>;
  findTaskByBinding(platform: string, externalId: string): Promise<OrchestrationTask | null>;

  addTaskMessage(input: CreateTaskMessageInput): Promise<TaskMessage>;
  getTaskMessages(taskId: string): Promise<TaskMessage[]>;
}
```

`findTaskByBinding` is the core routing lookup: "do we already have a task for this Linear issue / Slack thread?" Returns `null` if not found — caller creates a new task and binding.

## Design Decisions

**Why no `description` field on `OrchestrationTask`:** For platform tasks, the description lives in Linear/GitHub/Slack and should always be fetched live. For CLI tasks, the `title` field carries the full description (it's a sentence or two). If a longer CLI description is needed, store it as the first `TaskMessage` with `source: { type: "cli" }`.

**Why no snapshot fields on `ExternalBinding`:** Live fetching means missed webhooks never cause stale context. When the app restarts after downtime, the next session automatically sees current state from the platform. No sync logic, no deduplication, no "is my copy stale?" problem.

**Why `TaskMessage` excludes platform messages:** Platform messages (Linear comments, Slack messages) have a live authoritative source. Copying them locally creates a sync problem. Only messages we own — what the user typed in the CLI and what the agent produced — are stored locally because there's nowhere else to get them.

**`UNIQUE(platform, external_id)` constraint on `external_bindings`:** Prevents duplicate bindings when a webhook fires multiple times for the same entity. The store should use `INSERT OR IGNORE` (SQLite) or equivalent.
