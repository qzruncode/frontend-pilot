import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AssistantEditSessionStatus = "active" | "approval_pending" | "closed" | "failed" | "expired";
export type AssistantEditSessionRetentionMode = "auto" | "pinned";
export type AssistantEditOperationStatus = "pending" | "applied" | "rejected" | "conflict" | "failed";

export interface StoredAssistantEditSession {
  id: string;
  ownerKey: string;
  projectId: string;
  projectPath: string;
  baseRef: string;
  baseSha: string;
  workspacePath: string;
  status: AssistantEditSessionStatus;
  retentionMode: AssistantEditSessionRetentionMode;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface StoredAssistantEditOperation {
  id: string;
  sessionId: string;
  path: string;
  summary: string;
  patch: string;
  status: AssistantEditOperationStatus;
  beforeSha256: string | null;
  afterSha256: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SqlRow {
  [key: string]: unknown;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toSession(row: SqlRow): StoredAssistantEditSession {
  return {
    id: String(row.id),
    ownerKey: String(row.owner_key),
    projectId: String(row.project_id),
    projectPath: String(row.project_path),
    baseRef: String(row.base_ref),
    baseSha: String(row.base_sha),
    workspacePath: String(row.workspace_path),
    status: String(row.status) as AssistantEditSessionStatus,
    retentionMode: row.retention_mode === "pinned" ? "pinned" : "auto",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at),
  };
}

function toOperation(row: SqlRow): StoredAssistantEditOperation {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    path: String(row.path),
    summary: String(row.summary),
    patch: String(row.patch),
    status: String(row.status) as AssistantEditOperationStatus,
    beforeSha256: nullableString(row.before_sha256),
    afterSha256: nullableString(row.after_sha256),
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class AssistantEditStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  createSession(input: StoredAssistantEditSession): StoredAssistantEditSession {
    this.ensureOpen();
    this.db.prepare(`
      INSERT INTO assistant_edit_sessions (
        id, owner_key, project_id, project_path, base_ref, base_sha, workspace_path,
        status, retention_mode, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.ownerKey,
      input.projectId,
      input.projectPath,
      input.baseRef,
      input.baseSha,
      input.workspacePath,
      input.status,
      input.retentionMode,
      input.createdAt,
      input.updatedAt,
      input.expiresAt,
    );
    return input;
  }

  getSession(id: string, ownerKey?: string): StoredAssistantEditSession | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id, owner_key, project_id, project_path, base_ref, base_sha, workspace_path,
        status, retention_mode, created_at, updated_at, expires_at
      FROM assistant_edit_sessions
      WHERE id = ? ${ownerKey ? "AND owner_key = ?" : ""}
    `).get(...(ownerKey ? [id, ownerKey] : [id])) as SqlRow | undefined;
    return row ? toSession(row) : null;
  }

  listSessions(statuses: AssistantEditSessionStatus[] = ["active", "approval_pending"], ownerKey?: string): StoredAssistantEditSession[] {
    this.ensureOpen();
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT id, owner_key, project_id, project_path, base_ref, base_sha, workspace_path,
        status, retention_mode, created_at, updated_at, expires_at
      FROM assistant_edit_sessions
      WHERE status IN (${placeholders}) ${ownerKey ? "AND owner_key = ?" : ""}
      ORDER BY updated_at DESC, id DESC
    `).all(...statuses, ...(ownerKey ? [ownerKey] : [])) as SqlRow[];
    return rows.map(toSession);
  }

  updateSessionStatus(id: string, ownerKey: string, status: AssistantEditSessionStatus): void {
    this.ensureOpen();
    this.db.prepare(`
      UPDATE assistant_edit_sessions SET status = ?, updated_at = ?
      WHERE id = ? AND owner_key = ?
    `).run(status, new Date().toISOString(), id, ownerKey);
  }

  updateSessionRetention(
    id: string,
    ownerKey: string,
    retentionMode: AssistantEditSessionRetentionMode,
    expiresAt: string,
  ): void {
    this.ensureOpen();
    this.db.prepare(`
      UPDATE assistant_edit_sessions SET retention_mode = ?, expires_at = ?, updated_at = ?
      WHERE id = ? AND owner_key = ?
    `).run(retentionMode, expiresAt, new Date().toISOString(), id, ownerKey);
  }

  createOperation(input: StoredAssistantEditOperation): StoredAssistantEditOperation {
    this.ensureOpen();
    this.db.prepare(`
      INSERT INTO assistant_edit_operations (
        id, session_id, path, summary, patch, status, before_sha256, after_sha256,
        error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.sessionId,
      input.path,
      input.summary,
      input.patch,
      input.status,
      input.beforeSha256,
      input.afterSha256,
      input.error,
      input.createdAt,
      input.updatedAt,
    );
    return input;
  }

  getOperation(id: string, ownerKey?: string): StoredAssistantEditOperation | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT o.id, o.session_id, o.path, o.summary, o.patch, o.status,
        o.before_sha256, o.after_sha256, o.error, o.created_at, o.updated_at
      FROM assistant_edit_operations o
      INNER JOIN assistant_edit_sessions s ON s.id = o.session_id
      WHERE o.id = ? ${ownerKey ? "AND s.owner_key = ?" : ""}
    `).get(...(ownerKey ? [id, ownerKey] : [id])) as SqlRow | undefined;
    return row ? toOperation(row) : null;
  }

  listOperations(sessionId: string, ownerKey?: string): StoredAssistantEditOperation[] {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT o.id, o.session_id, o.path, o.summary, o.patch, o.status,
        o.before_sha256, o.after_sha256, o.error, o.created_at, o.updated_at
      FROM assistant_edit_operations o
      INNER JOIN assistant_edit_sessions s ON s.id = o.session_id
      WHERE o.session_id = ? ${ownerKey ? "AND s.owner_key = ?" : ""}
      ORDER BY o.created_at ASC, o.id ASC
    `).all(...(ownerKey ? [sessionId, ownerKey] : [sessionId])) as SqlRow[];
    return rows.map(toOperation);
  }

  updateOperation(
    id: string,
    ownerKey: string,
    update: Pick<StoredAssistantEditOperation, "status" | "afterSha256" | "error">,
  ): StoredAssistantEditOperation | null {
    this.ensureOpen();
    this.db.prepare(`
      UPDATE assistant_edit_operations
      SET status = ?, after_sha256 = ?, error = ?, updated_at = ?
      WHERE id = ? AND session_id IN (SELECT id FROM assistant_edit_sessions WHERE owner_key = ?)
    `).run(update.status, update.afterSha256, update.error, new Date().toISOString(), id, ownerKey);
    return this.getOperation(id, ownerKey);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_edit_sessions (
        id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        workspace_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'approval_pending', 'closed', 'failed', 'expired')),
        retention_mode TEXT NOT NULL DEFAULT 'auto' CHECK (retention_mode IN ('auto', 'pinned')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assistant_edit_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        summary TEXT NOT NULL,
        patch TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'conflict', 'failed')),
        before_sha256 TEXT,
        after_sha256 TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES assistant_edit_sessions (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_assistant_edit_sessions_owner
        ON assistant_edit_sessions (owner_key, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assistant_edit_operations_session
        ON assistant_edit_operations (session_id, created_at ASC);
    `);

    const columns = this.db.prepare("PRAGMA table_info(assistant_edit_sessions)").all() as SqlRow[];
    if (!columns.some((column) => column.name === "retention_mode")) {
      this.db.exec("ALTER TABLE assistant_edit_sessions ADD COLUMN retention_mode TEXT NOT NULL DEFAULT 'auto'");
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("assistant edit store is closed");
  }
}
