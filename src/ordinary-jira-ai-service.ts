import { createHash, randomUUID } from "node:crypto";
import {
  GitLabCreateMergeRequestInputSchema,
  InspectionAiPreReviewSchema,
  InspectionAiVerificationSchema,
  type InspectionAiVerification,
  type JiraIssueDetails,
  type OrdinaryJiraAiCheckId,
  type OrdinaryJiraAiPrecheck,
  type OrdinaryJiraAiPrecheckSummary,
  OrdinaryJiraAiPrecheckSchema,
  type OrdinaryJiraAiSupplement,
  OrdinaryJiraAiSupplementSchema,
  type OrdinaryJiraAiTask,
  type OrdinaryJiraAiTaskSummary,
  type OrdinaryJiraAiTaskDetail,
} from "./api-contracts.js";
import type { AssistantEditService } from "./assistant-edit-service.js";
import type { AssistantExecutionManager } from "./assistant-execution.js";
import type { AssistantStore } from "./assistant-store.js";
import type { GitLabConnection } from "./gitlab-connection.js";
import { GitLabApiError, type GitLabClientPort, type GitLabCurrentUser } from "./gitlab-client.js";
import type { JiraClientPort } from "./jira-client.js";
import type { GitLabMergeRequestDetails, GitLabMergeRequestSummary } from "./gitlab-workbench.js";
import type { PreSubmitReviewRunner, ReviewProfile } from "./contracts.js";
import type { GitLabReviewDecisionRunner } from "./gitlab-review-decision.js";
import {
  buildDefaultMergeRequestDescription,
  ensureMergeRequestTitleJiraKey,
  normalizeMergeRequestDescription,
  type ManagedPromptRunner,
  type MergeRequestDescriptionPromptInput,
} from "./prompt-generation.js";
import {
  abortableDelay,
  DEFAULT_INSPECTION_AI_REVIEW_JOB_NAMES,
  INSPECTION_AI_MAX_PRE_SUBMIT_REPAIR_ATTEMPTS,
  INSPECTION_AI_VERIFICATION_POLL_INTERVAL_MS,
  INSPECTION_AI_VERIFICATION_TIMEOUT_MS,
  isActiveVerification,
  inspectAiVerification,
  retryTransientGitLabRead,
  type AiVerificationOutcome,
} from "./inspection-ai-verification.js";
import { parsePreSubmitReviewOutput, preSubmitReviewGate, renderPreSubmitReviewFeedback, renderPreSubmitReviewReport } from "./review-prompt.js";
import { safeErrorMessage } from "./errors.js";
import { jiraAiContentHash, jiraAiIssueMaterial, ORDINARY_JIRA_AI_CHECKS, type JiraAiPrecheckInput, type JiraAiPrecheckRunner, type JiraAiPrecheckSupplementInput } from "./jira-ai-precheck.js";
import { OrdinaryJiraAiStore, publicOrdinaryJiraAiTask, publicOrdinaryJiraAiTaskSummary, type StoredOrdinaryJiraAiTask } from "./ordinary-jira-ai-store.js";
import { ensureGitLabDraftTitle } from "./gitlab-mr-title.js";
import { createPreSubmitReviewProgressRecorder } from "./pre-submit-review-progress.js";

export interface OrdinaryJiraAiIdentity {
  userId: string;
  username: string;
}

interface Dependencies {
  gitlab: GitLabClientPort;
  jira: JiraClientPort;
  connection: GitLabConnection;
}

interface CheckedDependencies extends Dependencies {
  user: GitLabCurrentUser;
}

interface ProjectInput {
  projectId: string;
  projectPath: string;
  targetBranch: string;
}

interface PrecheckRecord {
  precheck: OrdinaryJiraAiPrecheck | null;
  input: ProjectInput;
  expiresAt: number;
  status: "processing" | "ready";
}

interface Options {
  store: OrdinaryJiraAiStore;
  edits: AssistantEditService;
  assistant: AssistantStore;
  execution: AssistantExecutionManager;
  dependencies: (identity: OrdinaryJiraAiIdentity) => Promise<Dependencies>;
  precheckRunner: JiraAiPrecheckRunner;
  preSubmitReview?: PreSubmitReviewRunner;
  promptRunner?: ManagedPromptRunner;
  reviewDecisionRunner: GitLabReviewDecisionRunner;
  reviewProfile?: (projectPath: string) => Promise<ReviewProfile>;
  concurrency?: number;
  verificationPollIntervalMs?: number;
  verificationTimeoutMs?: number;
  maxPreSubmitRepairAttempts?: number;
  reviewJobNames?: readonly string[];
}

const ORDINARY_JIRA_AI_MERGE_REQUEST_LABEL = "ai-created";
const BUSY = new Set(["preparing", "running", "publishing", "review_fixing"]);
const RESUMABLE_VERIFICATION = new Set(["pipeline_pending", "review_pending"]);

function shortTitle(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return "普通 Jira 问题修复";
  const boundary = normalized.search(/[；;。！？!?]/u);
  const primary = boundary >= 20 ? normalized.slice(0, boundary).trim() : normalized;
  const characters = Array.from(primary);
  return characters.length <= 110 ? primary : `${characters.slice(0, 109).join("").trimEnd()}…`;
}

function ownerKey(task: StoredOrdinaryJiraAiTask): string {
  return `jira-ai:${task.userId}`;
}

function normalizeProjectInput(input: ProjectInput): ProjectInput {
  const projectId = input.projectId.trim();
  const projectPath = input.projectPath.trim();
  const targetBranch = input.targetBranch.trim();
  if (!projectId || !projectPath || !targetBranch) throw new Error("GitLab 项目和目标分支不能为空");
  return { projectId, projectPath, targetBranch };
}

