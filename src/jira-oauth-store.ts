import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JiraIdentitySchema } from "./api-contracts.js";
import { decryptCredential, encryptCredential } from "./credential-crypto.js";
import type { JiraOAuthCredentials } from "./jira-client.js";
import type { JiraIdentity } from "./jira-workbench.js";

export interface JiraOAuthSession {
  credentials: JiraOAuthCredentials;
  identity: JiraIdentity;
}

export interface JiraOAuthSessionStorePort {
  read(ownerKey: string, providerKey: string): JiraOAuthSession | null;
  write(ownerKey: string, providerKey: string, session: JiraOAuthSession): void;
  delete(ownerKey: string, providerKey: string): void;
  close(): void;
}

interface StoredSession {
  consumer_key_ciphertext?: unknown;
  private_key_ciphertext?: unknown;
  access_token_ciphertext?: unknown;
  access_token_secret_ciphertext?: unknown;
  identity_json?: unknown;
}

export class JiraOAuthSessionStore implements JiraOAuthSessionStorePort {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(private readonly databasePath: string, private readonly encryptionSecret: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jira_oauth_sessions (
        owner_key TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        consumer_key_ciphertext TEXT NOT NULL,
        private_key_ciphertext TEXT NOT NULL,
        access_token_ciphertext TEXT NOT NULL,
        access_token_secret_ciphertext TEXT NOT NULL,
        identity_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_key, provider_key)
      );
      CREATE INDEX IF NOT EXISTS idx_jira_oauth_sessions_updated_at
        ON jira_oauth_sessions (updated_at);
    `);
  }

  read(ownerKey: string, providerKey: string): JiraOAuthSession | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT consumer_key_ciphertext, private_key_ciphertext,
        access_token_ciphertext, access_token_secret_ciphertext, identity_json
      FROM jira_oauth_sessions
      WHERE owner_key = ? AND provider_key = ?
    `).get(ownerKey, providerKey) as StoredSession | undefined;
    if (!row) return null;

    const consumerKey = decryptCredential(String(row.consumer_key_ciphertext ?? ""), this.encryptionSecret);
    const privateKey = decryptCredential(String(row.private_key_ciphertext ?? ""), this.encryptionSecret);
    const accessToken = decryptCredential(String(row.access_token_ciphertext ?? ""), this.encryptionSecret);
    const accessTokenSecret = decryptCredential(String(row.access_token_secret_ciphertext ?? ""), this.encryptionSecret);
    if (!consumerKey || !privateKey || !accessToken || !accessTokenSecret) return null;

    try {
      const parsed = JiraIdentitySchema.safeParse(JSON.parse(String(row.identity_json ?? "")));
      if (!parsed.success) return null;
      return {
        credentials: { consumerKey, privateKey, accessToken, accessTokenSecret },
        identity: parsed.data,
      };
    } catch {
      return null;
    }
  }

  write(ownerKey: string, providerKey: string, session: JiraOAuthSession): void {
    this.ensureOpen();
    const values = [
      encryptCredential(session.credentials.consumerKey, this.encryptionSecret),
      encryptCredential(session.credentials.privateKey, this.encryptionSecret),
      encryptCredential(session.credentials.accessToken, this.encryptionSecret),
      encryptCredential(session.credentials.accessTokenSecret, this.encryptionSecret),
    ];
    if (!ownerKey || !providerKey || values.some((value) => !value)) throw new Error("Jira OAuth 会话无法安全保存");
    this.db.prepare(`
      INSERT INTO jira_oauth_sessions (
        owner_key, provider_key, consumer_key_ciphertext, private_key_ciphertext,
        access_token_ciphertext, access_token_secret_ciphertext, identity_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_key, provider_key) DO UPDATE SET
        consumer_key_ciphertext = excluded.consumer_key_ciphertext,
        private_key_ciphertext = excluded.private_key_ciphertext,
        access_token_ciphertext = excluded.access_token_ciphertext,
        access_token_secret_ciphertext = excluded.access_token_secret_ciphertext,
        identity_json = excluded.identity_json,
        updated_at = excluded.updated_at
    `).run(ownerKey, providerKey, values[0], values[1], values[2], values[3], JSON.stringify(session.identity), new Date().toISOString());
  }

  delete(ownerKey: string, providerKey: string): void {
    this.ensureOpen();
    this.db.prepare("DELETE FROM jira_oauth_sessions WHERE owner_key = ? AND provider_key = ?").run(ownerKey, providerKey);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Jira OAuth 会话存储已关闭");
  }
}
