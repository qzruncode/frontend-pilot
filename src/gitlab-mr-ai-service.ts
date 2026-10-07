import { randomUUID } from "node:crypto";
import {
  InspectionAiVerificationSchema,
  type GitLabMrAiRepairTaskDetail,
  type GitLabMrAiRepairTask,
  type InspectionAiVerification,
} from "./api-contracts.js";
import type { AssistantEditService } from "./assistant-edit-service.js";
import type { AssistantExecutionManager } from "./assistant-execution.js";
import type { AssistantStore } from "./assistant-store.js";
import type { GitLabConnection } from "./gitlab-connection.js";
import { type GitLabClientPort, type GitLabCurrentUser } from "./gitlab-client.js";
import type { GitLabMergeRequestDetails, GitLabMergeRequestSummary } from "./gitlab-workbench.js";
import {
  abortableDelay,
  DEFAULT_INSPECTION_AI_REVIEW_JOB_NAMES,
  INSPECTION_AI_VERIFICATION_POLL_INTERVAL_MS,
  INSPECTION_AI_VERIFICATION_TIMEOUT_MS,
  isActiveVerification,
  inspectAiVerification,
  retryTransientGitLabRead,
  type AiVerificationOutcome,
} from "./inspection-ai-verification.js";
import { safeErrorMessage } from "./errors.js";
import { GitLabMrAiRepairStore, publicGitLabMrAiRepairTask, type StoredGitLabMrAiRepairTask } from "./gitlab-mr-ai-store.js";
import type { GitLabReviewDecisionRunner } from "./gitlab-review-decision.js";

export interface GitLabMrAiRepairIdentity {
  userId: string;
  username: string;
}

interface Dependencies {
  gitlab: GitLabClientPort;
  connection: GitLabConnection;
}

interface CheckedDependencies extends Dependencies {
  user: GitLabCurrentUser;
}

interface Options {
  store: GitLabMrAiRepairStore;
  edits: AssistantEditService;
  assistant: AssistantStore;
  execution: AssistantExecutionManager;
  dependencies: (identity: GitLabMrAiRepairIdentity) => Promise<Dependencies>;
  concurrency?: number;
  verificationPollIntervalMs?: number;
  verificationTimeoutMs?: number;
  reviewJobNames?: readonly string[];
  reviewDecisionRunner: GitLabReviewDecisionRunner;
}

const BUSY = new Set(["preparing", "running", "publishing", "review_fixing"]);
const RESUMABLE_VERIFICATION = new Set(["pipeline_pending", "review_pending"]);

function ownerKey(task: StoredGitLabMrAiRepairTask): string {
  return `gitlab-mr-ai:${task.userId}`;
}

