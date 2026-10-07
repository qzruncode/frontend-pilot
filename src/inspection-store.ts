import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_INSPECTION_RULE_IDS } from "./contracts.js";
import type { InspectionProject, InspectionRun } from "./contracts.js";
import type { InspectionFindingContext, TrackedInspectionFinding } from "./inspection-findings.js";

type InspectionProgressEvent = InspectionRun["progress"][number];
type PersistedInspectionProgressEvent = {
  sequence: number;
  event: InspectionProgressEvent;
};

const MAX_PROGRESS_EVENTS = 1_000;
const MAX_PERSISTED_RUNS = 2_000;
const DEFAULT_SCHEDULE_CRON = "0 0 * * *";

interface SqlRow {
  [key: string]: unknown;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function legacyIntervalToCron(minutes: number): string {
  if (minutes > 0 && minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  if (minutes === 60) return "0 * * * *";
  if (minutes > 60 && minutes < 1_440 && minutes % 60 === 0) return `0 */${minutes / 60} * * *`;
  if (minutes >= 1_440 && minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    return days === 1 ? DEFAULT_SCHEDULE_CRON : `0 0 */${days} * *`;
  }
  return DEFAULT_SCHEDULE_CRON;
}

export class InspectionStore {
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

  loadProjects(): InspectionProject[] {
    this.ensureOpen();
    const scopedRows = this.db.prepare(`
      SELECT execution_identity_json, maintainer_id AS scoped_maintainer_id, project_id, project_path, project_name, branch, enabled,
        finding_limit, schedule_enabled, schedule_cron, schedule_interval_minutes, next_run_at, last_run_at,
        last_run_status, last_head_sha, rule_profile_name, rule_count,
        inspection_rule_ids_json, jira_mode, jira_component, jira_fix_version, jira_issue_type
      FROM inspection_projects_scoped
      ORDER BY project_name COLLATE NOCASE ASC
    `).all() as SqlRow[];
    const legacyRows = this.db.prepare(`
      SELECT execution_identity_json, project_id, project_path, project_name, branch, enabled,
        finding_limit, schedule_enabled, schedule_cron, schedule_interval_minutes, next_run_at, last_run_at,
        last_run_status, last_head_sha, rule_profile_name, rule_count,
        inspection_rule_ids_json, jira_mode, jira_component, jira_fix_version, jira_issue_type
      FROM inspection_projects
      ORDER BY project_name COLLATE NOCASE ASC
    `).all() as SqlRow[];
    const projects = new Map<string, InspectionProject>();
    for (const row of [...scopedRows, ...legacyRows]) {
      const identity = parseJson<Record<string, string | null>>(row.execution_identity_json, {});
      const maintainerId = nullableString(row.scoped_maintainer_id) ?? identity.maintainerId ?? null;
      const projectId = String(row.project_id);
      const scopeKey = `${maintainerId ?? ""}\u0000${projectId}`;
      // A scoped row is authoritative when an old global row was migrated by a later save.
      if (projects.has(scopeKey)) continue;
      projects.set(scopeKey, {
        ...identity,
        maintainerId,
        projectId,
        projectPath: String(row.project_path),
        projectName: String(row.project_name),
        branch: String(row.branch),
        findingLimit: row.finding_limit === null || row.finding_limit === undefined ? null : Number(row.finding_limit),
        enabled: Boolean(row.enabled),
        scheduleEnabled: Boolean(row.schedule_enabled),
        scheduleCron: String(row.schedule_cron || DEFAULT_SCHEDULE_CRON),
        nextRunAt: nullableString(row.next_run_at),
        lastRunAt: nullableString(row.last_run_at),
        lastRunStatus: nullableString(row.last_run_status) as InspectionProject["lastRunStatus"],
        lastHeadSha: nullableString(row.last_head_sha),
        ruleSetName: String(row.rule_profile_name ?? "inspection-default"),
        ruleCount: Number(row.rule_count),
        inspectionRuleIds: parseJson<string[]>(row.inspection_rule_ids_json, [...DEFAULT_INSPECTION_RULE_IDS]),
        jiraMode: String(row.jira_mode) as InspectionProject["jiraMode"],
        jiraComponent: nullableString(row.jira_component),
        jiraFixVersion: nullableString(row.jira_fix_version),
        jiraIssueType: String(row.jira_issue_type),
      });
    }
    return [...projects.values()];
  }

  saveProject(project: InspectionProject): void {
    this.ensureOpen();
    const values = [
      project.projectId,
      project.projectPath,
      project.projectName,
      project.branch,
      project.findingLimit,
      project.enabled ? 1 : 0,
      project.scheduleEnabled ? 1 : 0,
      project.scheduleCron,
      1_440,
      project.nextRunAt,
      project.lastRunAt,
      project.lastRunStatus,
      project.lastHeadSha,
      project.ruleSetName,
      project.ruleCount,
      JSON.stringify(project.inspectionRuleIds),
      project.jiraMode,
      project.jiraComponent,
      project.jiraFixVersion,
      project.jiraIssueType,
      "{}",
      new Date().toISOString(),
      this.identityJson(project),
    ];
    if (project.maintainerId) {
      this.db.prepare(`
      INSERT INTO inspection_projects_scoped (
        maintainer_id, project_id, project_path, project_name, branch, finding_limit, enabled,
        schedule_enabled, schedule_cron, schedule_interval_minutes, next_run_at, last_run_at,
        last_run_status, last_head_sha, rule_profile_name, rule_count,
        inspection_rule_ids_json, jira_mode, jira_component, jira_fix_version, jira_issue_type,
        author_mappings_json, updated_at, execution_identity_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(maintainer_id, project_id) DO UPDATE SET
        project_path = excluded.project_path,
        project_name = excluded.project_name,
        branch = excluded.branch,
        finding_limit = excluded.finding_limit,
        enabled = excluded.enabled,
        schedule_enabled = excluded.schedule_enabled,
        schedule_cron = excluded.schedule_cron,
        schedule_interval_minutes = excluded.schedule_interval_minutes,
        next_run_at = excluded.next_run_at,
        last_run_at = excluded.last_run_at,
        last_run_status = excluded.last_run_status,
        last_head_sha = excluded.last_head_sha,
        rule_profile_name = excluded.rule_profile_name,
        rule_count = excluded.rule_count,
        inspection_rule_ids_json = excluded.inspection_rule_ids_json,
        jira_mode = excluded.jira_mode,
        jira_component = excluded.jira_component,
        jira_fix_version = excluded.jira_fix_version,
        jira_issue_type = excluded.jira_issue_type,
        author_mappings_json = excluded.author_mappings_json,
        execution_identity_json = excluded.execution_identity_json,
        updated_at = excluded.updated_at
      `).run(project.maintainerId, ...values);
      return;
    }
    this.db.prepare(`
      INSERT INTO inspection_projects (
        project_id, project_path, project_name, branch, finding_limit, enabled,
        schedule_enabled, schedule_cron, schedule_interval_minutes, next_run_at, last_run_at,
        last_run_status, last_head_sha, rule_profile_name, rule_count,
        inspection_rule_ids_json, jira_mode, jira_component, jira_fix_version, jira_issue_type,
        author_mappings_json, updated_at, execution_identity_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        project_path = excluded.project_path,
        project_name = excluded.project_name,
        branch = excluded.branch,
        finding_limit = excluded.finding_limit,
        enabled = excluded.enabled,
        schedule_enabled = excluded.schedule_enabled,
        schedule_cron = excluded.schedule_cron,
        schedule_interval_minutes = excluded.schedule_interval_minutes,
        next_run_at = excluded.next_run_at,
        last_run_at = excluded.last_run_at,
        last_run_status = excluded.last_run_status,
        last_head_sha = excluded.last_head_sha,
        rule_profile_name = excluded.rule_profile_name,
        rule_count = excluded.rule_count,
        inspection_rule_ids_json = excluded.inspection_rule_ids_json,
        jira_mode = excluded.jira_mode,
        jira_component = excluded.jira_component,
        jira_fix_version = excluded.jira_fix_version,
        jira_issue_type = excluded.jira_issue_type,
        author_mappings_json = excluded.author_mappings_json,
        execution_identity_json = excluded.execution_identity_json,
        updated_at = excluded.updated_at
    `).run(...values);
  }

  loadRuns(limit = MAX_PERSISTED_RUNS): InspectionRun[] {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT execution_identity_json, id, project_id, project_path, project_name, branch, source,
        status, created_at, started_at, finished_at, head_sha, error,
        result_json, progress_sequence
      FROM inspection_runs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(limit, MAX_PERSISTED_RUNS))) as SqlRow[];
    return rows.map((row) => {
      const id = String(row.id);
      return {
        id,
        ...parseJson<Record<string, string | null>>(row.execution_identity_json, {}),
      projectId: String(row.project_id),
        projectPath: String(row.project_path),
        projectName: String(row.project_name),
        branch: String(row.branch),
        source: String(row.source) as InspectionRun["source"],
        status: String(row.status) as InspectionRun["status"],
        createdAt: String(row.created_at),
        startedAt: nullableString(row.started_at),
        finishedAt: nullableString(row.finished_at),
        headSha: nullableString(row.head_sha),
        error: nullableString(row.error),
        result: parseJson<InspectionRun["result"]>(row.result_json, null),
        progress: this.loadProgress(id),
      };
    });
  }

