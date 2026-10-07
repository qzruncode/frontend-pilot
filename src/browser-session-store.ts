import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface BrowserSessionUser {
  id: string;
  username: string;
}

export interface BrowserSessionRecord extends BrowserSessionUser {
  sessionKey: string;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export interface BrowserSessionRequestContext {
  sessionKey: string;
  userId: string;
  username: string;
}

const requestContexts = new WeakMap<object, BrowserSessionRequestContext>();

export function setBrowserSessionRequestContext(request: object, context: BrowserSessionRequestContext): void {
  requestContexts.set(request, context);
}

export function getBrowserSessionRequestContext(request: object): BrowserSessionRequestContext | null {
  return requestContexts.get(request) ?? null;
}

export interface BrowserSessionStorePort {
  create(user: BrowserSessionUser, options: { now?: number; idleTtlSeconds: number; absoluteTtlSeconds: number }): { token: string; record: BrowserSessionRecord };
  read(token: string, now?: number): BrowserSessionRecord | null;
  touch(token: string, options: { now?: number; idleTtlSeconds: number }): BrowserSessionRecord | null;
  revoke(token: string, now?: number): void;
  close(): void;
}

interface StoredSession {
  session_key?: unknown;
  user_id?: unknown;
  username?: unknown;
  created_at?: unknown;
  last_seen_at?: unknown;
  idle_expires_at?: unknown;
  absolute_expires_at?: unknown;
  revoked_at?: unknown;
}

function numeric(value: unknown): number {
  return Number(value ?? 0);
}

function hashToken(token: string, secret: string): string {
  if (secret) return createHmac("sha256", secret).update(token).digest("hex");
  return createHash("sha256").update(token).digest("hex");
}

export function sessionMaxAgeSeconds(record: BrowserSessionRecord, now = Date.now()): number {
  return Math.max(0, Math.floor((Math.min(record.idleExpiresAt, record.absoluteExpiresAt) - now) / 1_000));
}

export class BrowserSessionStore implements BrowserSessionStorePort {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(private readonly databasePath: string, private readonly hashSecret: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_sessions (
        session_key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        idle_expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_browser_sessions_user_id
        ON browser_sessions (user_id, revoked_at, absolute_expires_at);
    `);
  }

  create(user: BrowserSessionUser, options: { now?: number; idleTtlSeconds: number; absoluteTtlSeconds: number }): { token: string; record: BrowserSessionRecord } {
    this.ensureOpen();
    const now = options.now ?? Date.now();
    this.db.prepare("DELETE FROM browser_sessions WHERE revoked_at IS NOT NULL OR absolute_expires_at <= ?").run(now);
    const token = randomBytes(32).toString("base64url");
    const sessionKey = hashToken(token, this.hashSecret);
    const record: BrowserSessionRecord = {
      sessionKey,
      id: user.id,
      username: user.username,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: now + Math.max(1, options.idleTtlSeconds) * 1_000,
      absoluteExpiresAt: now + Math.max(1, options.absoluteTtlSeconds) * 1_000,
    };
    record.idleExpiresAt = Math.min(record.idleExpiresAt, record.absoluteExpiresAt);
    this.db.prepare(`
      INSERT INTO browser_sessions (
        session_key, user_id, username, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(record.sessionKey, record.id, record.username, record.createdAt, record.lastSeenAt, record.idleExpiresAt, record.absoluteExpiresAt);
    return { token, record };
  }

  read(token: string, now = Date.now()): BrowserSessionRecord | null {
    this.ensureOpen();
    const normalized = token.trim();
    if (!normalized) return null;
    const row = this.db.prepare(`
      SELECT session_key, user_id, username, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at, revoked_at
      FROM browser_sessions
      WHERE session_key = ?
    `).get(hashToken(normalized, this.hashSecret)) as StoredSession | undefined;
    if (!row || (row.revoked_at !== null && row.revoked_at !== undefined)) return null;
    const record = this.toRecord(row);
    if (record.idleExpiresAt <= now || record.absoluteExpiresAt <= now) {
      this.db.prepare("UPDATE browser_sessions SET revoked_at = ? WHERE session_key = ? AND revoked_at IS NULL").run(now, record.sessionKey);
      return null;
    }
    return record;
  }

  touch(token: string, options: { now?: number; idleTtlSeconds: number }): BrowserSessionRecord | null {
    this.ensureOpen();
    const now = options.now ?? Date.now();
    const current = this.read(token, now);
    if (!current) return null;
    const idleExpiresAt = Math.min(now + Math.max(1, options.idleTtlSeconds) * 1_000, current.absoluteExpiresAt);
    this.db.prepare(`
      UPDATE browser_sessions
      SET last_seen_at = ?, idle_expires_at = ?
      WHERE session_key = ? AND revoked_at IS NULL
    `).run(now, idleExpiresAt, current.sessionKey);
    return { ...current, lastSeenAt: now, idleExpiresAt };
  }

  revoke(token: string, now = Date.now()): void {
    this.ensureOpen();
    const normalized = token.trim();
    if (!normalized) return;
    this.db.prepare("UPDATE browser_sessions SET revoked_at = ? WHERE session_key = ? AND revoked_at IS NULL").run(now, hashToken(normalized, this.hashSecret));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private toRecord(row: StoredSession): BrowserSessionRecord {
    return {
      sessionKey: String(row.session_key ?? ""),
      id: String(row.user_id ?? ""),
      username: String(row.username ?? ""),
      createdAt: numeric(row.created_at),
      lastSeenAt: numeric(row.last_seen_at),
      idleExpiresAt: numeric(row.idle_expires_at),
      absoluteExpiresAt: numeric(row.absolute_expires_at),
    };
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("浏览器会话存储已关闭");
  }
}
