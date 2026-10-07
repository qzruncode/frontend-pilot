import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nullableString, rowToMessage, rowToRunEvent, type AssistantSqlRow } from "./assistant-store-rows.js";

export type AssistantStoredMessageRole = "user" | "assistant";

export interface AssistantStoredMessage {
  id: string;
  role: AssistantStoredMessageRole;
  content: string;
  createdAt: string;
}

export interface AssistantConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export type AssistantRunStatus = "running" | "completed" | "failed" | "canceled";

export interface AssistantRunEvent {
  sequence: number;
  event: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AssistantRunSnapshot {
  id: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: AssistantRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  lastSequence: number;
  events: AssistantRunEvent[];
}

export interface AssistantConversation extends AssistantConversationSummary {
  messages: AssistantStoredMessage[];
  activeRun?: AssistantRunSnapshot;
  latestRun?: AssistantRunSnapshot;
}

const DEFAULT_CONVERSATION_TITLE = "新对话";
const MAX_RUN_EVENTS = 5_000;
const MAX_RUN_HISTORY = 20;
const MAX_HISTORY_EVENTS = 300;

export class AssistantStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  listConversations(limit = 100, ownerKey?: string): AssistantConversationSummary[] {
    this.ensureOpen();
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const ownerClause = ownerKey ? "WHERE c.owner_key = ?" : "";
    const rows = this.db.prepare(`
      SELECT
        c.id,
        c.title,
        c.created_at,
        c.updated_at,
        COUNT(m.id) AS message_count
      FROM assistant_conversations c
      LEFT JOIN assistant_messages m ON m.conversation_id = c.id
      ${ownerClause}
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT ?
    `).all(...(ownerKey ? [ownerKey, boundedLimit] : [boundedLimit])) as AssistantSqlRow[];
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      messageCount: Number(row.message_count ?? 0),
    }));
  }

  getConversation(id: string, messageLimit = 200, ownerKey?: string): AssistantConversation | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id, title, created_at, updated_at
      FROM assistant_conversations
      WHERE id = ? ${ownerKey ? "AND owner_key = ?" : ""}
    `).get(...(ownerKey ? [id, ownerKey] : [id])) as AssistantSqlRow | undefined;
    if (!row) return null;

    const boundedLimit = Math.max(1, Math.min(messageLimit, 500));
    const messages = this.db.prepare(`
      SELECT id, role, content, created_at
      FROM assistant_messages
      WHERE conversation_id = ?
      ORDER BY rowid ASC
      LIMIT ?
    `).all(id, boundedLimit) as AssistantSqlRow[];
    const summary = this.listConversations(200, ownerKey).find((conversation) => conversation.id === id);
    const latestRun = this.getLatestRun(id);
    return {
      id: String(row.id),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      messageCount: summary?.messageCount ?? messages.length,
      messages: messages.map(rowToMessage),
      activeRun: latestRun?.status === "completed" ? undefined : latestRun ?? undefined,
      latestRun: latestRun ?? undefined,
    };
  }

  createRun(input: {
    id: string;
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
  }): { run: AssistantRunSnapshot; created: boolean } {
    this.ensureOpen();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO assistant_runs (
          id, conversation_id, user_message_id, assistant_message_id,
          status, started_at, updated_at, finished_at, error
        ) VALUES (?, ?, ?, ?, 'running', ?, ?, NULL, NULL)
      `).run(
        input.id,
        input.conversationId,
        input.userMessageId,
        input.assistantMessageId,
        now,
        now,
      );
      this.db.exec("COMMIT;");
      const created = Number(result.changes ?? 0) > 0;
      const run = this.getRun(created ? input.id : this.getRunByUserMessage(input.conversationId, input.userMessageId)?.id ?? input.id);
      if (!run) throw new Error("assistant_run_not_found");
      return { run, created };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  getRun(id: string, afterSequence = 0, ownerKey?: string, eventLimit = MAX_RUN_EVENTS): AssistantRunSnapshot | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT r.id, r.conversation_id, r.user_message_id, r.assistant_message_id,
        r.status, r.started_at, r.updated_at, r.finished_at, r.error
      FROM assistant_runs r
      INNER JOIN assistant_conversations c ON c.id = r.conversation_id
      WHERE r.id = ? ${ownerKey ? "AND c.owner_key = ?" : ""}
    `).get(...(ownerKey ? [id, ownerKey] : [id])) as AssistantSqlRow | undefined;
    if (!row) return null;
    const events = this.listRunEvents(id, afterSequence, eventLimit);
    const lastSequence = Number(this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS last_sequence
      FROM assistant_run_events
      WHERE run_id = ?
    `).get(id)?.last_sequence ?? 0);
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      userMessageId: String(row.user_message_id),
      assistantMessageId: String(row.assistant_message_id),
      status: String(row.status) as AssistantRunStatus,
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      finishedAt: nullableString(row.finished_at),
      error: nullableString(row.error),
      lastSequence,
      events,
    };
  }

  getRunByUserMessage(conversationId: string, userMessageId: string): AssistantRunSnapshot | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id
      FROM assistant_runs
      WHERE conversation_id = ? AND user_message_id = ?
    `).get(conversationId, userMessageId) as AssistantSqlRow | undefined;
    return row ? this.getRun(String(row.id)) : null;
  }

  getLatestUnfinishedRun(conversationId: string): AssistantRunSnapshot | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id
      FROM assistant_runs
      WHERE conversation_id = ? AND status <> 'completed'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(conversationId) as AssistantSqlRow | undefined;
    return row ? this.getRun(String(row.id)) : null;
  }

  getLatestRun(conversationId: string): AssistantRunSnapshot | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id
      FROM assistant_runs
      WHERE conversation_id = ?
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(conversationId) as AssistantSqlRow | undefined;
    return row ? this.getRun(String(row.id)) : null;
  }

  listRuns(conversationId: string, ownerKey?: string, limit = MAX_RUN_HISTORY, eventLimit = MAX_HISTORY_EVENTS): AssistantRunSnapshot[] {
    this.ensureOpen();
    const boundedLimit = Math.max(1, Math.min(limit, MAX_RUN_HISTORY));
    const boundedEventLimit = Math.max(1, Math.min(eventLimit, MAX_RUN_EVENTS));
    const rows = this.db.prepare(`
      SELECT r.id
      FROM assistant_runs r
      INNER JOIN assistant_conversations c ON c.id = r.conversation_id
      WHERE r.conversation_id = ? ${ownerKey ? "AND c.owner_key = ?" : ""}
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT ?
    `).all(...(ownerKey ? [conversationId, ownerKey, boundedLimit] : [conversationId, boundedLimit])) as AssistantSqlRow[];
    return rows
      .map((row) => this.getRun(String(row.id), 0, ownerKey, boundedEventLimit))
      .filter((run): run is AssistantRunSnapshot => run !== null);
  }

  listRunEvents(runId: string, afterSequence = 0, limit = MAX_RUN_EVENTS): AssistantRunEvent[] {
    this.ensureOpen();
    const boundedSequence = Math.max(0, Math.floor(afterSequence));
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), MAX_RUN_EVENTS));
    const readLatest = boundedLimit < MAX_RUN_EVENTS;
    const rows = this.db.prepare(`
      SELECT sequence, event, payload, created_at
      FROM assistant_run_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ${readLatest ? "DESC" : "ASC"}
      LIMIT ?
    `).all(runId, boundedSequence, boundedLimit) as AssistantSqlRow[];
    return (readLatest ? rows.reverse() : rows).map(rowToRunEvent);
  }

  appendRunEvent(runId: string, event: string, payload: Record<string, unknown>): AssistantRunEvent {
    this.ensureOpen();
    const createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const sequence = Number(this.db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
        FROM assistant_run_events
        WHERE run_id = ?
      `).get(runId)?.next_sequence ?? 1);
      this.db.prepare(`
        INSERT INTO assistant_run_events (run_id, sequence, event, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(runId, sequence, event, JSON.stringify(payload), createdAt);
      this.db.prepare(`
        UPDATE assistant_runs SET updated_at = ? WHERE id = ?
      `).run(createdAt, runId);
      this.db.prepare(
        "DELETE FROM assistant_run_events WHERE run_id = ? AND sequence <= ?",
      ).run(runId, sequence - MAX_RUN_EVENTS);
      this.db.exec("COMMIT;");
      return { sequence, event, payload, createdAt };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  finishRun(runId: string, status: Exclude<AssistantRunStatus, "running">, error: string | null = null): void {
    this.ensureOpen();
    const finishedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE assistant_runs
      SET status = ?, updated_at = ?, finished_at = ?, error = ?
      WHERE id = ?
    `).run(status, finishedAt, finishedAt, error, runId);
  }

  appendMessage(
    conversationId: string,
    message: AssistantStoredMessage,
    title?: string,
    ownerKey?: string,
  ): void {
    this.ensureOpen();
    const now = new Date().toISOString();
    const conversationTitle = title?.trim() || DEFAULT_CONVERSATION_TITLE;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.db.prepare("SELECT owner_key FROM assistant_conversations WHERE id = ?").get(conversationId) as AssistantSqlRow | undefined;
      if (ownerKey && existing && String(existing.owner_key) !== ownerKey) throw new Error("assistant_conversation_forbidden");
      this.db.prepare(`
        INSERT INTO assistant_conversations (id, title, created_at, updated_at, owner_key)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = CASE
            WHEN assistant_conversations.title = ? AND excluded.title <> ? THEN excluded.title
            ELSE assistant_conversations.title
          END,
          updated_at = excluded.updated_at
      `).run(
        conversationId,
        conversationTitle,
        message.createdAt || now,
        now,
        ownerKey ?? "legacy",
        DEFAULT_CONVERSATION_TITLE,
        DEFAULT_CONVERSATION_TITLE,
      );
      this.db.prepare(`
        INSERT OR IGNORE INTO assistant_messages (id, conversation_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(message.id, conversationId, message.role, message.content, message.createdAt || now);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  deleteConversation(id: string, ownerKey?: string): boolean {
    this.ensureOpen();
    const result = this.db.prepare(`DELETE FROM assistant_conversations WHERE id = ? ${ownerKey ? "AND owner_key = ?" : ""}`).run(...(ownerKey ? [id, ownerKey] : [id]));
    return Number(result.changes ?? 0) > 0;
  }

  deleteMessage(conversationId: string, messageId: string, ownerKey?: string): boolean {
    this.ensureOpen();
    const target = this.findMessage(conversationId, messageId, ownerKey);
    if (!target) return false;
    const messageIds = [String(target.id)];
    if (target.role === "user") {
      const next = this.db.prepare(`
        SELECT id, role
        FROM assistant_messages
        WHERE conversation_id = ? AND rowid > ?
        ORDER BY rowid ASC
        LIMIT 1
      `).get(conversationId, Number(target.message_row_id)) as AssistantSqlRow | undefined;
      if (next?.role === "assistant") messageIds.push(String(next.id));
    }
    return this.deleteMessageIds(conversationId, messageIds);
  }

  deleteMessagesFrom(conversationId: string, messageId: string, ownerKey?: string): boolean {
    this.ensureOpen();
    const target = this.findMessage(conversationId, messageId, ownerKey);
    if (!target) return false;
    const rows = this.db.prepare(`
      SELECT id
      FROM assistant_messages
      WHERE conversation_id = ? AND rowid >= ?
      ORDER BY rowid ASC
    `).all(conversationId, Number(target.message_row_id)) as AssistantSqlRow[];
    return this.deleteMessageIds(conversationId, rows.map((row) => String(row.id)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private findMessage(conversationId: string, messageId: string, ownerKey?: string): AssistantSqlRow | undefined {
    return this.db.prepare(`
      SELECT m.rowid AS message_row_id, m.id, m.role
      FROM assistant_messages m
      INNER JOIN assistant_conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = ? AND m.id = ? ${ownerKey ? "AND c.owner_key = ?" : ""}
    `).get(...(ownerKey ? [conversationId, messageId, ownerKey] : [conversationId, messageId])) as AssistantSqlRow | undefined;
  }

  private deleteMessageIds(conversationId: string, messageIds: string[]): boolean {
    if (messageIds.length === 0) return false;
    const placeholders = messageIds.map(() => "?").join(", ");
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const runRows = this.db.prepare(`
        SELECT id
        FROM assistant_runs
        WHERE conversation_id = ?
          AND (user_message_id IN (${placeholders}) OR assistant_message_id IN (${placeholders}))
      `).all(conversationId, ...messageIds, ...messageIds) as AssistantSqlRow[];
      const runIds = runRows.map((row) => String(row.id));
      if (runIds.length > 0) {
        const runPlaceholders = runIds.map(() => "?").join(", ");
        this.db.prepare(`DELETE FROM assistant_run_events WHERE run_id IN (${runPlaceholders})`).run(...runIds);
        this.db.prepare(`DELETE FROM assistant_runs WHERE id IN (${runPlaceholders})`).run(...runIds);
      }
      const deleted = this.db.prepare(`
        DELETE FROM assistant_messages
        WHERE conversation_id = ? AND id IN (${placeholders})
      `).run(conversationId, ...messageIds);
      const now = new Date().toISOString();
      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM assistant_messages WHERE conversation_id = ?").get(conversationId) as AssistantSqlRow;
      if (Number(remaining.count ?? 0) === 0) {
        this.db.prepare("UPDATE assistant_conversations SET title = ?, updated_at = ? WHERE id = ?").run(DEFAULT_CONVERSATION_TITLE, now, conversationId);
      } else {
        this.db.prepare("UPDATE assistant_conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
      }
      this.db.exec("COMMIT;");
      return Number(deleted.changes ?? 0) > 0;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        owner_key TEXT NOT NULL DEFAULT 'legacy'
      );

      CREATE TABLE IF NOT EXISTS assistant_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_assistant_conversations_updated_at
        ON assistant_conversations (updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assistant_messages_conversation
        ON assistant_messages (conversation_id, created_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS assistant_runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'canceled')),
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT,
        UNIQUE (conversation_id, user_message_id),
        FOREIGN KEY (conversation_id) REFERENCES assistant_conversations (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS assistant_run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES assistant_runs (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_assistant_runs_conversation
        ON assistant_runs (conversation_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assistant_run_events_run
        ON assistant_run_events (run_id, sequence ASC);
    `);
    const columns = this.db.prepare("PRAGMA table_info(assistant_conversations)").all() as AssistantSqlRow[];
    if (!columns.some((column) => column.name === "owner_key")) {
      this.db.exec("ALTER TABLE assistant_conversations ADD COLUMN owner_key TEXT NOT NULL DEFAULT 'legacy';");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_assistant_conversations_owner ON assistant_conversations (owner_key, updated_at DESC);");
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("assistant store is closed");
  }
}
