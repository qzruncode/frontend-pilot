import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ReviewJob,
  ReviewProgressEvent,
  ReviewStatus,
} from "./contracts.js";
import type { ReviewCiBinding } from "./review-service-types.js";

const MAX_PROGRESS_EVENTS = 1_000;
const MAX_PERSISTED_REVIEW_JOBS = 2_000;
const REVIEW_SESSION_SETTING_PREFIX = "review.session.";
const REVIEW_WORKSPACE_SETTING_PREFIX = "review.workspace.";

export interface StoredReviewJob extends ReviewJob {
  key: string;
  ciBinding: ReviewCiBinding | null;
  progressSequence: number;
}

export interface StoredReviewSession {
  projectId: string;
  mrIid: string;
  sessionId: string;
}

export interface StoredReviewWorkspace {
  projectId: string;
  mrIid: string;
}

interface SqlRow {
  [key: string]: unknown;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseResult(value: unknown): ReviewJob["result"] {
  if (value === null || value === undefined || value === "") return null;
  return JSON.parse(String(value)) as ReviewJob["result"];
}

function parseMeta(value: unknown): ReviewProgressEvent["meta"] {
  if (value === null || value === undefined || value === "") return undefined;
  return JSON.parse(String(value)) as ReviewProgressEvent["meta"];
}

function parseCiBinding(value: unknown): ReviewCiBinding | null {
  if (value === null || value === undefined || value === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.jobId !== "string"
    || typeof record.pipelineId !== "string"
    || typeof record.jobUrl !== "string"
    || typeof record.tokenHash !== "string"
  ) return null;
  return {
    jobId: record.jobId,
    pipelineId: record.pipelineId,
    jobUrl: record.jobUrl,
    tokenHash: record.tokenHash,
  };
}

export class ReviewStore {
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

  loadJobs(): StoredReviewJob[] {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT
        id, job_key, project_id, project_path, mr_iid, head_sha, target_branch,
        source, status, created_at, started_at, finished_at, note_id, error,
        result_json, ci_json, progress_sequence
      FROM review_jobs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(MAX_PERSISTED_REVIEW_JOBS) as SqlRow[];

    return rows.map((row) => {
      const id = String(row.id);
      const progress = this.loadProgress(id);
      return {
        id,
        projectId: String(row.project_id),
        projectPath: nullableString(row.project_path),
        mrIid: String(row.mr_iid),
        headSha: nullableString(row.head_sha),
        targetBranch: nullableString(row.target_branch),
        source: String(row.source),
        status: String(row.status) as ReviewStatus,
        createdAt: String(row.created_at),
        startedAt: nullableString(row.started_at),
        finishedAt: nullableString(row.finished_at),
        noteId: row.note_id === null || row.note_id === undefined ? null : Number(row.note_id),
        error: nullableString(row.error),
        result: parseResult(row.result_json),
        ciBinding: parseCiBinding(row.ci_json),
        progress,
        key: String(row.job_key),
        progressSequence: Number(row.progress_sequence ?? 0),
      } satisfies StoredReviewJob;
    });
  }

