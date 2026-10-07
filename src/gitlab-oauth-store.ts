import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GitLabIdentitySchema } from "./api-contracts.js";
import { decryptCredential, encryptCredential } from "./credential-crypto.js";
import type { GitLabIdentity } from "./gitlab-workbench.js";

export interface GitLabOAuthSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  identity: GitLabIdentity;
}

export interface GitLabOAuthSessionStorePort {
  read(sessionKey: string, providerKey: string): GitLabOAuthSession | null;
  write(sessionKey: string, providerKey: string, session: GitLabOAuthSession): void;
  delete(sessionKey: string, providerKey: string): void;
  close(): void;
}

interface StoredSession {
  session_key?: unknown;
  provider_key?: unknown;
  access_token_ciphertext?: unknown;
  refresh_token_ciphertext?: unknown;
  expires_at?: unknown;
  identity_json?: unknown;
}

export class GitLabOAuthSessionStore implements GitLabOAuthSessionStorePort {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(private readonly databasePath: string, private readonly encryptionSecret: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gitlab_oauth_sessions (
        session_key TEXT PRIMARY KEY,
        provider_key TEXT NOT NULL,
        access_token_ciphertext TEXT NOT NULL,
        refresh_token_ciphertext TEXT,
        expires_at INTEGER,
        identity_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gitlab_oauth_sessions_updated_at
        ON gitlab_oauth_sessions (updated_at);
    `);
  }

  read(sessionKey: string, providerKey: string): GitLabOAuthSession | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT session_key, provider_key, access_token_ciphertext,
        refresh_token_ciphertext, expires_at, identity_json
      FROM gitlab_oauth_sessions
      WHERE session_key = ? AND provider_key = ?
    `).get(sessionKey, providerKey) as StoredSession | undefined;
    if (!row) return null;

    const accessToken = decryptCredential(String(row.access_token_ciphertext ?? ""), this.encryptionSecret);
    if (!accessToken) return null;
    const refreshTokenCiphertext = String(row.refresh_token_ciphertext ?? "");
    const refreshToken = refreshTokenCiphertext
      ? decryptCredential(refreshTokenCiphertext, this.encryptionSecret) ?? undefined
      : undefined;
    let identity: GitLabIdentity;
    try {
      const parsed = GitLabIdentitySchema.safeParse(JSON.parse(String(row.identity_json ?? "")));
      if (!parsed.success) return null;
      identity = parsed.data;
    } catch {
      return null;
    }

    const expiresAt = row.expires_at === null || row.expires_at === undefined ? undefined : Number(row.expires_at);
    return {
      accessToken,
      refreshToken,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
      identity,
    };
  }

  write(sessionKey: string, providerKey: string, session: GitLabOAuthSession): void {
    this.ensureOpen();
    const accessTokenCiphertext = encryptCredential(session.accessToken, this.encryptionSecret);
    const refreshTokenCiphertext = session.refreshToken
      ? encryptCredential(session.refreshToken, this.encryptionSecret)
      : null;
    if (!sessionKey || !providerKey || !accessTokenCiphertext || (session.refreshToken && !refreshTokenCiphertext)) {
      throw new Error("GitLab OAuth 会话无法安全保存");
    }
    this.db.prepare(`
      INSERT INTO gitlab_oauth_sessions (
        session_key, provider_key, access_token_ciphertext,
        refresh_token_ciphertext, expires_at, identity_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        provider_key = excluded.provider_key,
        access_token_ciphertext = excluded.access_token_ciphertext,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        expires_at = excluded.expires_at,
        identity_json = excluded.identity_json,
        updated_at = excluded.updated_at
    `).run(
      sessionKey,
      providerKey,
      accessTokenCiphertext,
      refreshTokenCiphertext,
      session.expiresAt ?? null,
      JSON.stringify(session.identity),
      new Date().toISOString(),
    );
  }

  delete(sessionKey: string, providerKey: string): void {
    this.ensureOpen();
    this.db.prepare("DELETE FROM gitlab_oauth_sessions WHERE session_key = ? AND provider_key = ?").run(sessionKey, providerKey);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("GitLab OAuth 会话存储已关闭");
  }
}
