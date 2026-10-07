import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type UserRole = "admin" | "user";

export interface ProductUser {
  id: string;
  username: string;
  password: string | null;
  role: UserRole;
  enabled: boolean;
  inspectionAccess?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserStorePort {
  hasUsers(): boolean;
  countUsers(): number;
  list(limit?: number): ProductUser[];
  findById(id: string): ProductUser | null;
  findByUsername(username: string): ProductUser | null;
  verifyCredentials(username: string, password: string): ProductUser | null;
  create(input: { username: string; password: string }): ProductUser;
  update(id: string, input: { username?: string; password?: string; enabled?: boolean; inspectionAccess?: boolean }): ProductUser | null;
  delete(id: string): boolean;
  countAdmins(): number;
  countEnabledAdmins(): number;
  close(): void;
}

export const DEFAULT_ADMIN_USERNAME = "pilot-admin";

export class UserStoreError extends Error {
  constructor(readonly code: "username_taken") {
    super(code);
    this.name = "UserStoreError";
  }
}

interface StoredUser extends ProductUser {
  passwordHash: string;
}

interface UserSqlRow {
  id?: unknown;
  username?: unknown;
  role?: unknown;
  enabled?: unknown;
  inspection_access?: unknown;
  password_hash?: unknown;
  password_ciphertext?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const digest = scryptSync(password, salt, 32).toString("base64url");
  return `scrypt$${salt}$${digest}`;
}

function matchesPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, digest] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !digest) return false;
  const expected = Buffer.from(digest, "base64url");
  const actual = scryptSync(password, salt, expected.length || 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function encryptionKey(secret: string): Buffer | null {
  return secret ? createHash("sha256").update(secret).digest() : null;
}

function encryptPassword(password: string, secret: string): string | null {
  const key = encryptionKey(secret);
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return `v1$${iv.toString("base64url")}$${cipher.getAuthTag().toString("base64url")}$${ciphertext.toString("base64url")}`;
}

function decryptPassword(encoded: string, secret: string): string | null {
  const key = encryptionKey(secret);
  if (!key) return null;
  const [version, ivValue, tagValue, ciphertextValue] = encoded.split("$");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export class UserStore implements UserStorePort {
  private readonly db: DatabaseSync;
  private readonly passwordDisplayKey: string;
  private closed = false;

  constructor(databasePath: string, bootstrapUsers: Array<{ username: string; password: string; role: UserRole }> = [], passwordDisplayKey = "") {
    this.passwordDisplayKey = passwordDisplayKey;
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.migrate();
    bootstrapUsers.forEach((user) => this.seed(user));
  }

  hasUsers(): boolean {
    return this.countUsers() > 0;
  }

  countUsers(): number {
    this.ensureOpen();
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM product_users").get() as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  list(limit = 200): ProductUser[] {
    this.ensureOpen();
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.db.prepare(`
      SELECT id, username, role, enabled, inspection_access, password_ciphertext, created_at, updated_at
      FROM product_users
      ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username COLLATE NOCASE ASC
      LIMIT ?
    `).all(boundedLimit) as UserSqlRow[];
    return rows.map((row) => this.toPublicUser(row));
  }

  findById(id: string): ProductUser | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id, username, role, enabled, inspection_access, password_hash, password_ciphertext, created_at, updated_at
      FROM product_users WHERE id = ?
    `).get(id) as UserSqlRow | undefined;
    return row ? this.toStoredUser(row) : null;
  }

  findByUsername(username: string): ProductUser | null {
    this.ensureOpen();
    const user = this.findStoredByUsername(username);
    return user ? this.toPublicUser(user) : null;
  }

  verifyCredentials(username: string, password: string): ProductUser | null {
    const user = this.findStoredByUsername(username);
    if (!user || !user.enabled || !matchesPassword(password, user.passwordHash)) return null;
    return this.toPublicUser(user);
  }

  create(input: { username: string; password: string }): ProductUser {
    this.ensureOpen();
    const username = input.username.trim();
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO product_users (id, username, password_hash, password_ciphertext, role, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'user', 1, ?, ?)
      `).run(randomUUID(), username, hashPassword(input.password), encryptPassword(input.password, this.passwordDisplayKey), now, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) throw new UserStoreError("username_taken");
      throw error;
    }
    const user = this.findByUsername(username);
    if (!user) throw new Error("created_user_not_found");
    return user;
  }

  update(id: string, input: { username?: string; password?: string; enabled?: boolean; inspectionAccess?: boolean }): ProductUser | null {
    this.ensureOpen();
    const current = this.findById(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if (input.username !== undefined) {
      assignments.push("username = ?");
      values.push(input.username.trim());
    }
    if (input.password !== undefined) {
      assignments.push("password_hash = ?", "password_ciphertext = ?");
      values.push(hashPassword(input.password), encryptPassword(input.password, this.passwordDisplayKey));
    }
    if (input.enabled !== undefined) {
      assignments.push("enabled = ?");
      values.push(input.enabled ? 1 : 0);
    }
    if (input.inspectionAccess !== undefined) {
      assignments.push("inspection_access = ?");
      values.push(input.inspectionAccess ? 1 : 0);
    }
    assignments.push("updated_at = ?");
    values.push(now);
    try {
      this.db.prepare(`UPDATE product_users SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) throw new UserStoreError("username_taken");
      throw error;
    }
    return this.findById(id);
  }

  delete(id: string): boolean {
    this.ensureOpen();
    const result = this.db.prepare("DELETE FROM product_users WHERE id = ?").run(id);
    return Number(result.changes ?? 0) > 0;
  }

  countAdmins(): number {
    return this.countUsersBy("admin", false);
  }

  countEnabledAdmins(): number {
    return this.countUsersBy("admin", true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private seed(user: { username: string; password: string; role: UserRole }): void {
    const username = user.username.trim();
    if (!username || !user.password) return;
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT password_hash, password_ciphertext FROM product_users WHERE username = ?").get(username) as { password_hash?: unknown; password_ciphertext?: unknown } | undefined;
    if (existing) {
      if (!existing.password_ciphertext && this.passwordDisplayKey && matchesPassword(user.password, String(existing.password_hash ?? ""))) {
        this.db.prepare("UPDATE product_users SET password_ciphertext = ?, updated_at = ? WHERE username = ?")
          .run(encryptPassword(user.password, this.passwordDisplayKey), now, username);
      }
      return;
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO product_users (id, username, password_hash, password_ciphertext, role, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(randomUUID(), username, hashPassword(user.password), encryptPassword(user.password, this.passwordDisplayKey), user.role, now, now);
  }

  private countUsersBy(role: UserRole, enabledOnly: boolean): number {
    this.ensureOpen();
    const query = enabledOnly
      ? "SELECT COUNT(*) AS count FROM product_users WHERE role = ? AND enabled = 1"
      : "SELECT COUNT(*) AS count FROM product_users WHERE role = ?";
    const row = this.db.prepare(query).get(role) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0);
  }

  private findStoredByUsername(username: string): StoredUser | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id, username, role, enabled, inspection_access, password_hash, password_ciphertext, created_at, updated_at
      FROM product_users WHERE username = ?
    `).get(username.trim()) as UserSqlRow | undefined;
    return row ? this.toStoredUser(row) : null;
  }

  private toPublicUser(row: UserSqlRow | StoredUser): ProductUser {
    return {
      id: String(row.id),
      username: String(row.username),
      password: "password" in row ? row.password : decryptPassword(String(row.password_ciphertext ?? ""), this.passwordDisplayKey),
      role: row.role === "admin" ? "admin" : "user",
      enabled: Number(row.enabled) === 1,
      inspectionAccess: row.role === "admin" || ("inspectionAccess" in row ? Boolean(row.inspectionAccess) : ("inspection_access" in row && Number(row.inspection_access) === 1)),
      createdAt: String("createdAt" in row ? row.createdAt : row.created_at),
      updatedAt: String("updatedAt" in row ? row.updatedAt : row.updated_at),
    };
  }

  private toStoredUser(row: UserSqlRow): StoredUser {
    return {
      ...this.toPublicUser(row),
      passwordHash: String(row.password_hash ?? ""),
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS product_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        password_ciphertext TEXT,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_product_users_enabled ON product_users (enabled, username COLLATE NOCASE);
    `);
    const columns = this.db.prepare("PRAGMA table_info(product_users)").all() as Array<{ name?: unknown }>;
    if (!columns.some((column) => column.name === "inspection_access")) {
      this.db.exec("ALTER TABLE product_users ADD COLUMN inspection_access INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((column) => column.name === "password_ciphertext")) {
      this.db.exec("ALTER TABLE product_users ADD COLUMN password_ciphertext TEXT");
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("user store is closed");
  }
}
