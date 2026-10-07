import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GitLabMrAiRepairTaskSchema, type GitLabMrAiRepairTask } from "./api-contracts.js";

export interface StoredGitLabMrAiRepairTask extends GitLabMrAiRepairTask {
  identity: { userId: string; username: string };
  gitlabUserId: string | null;
  gitlabApiBaseUrl: string | null;
  conversationId: string;
  editCompleted: boolean;
}

function claimKey(projectId: string, mrIid: string): string {
  return [projectId, mrIid].map((value) => value.trim().toLowerCase()).join("\u0000");
}

function claimPriority(task: StoredGitLabMrAiRepairTask): number {
  if (["preparing", "running", "publishing", "pipeline_pending", "review_pending", "review_fixing"].includes(task.status)) return 3;
  if (task.status === "mr_open") return 2;
  return 1;
}

export class GitLabMrAiRepairStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS gitlab_mr_ai_tasks (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
        mr_iid TEXT NOT NULL, record_json TEXT NOT NULL,
        UNIQUE(user_id, project_id, mr_iid)
      );
      CREATE TABLE IF NOT EXISTS gitlab_mr_ai_claims (
        claim_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id TEXT NOT NULL
      )`);
    this.db.prepare("DELETE FROM gitlab_mr_ai_claims WHERE task_id NOT IN (SELECT id FROM gitlab_mr_ai_tasks)").run();
    this.backfillClaims();
  }

  list(): StoredGitLabMrAiRepairTask[] {
    return this.db.prepare("SELECT record_json FROM gitlab_mr_ai_tasks").all()
      .map((row) => JSON.parse(String((row as { record_json?: unknown }).record_json)) as StoredGitLabMrAiRepairTask);
  }

  find(userId: string, projectId: string, mrIid: string): StoredGitLabMrAiRepairTask | null {
    const row = this.db.prepare(`SELECT record_json FROM gitlab_mr_ai_tasks
      WHERE user_id = ? AND project_id = ? AND mr_iid = ?`).get(userId, projectId, mrIid) as { record_json?: unknown } | undefined;
    return row?.record_json ? JSON.parse(String(row.record_json)) as StoredGitLabMrAiRepairTask : null;
  }

  get(id: string, userId: string): StoredGitLabMrAiRepairTask | null {
    const row = this.db.prepare("SELECT record_json FROM gitlab_mr_ai_tasks WHERE id = ? AND user_id = ?").get(id, userId) as { record_json?: unknown } | undefined;
    return row?.record_json ? JSON.parse(String(row.record_json)) as StoredGitLabMrAiRepairTask : null;
  }

  save(task: StoredGitLabMrAiRepairTask): void {
    this.db.prepare(`INSERT INTO gitlab_mr_ai_tasks VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json`)
      .run(task.id, task.userId, task.projectId, task.mrIid, JSON.stringify(task));
  }

  claimMr(projectId: string, mrIid: string, taskId: string, userId: string): boolean {
    const key = claimKey(projectId, mrIid);
    if (!key || !taskId || !userId) return false;
    const result = this.db.prepare(`INSERT INTO gitlab_mr_ai_claims (claim_key, task_id, user_id)
      VALUES (?, ?, ?) ON CONFLICT(claim_key) DO NOTHING`).run(key, taskId, userId);
    if (Number(result.changes ?? 0) > 0) return true;
    const existing = this.db.prepare("SELECT task_id, user_id FROM gitlab_mr_ai_claims WHERE claim_key = ?").get(key) as { task_id?: unknown; user_id?: unknown } | undefined;
    return existing?.task_id === taskId && existing?.user_id === userId;
  }

  releaseMrClaim(projectId: string, mrIid: string, taskId: string): void {
    this.db.prepare("DELETE FROM gitlab_mr_ai_claims WHERE claim_key = ? AND task_id = ?").run(claimKey(projectId, mrIid), taskId);
  }

  close(): void { this.db.close(); }

  private backfillClaims(): void {
    const tasks = this.list().sort((left, right) => claimPriority(right) - claimPriority(left)
      || right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    for (const task of tasks) this.claimMr(task.projectId, task.mrIid, task.id, task.userId);
  }
}

export function publicGitLabMrAiRepairTask(task: StoredGitLabMrAiRepairTask): GitLabMrAiRepairTask {
  const {
    identity: _identity,
    gitlabUserId: _gitlabUserId,
    gitlabApiBaseUrl: _gitlabApiBaseUrl,
    conversationId: _conversationId,
    editCompleted: _editCompleted,
    ...publicTask
  } = task;
  return GitLabMrAiRepairTaskSchema.parse(publicTask);
}