  loadTrackedFindings(): TrackedInspectionFinding[] {
    this.ensureOpen();
    return (this.db.prepare("SELECT record_json FROM inspection_findings").all() as SqlRow[])
      .map((row) => JSON.parse(String(row.record_json)) as TrackedInspectionFinding);
  }

  saveTrackedFinding(record: TrackedInspectionFinding): void {
    this.ensureOpen();
    this.db.prepare(`INSERT INTO inspection_findings (id, record_json) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json`)
      .run(record.finding.tracking.id, JSON.stringify(record));
  }

  loadFindingHistory(): Array<InspectionFindingContext & Pick<InspectionRun, "result">> {
    this.ensureOpen();
    return (this.db.prepare(`SELECT id, project_id, branch, head_sha, created_at, execution_identity_json, result_json
      FROM inspection_runs WHERE result_json IS NOT NULL ORDER BY created_at ASC, id ASC`).all() as SqlRow[]).map((row) => ({
      ...parseJson<Record<string, string | null>>(row.execution_identity_json, {}),
      id: String(row.id), projectId: String(row.project_id), branch: String(row.branch), headSha: nullableString(row.head_sha),
      createdAt: String(row.created_at), result: parseJson<InspectionRun["result"]>(row.result_json, null),
    }));
  }

  saveFindingHistory(id: string, result: InspectionRun["result"]): void {
    this.ensureOpen();
    this.db.prepare("UPDATE inspection_runs SET result_json = ? WHERE id = ?").run(JSON.stringify(result), id);
  }

