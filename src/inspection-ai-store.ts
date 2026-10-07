import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InspectionAiTask } from "./api-contracts.js";
import type { InspectionExecutionIdentity } from "./inspection-service.js";

export interface StoredInspectionAiTask extends InspectionAiTask {
  identity: InspectionExecutionIdentity;
  description: string;
  jiraUrl: string;
  gitlabUserId: string | null;
  gitlabApiBaseUrl: string | null;
  conversationId: string;
  editCompleted: boolean;
}

function normalizeJiraKey(value: string): string {
  return value.trim().toLowerCase();
}

function claimPriority(task: StoredInspectionAiTask): number {
  if (task.mr) return 3;
  if (["preparing", "running", "publishing", "pipeline_pending", "review_pending", "review_fixing"].includes(task.status)) return 2;
  return 1;
}

export class InspectionAiStore {
  private readonly db: DatabaseSync;
  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS inspection_ai_tasks (
        id TEXT PRIMARY KEY, maintainer_id TEXT NOT NULL, project_id TEXT NOT NULL,
        target_branch TEXT NOT NULL, jira_key TEXT NOT NULL, record_json TEXT NOT NULL,
        UNIQUE(maintainer_id, project_id, target_branch, jira_key)
      );
      CREATE TABLE IF NOT EXISTS inspection_ai_claims (
        jira_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, maintainer_id TEXT NOT NULL
      )`);
    this.db.prepare("DELETE FROM inspection_ai_claims WHERE task_id NOT IN (SELECT id FROM inspection_ai_tasks)").run();
    this.backfillClaims();
  }
  list(): StoredInspectionAiTask[] {
    return this.db.prepare("SELECT record_json FROM inspection_ai_tasks").all()
      .map((row) => JSON.parse(String(row.record_json)) as StoredInspectionAiTask);
  }
  save(task: StoredInspectionAiTask): void {
    this.db.prepare(`INSERT INTO inspection_ai_tasks VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json`)
      .run(task.id, task.maintainerId, task.projectId, task.targetBranch, task.jiraKey, JSON.stringify(task));
  }
  claimJira(jiraKey: string, taskId: string, maintainerId: string): boolean {
    const key = normalizeJiraKey(jiraKey);
    if (!key || !taskId || !maintainerId) return false;
    const result = this.db.prepare(`INSERT INTO inspection_ai_claims (jira_key, task_id, maintainer_id)
      VALUES (?, ?, ?) ON CONFLICT(jira_key) DO NOTHING`).run(key, taskId, maintainerId);
    if (Number(result.changes ?? 0) > 0) return true;
    const existing = this.db.prepare("SELECT task_id, maintainer_id FROM inspection_ai_claims WHERE jira_key = ?").get(key) as {
      task_id?: unknown;
      maintainer_id?: unknown;
    } | undefined;
    return existing?.task_id === taskId && existing?.maintainer_id === maintainerId;
  }
  releaseJiraClaim(jiraKey: string, taskId: string): void {
    const key = normalizeJiraKey(jiraKey);
    if (key) this.db.prepare("DELETE FROM inspection_ai_claims WHERE jira_key = ? AND task_id = ?").run(key, taskId);
  }
  close(): void { this.db.close(); }

  private backfillClaims(): void {
    const tasks = this.list().sort((left, right) => claimPriority(right) - claimPriority(left)
      || right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    for (const task of tasks) this.claimJira(task.jiraKey, task.id, task.maintainerId);
  }
}