export class OrdinaryJiraAiConflictError extends Error {
  constructor() {
    super("该 Jira 在当前项目和目标分支上已有 AI 处理任务，请勿重复处理。");
    this.name = "OrdinaryJiraAiConflictError";
  }
}

export class OrdinaryJiraAiPrecheckStaleError extends Error {
  constructor() {
    super("Jira 内容在预检查后发生了变化，请重新执行预检查。");
    this.name = "OrdinaryJiraAiPrecheckStaleError";
  }
}

export class OrdinaryJiraAiService {
  private readonly tasks = new Map<string, StoredOrdinaryJiraAiTask>();
  private readonly prechecks = new Map<string, PrecheckRecord>();
  private readonly queue: string[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly syncing = new Map<string, Promise<void>>();
  private readonly concurrency: number;
  private readonly verificationPollIntervalMs: number;
  private readonly verificationTimeoutMs: number;
  private readonly maxPreSubmitRepairAttempts: number;
  private readonly reviewJobNames: readonly string[];
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;

  constructor(private readonly options: Options) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.verificationPollIntervalMs = Math.max(0, options.verificationPollIntervalMs ?? INSPECTION_AI_VERIFICATION_POLL_INTERVAL_MS);
    this.verificationTimeoutMs = Math.max(1_000, options.verificationTimeoutMs ?? INSPECTION_AI_VERIFICATION_TIMEOUT_MS);
    this.maxPreSubmitRepairAttempts = Math.max(0, options.maxPreSubmitRepairAttempts ?? INSPECTION_AI_MAX_PRE_SUBMIT_REPAIR_ATTEMPTS);
    this.reviewJobNames = options.reviewJobNames?.length ? options.reviewJobNames : DEFAULT_INSPECTION_AI_REVIEW_JOB_NAMES;
    this.tasks = new Map(options.store.list().map((task) => [task.id, task]));
    for (const task of this.tasks.values()) {
      if (BUSY.has(task.status)) this.update(task, { status: "failed", phase: "执行中断", error: "服务重启中断了处理，可重试继续" });
      else if (RESUMABLE_VERIFICATION.has(task.status) && task.mr) this.update(task, { status: "queued", phase: "服务已恢复，继续验证 MR", error: null, syncError: null });
    }
    this.timer = setInterval(() => { void this.syncAll(); }, 60_000);
    this.timer.unref();
    for (const task of [...this.tasks.values()].filter((item) => item.status === "queued").sort((left, right) => left.createdAt.localeCompare(right.createdAt))) this.enqueue(task);
  }

  async precheck(jiraKey: string, input: ProjectInput, identity: OrdinaryJiraAiIdentity): Promise<OrdinaryJiraAiPrecheck> {
    this.assertIdentity(identity);
    const project = normalizeProjectInput(input);
    const key = this.precheckKey(identity, jiraKey);
    const record: PrecheckRecord = { precheck: null, input: project, expiresAt: Date.now() + 30 * 60_000, status: "processing" };
    this.prechecks.set(key, record);
    try {
      const deps = await this.options.dependencies(identity);
      await this.validateProject(deps.gitlab, project);
      const issue = await deps.jira.getIssue(jiraKey.trim().toUpperCase());
      const precheckInput: JiraAiPrecheckInput = { issue, projectPath: project.projectPath, targetBranch: project.targetBranch };
      const modelResult = await this.options.precheckRunner.runJiraAiPrecheck(precheckInput, { ownerId: identity.userId });
      const result = OrdinaryJiraAiPrecheckSchema.parse({
        id: randomUUID(),
        jiraKey: issue.key,
        jiraUpdatedAt: issue.updatedAt,
        contentHash: jiraAiContentHash(precheckInput),
        checkedAt: new Date().toISOString(),
        status: modelResult.status,
        checks: modelResult.checks,
        summary: modelResult.summary,
        implementationBrief: modelResult.implementationBrief,
        projectPath: project.projectPath,
        targetBranch: project.targetBranch,
        error: null,
      });
      if (this.prechecks.get(key) === record) {
        record.precheck = result;
        record.status = "ready";
        record.expiresAt = Date.now() + 30 * 60_000;
      }
      this.prunePrechecks();
      return result;
    } catch (error) {
      if (this.prechecks.get(key) === record) this.prechecks.delete(key);
      throw error;
    }
  }

  find(jiraKey: string, identity: OrdinaryJiraAiIdentity): OrdinaryJiraAiTask | null {
    this.assertIdentity(identity);
    const task = this.options.store.find(identity.userId, jiraKey);
    return task ? publicOrdinaryJiraAiTask(task) : null;
  }

  findSummaries(jiraKeys: readonly string[], identity: OrdinaryJiraAiIdentity): OrdinaryJiraAiTaskSummary[] {
    this.assertIdentity(identity);
    const wanted = new Set(jiraKeys.map((key) => key.trim().toLowerCase()).filter(Boolean));
    if (wanted.size === 0) return [];
    const latest = new Map<string, StoredOrdinaryJiraAiTask>();
    for (const task of this.options.store.list()) {
      if (task.userId !== identity.userId) continue;
      const key = task.jiraKey.trim().toLowerCase();
      if (!wanted.has(key)) continue;
      const current = latest.get(key);
      if (!current || task.updatedAt.localeCompare(current.updatedAt) > 0 || (task.updatedAt === current.updatedAt && task.id.localeCompare(current.id) > 0)) latest.set(key, task);
    }
    return [...latest.values()].map(publicOrdinaryJiraAiTaskSummary);
  }

