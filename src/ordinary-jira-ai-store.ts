import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OrdinaryJiraAiTaskSchema, OrdinaryJiraAiTaskSummarySchema, type OrdinaryJiraAiTask, type OrdinaryJiraAiTaskSummary } from "./api-contracts.js";

export interface StoredOrdinaryJiraAiTask extends OrdinaryJiraAiTask {
  identity: { userId: string; username: string };
  jiraDescription: string;
  jiraContext: string;
  gitlabUserId: string | null;
  gitlabApiBaseUrl: string | null;
  conversationId: string;
  editCompleted: boolean;
}

function claimKey(jiraKey: string, projectId: string, targetBranch: string): string {
  return [jiraKey, projectId, targetBranch].map((value) => value.trim().toLowerCase()).join("\u0000");
}

function claimPriority(task: StoredOrdinaryJiraAiTask): number {
  if (task.mr) return 3;
  if (["preparing", "running", "publishing", "pipeline_pending", "review_pending", "review_fixing"].includes(task.status)) return 2;
  return 1;
}

export class OrdinaryJiraAiStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ordinary_jira_ai_tasks (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
        target_branch TEXT NOT NULL, jira_key TEXT NOT NULL, record_json TEXT NOT NULL,
        UNIQUE(user_id, project_id, target_branch, jira_key)
      );
      CREATE TABLE IF NOT EXISTS ordinary_jira_ai_claims (
        claim_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id TEXT NOT NULL
      )`);
    this.db.prepare("DELETE FROM ordinary_jira_ai_claims WHERE task_id NOT IN (SELECT id FROM ordinary_jira_ai_tasks)").run();
    this.backfillClaims();
  }

  list(): StoredOrdinaryJiraAiTask[] {
    return this.db.prepare("SELECT record_json FROM ordinary_jira_ai_tasks").all()
      .map((row) => JSON.parse(String((row as { record_json?: unknown }).record_json)) as StoredOrdinaryJiraAiTask);
  }

  find(userId: string, jiraKey: string): StoredOrdinaryJiraAiTask | null {
    const task = this.list()
      .filter((item) => item.userId === userId && item.jiraKey.toLowerCase() === jiraKey.trim().toLowerCase())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
    return task ?? null;
  }

  get(id: string, userId: string): StoredOrdinaryJiraAiTask | null {
    const row = this.db.prepare("SELECT record_json FROM ordinary_jira_ai_tasks WHERE id = ? AND user_id = ?").get(id, userId) as { record_json?: unknown } | undefined;
    return row?.record_json ? JSON.parse(String(row.record_json)) as StoredOrdinaryJiraAiTask : null;
  }

  save(task: StoredOrdinaryJiraAiTask): void {
    this.db.prepare(`INSERT INTO ordinary_jira_ai_tasks VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json`)
      .run(task.id, task.userId, task.projectId, task.targetBranch, task.jiraKey, JSON.stringify(task));
  }

  claimJira(jiraKey: string, projectId: string, targetBranch: string, taskId: string, userId: string): boolean {
    const key = claimKey(jiraKey, projectId, targetBranch);
    if (!key || !taskId || !userId) return false;
    const result = this.db.prepare(`INSERT INTO ordinary_jira_ai_claims (claim_key, task_id, user_id)
      VALUES (?, ?, ?) ON CONFLICT(claim_key) DO NOTHING`).run(key, taskId, userId);
    if (Number(result.changes ?? 0) > 0) return true;
    const existing = this.db.prepare("SELECT task_id, user_id FROM ordinary_jira_ai_claims WHERE claim_key = ?").get(key) as { task_id?: unknown; user_id?: unknown } | undefined;
    return existing?.task_id === taskId && existing?.user_id === userId;
  }

  releaseJiraClaim(jiraKey: string, projectId: string, targetBranch: string, taskId: string): void {
    this.db.prepare("DELETE FROM ordinary_jira_ai_claims WHERE claim_key = ? AND task_id = ?").run(claimKey(jiraKey, projectId, targetBranch), taskId);
  }

  close(): void { this.db.close(); }

  private backfillClaims(): void {
    const tasks = this.list().sort((left, right) => claimPriority(right) - claimPriority(left)
      || right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    for (const task of tasks) this.claimJira(task.jiraKey, task.projectId, task.targetBranch, task.id, task.userId);
  }
}

export function publicOrdinaryJiraAiTask(task: StoredOrdinaryJiraAiTask): OrdinaryJiraAiTask {
  const {
    identity: _identity,
    jiraDescription: _jiraDescription,
    jiraContext: _jiraContext,
    gitlabUserId: _gitlabUserId,
    gitlabApiBaseUrl: _gitlabApiBaseUrl,
    conversationId: _conversationId,
    editCompleted: _editCompleted,
    ...publicTask
  } = task;
  return OrdinaryJiraAiTaskSchema.parse(publicTask);
}

export function publicOrdinaryJiraAiTaskSummary(task: StoredOrdinaryJiraAiTask): OrdinaryJiraAiTaskSummary {
  return OrdinaryJiraAiTaskSummarySchema.parse({
    id: task.id,
    jiraKey: task.jiraKey,
    status: task.status,
    phase: task.phase,
    updatedAt: task.updatedAt,
    hasMr: Boolean(task.mr),
  });
}