  saveRun(run: InspectionRun, sequence: number, event?: InspectionProgressEvent): void {
    this.saveRunBatch(run, event ? [{ sequence, event }] : []);
  }

  saveRunBatch(run: InspectionRun, events: PersistedInspectionProgressEvent[]): void {
    this.ensureOpen();
    const progressSequence = events.at(-1)?.sequence ?? run.progress.length;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        INSERT INTO inspection_runs (
          id, project_id, project_path, project_name, branch, source, status,
          created_at, started_at, finished_at, head_sha, error, result_json,
          progress_sequence, updated_at, execution_identity_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          project_path = excluded.project_path,
          project_name = excluded.project_name,
          branch = excluded.branch,
          source = excluded.source,
          status = excluded.status,
          created_at = excluded.created_at,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          head_sha = excluded.head_sha,
          error = excluded.error,
          result_json = excluded.result_json,
          progress_sequence = excluded.progress_sequence,
          execution_identity_json = excluded.execution_identity_json,
          updated_at = excluded.updated_at
      `).run(
        run.id,
        run.projectId,
        run.projectPath,
        run.projectName,
        run.branch,
        run.source,
        run.status,
        run.createdAt,
        run.startedAt,
        run.finishedAt,
        run.headSha,
        run.error,
        run.result ? JSON.stringify(run.result) : null,
        progressSequence,
        new Date().toISOString(),
        this.identityJson(run),
      );

      for (const { sequence, event } of events) {
        this.db.prepare(`
          INSERT OR REPLACE INTO inspection_progress (
            run_id, sequence, event_id, at, kind, message, detail, meta_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          run.id,
          sequence,
          event.id,
          event.at,
          event.kind,
          event.message,
          event.detail ?? null,
          event.meta === undefined ? null : JSON.stringify(event.meta),
        );
      }
      if (events.length > 0) {
        this.db.prepare(
          "DELETE FROM inspection_progress WHERE run_id = ? AND sequence <= ?",
        ).run(run.id, progressSequence - MAX_PROGRESS_EVENTS);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  clearRunProgress(runId: string): void {
    this.ensureOpen();
    this.db.prepare("DELETE FROM inspection_progress WHERE run_id = ?").run(runId);
  }

  deleteRun(id: string): boolean {
    this.ensureOpen();
    const result = this.db.prepare("DELETE FROM inspection_runs WHERE id = ?").run(id);
    return Number(result.changes ?? 0) > 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private loadProgress(runId: string): InspectionProgressEvent[] {
    const rows = this.db.prepare(`
      SELECT event_id, at, kind, message, detail, meta_json
      FROM inspection_progress
      WHERE run_id = ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(runId, MAX_PROGRESS_EVENTS) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.event_id),
      at: String(row.at),
      kind: String(row.kind) as InspectionProgressEvent["kind"],
      message: String(row.message),
      ...(row.detail === null || row.detail === undefined ? {} : { detail: String(row.detail) }),
      ...(row.meta_json === null || row.meta_json === undefined ? {} : { meta: parseJson(row.meta_json, undefined) }),
    }));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inspection_findings (
        id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inspection_projects (
        project_id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        project_name TEXT NOT NULL,
        branch TEXT NOT NULL,
        finding_limit INTEGER,
        enabled INTEGER NOT NULL,
        schedule_enabled INTEGER NOT NULL,
        schedule_cron TEXT NOT NULL DEFAULT '0 0 * * *',
        schedule_interval_minutes INTEGER NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        last_run_status TEXT,
        last_head_sha TEXT,
        rule_profile_name TEXT NOT NULL,
        rule_count INTEGER NOT NULL,
        inspection_rule_ids_json TEXT,
        jira_mode TEXT NOT NULL,
        jira_component TEXT,
        jira_fix_version TEXT,
        jira_issue_type TEXT NOT NULL,
        author_mappings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inspection_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        project_name TEXT NOT NULL,
        branch TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        head_sha TEXT,
        error TEXT,
        result_json TEXT,
        progress_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_inspection_runs_created_at
        ON inspection_runs (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inspection_runs_project
        ON inspection_runs (project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS inspection_progress (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT,
        meta_json TEXT,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES inspection_runs (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_inspection_progress_run
        ON inspection_progress (run_id, sequence ASC);
    `);
    for (const table of ["inspection_projects", "inspection_runs"]) {
      const fields = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
      if (!fields.some((field) => field.name === "execution_identity_json")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN execution_identity_json TEXT`);
      }
    }
    const columns = this.db.prepare("PRAGMA table_info(inspection_projects)").all() as SqlRow[];
    if (!columns.some((column) => String(column.name) === "schedule_cron")) {
      this.db.exec(`ALTER TABLE inspection_projects ADD COLUMN schedule_cron TEXT NOT NULL DEFAULT '${DEFAULT_SCHEDULE_CRON}'`);
      const legacyProjects = this.db.prepare("SELECT execution_identity_json, project_id, schedule_interval_minutes FROM inspection_projects").all() as SqlRow[];
      const updateSchedule = this.db.prepare("UPDATE inspection_projects SET schedule_cron = ? WHERE project_id = ?");
      for (const project of legacyProjects) updateSchedule.run(legacyIntervalToCron(Number(project.schedule_interval_minutes)), String(project.project_id));
    }
    if (!columns.some((column) => String(column.name) === "inspection_rule_ids_json")) {
      this.db.exec("ALTER TABLE inspection_projects ADD COLUMN inspection_rule_ids_json TEXT");
    }
    if (!columns.some((column) => String(column.name) === "finding_limit")) {
      this.db.exec("ALTER TABLE inspection_projects ADD COLUMN finding_limit INTEGER");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inspection_projects_scoped (
        maintainer_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        project_name TEXT NOT NULL,
        branch TEXT NOT NULL,
        finding_limit INTEGER,
        enabled INTEGER NOT NULL,
        schedule_enabled INTEGER NOT NULL,
        schedule_cron TEXT NOT NULL DEFAULT '${DEFAULT_SCHEDULE_CRON}',
        schedule_interval_minutes INTEGER NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        last_run_status TEXT,
        last_head_sha TEXT,
        rule_profile_name TEXT NOT NULL,
        rule_count INTEGER NOT NULL,
        inspection_rule_ids_json TEXT,
        jira_mode TEXT NOT NULL,
        jira_component TEXT,
        jira_fix_version TEXT,
        jira_issue_type TEXT NOT NULL,
        author_mappings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        execution_identity_json TEXT,
        PRIMARY KEY (maintainer_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_inspection_projects_scoped_name
        ON inspection_projects_scoped (maintainer_id, project_name COLLATE NOCASE);
    `);
  }

  private identityJson(value: InspectionProject | InspectionRun): string {
    return JSON.stringify({ ...("authorizationError" in value ? { authorizationError: value.authorizationError } : {}), maintainerId: value.maintainerId ?? null, maintainerName: value.maintainerName ?? null,
      operatorId: value.operatorId ?? null, operatorName: value.operatorName ?? null });
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("inspection store is closed");
  }
}