  findPrecheckSummaries(jiraKeys: readonly string[], identity: OrdinaryJiraAiIdentity): OrdinaryJiraAiPrecheckSummary[] {
    this.assertIdentity(identity);
    this.prunePrechecks();
    return [...new Set(jiraKeys.map((key) => key.trim().toLowerCase()).filter(Boolean))].flatMap((jiraKey): OrdinaryJiraAiPrecheckSummary[] => {
      const record = this.prechecks.get(this.precheckKey(identity, jiraKey));
      if (!record) return [];
      if (record.status === "processing") return [{ jiraKey: jiraKey.toUpperCase(), status: "processing" as const, precheckStatus: null }];
      return record.precheck ? [{ jiraKey: record.precheck.jiraKey, status: "ready" as const, precheckStatus: record.precheck.status }] : [];
    });
  }

  findPrecheck(jiraKey: string, identity: OrdinaryJiraAiIdentity): { status: "idle" | "processing" | "ready"; precheck: OrdinaryJiraAiPrecheck | null; projectId: string | null } {
    this.assertIdentity(identity);
    this.prunePrechecks();
    const record = this.prechecks.get(this.precheckKey(identity, jiraKey));
    if (!record) return { status: "idle", precheck: null, projectId: null };
    if (record.status === "processing" || !record.precheck) return { status: "processing", precheck: null, projectId: record.input.projectId };
    return { status: "ready", precheck: record.precheck, projectId: record.input.projectId };
  }

  async suggestPrecheckSupplement(jiraKey: string, input: ProjectInput & { precheckId: string; checkId: OrdinaryJiraAiCheckId }, identity: OrdinaryJiraAiIdentity): Promise<OrdinaryJiraAiSupplement> {
    const context = await this.currentPrecheckContext(jiraKey, input, identity);
    const definition = ORDINARY_JIRA_AI_CHECKS.find((item) => item.id === input.checkId);
    const check = context.precheck.checks.find((item) => item.id === input.checkId);
    if (!definition || !check || check.status !== "missing") throw new Error("该检查项当前不需要 AI 补充，请重新执行预检查");
    const supplementInput = {
      issue: context.issue,
      projectPath: context.project.projectPath,
      targetBranch: context.project.targetBranch,
      check: { ...definition, detail: check.detail },
    } satisfies JiraAiPrecheckSupplementInput;
    const result = this.options.precheckRunner.runJiraAiPrecheckSupplement
      ? await this.options.precheckRunner.runJiraAiPrecheckSupplement(supplementInput, { ownerId: identity.userId })
      : { status: "needs_user" as const, suggestion: "", evidence: "", reason: "当前 AI 运行器不支持缺失项补充判断，请由用户补充。" };
    return OrdinaryJiraAiSupplementSchema.parse({
      checkId: check.id,
      label: check.label,
      status: result.status,
      suggestion: result.suggestion,
      evidence: result.evidence,
      reason: result.reason,
    });
  }

  async confirmPrecheckSupplement(jiraKey: string, input: ProjectInput & { precheckId: string; checkId: OrdinaryJiraAiCheckId; supplement: string }, identity: OrdinaryJiraAiIdentity): Promise<OrdinaryJiraAiPrecheck> {
    const context = await this.currentPrecheckContext(jiraKey, input, identity);
    const check = context.precheck.checks.find((item) => item.id === input.checkId);
    if (!check || check.status !== "missing") throw new Error("该检查项已经更新，请重新执行预检查");
    const supplement = input.supplement.trim();
    if (!supplement) throw new Error("AI 补充内容不能为空");
    if (supplement.length > 4_000) throw new Error("AI 补充内容不能超过 4000 个字符");
    await context.deps.jira.addComment(context.issue.key, `AI 补充（${check.label}）：\n${supplement}`);
    return this.precheck(context.issue.key, context.project, identity);
  }

  async start(jiraKey: string, input: ProjectInput & { precheckId: string; confirmed: boolean }, identity: OrdinaryJiraAiIdentity): Promise<OrdinaryJiraAiTask> {
    this.assertIdentity(identity);
    if (!input.confirmed) throw new Error("请先确认预检查结果");
    const project = normalizeProjectInput(input);
    const key = jiraKey.trim().toUpperCase();
    const record = this.prechecks.get(this.precheckKey(identity, key));
    if (!record || record.status !== "ready" || !record.precheck || record.expiresAt <= Date.now() || record.precheck.id !== input.precheckId) throw new OrdinaryJiraAiPrecheckStaleError();
    if (record.precheck.status !== "passed") throw new Error("Jira 预检查未通过，请先补充 Jira 描述后重新检查");
    if (record.input.projectId !== project.projectId || record.input.projectPath !== project.projectPath || record.input.targetBranch !== project.targetBranch) throw new OrdinaryJiraAiPrecheckStaleError();
    const deps = await this.options.dependencies(identity);
    await this.validateProject(deps.gitlab, project);
    const issue = await deps.jira.getIssue(key);
    const currentHash = jiraAiContentHash({ issue, projectPath: project.projectPath, targetBranch: project.targetBranch });
    if (currentHash !== record.precheck.contentHash) throw new OrdinaryJiraAiPrecheckStaleError();
    const existing = this.options.store.find(identity.userId, key);
    if (existing) return publicOrdinaryJiraAiTask(existing);
    const id = randomUUID();
    const now = new Date().toISOString();
    const sourceBranch = `ai/jira-${key.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${id.slice(0, 12)}`;
    const task: StoredOrdinaryJiraAiTask = {
      id,
      userId: identity.userId,
      jiraKey: issue.key,
      title: shortTitle(issue.summary),
      jiraUrl: issue.webUrl,
      projectId: project.projectId,
      projectPath: project.projectPath,
      targetBranch: project.targetBranch,
      sourceBranch,
      status: "queued",
      phase: "已通过 Jira 预检查，进入 AI 处理队列",
      createdAt: now,
      updatedAt: now,
      editSessionId: null,
      assistantRunId: null,
      commitSha: null,
      mr: null,
      precheck: record.precheck,
      preReview: null,
      verification: null,
      error: null,
      syncedAt: null,
      syncError: null,
      identity: { ...identity },
      jiraDescription: issue.description ?? "",
      jiraContext: jiraAiIssueMaterial(issue),
      gitlabUserId: null,
      gitlabApiBaseUrl: null,
      conversationId: randomUUID(),
      editCompleted: false,
    };
    if (!this.options.store.claimJira(task.jiraKey, task.projectId, task.targetBranch, task.id, task.userId)) throw new OrdinaryJiraAiConflictError();
    try {
      this.options.store.save(task);
    } catch (error) {
      this.options.store.releaseJiraClaim(task.jiraKey, task.projectId, task.targetBranch, task.id);
      throw error;
    }
    this.tasks.set(task.id, task);
    this.enqueue(task);
    return publicOrdinaryJiraAiTask(task);
  }

