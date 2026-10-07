import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decryptCredential, encryptCredential } from "./credential-crypto.js";

export interface JiraUserCredential {
  productUsername: string;
  jiraUsername: string;
  token: string;
  updatedAt: string;
}

export interface JiraUserCredentialStorePort {
  read(productUsername: string): JiraUserCredential | null;
  write(productUsername: string, input: { jiraUsername: string; token: string }): JiraUserCredential;
  delete(productUsername: string): boolean;
  close(): void;
}

interface StoredCredential {
  product_username?: unknown;
  jira_username?: unknown;
  token_ciphertext?: unknown;
  updated_at?: unknown;
}

function normalizeProductUsername(value: string): string {
  return value.trim().toLowerCase();
}

export class JiraUserCredentialStore implements JiraUserCredentialStorePort {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(private readonly databasePath: string, private readonly encryptionSecret: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jira_user_credentials (
        product_username TEXT PRIMARY KEY,
        jira_username TEXT NOT NULL,
        token_ciphertext TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  read(productUsername: string): JiraUserCredential | null {
    this.ensureOpen();
    const normalized = normalizeProductUsername(productUsername);
    if (!normalized) return null;
    const row = this.db.prepare(`
      SELECT product_username, jira_username, token_ciphertext, updated_at
      FROM jira_user_credentials
      WHERE product_username = ?
    `).get(normalized) as StoredCredential | undefined;
    if (!row) return null;
    const token = decryptCredential(String(row.token_ciphertext ?? ""), this.encryptionSecret);
    if (!token) return null;
    return {
      productUsername: String(row.product_username ?? normalized),
      jiraUsername: String(row.jira_username ?? ""),
      token,
      updatedAt: String(row.updated_at ?? ""),
    };
  }

  write(productUsername: string, input: { jiraUsername: string; token: string }): JiraUserCredential {
    this.ensureOpen();
    const normalized = normalizeProductUsername(productUsername);
    const jiraUsername = input.jiraUsername.trim();
    const token = input.token.trim();
    const tokenCiphertext = encryptCredential(token, this.encryptionSecret);
    if (!normalized || !jiraUsername || !tokenCiphertext) throw new Error("Jira 个人凭据无法保存");
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO jira_user_credentials (product_username, jira_username, token_ciphertext, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(product_username) DO UPDATE SET
        jira_username = excluded.jira_username,
        token_ciphertext = excluded.token_ciphertext,
        updated_at = excluded.updated_at
    `).run(normalized, jiraUsername, tokenCiphertext, updatedAt);
    return { productUsername: normalized, jiraUsername, token, updatedAt };
  }

  delete(productUsername: string): boolean {
    this.ensureOpen();
    const result = this.db.prepare("DELETE FROM jira_user_credentials WHERE product_username = ?").run(normalizeProductUsername(productUsername));
    return Number(result.changes ?? 0) > 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Jira 个人凭据存储已关闭");
  }
}
