import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FeedbackCategorySchema, type FeedbackCategory, type FeedbackImageMimeType } from "./contracts.js";
import { isFeedbackImageMimeType, type FeedbackAttachmentInput } from "./feedback-upload.js";

export interface FeedbackAttachment {
  id: string;
  filename: string;
  mimeType: FeedbackImageMimeType;
  size: number;
}

export interface FeedbackAttachmentDownload extends FeedbackAttachment {
  filePath: string;
}

export interface FeedbackSubmission {
  category: FeedbackCategory;
  rating: number;
  message: string;
  contact?: string;
  attachments?: FeedbackAttachmentInput[];
}

export interface FeedbackSubmissionResult {
  id: string;
  receivedAt: string;
}

export interface FeedbackListItem {
  id: string;
  category: FeedbackCategory;
  rating: number;
  message: string;
  createdAt: string;
}

export interface FeedbackDetail extends FeedbackListItem {
  contact?: string;
  attachments?: FeedbackAttachment[];
}

export interface FeedbackListResult {
  items: FeedbackListItem[];
  total: number;
}

export interface FeedbackStorePort {
  create(input: FeedbackSubmission): FeedbackSubmissionResult;
  get(id: string): FeedbackDetail | null;
  readAttachment?(feedbackId: string, attachmentId: string): FeedbackAttachmentDownload | null;
  list(limit?: number): FeedbackListResult;
  delete(id: string): boolean;
  close(): void;
}

interface FeedbackSqlRow {
  id?: unknown;
  category?: unknown;
  rating?: unknown;
  message?: unknown;
  contact?: unknown;
  created_at?: unknown;
}

interface FeedbackAttachmentSqlRow {
  id?: unknown;
  feedback_id?: unknown;
  filename?: unknown;
  mime_type?: unknown;
  size?: unknown;
  storage_name?: unknown;
}

export class FeedbackStore implements FeedbackStorePort {
  private readonly db: DatabaseSync;
  private readonly attachmentsDir: string;
  private closed = false;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }
    this.attachmentsDir = path.join(databasePath === ":memory:"
      ? path.join(process.cwd(), "var")
      : path.dirname(path.resolve(databasePath)), "feedback-attachments");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  create(input: FeedbackSubmission): FeedbackSubmissionResult {
    this.ensureOpen();
    const result = { id: randomUUID(), receivedAt: new Date().toISOString() };
    const attachments = (input.attachments ?? []).map((attachment) => ({
      ...attachment,
      id: randomUUID(),
      storageName: `${randomUUID()}.bin`,
    }));
    const writtenPaths: string[] = [];
    try {
      if (attachments.length > 0) mkdirSync(this.attachmentsDir, { recursive: true });
      for (const attachment of attachments) {
        const filePath = path.join(this.attachmentsDir, attachment.storageName);
        writeFileSync(filePath, attachment.data, { flag: "wx", mode: 0o600 });
        writtenPaths.push(filePath);
      }
      this.db.exec("BEGIN");
      try {
        this.db.prepare(`
          INSERT INTO feedback_submissions (id, category, rating, message, contact, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          result.id,
          input.category,
          input.rating,
          input.message,
          input.contact ?? null,
          result.receivedAt,
        );
        const insertAttachment = this.db.prepare(`
          INSERT INTO feedback_attachments (id, feedback_id, filename, mime_type, size, storage_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const attachment of attachments) {
          insertAttachment.run(attachment.id, result.id, attachment.filename, attachment.mimeType, attachment.data.byteLength, attachment.storageName, result.receivedAt);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      for (const filePath of writtenPaths) if (existsSync(filePath)) unlinkSync(filePath);
      throw error;
    }
    return result;
  }

  get(id: string): FeedbackDetail | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id, category, rating, message, contact, created_at
      FROM feedback_submissions
      WHERE id = ?
    `).get(id) as FeedbackSqlRow | undefined;
    if (!row) return null;
    const attachments = this.attachmentsFor(id);
    return {
      id: String(row.id),
      category: FeedbackCategorySchema.parse(row.category),
      rating: Number(row.rating),
      message: String(row.message),
      createdAt: String(row.created_at),
      ...(typeof row.contact === "string" && row.contact.length > 0 ? { contact: row.contact } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  readAttachment(feedbackId: string, attachmentId: string): FeedbackAttachmentDownload | null {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id, feedback_id, filename, mime_type, size, storage_name
      FROM feedback_attachments
      WHERE id = ? AND feedback_id = ?
    `).get(attachmentId, feedbackId) as FeedbackAttachmentSqlRow | undefined;
    if (!row) return null;
    const storageName = String(row.storage_name ?? "");
    const filePath = path.join(this.attachmentsDir, storageName);
    if (!storageName || !existsSync(filePath)) return null;
    const mimeType = isFeedbackImageMimeType(row.mime_type) ? row.mime_type : null;
    if (!mimeType) return null;
    return {
      id: String(row.id),
      filename: String(row.filename),
      mimeType,
      size: Number(row.size),
      filePath,
    };
  }

  list(limit = 100): FeedbackListResult {
    this.ensureOpen();
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const rows = this.db.prepare(`
      SELECT id, category, rating, message, created_at
      FROM feedback_submissions
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(boundedLimit) as FeedbackSqlRow[];
    const totalRow = this.db.prepare("SELECT COUNT(*) AS count FROM feedback_submissions").get() as { count?: unknown } | undefined;
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        category: FeedbackCategorySchema.parse(row.category),
        rating: Number(row.rating),
        message: String(row.message),
        createdAt: String(row.created_at),
      })),
      total: Number(totalRow?.count ?? 0),
    };
  }

  delete(id: string): boolean {
    this.ensureOpen();
    const attachmentRows = this.db.prepare("SELECT storage_name FROM feedback_attachments WHERE feedback_id = ?").all(id) as FeedbackAttachmentSqlRow[];
    const result = this.db.prepare("DELETE FROM feedback_submissions WHERE id = ?").run(id);
    if (Number(result.changes ?? 0) === 0) return false;
    this.db.prepare("DELETE FROM feedback_attachments WHERE feedback_id = ?").run(id);
    for (const row of attachmentRows) {
      const storageName = String(row.storage_name ?? "");
      const filePath = path.join(this.attachmentsDir, storageName);
      if (storageName && existsSync(filePath)) unlinkSync(filePath);
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_submissions (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'experience', 'other')),
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        message TEXT NOT NULL,
        contact TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_submissions_created_at
        ON feedback_submissions (created_at DESC);

      CREATE TABLE IF NOT EXISTS feedback_attachments (
        id TEXT PRIMARY KEY,
        feedback_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_attachments_feedback_id
        ON feedback_attachments (feedback_id);
    `);
  }

  private attachmentsFor(feedbackId: string): FeedbackAttachment[] {
    const rows = this.db.prepare(`
      SELECT id, filename, mime_type, size, storage_name
      FROM feedback_attachments
      WHERE feedback_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(feedbackId) as FeedbackAttachmentSqlRow[];
    return rows
      .filter((row) => {
        const storageName = String(row.storage_name ?? "");
        return Boolean(storageName) && existsSync(path.join(this.attachmentsDir, storageName));
      })
      .map((row) => {
        const mimeType = isFeedbackImageMimeType(row.mime_type) ? row.mime_type : null;
        return mimeType ? {
          id: String(row.id),
          filename: String(row.filename),
          mimeType,
          size: Number(row.size),
        } : null;
      })
      .filter((attachment): attachment is FeedbackAttachment => attachment !== null);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("feedback store is closed");
  }
}