  async detail(id: string, identity: OrdinaryJiraAiIdentity): Promise<OrdinaryJiraAiTaskDetail> {
    const task = this.authorized(id, identity);
    await this.sync(task);
    return {
      task: publicOrdinaryJiraAiTask(task),
      execution: task.assistantRunId ? this.options.assistant.getRun(task.assistantRunId, 0, ownerKey(task)) : null,
      executions: this.options.assistant.listRuns(task.conversationId, ownerKey(task)),
      editSession: task.editSessionId ? await this.options.edits.getSession(task.editSessionId, ownerKey(task)) : null,
    };
  }

  retry(id: string, identity: OrdinaryJiraAiIdentity): OrdinaryJiraAiTask {
    const task = this.authorized(id, identity);
    if (this.closing) throw new Error("服务正在关闭");
    if (this.active.has(id) || task.status === "queued") return publicOrdinaryJiraAiTask(task);
    if (!["failed", "canceled"].includes(task.status)) throw new Error("当前任务不能重试");
    if (!this.options.store.claimJira(task.jiraKey, task.projectId, task.targetBranch, task.id, task.userId)) throw new OrdinaryJiraAiConflictError();
    this.update(task, {
      identity: { ...identity },
      status: "queued",
      phase: task.mr ? "已重新进入 MR 验证队列" : task.editSessionId ? "已保留现有工作区，重新进入 AI 处理队列" : "已重新进入 AI 处理队列",
      error: null,
      syncError: null,
      assistantRunId: null,
      verification: task.mr ? task.verification ? { ...task.verification, reviewStatus: "pending", report: null, feedback: null, reviewNoteId: null } : null : task.verification,
    });
    this.enqueue(task);
    return publicOrdinaryJiraAiTask(task);
  }