function projectPath(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function taskTitle(title: string, iid: string): string {
  const normalized = title.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized || `GitLab MR !${iid}`;
}

export class GitLabMrAiRepairConflictError extends Error {
  constructor() {
    super("这个 GitLab MR 已经有 AI 自动修复任务，请查看现有任务后再操作。");
    this.name = "GitLabMrAiRepairConflictError";
  }
}

export class GitLabMrAiRepairService {
  private readonly tasks = new Map<string, StoredGitLabMrAiRepairTask>();
  private readonly queue: string[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly syncing = new Map<string, Promise<void>>();
  private readonly concurrency: number;
  private readonly verificationPollIntervalMs: number;
  private readonly verificationTimeoutMs: number;
  private readonly reviewJobNames: readonly string[];
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;

  constructor(private readonly options: Options) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.verificationPollIntervalMs = Math.max(0, options.verificationPollIntervalMs ?? INSPECTION_AI_VERIFICATION_POLL_INTERVAL_MS);
    this.verificationTimeoutMs = Math.max(1_000, options.verificationTimeoutMs ?? INSPECTION_AI_VERIFICATION_TIMEOUT_MS);
    this.reviewJobNames = options.reviewJobNames?.length ? options.reviewJobNames : DEFAULT_INSPECTION_AI_REVIEW_JOB_NAMES;
    this.tasks = new Map(options.store.list().map((task) => [task.id, task]));
    for (const task of this.tasks.values()) {
      if (BUSY.has(task.status)) this.update(task, { status: "failed", phase: "执行中断", error: "服务重启中断了处理，可重试继续" });
      else if (RESUMABLE_VERIFICATION.has(task.status)) this.update(task, { status: "queued", phase: "服务已恢复，继续验证 MR", error: null, syncError: null });
    }
    this.timer = setInterval(() => { void this.syncAll(); }, 60_000);
    this.timer.unref();
    for (const task of [...this.tasks.values()].filter((item) => item.status === "queued").sort((left, right) => left.createdAt.localeCompare(right.createdAt))) this.enqueue(task);
  }

  async start(projectId: string, mrIid: string, input: { confirmed: boolean }, identity: GitLabMrAiRepairIdentity): Promise<GitLabMrAiRepairTask> {
    this.assertIdentity(identity);
    if (!input.confirmed) throw new Error("请先确认要让 AI 修改并推送到这个 MR 的源分支");
    if (this.closing) throw new Error("服务正在关闭");
    const normalizedProjectId = projectId.trim();
    const normalizedMrIid = mrIid.trim();
    if (!normalizedProjectId || !/^\d+$/.test(normalizedMrIid)) throw new Error("GitLab 项目或 MR 编号无效");

    const deps = await this.loadDependencies(identity);
    const detail = await this.readMr(deps.gitlab, normalizedProjectId, normalizedMrIid);
    if (detail.state === "merged" || detail.state === "closed") throw new Error(`MR 已${detail.state === "merged" ? "合并" : "关闭"}，无需启动 AI 自动修复`);
    const headSha = this.requireMrFields(detail).headSha;
    const sourcePath = projectPath(detail.projectPath);
    const targetPath = await this.targetProjectPath(deps.gitlab, normalizedProjectId, sourcePath);
    if (!sourcePath || !targetPath || sourcePath !== targetPath) throw new Error("暂不支持来自 fork 项目的 MR，AI 只会修改当前项目的源分支");

    const existing = this.options.store.find(identity.userId, normalizedProjectId, normalizedMrIid);
    if (existing) {
      const task = this.rememberTask(existing);
      if (this.isActive(task) || (task.commitSha === headSha && ["mr_open", "merged", "closed"].includes(task.status))) {
        return publicGitLabMrAiRepairTask(task);
      }
      await this.resetForHead(task, deps, detail, headSha, identity);
      this.enqueue(task);
      return publicGitLabMrAiRepairTask(task);
    }

    const now = new Date().toISOString();
    const task: StoredGitLabMrAiRepairTask = {
      id: randomUUID(),
      userId: identity.userId,
      projectId: normalizedProjectId,
      projectPath: targetPath,
      sourceProjectId: normalizedProjectId,
      sourceProjectPath: sourcePath,
      mrIid: normalizedMrIid,
      title: taskTitle(detail.title, normalizedMrIid),
      mrUrl: detail.webUrl,
      sourceBranch: this.requireMrFields(detail).sourceBranch,
      targetBranch: this.requireMrFields(detail).targetBranch,
      status: "queued",
      phase: "已确认，进入 AI 自动修复队列",
      createdAt: now,
      updatedAt: now,
      editSessionId: null,
      assistantRunId: null,
      commitSha: headSha,
      verification: null,
      error: null,
      syncedAt: null,
      syncError: null,
      identity: { ...identity },
      gitlabUserId: deps.user.id === undefined || deps.user.id === null ? null : String(deps.user.id),
      gitlabApiBaseUrl: deps.connection.apiBaseUrl,
      conversationId: randomUUID(),
      editCompleted: false,
    };
    if (!this.options.store.claimMr(task.projectId, task.mrIid, task.id, task.userId)) throw new GitLabMrAiRepairConflictError();
    try {
      this.options.store.save(task);
    } catch (error) {
      this.options.store.releaseMrClaim(task.projectId, task.mrIid, task.id);
      throw error;
    }
    this.tasks.set(task.id, task);
    this.enqueue(task);
    return publicGitLabMrAiRepairTask(task);
  }

  async find(projectId: string, mrIid: string, identity: GitLabMrAiRepairIdentity): Promise<GitLabMrAiRepairTask | null> {
    this.assertIdentity(identity);
    const storedTask = this.options.store.find(identity.userId, projectId.trim(), mrIid.trim());
    if (!storedTask) return null;
    const task = this.rememberTask(storedTask);
    await this.sync(task);
    return publicGitLabMrAiRepairTask(task);
  }

  async detail(id: string, identity: GitLabMrAiRepairIdentity): Promise<GitLabMrAiRepairTaskDetail> {
    const task = this.authorized(id, identity);
    await this.sync(task);
    return {
      task: publicGitLabMrAiRepairTask(task),
      execution: task.assistantRunId ? this.options.assistant.getRun(task.assistantRunId, 0, ownerKey(task)) : null,
      executions: this.options.assistant.listRuns(task.conversationId, ownerKey(task)),
      editSession: task.editSessionId ? await this.options.edits.getSession(task.editSessionId, ownerKey(task)) : null,
    };
  }

  retry(id: string, identity: GitLabMrAiRepairIdentity): GitLabMrAiRepairTask {
    const task = this.authorized(id, identity);
    if (this.closing) throw new Error("服务正在关闭");
    if (this.active.has(id) || task.status === "queued") return publicGitLabMrAiRepairTask(task);
    if (!(task.status === "failed" || task.status === "canceled")) throw new Error("当前任务不能重试");
    if (!this.options.store.claimMr(task.projectId, task.mrIid, task.id, task.userId)) throw new GitLabMrAiRepairConflictError();
    this.update(task, { identity: { ...identity }, status: "queued", phase: task.editSessionId ? "已保留已有工作区，重新进入 MR 验证队列" : "已重新进入 MR 验证队列", error: null, syncError: null, assistantRunId: null, verification: task.verification ? this.makeVerification(task, { reviewStatus: "pending", report: null, feedback: null, reviewNoteId: null, repairAttempts: 0 }) : null });
    this.enqueue(task);
    return publicGitLabMrAiRepairTask(task);
  }

  cancel(id: string, identity: GitLabMrAiRepairIdentity): GitLabMrAiRepairTask {
    const task = this.authorized(id, identity);
    if (task.status === "queued") {
      this.queuedIds.delete(id);
      this.update(task, { status: "canceled", phase: "已停止", error: "已停止 AI 自动修复" });
      this.pump();
      return publicGitLabMrAiRepairTask(task);
    }
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new Error("已停止 AI 自动修复"));
      if (task.assistantRunId) this.options.execution.cancel(task.assistantRunId);
      this.update(task, { phase: "正在停止，请稍候" });
    }
    return publicGitLabMrAiRepairTask(task);
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    for (const [id, active] of this.active) {
      active.controller.abort();
      const task = this.tasks.get(id);
      if (task?.assistantRunId) this.options.execution.cancel(task.assistantRunId);
    }
    await Promise.allSettled([...this.active.values()].map((item) => item.promise));
    await Promise.allSettled([...this.syncing.values()]);
  }

  private assertIdentity(identity: GitLabMrAiRepairIdentity): void {
    if (!identity.userId.trim() || !identity.username.trim()) throw new Error("当前登录用户无效，请重新登录");
  }

  private authorized(id: string, identity: GitLabMrAiRepairIdentity): StoredGitLabMrAiRepairTask {
    this.assertIdentity(identity);
    const task = this.tasks.get(id) ?? this.options.store.get(id, identity.userId);
    if (!task || task.userId !== identity.userId) throw new Error("AI 任务不存在或不属于当前用户");
    return this.rememberTask(task);
  }

  private rememberTask(task: StoredGitLabMrAiRepairTask): StoredGitLabMrAiRepairTask {
    const current = this.tasks.get(task.id);
    if (current) return current;
    this.tasks.set(task.id, task);
    return task;
  }

  private isCurrentTask(task: StoredGitLabMrAiRepairTask): boolean {
    return this.tasks.get(task.id) === task;
  }

  private update(task: StoredGitLabMrAiRepairTask, patch: Partial<StoredGitLabMrAiRepairTask>): void {
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.options.store.save(task);
  }

  private isActive(task: StoredGitLabMrAiRepairTask): boolean {
    return task.status === "queued" || BUSY.has(task.status) || RESUMABLE_VERIFICATION.has(task.status);
  }

  private enqueue(task: StoredGitLabMrAiRepairTask): void {
    if (this.closing || task.status !== "queued" || this.active.has(task.id) || this.queuedIds.has(task.id)) return;
    this.queue.push(task.id);
    this.queuedIds.add(task.id);
    this.pump();
  }

  private pump(): void {
    if (this.closing) return;
    while (this.active.size < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.queuedIds.delete(id);
      const task = this.tasks.get(id);
      if (!task || task.status !== "queued") continue;
      const active = { controller: new AbortController(), promise: Promise.resolve() };
      this.active.set(id, active);
      this.update(task, { status: "preparing", phase: task.editSessionId ? "正在恢复已有工作区并继续验证" : "正在读取 MR 并准备隔离工作区" });
      active.promise = this.execute(task, active.controller.signal).finally(() => {
        this.active.delete(id);
        this.pump();
      });
    }
  }

  private async loadDependencies(identity: GitLabMrAiRepairIdentity): Promise<CheckedDependencies> {
    const deps = await this.options.dependencies(identity);
    if (!deps.gitlab.getCurrentUser || !deps.gitlab.getMergeRequestDetails || !deps.gitlab.listPipelineJobs || !deps.gitlab.getPipelineJobTrace) {
      throw new Error("GitLab 不支持读取 MR、Pipeline 或 Pipeline Review 结果");
    }
    const user = await deps.gitlab.getCurrentUser();
    if (!user.id) throw new Error("无法确认当前用户的 GitLab 身份，请重新连接");
    return { ...deps, user };
  }

  private async checkedDependencies(task: StoredGitLabMrAiRepairTask): Promise<CheckedDependencies> {
    const deps = await this.loadDependencies(task.identity);
    if (task.gitlabUserId && (task.gitlabUserId !== String(deps.user.id) || task.gitlabApiBaseUrl !== deps.connection.apiBaseUrl)) throw new Error("GitLab 连接已更换，请恢复创建任务时使用的账号后重试");
    return deps;
  }

  private async readMr(gitlab: GitLabClientPort, projectId: string, mrIid: string): Promise<GitLabMergeRequestDetails> {
    if (!gitlab.getMergeRequestDetails) throw new Error("GitLab 不支持读取 MR 详情");
    return gitlab.getMergeRequestDetails(projectId, mrIid);
  }

  private async targetProjectPath(gitlab: GitLabClientPort, projectId: string, fallback: string): Promise<string> {
    if (!gitlab.getProject) return fallback;
    const project = await gitlab.getProject(projectId);
    return projectPath(project.pathWithNamespace);
  }

  private requireMrFields(detail: GitLabMergeRequestDetails): { headSha: string; sourceBranch: string; targetBranch: string } {
    if (!detail.headSha || !detail.sourceBranch || !detail.targetBranch) throw new Error("MR 缺少当前提交或源/目标分支信息，无法启动 AI 自动修复");
    return { headSha: detail.headSha, sourceBranch: detail.sourceBranch, targetBranch: detail.targetBranch };
  }

  private async resetForHead(task: StoredGitLabMrAiRepairTask, deps: CheckedDependencies, detail: GitLabMergeRequestDetails, headSha: string, identity: GitLabMrAiRepairIdentity): Promise<void> {
    const fields = this.requireMrFields(detail);
    const sourcePath = projectPath(detail.projectPath);
    const targetPath = await this.targetProjectPath(deps.gitlab, task.projectId, task.projectPath);
    if (!sourcePath || !targetPath || sourcePath !== targetPath) throw new Error("暂不支持来自 fork 项目的 MR，AI 只会修改当前项目的源分支");
    if (task.editSessionId) await this.options.edits.closeSession(task.editSessionId, ownerKey(task)).catch(() => undefined);
    this.update(task, {
      identity: { ...identity },
      projectPath: targetPath,
      sourceProjectPath: sourcePath,
      title: taskTitle(detail.title, task.mrIid),
      mrUrl: detail.webUrl,
      sourceBranch: fields.sourceBranch,
      targetBranch: fields.targetBranch,
      status: "queued",
      phase: "已确认新的 MR 提交，重新进入 AI 自动修复队列",
      editSessionId: null,
      assistantRunId: null,
      commitSha: headSha,
      verification: null,
      error: null,
      syncedAt: null,
      syncError: null,
      conversationId: randomUUID(),
      editCompleted: false,
      gitlabUserId: deps.user.id === undefined || deps.user.id === null ? task.gitlabUserId : String(deps.user.id),
      gitlabApiBaseUrl: deps.connection.apiBaseUrl,
    });
  }

  private async execute(task: StoredGitLabMrAiRepairTask, signal: AbortSignal): Promise<void> {
    const owner = ownerKey(task);
    const validate = () => { signal.throwIfAborted(); };
    try {
      let deps = await this.checkedDependencies(task);
      validate();
      const detail = await this.readMr(deps.gitlab, task.projectId, task.mrIid);
      validate();
      if (detail.state === "merged" || detail.state === "closed") {
        await this.applyMr(task, detail);
        return;
      }
      const fields = this.requireMrFields(detail);
      if (!task.commitSha) this.update(task, { commitSha: fields.headSha });
      if (task.commitSha && task.commitSha !== fields.headSha) throw new Error(`MR 分支已出现其他提交（当前 ${fields.headSha.slice(0, 12)}，任务记录 ${task.commitSha.slice(0, 12)}），为避免覆盖他人修改已停止处理`);
      this.refreshMr(task, detail);
      if (!task.editSessionId) {
        const session = await this.options.edits.createSession({ ownerKey: owner, projectId: task.sourceProjectId, projectPath: task.sourceProjectPath, baseRef: task.sourceBranch }, deps.connection, { signal });
        this.update(task, { editSessionId: session.id });
        await this.options.edits.setRetentionMode(session.id, owner, "pinned");
      }
      validate();
      await this.verifyAndRepair(task, owner, deps, signal, validate);
    } catch (error) {
      this.update(task, {
        status: signal.aborted ? "canceled" : "failed",
        phase: signal.aborted ? "已停止" : task.verification ? task.phase : "处理失败",
        error: signal.aborted ? "已停止 AI 自动修复，已有改动和发布记录已保留" : safeErrorMessage(error, "AI 自动修复失败"),
      });
    } finally {
      if (task.editSessionId) await this.options.edits.setRetentionMode(task.editSessionId, owner, "auto").catch(() => undefined);
    }
  }

  private makeVerification(task: StoredGitLabMrAiRepairTask, patch: Partial<InspectionAiVerification> = {}): InspectionAiVerification {
    return InspectionAiVerificationSchema.parse({
      headSha: patch.headSha !== undefined ? patch.headSha : task.verification?.headSha ?? null,
      pipelineId: patch.pipelineId !== undefined ? patch.pipelineId : task.verification?.pipelineId ?? null,
      pipelineStatus: patch.pipelineStatus !== undefined ? patch.pipelineStatus : task.verification?.pipelineStatus ?? null,
      pipelineWebUrl: patch.pipelineWebUrl !== undefined ? patch.pipelineWebUrl : task.verification?.pipelineWebUrl ?? null,
      reviewJobId: patch.reviewJobId !== undefined ? patch.reviewJobId : task.verification?.reviewJobId ?? null,
      reviewJobName: patch.reviewJobName !== undefined ? patch.reviewJobName : task.verification?.reviewJobName ?? null,
      reviewJobStatus: patch.reviewJobStatus !== undefined ? patch.reviewJobStatus : task.verification?.reviewJobStatus ?? null,
      reviewJobWebUrl: patch.reviewJobWebUrl !== undefined ? patch.reviewJobWebUrl : task.verification?.reviewJobWebUrl ?? null,
      reviewNoteId: patch.reviewNoteId !== undefined ? patch.reviewNoteId : task.verification?.reviewNoteId ?? null,
      reviewStatus: patch.reviewStatus !== undefined ? patch.reviewStatus : task.verification?.reviewStatus ?? "pending",
      report: patch.report !== undefined ? patch.report : task.verification?.report ?? null,
      feedback: patch.feedback !== undefined ? patch.feedback : task.verification?.feedback ?? null,
      repairAttempts: patch.repairAttempts !== undefined ? patch.repairAttempts : task.verification?.repairAttempts ?? 0,
    });
  }

  private setVerification(task: StoredGitLabMrAiRepairTask, patch: Partial<InspectionAiVerification>, status: GitLabMrAiRepairTask["status"], phase: string): InspectionAiVerification {
    const verification = this.makeVerification(task, patch);
    this.update(task, { verification, status, phase, error: null, syncError: null, syncedAt: new Date().toISOString() });
    return verification;
  }

  private async runAssistantEdit(task: StoredGitLabMrAiRepairTask, owner: string, prompt: string, phase: string, signal: AbortSignal, validate: () => void): Promise<void> {
    const editSession = await this.options.edits.getRunnerContext(task.editSessionId!, owner);
    if (!editSession) throw new Error("编辑工作区已不可用，无法继续处理");
    const message = { id: randomUUID(), role: "user" as const, content: prompt, createdAt: new Date().toISOString() };
    this.options.assistant.appendMessage(task.conversationId, message, task.title, owner);
    const { run } = this.options.execution.createRun(task.conversationId, message.id);
    this.update(task, { assistantRunId: run.id, status: "running", phase });
    validate();
    await this.options.execution.start(run, {
      messages: [message],
      editSession,
      runtimeContext: {
        editSession,
        validateWrite: validate,
        productUsername: task.identity.username,
        getGitLabClient: async () => (validate(), (await this.options.dependencies(task.identity)).gitlab),
      },
    });
    validate();
    const result = this.options.assistant.getRun(run.id);
    if (result?.status !== "completed") throw new Error(result?.error || "助手未完成代码修改");
    if (!(await this.options.edits.getDiff(task.editSessionId!, owner)).changedFiles) throw new Error("助手没有产生代码改动");
  }

  private async verifyAndRepair(task: StoredGitLabMrAiRepairTask, owner: string, initialDeps: CheckedDependencies, signal: AbortSignal, validate: () => void): Promise<void> {
    const budget = { deadline: Date.now() + this.verificationTimeoutMs, activeObserved: false };
    let deps = initialDeps;
    for (;;) {
      const outcome = await this.waitForVerification(task, deps, signal, validate, budget);
      if (outcome.kind === "terminal" || outcome.kind === "passed") return;
      if (outcome.kind === "pending") continue;
      if (outcome.kind === "blocked") throw new Error(outcome.error);
      const attempts = (task.verification?.repairAttempts ?? 0) + 1;
      if (!budget.activeObserved && Date.now() >= budget.deadline) {
        const message = outcome.reason === "review"
          ? "Pipeline Review 反馈已返回，但整体验证已超时，未继续开启下一轮修复"
          : "Pipeline 失败反馈已返回，但整体验证已超时，未继续开启下一轮修复";
        this.update(task, { status: "failed", phase: "验证超时", error: message,
          verification: this.makeVerification(task, { ...outcome.evidence, reviewStatus: "failed", feedback: outcome.feedback }) });
        throw new Error(message);
      }
      this.update(task, { status: "review_fixing", phase: outcome.reason === "review" ? `正在根据 Pipeline Review 修复问题（第 ${attempts} 轮）` : `正在根据 Pipeline 失败日志修复问题（第 ${attempts} 轮）`, error: null, syncError: null, verification: this.makeVerification(task, { ...outcome.evidence, repairAttempts: attempts, feedback: outcome.feedback }) });
      const nextDeps = await this.repairFromVerification(task, owner, deps, signal, validate, outcome, attempts);
      if (!nextDeps) return;
      deps = nextDeps;
    }
  }

  private async repairFromVerification(task: StoredGitLabMrAiRepairTask, owner: string, deps: CheckedDependencies, signal: AbortSignal, validate: () => void, outcome: Extract<AiVerificationOutcome, { kind: "repair" }>, attempts: number): Promise<CheckedDependencies | null> {
    const expectedRemoteSha = outcome.evidence.headSha ?? task.commitSha;
    if (!expectedRemoteSha) throw new Error("无法确认 MR 当前提交，未继续发布验证修复");
    const before = await this.readMr(deps.gitlab, task.projectId, task.mrIid);
    if (before.state === "merged" || before.state === "closed") {
      await this.applyMr(task, before);
      return null;
    }
    if (before.headSha !== expectedRemoteSha) throw new Error(`MR 分支已出现其他提交（当前 ${before.headSha?.slice(0, 12) ?? "未知"}，任务记录 ${expectedRemoteSha.slice(0, 12)}），为避免覆盖他人修改已停止处理`);
    const prompt = `请继续修复当前 GitLab Merge Request 的代码，目标是让同一个 MR 在最新提交上通过目标仓库的 Pipeline 和 Pipeline Review。这个任务与 Jira 无关，不要查找、更新或创建 Jira。

项目：${task.projectPath}
MR：!${task.mrIid}
源分支：${task.sourceBranch}
目标分支：${task.targetBranch}
当前提交：${expectedRemoteSha}
问题类型：${outcome.reason === "review" ? "Pipeline Review 机器人评论" : "Pipeline 失败日志"}

目标仓库针对当前提交产生的真实反馈：
${outcome.feedback}

请逐条核对反馈后直接完成必要的代码修复，只修改与这些反馈直接相关的代码，不要修改 CI 配置、Pipeline 脚本或无关历史问题。不要提交或推送，提交、推送和下一轮验证由系统处理。`;
    await this.runAssistantEdit(task, owner, prompt, `助手正在根据 Pipeline 反馈修复代码（第 ${attempts} 轮）`, signal, validate);
    this.update(task, { editCompleted: true });
    validate();
    const after = await this.readMr(deps.gitlab, task.projectId, task.mrIid);
    if (after.state === "merged" || after.state === "closed") {
      await this.applyMr(task, after);
      return null;
    }
    if (after.headSha !== expectedRemoteSha) throw new Error(`AI 修复期间 MR 出现了其他提交（当前 ${after.headSha?.slice(0, 12) ?? "未知"}），为避免覆盖远端修改已停止处理`);
    this.update(task, { status: "publishing", phase: "正在将 AI 修复发布到 MR 源分支" });
    deps = await this.checkedDependencies(task);
    const email = deps.user.commit_email || deps.user.email;
    if (!email) throw new Error("GitLab 未返回提交邮箱，请完善账号邮箱后重试");
    let newCommitSha: string | null = null;
    await this.options.edits.publish(task.editSessionId!, owner, {
      branch: task.sourceBranch,
      title: `修复 MR !${task.mrIid} 的验证问题`,
      description: outcome.reason === "review" ? "根据目标仓库 Pipeline Review 反馈自动修复代码。" : "根据目标仓库 Pipeline 失败日志自动修复代码。",
      expectedRemoteSha,
      author: { name: deps.user.name || deps.user.username || String(deps.user.id), email },
      connection: deps.connection,
      signal,
      validate,
      onCommitted: (commitSha) => { newCommitSha = commitSha; this.update(task, { commitSha, phase: "验证修复已提交，正在等待新的 Pipeline" }); },
    });
    if (!newCommitSha) throw new Error("发布验证修复后未得到新的提交 SHA");
    this.update(task, {
      verification: this.makeVerification(task, { headSha: newCommitSha, pipelineId: null, pipelineStatus: null, pipelineWebUrl: null, reviewJobId: null, reviewJobName: null, reviewJobStatus: null, reviewJobWebUrl: null, reviewNoteId: null, reviewStatus: "pending", report: null, feedback: null, repairAttempts: attempts }),
      status: "pipeline_pending",
      phase: "验证修复已发布，等待新的 Pipeline",
      error: null,
      syncError: null,
    });
    return this.checkedDependencies(task);
  }

  private async waitForVerification(task: StoredGitLabMrAiRepairTask, deps: CheckedDependencies, signal: AbortSignal, validate: () => void, budget: { deadline: number; activeObserved: boolean }): Promise<AiVerificationOutcome> {
    for (;;) {
      validate();
      if (isActiveVerification(task.verification)) budget.activeObserved = true;
      const result = await retryTransientGitLabRead(
        () => this.inspectVerification(task, deps, signal, validate),
        {
          signal,
          validate,
          deadline: budget.activeObserved ? Number.POSITIVE_INFINITY : budget.deadline,
          retryDelayMs: this.verificationPollIntervalMs,
          onRetry: () => this.update(task, {
            status: task.status === "review_pending" ? "review_pending" : "pipeline_pending",
            phase: "GitLab 状态暂时无法读取，正在自动重试",
            error: null,
            syncError: null,
          }),
        },
      );
      if (!result.ok) {
        const verification = this.setVerification(task, { reviewStatus: "failed", feedback: "GitLab 状态读取持续失败，未能确认当前提交是否通过。" }, "failed", "验证超时");
        return { kind: "blocked", evidence: verification, error: "GitLab 状态读取持续失败，未能确认当前提交是否通过" };
      }
      const outcome = result.value;
      if (outcome.kind !== "pending") return outcome;
      if (isActiveVerification(task.verification)) budget.activeObserved = true;
      if (!budget.activeObserved && Date.now() >= budget.deadline) {
        const verification = this.setVerification(task, { reviewStatus: "failed", feedback: "等待目标仓库 Pipeline 或 Review Job 超时，未能确认当前提交是否通过。" }, "failed", "验证超时");
        return { kind: "blocked", evidence: verification, error: "等待目标仓库 Pipeline 或 Review Job 超时，未能确认当前提交是否通过" };
      }
      const delay = budget.activeObserved ? this.verificationPollIntervalMs || 1 : Math.min(this.verificationPollIntervalMs || 1, budget.deadline - Date.now());
      await abortableDelay(delay, signal);
    }
  }

  private async inspectVerification(task: StoredGitLabMrAiRepairTask, deps: CheckedDependencies, signal: AbortSignal, validate: () => void): Promise<AiVerificationOutcome> {
    return inspectAiVerification({
      task: { mr: { projectId: task.projectId, iid: task.mrIid }, commitSha: task.commitSha, verification: task.verification },
      gitlab: deps.gitlab,
      reviewJobNames: this.reviewJobNames,
      signal,
      reviewDecisionRunner: this.options.reviewDecisionRunner,
      validate,
      setVerification: (patch, status, phase) => this.setVerification(task, patch, status, phase),
      refreshMr: (mr) => this.refreshMr(task, mr),
      applyMr: (mr) => this.applyMr(task, mr),
    });
  }

  private refreshMr(task: StoredGitLabMrAiRepairTask, detail: GitLabMergeRequestDetails): void {
    this.update(task, {
      title: taskTitle(detail.title, task.mrIid),
      mrUrl: detail.webUrl,
      sourceBranch: detail.sourceBranch ?? task.sourceBranch,
      targetBranch: detail.targetBranch ?? task.targetBranch,
      commitSha: task.commitSha ?? detail.headSha,
      syncedAt: new Date().toISOString(),
      syncError: null,
    });
  }

  private async applyMr(task: StoredGitLabMrAiRepairTask, detail: GitLabMergeRequestDetails | GitLabMergeRequestSummary): Promise<void> {
    const status = detail.state === "merged" ? "merged" : detail.state === "closed" ? "closed" : "mr_open";
    if (status === "mr_open") return;
    this.update(task, {
      title: taskTitle(detail.title, task.mrIid),
      mrUrl: detail.webUrl,
      sourceBranch: detail.sourceBranch ?? task.sourceBranch,
      targetBranch: detail.targetBranch ?? task.targetBranch,
      status,
      phase: status === "merged" ? "MR 已合并" : "MR 已关闭",
      error: null,
      syncError: null,
      syncedAt: new Date().toISOString(),
    });
  }

  private async sync(task: StoredGitLabMrAiRepairTask): Promise<void> {
    if (this.active.has(task.id) || this.queuedIds.has(task.id) || !this.isCurrentTask(task)) return;
    const running = this.syncing.get(task.id);
    if (running) return running;
    const work = (async () => {
      try {
        const deps = await this.options.dependencies(task.identity);
        const detail = await this.readMr(deps.gitlab, task.projectId, task.mrIid);
        if (this.active.has(task.id) || this.queuedIds.has(task.id) || !this.isCurrentTask(task)) return;
        if (detail.state === "merged" || detail.state === "closed") await this.applyMr(task, detail);
        else this.refreshMr(task, detail);
      } catch (error) {
        if (this.active.has(task.id) || this.queuedIds.has(task.id) || !this.isCurrentTask(task)) return;
        this.update(task, { syncError: safeErrorMessage(error, "MR 状态暂时无法同步"), syncedAt: new Date().toISOString() });
      }
    })();
    this.syncing.set(task.id, work);
    try { await work; } finally { this.syncing.delete(task.id); }
  }

  private async syncAll(): Promise<void> {
    for (const task of this.tasks.values()) if (!this.active.has(task.id)) await this.sync(task);
  }
}