  saveJob(job: StoredReviewJob, event?: ReviewProgressEvent): void {
    this.ensureOpen();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        INSERT INTO review_jobs (
          id, job_key, project_id, project_path, mr_iid, head_sha, target_branch,
          source, status, created_at, started_at, finished_at, note_id, error,
          result_json, ci_json, progress_sequence, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          job_key = excluded.job_key,
          project_id = excluded.project_id,
          project_path = excluded.project_path,
          mr_iid = excluded.mr_iid,
          head_sha = excluded.head_sha,
          target_branch = excluded.target_branch,
          source = excluded.source,
          status = excluded.status,
          created_at = excluded.created_at,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          note_id = excluded.note_id,
          error = excluded.error,
          result_json = excluded.result_json,
          ci_json = excluded.ci_json,
          progress_sequence = excluded.progress_sequence,
          updated_at = excluded.updated_at
      `).run(
        job.id,
        job.key,
        job.projectId,
        job.projectPath,
        job.mrIid,
        job.headSha,
        job.targetBranch,
        job.source,
        job.status,
        job.createdAt,
        job.startedAt,
        job.finishedAt,
        job.noteId,
        job.error,
        job.result ? JSON.stringify(job.result) : null,
        job.ciBinding ? JSON.stringify(job.ciBinding) : null,
        job.progressSequence,
        new Date().toISOString(),
      );

      if (event) {
        this.db.prepare(`
          INSERT OR REPLACE INTO review_progress (
            job_id, sequence, event_id, at, kind, message, detail, meta_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          job.id,
          job.progressSequence,
          event.id,
          event.at,
          event.kind,
          event.message,
          event.detail ?? null,
          event.meta === undefined ? null : JSON.stringify(event.meta),
        );
        this.db.prepare(
          "DELETE FROM review_progress WHERE job_id = ? AND sequence <= ?",
        ).run(job.id, job.progressSequence - MAX_PROGRESS_EVENTS);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  deleteJob(id: string): boolean {
    this.ensureOpen();
    const result = this.db.prepare("DELETE FROM review_jobs WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  getSetting(key: string): string | null {
    this.ensureOpen();
    const row = this.db.prepare(
      "SELECT setting_value FROM review_settings WHERE setting_key = ?",
    ).get(key) as SqlRow | undefined;
    return row?.setting_value === undefined || row.setting_value === null
      ? null
      : String(row.setting_value);
  }

  setSetting(key: string, value: string): void {
    this.ensureOpen();
    this.db.prepare(`
      INSERT INTO review_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  getReviewSession(projectId: string, mrIid: string): string | null {
    const sessionId = this.getSetting(`${REVIEW_SESSION_SETTING_PREFIX}${projectId}:${mrIid}`)?.trim();
    return sessionId || null;
  }

  saveReviewSession(projectId: string, mrIid: string, sessionId: string): void {
    const normalized = sessionId.trim();
    if (!normalized) return;
    this.setSetting(`${REVIEW_SESSION_SETTING_PREFIX}${projectId}:${mrIid}`, normalized);
  }

  deleteReviewSession(projectId: string, mrIid: string): boolean {
    this.ensureOpen();
    const result = this.db.prepare(
      "DELETE FROM review_settings WHERE setting_key = ?",
    ).run(`${REVIEW_SESSION_SETTING_PREFIX}${projectId}:${mrIid}`);
    return Number(result.changes) > 0;
  }

  listReviewSessions(): StoredReviewSession[] {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT setting_key, setting_value
      FROM review_settings
      WHERE setting_key LIKE ?
      ORDER BY updated_at ASC
    `).all(`${REVIEW_SESSION_SETTING_PREFIX}%`) as SqlRow[];

    return rows.flatMap((row) => {
      const key = String(row.setting_key ?? "");
      const value = String(row.setting_value ?? "").trim();
      if (!key.startsWith(REVIEW_SESSION_SETTING_PREFIX) || !value) return [];
      const suffix = key.slice(REVIEW_SESSION_SETTING_PREFIX.length);
      const separator = suffix.lastIndexOf(":");
      if (separator <= 0 || separator >= suffix.length - 1) return [];
      return [{
        projectId: suffix.slice(0, separator),
        mrIid: suffix.slice(separator + 1),
        sessionId: value,
      }];
    });
  }

  saveReviewWorkspace(projectId: string, mrIid: string): void {
    this.setSetting(`${REVIEW_WORKSPACE_SETTING_PREFIX}${projectId}:${mrIid}`, "active");
  }

  deleteReviewWorkspace(projectId: string, mrIid: string): boolean {
    this.ensureOpen();
    const result = this.db.prepare(
      "DELETE FROM review_settings WHERE setting_key = ?",
    ).run(`${REVIEW_WORKSPACE_SETTING_PREFIX}${projectId}:${mrIid}`);
    return Number(result.changes) > 0;
  }

  listReviewWorkspaces(): StoredReviewWorkspace[] {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT setting_key
      FROM review_settings
      WHERE setting_key LIKE ?
      ORDER BY updated_at ASC
    `).all(`${REVIEW_WORKSPACE_SETTING_PREFIX}%`) as SqlRow[];

    return rows.flatMap((row) => {
      const key = String(row.setting_key ?? "");
      if (!key.startsWith(REVIEW_WORKSPACE_SETTING_PREFIX)) return [];
      const suffix = key.slice(REVIEW_WORKSPACE_SETTING_PREFIX.length);
      const separator = suffix.lastIndexOf(":");
      if (separator <= 0 || separator >= suffix.length - 1) return [];
      return [{
        projectId: suffix.slice(0, separator),
        mrIid: suffix.slice(separator + 1),
      }];
    });
  }

  private loadProgress(jobId: string): ReviewProgressEvent[] {
    const rows = this.db.prepare(`
      SELECT event_id, at, kind, message, detail, meta_json
      FROM review_progress
      WHERE job_id = ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(jobId, MAX_PROGRESS_EVENTS) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.event_id),
      at: String(row.at),
      kind: String(row.kind) as ReviewProgressEvent["kind"],
      message: String(row.message),
      ...(row.detail === null || row.detail === undefined ? {} : { detail: String(row.detail) }),
      ...(row.meta_json === null || row.meta_json === undefined ? {} : { meta: parseMeta(row.meta_json) }),
    }));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    ).get() as SqlRow;
    const currentVersion = Number(row.version ?? 0);
    if (currentVersion < 1) {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS review_jobs (
            id TEXT PRIMARY KEY,
            job_key TEXT NOT NULL,
            project_id TEXT NOT NULL,
            project_path TEXT,
            mr_iid TEXT NOT NULL,
            head_sha TEXT,
            target_branch TEXT,
            source TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'superseded', 'canceled')),
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            note_id INTEGER,
            error TEXT,
            result_json TEXT,
            progress_sequence INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_review_jobs_created_at
            ON review_jobs (created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_review_jobs_job_key
            ON review_jobs (job_key, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_review_jobs_merge_request
            ON review_jobs (project_id, mr_iid, created_at DESC);

          CREATE TABLE IF NOT EXISTS review_progress (
            job_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            at TEXT NOT NULL,
            kind TEXT NOT NULL,
            message TEXT NOT NULL,
            detail TEXT,
            meta_json TEXT,
            PRIMARY KEY (job_id, sequence),
            FOREIGN KEY (job_id) REFERENCES review_jobs (id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_review_progress_job
            ON review_progress (job_id, sequence ASC);
        `);
        this.db.prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        ).run(1, new Date().toISOString());
        this.db.exec("COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK;");
        throw error;
      }
    }

    if (currentVersion < 2) {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db.exec("ALTER TABLE review_jobs ADD COLUMN ci_json TEXT");
        this.db.prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        ).run(2, new Date().toISOString());
        this.db.exec("COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK;");
        throw error;
      }
    }

    if (currentVersion < 3) {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS review_settings (
            setting_key TEXT PRIMARY KEY,
            setting_value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `);
        this.db.prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        ).run(3, new Date().toISOString());
        this.db.exec("COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("review store is closed");
  }
}