  cancel(id: string, identity: OrdinaryJiraAiIdentity): OrdinaryJiraAiTask {
    const task = this.authorized(id, identity);
    if (task.status === "queued") {
      this.queuedIds.delete(id);
      this.update(task, { status: "canceled", phase: "已停止", error: "已停止 AI 处理" });
      this.pump();
      return publicOrdinaryJiraAiTask(task);
    }
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new Error("已停止 AI 处理"));
      if (task.assistantRunId) this.options.execution.cancel(task.assistantRunId);
      this.update(task, { phase: "正在停止，请稍候" });
    }
    return publicOrdinaryJiraAiTask(task);
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

  private assertIdentity(identity: OrdinaryJiraAiIdentity): void {
    if (!identity.userId.trim() || !identity.username.trim()) throw new Error("当前登录用户无效，请重新登录");
  }

  private precheckKey(identity: OrdinaryJiraAiIdentity, jiraKey: string): string {
    return `${identity.userId}\u0000${jiraKey.trim().toLowerCase()}`;
  }

  private async currentPrecheckContext(jiraKey: string, input: ProjectInput & { precheckId: string }, identity: OrdinaryJiraAiIdentity): Promise<{ deps: Dependencies; issue: JiraIssueDetails; project: ProjectInput; precheck: OrdinaryJiraAiPrecheck }> {
    this.assertIdentity(identity);
    this.prunePrechecks();
    const project = normalizeProjectInput(input);
    const key = jiraKey.trim().toUpperCase();
    const record = this.prechecks.get(this.precheckKey(identity, key));
    if (!record || record.status !== "ready" || !record.precheck || record.expiresAt <= Date.now() || record.precheck.id !== input.precheckId) throw new OrdinaryJiraAiPrecheckStaleError();
    if (record.input.projectId !== project.projectId || record.input.projectPath !== project.projectPath || record.input.targetBranch !== project.targetBranch) throw new OrdinaryJiraAiPrecheckStaleError();
    const deps = await this.options.dependencies(identity);
    await this.validateProject(deps.gitlab, project);
    const issue = await deps.jira.getIssue(key);
    const currentHash = jiraAiContentHash({ issue, projectPath: project.projectPath, targetBranch: project.targetBranch });
    if (currentHash !== record.precheck.contentHash) throw new OrdinaryJiraAiPrecheckStaleError();
    return { deps, issue, project, precheck: record.precheck };
  }

  private authorized(id: string, identity: OrdinaryJiraAiIdentity): StoredOrdinaryJiraAiTask {
    this.assertIdentity(identity);
    const task = this.tasks.get(id) ?? this.options.store.get(id, identity.userId);
    if (!task || task.userId !== identity.userId) throw new Error("AI 任务不存在或不属于当前用户");
    this.tasks.set(id, task);
    return task;
  }

  private update(task: StoredOrdinaryJiraAiTask, patch: Partial<StoredOrdinaryJiraAiTask>): void {
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.options.store.save(task);
  }

  private enqueue(task: StoredOrdinaryJiraAiTask): void {
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
      this.update(task, { status: "preparing", phase: task.editSessionId ? "正在恢复已有工作区并继续处理" : "正在读取 Jira 和准备隔离工作区" });
      active.promise = this.execute(task, active.controller.signal).finally(() => {
        this.active.delete(id);
        this.pump();
      });
    }
  }

  private async checkedDependencies(task: StoredOrdinaryJiraAiTask): Promise<CheckedDependencies> {
    const deps = await this.options.dependencies(task.identity);
    const user = await deps.gitlab.getCurrentUser?.();
    if (!user?.id) throw new Error("无法确认当前用户的 GitLab 身份，请重新连接");
    if (task.gitlabUserId && (task.gitlabUserId !== String(user.id) || task.gitlabApiBaseUrl !== deps.connection.apiBaseUrl)) throw new Error("GitLab 连接已更换，请恢复创建任务时使用的账号后重试");
    if (!deps.gitlab.createMergeRequest || !deps.gitlab.listMergeRequests || !deps.gitlab.getMergeRequestDetails || !deps.gitlab.listPipelines || !deps.gitlab.listPipelineJobs || !deps.gitlab.getPipelineJobTrace) throw new Error("GitLab 不支持创建 MR 或读取 Pipeline Review 结果");
    return { ...deps, user };
  }

  private async validateProject(gitlab: GitLabClientPort, input: ProjectInput): Promise<void> {
    if (gitlab.getProject) {
      const project = await gitlab.getProject(input.projectId).catch((error) => {
        if (error instanceof GitLabApiError && error.status === 404) return null;
        throw error;
      });
      if (!project || project.pathWithNamespace !== input.projectPath) throw new Error("GitLab 项目已变化，请重新选择项目");
    } else if (gitlab.listProjects) {
      const projectName = input.projectPath.split("/").filter(Boolean).at(-1) ?? input.projectPath;
      const projects = await gitlab.listProjects({ search: projectName, page: 1, perPage: 50 });
      const project = projects.find((item) => item.id === input.projectId && item.pathWithNamespace === input.projectPath);
      if (!project) throw new Error("GitLab 项目已变化，请重新选择项目");
    }
    if (gitlab.getMergeRequestCreateOptions) {
      const options = await gitlab.getMergeRequestCreateOptions(input.projectId);
      if (options.branches.length > 0 && !options.branches.some((branch) => branch.name === input.targetBranch)) throw new Error("GitLab 目标分支不存在，请重新选择");
    }
  }

  private async execute(task: StoredOrdinaryJiraAiTask, signal: AbortSignal): Promise<void> {
    const owner = ownerKey(task);
    const validate = () => { signal.throwIfAborted(); };
    try {
      let deps = await this.checkedDependencies(task);
      validate();
      if (!task.gitlabUserId) {
        const issue = await deps.jira.getIssue(task.jiraKey);
        const currentHash = jiraAiContentHash({ issue, projectPath: task.projectPath, targetBranch: task.targetBranch });
        if (currentHash !== task.precheck.contentHash) throw new OrdinaryJiraAiPrecheckStaleError();
        this.update(task, { title: shortTitle(issue.summary), jiraDescription: issue.description ?? "", jiraContext: jiraAiIssueMaterial(issue), jiraUrl: issue.webUrl, gitlabUserId: String(deps.user.id), gitlabApiBaseUrl: deps.connection.apiBaseUrl });
      }
      if (!task.editSessionId) {
        const session = await this.options.edits.createSession({ ownerKey: owner, projectId: task.projectId, projectPath: task.projectPath, baseRef: task.targetBranch }, deps.connection, { signal });
        this.update(task, { editSessionId: session.id });
        await this.options.edits.setRetentionMode(session.id, owner, "pinned");
      }
      validate();
      if (!task.mr) {
        if (!task.editCompleted && !task.commitSha) {
          const prompt = `请在当前 GitLab 项目中解决以下普通 Jira 问题，直接使用现有代码编辑工具完成修改。\n\n项目：${task.projectPath}\n目标分支：${task.targetBranch}\nJira：${task.jiraKey}\n标题：${task.title}\n\nJira 描述和评论（已通过预检查，只能以这些事实为准）：\n${task.jiraContext}\n\n预检查整理：\n${JSON.stringify(task.precheck.implementationBrief, null, 2)}\n\n请先核对代码中是否存在该问题，保留已有正确改动，只修改与 Jira 直接相关的代码。结束时说明实际修改、验证和未确认内容；提交、推送和 MR 由系统处理。`;
          await this.runAssistantEdit(task, owner, prompt, "助手正在分析 Jira 并修改代码", signal, validate);
          this.update(task, { editCompleted: true });
        }
        if (!task.commitSha) await this.ensurePreSubmitReview(task, owner, signal, validate);
        this.update(task, { status: "publishing", phase: "正在提交代码并创建 MR" });
        deps = await this.checkedDependencies(task);
        validate();
        const existing = await this.findRemoteMr(task, deps.gitlab);
        if (existing) await this.applyMr(task, existing);
        else {
          const email = deps.user.commit_email || deps.user.email;
          if (!email) throw new Error("GitLab 未返回提交邮箱，请完善账号邮箱后重试");
          const mrTitle = ensureMergeRequestTitleJiraKey(task.title, task.jiraKey);
          const draftMrTitle = ensureGitLabDraftTitle(mrTitle);
          const mrPromptInput: MergeRequestDescriptionPromptInput = {
            projectPath: task.projectPath,
            jiraKey: task.jiraKey,
            jiraUrl: task.jiraUrl,
            sourceBranch: task.sourceBranch,
            targetBranch: task.targetBranch,
            title: mrTitle,
            commitTitle: mrTitle,
            commitMessage: task.jiraDescription,
            jiraDescription: task.jiraContext,
          };
          let mrDescription = buildDefaultMergeRequestDescription(mrPromptInput);
          if (this.options.promptRunner) {
            try {
              mrDescription = normalizeMergeRequestDescription(await this.options.promptRunner.generateMergeRequestDescription(mrPromptInput, { signal }), mrPromptInput);
            } catch (error) {
              this.update(task, { error: `MR 描述生成失败，已使用内置规范：${safeErrorMessage(error, "无法生成 MR 描述")}` });
            }
          }
          await this.options.edits.publish(task.editSessionId!, owner, {
            branch: task.sourceBranch,
            title: mrTitle,
            description: mrDescription,
            author: { name: deps.user.name || deps.user.username || String(deps.user.id), email },
            connection: deps.connection,
            signal,
            validate,
            onCommitted: (commitSha) => this.update(task, { commitSha, phase: "代码已提交，正在发布分支和 MR" }),
          });
          deps = await this.checkedDependencies(task);
          const mr = await deps.gitlab.createMergeRequest!(GitLabCreateMergeRequestInputSchema.parse({
            targetProjectId: task.projectId,
            sourceProjectId: task.projectId,
            sourceBranch: task.sourceBranch,
            targetBranch: task.targetBranch,
            title: draftMrTitle,
            description: mrDescription,
            assigneeIds: [task.gitlabUserId!],
            labels: [ORDINARY_JIRA_AI_MERGE_REQUEST_LABEL],
          }));
          await this.applyMr(task, mr);
        }
      }
      await this.verifyAndRepair(task, owner, deps, signal, validate);
    } catch (error) {
      this.update(task, {
        status: signal.aborted ? "canceled" : "failed",
        phase: signal.aborted ? "已停止" : task.mr && task.verification ? task.phase : "处理失败",
        error: signal.aborted ? "已停止 AI 处理，已有改动和发布记录已保留" : safeErrorMessage(error, "AI 处理失败"),
      });
    } finally {
      if (task.mr && task.editSessionId) await this.options.edits.setRetentionMode(task.editSessionId, owner, "auto").catch(() => undefined);
    }
  }

  private makeVerification(task: StoredOrdinaryJiraAiTask, patch: Partial<InspectionAiVerification> = {}): InspectionAiVerification {
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

  private setVerification(task: StoredOrdinaryJiraAiTask, patch: Partial<InspectionAiVerification>, status: OrdinaryJiraAiTask["status"], phase: string): InspectionAiVerification {
    const verification = this.makeVerification(task, patch);
    this.update(task, { verification, status, phase, error: null, syncError: null, syncedAt: new Date().toISOString() });
    return verification;
  }

  private async runAssistantEdit(task: StoredOrdinaryJiraAiTask, owner: string, prompt: string, phase: string, signal: AbortSignal, validate: () => void): Promise<void> {
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
        getJiraClient: async () => (validate(), (await this.options.dependencies(task.identity)).jira),
      },
    });
    validate();
    const result = this.options.assistant.getRun(run.id);
    if (result?.status !== "completed") throw new Error(result?.error || "助手未完成代码修改");
    if (!(await this.options.edits.getDiff(task.editSessionId!, owner)).changedFiles) throw new Error("助手没有产生代码改动");
  }

  private async ensurePreSubmitReview(task: StoredOrdinaryJiraAiTask, owner: string, signal: AbortSignal, validate: () => void, externalFeedback: string | null = null): Promise<void> {
    const runner = this.options.preSubmitReview;
    const loadProfile = this.options.reviewProfile;
    if (!runner || !loadProfile) throw new Error("提交前 Review 能力未配置，未允许发布代码");
    const editSession = await this.options.edits.getRunnerContext(task.editSessionId!, owner);
    if (!editSession) throw new Error("编辑工作区已不可用，无法进行提交前 Review");
    let repairs = 0;
    for (;;) {
      validate();
      const snapshot = await this.options.edits.getDiff(task.editSessionId!, owner);
      if (!snapshot.changedFiles) throw new Error("助手没有产生代码改动");
      const diffSha = createHash("sha256").update(snapshot.diff, "utf8").digest("hex");
      if (!externalFeedback && task.preReview?.status === "passed" && task.preReview.diffSha === diffSha) return;
      const attempt = repairs + 1;
      const progress = createPreSubmitReviewProgressRecorder({ taskId: task.id, attempt, diffSha, getPhase: () => task.phase, update: (patch) => this.update(task, patch) });
      this.update(task, { status: "running", phase: `正在进行提交前 Review（第 ${attempt} 轮）`, error: null, preReview: progress.initial });
      let parsed;
      try {
        const profile = await loadProfile(task.projectPath);
        const raw = await runner.runPreSubmitReview({ projectPath: task.projectPath, jiraKey: task.jiraKey, jiraTitle: task.title, jiraDescription: task.jiraContext, targetBranch: task.targetBranch, baseSha: editSession.baseSha, diff: snapshot.diff, profile, workspacePath: editSession.workspacePath, externalFeedback }, { signal, onProgress: progress.onProgress });
        validate();
        parsed = parsePreSubmitReviewOutput(raw, profile.rules);
      } catch (error) {
        if (signal.aborted) throw error;
        const message = safeErrorMessage(error, "提交前 Review 执行失败");
        this.update(task, { preReview: InspectionAiPreReviewSchema.parse({ status: "failed", report: null, feedback: message, diffSha, attempt, blockingFindingCount: 0, unmetRequirementCount: 0, missingRequirementCount: 0, unclearRequirementCount: 0, progress: progress.events }), error: `提交前 Review 失败：${message}` });
        throw new Error(`提交前 Review 失败：${message}`, { cause: error });
      }
      const gate = preSubmitReviewGate(parsed);
      const report = renderPreSubmitReviewReport({ jiraKey: task.jiraKey, diffSha, result: parsed });
      const feedback = renderPreSubmitReviewFeedback(parsed);
      this.update(task, { preReview: InspectionAiPreReviewSchema.parse({ status: gate.gate === "passed" ? "passed" : "findings", report, feedback: gate.gate === "passed" ? null : feedback, diffSha, attempt, blockingFindingCount: gate.blockingFindingCount, unmetRequirementCount: gate.unmetRequirementCount, missingRequirementCount: gate.missingRequirementCount, unclearRequirementCount: gate.unclearRequirementCount, progress: progress.events }), error: null, phase: gate.gate === "passed" ? gate.unclearRequirementCount > 0 ? "提交前 Review 已通过，待 Pipeline 验证" : "提交前 Review 已通过" : "提交前 Review 发现问题" });
      if (gate.gate === "passed") return;
      if (repairs >= this.maxPreSubmitRepairAttempts) {
        this.update(task, {
          phase: "提交前 Review 仍有问题，交由 Pipeline 验证",
          error: null,
          syncError: null,
        });
        return;
      }
      repairs += 1;
      const repairPrompt = `请修复当前项目中的代码，解决 Jira 问题并通过提交前 Review。只能修改与当前 Jira 相关的代码，不要修改 CI 配置或无关历史问题。\n\n项目：${task.projectPath}\nJira：${task.jiraKey}\n\nJira 描述和评论：\n${task.jiraContext}\n\n提交前 Review 反馈：\n${feedback}\n\n请逐条核对反馈后直接完成必要修改，不要只解释问题。提交、推送和 MR 由系统处理。`;
      await this.runAssistantEdit(task, owner, repairPrompt, `助手正在根据提交前 Review 修复问题（第 ${repairs}/${this.maxPreSubmitRepairAttempts} 轮）`, signal, validate);
      this.update(task, { editCompleted: true });
    }
  }

  private async verifyAndRepair(task: StoredOrdinaryJiraAiTask, owner: string, initialDeps: CheckedDependencies, signal: AbortSignal, validate: () => void): Promise<void> {
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
      deps = await this.repairFromVerification(task, owner, deps, signal, validate, outcome, attempts);
    }
  }

  private async repairFromVerification(task: StoredOrdinaryJiraAiTask, owner: string, deps: CheckedDependencies, signal: AbortSignal, validate: () => void, outcome: Extract<AiVerificationOutcome, { kind: "repair" }>, attempts: number): Promise<CheckedDependencies> {
    const prompt = `请继续修复当前项目中的代码，目标是让同一个 Merge Request 在最新提交上通过目标仓库的 Pipeline 和 Pipeline Review。只能修改与当前 Jira/MR 问题相关的代码，不要修改 CI 配置或无关历史问题。\n\n项目：${task.projectPath}\nJira：${task.jiraKey}\nMR：${task.mr?.iid ?? "未知"}\n当前提交：${outcome.evidence.headSha ?? task.commitSha ?? "未知"}\n问题类型：${outcome.reason === "review" ? "Pipeline Review 机器人评论" : "Pipeline 失败"}\n\n目标仓库针对当前提交产生的真实反馈：\n${outcome.feedback}\n\n请逐条核对代码后直接完成修复，不要只解释问题。提交、推送和 MR 由系统处理。`;
    await this.runAssistantEdit(task, owner, prompt, "助手正在根据 Pipeline 反馈修复代码", signal, validate);
    this.update(task, { editCompleted: true });
    await this.ensurePreSubmitReview(task, owner, signal, validate, outcome.feedback);
    this.update(task, { status: "publishing", phase: "正在发布 Pipeline 验证修复" });
    deps = await this.checkedDependencies(task);
    const email = deps.user.commit_email || deps.user.email;
    if (!email) throw new Error("GitLab 未返回提交邮箱，请完善账号邮箱后重试");
    const expectedRemoteSha = outcome.evidence.headSha ?? task.commitSha;
    if (!expectedRemoteSha) throw new Error("无法确认 MR 当前提交，未继续发布验证修复");
    let newCommitSha: string | null = null;
    await this.options.edits.publish(task.editSessionId!, owner, { branch: task.sourceBranch, title: `修复验证问题 ${task.jiraKey}`, description: outcome.reason === "review" ? "根据目标仓库 Pipeline Review 机器人评论修复代码。" : "根据目标仓库 Pipeline 失败日志修复代码。", expectedRemoteSha, author: { name: deps.user.name || deps.user.username || String(deps.user.id), email }, connection: deps.connection, signal, validate, onCommitted: (commitSha) => { newCommitSha = commitSha; this.update(task, { commitSha, phase: "验证修复已提交，正在启动新的 Pipeline" }); } });
    if (!newCommitSha) throw new Error("发布验证修复后未得到新的提交 SHA");
    this.update(task, { verification: this.makeVerification(task, { headSha: newCommitSha, pipelineId: null, pipelineStatus: null, pipelineWebUrl: null, reviewJobId: null, reviewJobName: null, reviewJobStatus: null, reviewJobWebUrl: null, reviewNoteId: null, reviewStatus: "pending", report: null, feedback: null, repairAttempts: attempts }), status: "pipeline_pending", phase: "验证修复已发布，等待新的 Pipeline", error: null, syncError: null });
    return this.checkedDependencies(task);
  }

  private async waitForVerification(task: StoredOrdinaryJiraAiTask, deps: CheckedDependencies, signal: AbortSignal, validate: () => void, budget: { deadline: number; activeObserved: boolean }): Promise<AiVerificationOutcome> {
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

  private async inspectVerification(task: StoredOrdinaryJiraAiTask, deps: CheckedDependencies, signal: AbortSignal, validate: () => void): Promise<AiVerificationOutcome> {
    return inspectAiVerification({
      task: { mr: task.mr ? { projectId: task.mr.projectId, iid: task.mr.iid } : null, commitSha: task.commitSha, verification: task.verification },
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

  private async findRemoteMr(task: StoredOrdinaryJiraAiTask, gitlab: GitLabClientPort): Promise<GitLabMergeRequestSummary | null> {
    const items = await gitlab.listMergeRequests!({ projectId: task.projectId, sourceBranch: task.sourceBranch, scope: "all", state: "all", page: 1, perPage: 100 });
    return items.find((mr) => mr.projectId === task.projectId && mr.sourceBranch === task.sourceBranch && mr.targetBranch === task.targetBranch) ?? null;
  }

  private refreshMr(task: StoredOrdinaryJiraAiTask, mr: GitLabMergeRequestDetails): void {
    this.update(task, { mr: { ...task.mr, projectId: mr.projectId, iid: mr.iid, webUrl: mr.webUrl, state: mr.state }, commitSha: task.commitSha ?? mr.headSha, syncedAt: new Date().toISOString(), syncError: null });
  }

  private mrMetadata(task: StoredOrdinaryJiraAiTask, mr: GitLabMergeRequestSummary | GitLabMergeRequestDetails) {
    const previous = task.mr;
    const changedPaths = "changes" in mr
      ? [...new Set(mr.changes.flatMap((change) => [change.oldPath, change.newPath].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim())))].sort()
      : previous?.changedPaths ?? [];
    return {
      projectId: mr.projectId,
      iid: mr.iid,
      webUrl: mr.webUrl,
      state: mr.state,
      mergeCommitSha: mr.mergeCommitSha ?? previous?.mergeCommitSha ?? null,
      squashCommitSha: mr.squashCommitSha ?? previous?.squashCommitSha ?? null,
      mergeBaseSha: mr.mergeBaseSha ?? previous?.mergeBaseSha ?? null,
      mergedAt: mr.mergedAt ?? previous?.mergedAt ?? null,
      changedPaths,
    };
  }

  private async applyMr(task: StoredOrdinaryJiraAiTask, mr: GitLabMergeRequestSummary | GitLabMergeRequestDetails): Promise<void> {
    const status = mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "mr_open";
    const preservePhase = ["pipeline_pending", "review_pending", "review_fixing"].includes(task.status);
    const preserveFailure = task.status === "failed" && Boolean(task.mr);
    const nextStatus = status === "merged" || status === "closed" ? status : preservePhase || preserveFailure ? task.status : "pipeline_pending";
    this.update(task, { mr: this.mrMetadata(task, mr), status: nextStatus, phase: status === "merged" ? "MR 已合并" : status === "closed" ? "MR 已关闭" : preservePhase || preserveFailure ? task.phase : "MR 已创建，等待 Pipeline 验证", error: preserveFailure ? task.error : null, syncError: null, syncedAt: new Date().toISOString() });
  }

  private syncMrMetadata(task: StoredOrdinaryJiraAiTask, mr: GitLabMergeRequestDetails): void {
    const status = mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : null;
    const passedForCurrentCommit = status === null
      && task.verification?.reviewStatus === "passed"
      && task.verification.pipelineStatus?.trim().toLowerCase() === "success"
      && Boolean(task.verification.headSha)
      && task.verification.headSha === mr.headSha
      && (!task.commitSha || task.commitSha === mr.headSha);
    const patch: Partial<StoredOrdinaryJiraAiTask> = {
      mr: this.mrMetadata(task, mr),
      syncError: null,
      syncedAt: new Date().toISOString(),
    };
    if (status) {
      Object.assign(patch, { status, phase: status === "merged" ? "MR 已合并" : "MR 已关闭", error: null });
    } else if (passedForCurrentCommit) {
      Object.assign(patch, { status: "mr_open", phase: "Pipeline 与 Pipeline Review 均已通过，等待维护人员审阅", error: null });
    }
    this.update(task, patch);
  }

  private async sync(task: StoredOrdinaryJiraAiTask): Promise<void> {
    if (!task.mr || !this.options.dependencies) return;
    const running = this.syncing.get(task.id);
    if (running) return running;
    const work = (async () => {
      try {
        const deps = await this.options.dependencies(task.identity);
        if (!deps.gitlab.getMergeRequestDetails) return;
        const detail = await deps.gitlab.getMergeRequestDetails(task.mr!.projectId, task.mr!.iid);
        this.syncMrMetadata(task, detail);
      } catch (error) {
        this.update(task, { syncError: safeErrorMessage(error, "MR 状态暂时无法同步"), syncedAt: new Date().toISOString() });
      }
    })();
    this.syncing.set(task.id, work);
    try { await work; } finally { this.syncing.delete(task.id); }
  }

  private async syncAll(): Promise<void> {
    for (const task of this.tasks.values()) if (task.mr && !this.active.has(task.id)) await this.sync(task);
  }

  private prunePrechecks(): void {
    const now = Date.now();
    for (const [key, value] of this.prechecks) if (value.expiresAt <= now) this.prechecks.delete(key);
  }
}
