import { createHash, randomUUID } from "node:crypto";
import {
  GitLabCreateMergeRequestInputSchema,
  InspectionAiConcurrencySchema,
  INSPECTION_AI_CONCURRENCY_DEFAULT,
  InspectionAiPreReviewSchema,
  type InspectionAiResolutionStatus,
  type InspectionAiReprocessResponse,
  InspectionAiTaskSchema,
  type InspectionAiVerification,
  type InspectionAiTaskDetail,
} from "./api-contracts.js";
import type { AssistantEditService } from "./assistant-edit-service.js";
import type { AssistantExecutionManager } from "./assistant-execution.js";
import type { AssistantStore } from "./assistant-store.js";
import type { GitLabClientPort, GitLabCurrentUser } from "./gitlab-client.js";
import type { GitLabConnection } from "./gitlab-connection.js";
import type { GitLabMergeRequestSummary } from "./gitlab-workbench.js";
import type { InspectionExecutionIdentity, InspectionJiraSource, InspectionService } from "./inspection-service.js";
import type { PreSubmitReviewRunner, ReviewProfile } from "./contracts.js";
import type { GitLabReviewDecisionRunner } from "./gitlab-review-decision.js";
import type { JiraClientPort } from "./jira-client.js";
import { InspectionAiStore, type StoredInspectionAiTask } from "./inspection-ai-store.js";
import { safeErrorMessage } from "./errors.js";
import { ensureGitLabDraftTitle } from "./gitlab-mr-title.js";
import { createPreSubmitReviewProgressRecorder } from "./pre-submit-review-progress.js";
import {
  buildDefaultMergeRequestDescription,
  ensureMergeRequestTitleJiraKey,
  normalizeMergeRequestDescription,
  type ManagedPromptRunner,
  type MergeRequestDescriptionPromptInput,
} from "./prompt-generation.js";
import {
  parsePreSubmitReviewOutput,
  preSubmitReviewGate,
  renderPreSubmitReviewFeedback,
  renderPreSubmitReviewReport,
} from "./review-prompt.js";
import { shortenInspectionFindingTitle } from "./inspection-title.js";
import {
  DEFAULT_INSPECTION_AI_REVIEW_JOB_NAMES,
  INSPECTION_AI_MAX_PRE_SUBMIT_REPAIR_ATTEMPTS,
  INSPECTION_AI_VERIFICATION_POLL_INTERVAL_MS,
  INSPECTION_AI_VERIFICATION_TIMEOUT_MS,
  failureTracesMatch,
  abortableDelay,
  isActiveVerification,
  inspectAiVerification,
  retryTransientGitLabRead,
  type AiVerificationOutcome,
} from "./inspection-ai-verification.js";
import type { GitLabMergeRequestDetails, GitLabPipelineJob, GitLabPipelineSummary } from "./gitlab-workbench.js";

interface Dependencies { gitlab: GitLabClientPort; jira: JiraClientPort | null; connection: GitLabConnection }
interface CheckedDependencies extends Dependencies { user: GitLabCurrentUser }
interface Options {
  store: InspectionAiStore;
  inspection: Pick<InspectionService, "getRun" | "findJiraSource" | "markFindingAiResolution">;
  edits: AssistantEditService;
  assistant: AssistantStore;
  execution: AssistantExecutionManager;
  validateIdentity: (identity: InspectionExecutionIdentity) => void;
  dependencies: (identity: InspectionExecutionIdentity) => Promise<Dependencies>;
  promptRunner?: ManagedPromptRunner;
  preSubmitReview?: PreSubmitReviewRunner;
  reviewDecisionRunner: GitLabReviewDecisionRunner;
  reviewProfile?: (projectPath: string) => Promise<ReviewProfile>;
  syncIntervalMs?: number;
  concurrency?: number;
  verificationPollIntervalMs?: number;
  verificationTimeoutMs?: number;
  maxPreSubmitRepairAttempts?: number;
  reviewJobNames?: readonly string[];
}
const BUSY = new Set(["preparing", "running", "publishing", "review_fixing"]);
const RESUMABLE_VERIFICATION = new Set(["pipeline_pending", "review_pending"]);
const INSPECTION_AI_MERGE_REQUEST_LABEL = "ai-created";
export class InspectionAiConflictError extends Error {
  constructor() {
    super("该 Jira 已有 AI 处理任务，请勿重复处理。");
    this.name = "InspectionAiConflictError";
  }
}

export class InspectionAiService {
  private readonly tasks: Map<string, StoredInspectionAiTask>;
  private readonly concurrency: number;
  private readonly verificationPollIntervalMs: number;
  private readonly verificationTimeoutMs: number;
  private readonly maxPreSubmitRepairAttempts: number;
  private readonly reviewJobNames: readonly string[];
  private readonly queue: string[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly syncing = new Map<string, Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(private readonly options: Options) {
    this.concurrency = InspectionAiConcurrencySchema.parse(options.concurrency ?? INSPECTION_AI_CONCURRENCY_DEFAULT);
    this.verificationPollIntervalMs = Math.max(0, options.verificationPollIntervalMs ?? INSPECTION_AI_VERIFICATION_POLL_INTERVAL_MS);
    this.verificationTimeoutMs = Math.max(1_000, options.verificationTimeoutMs ?? INSPECTION_AI_VERIFICATION_TIMEOUT_MS);
    this.maxPreSubmitRepairAttempts = Math.max(0, options.maxPreSubmitRepairAttempts ?? INSPECTION_AI_MAX_PRE_SUBMIT_REPAIR_ATTEMPTS);
    this.reviewJobNames = options.reviewJobNames?.length ? options.reviewJobNames : DEFAULT_INSPECTION_AI_REVIEW_JOB_NAMES;
    this.tasks = new Map(options.store.list().map((task) => [task.id, task]));
    for (const task of this.tasks.values()) {
      if (task.status === "merged") {
        this.markFindingAiResolution(task, task.resolution?.status === "reverted" ? "reverted" : "merged");
      }
      if (BUSY.has(task.status)) {
        if (task.assistantRunId) options.execution.cancel(task.assistantRunId);
        this.update(task, { status: "failed", phase: "执行中断", error: "服务重启中断了处理，可从现有改动继续重试" });
      } else if (RESUMABLE_VERIFICATION.has(task.status) && task.mr) {
        this.update(task, { status: "queued", phase: "服务已恢复，继续验证 MR", error: null, syncError: null });
      }
    }
    this.timer = setInterval(() => { void this.syncAll(); }, options.syncIntervalMs ?? 60_000);
    this.timer.unref();
    for (const task of this.tasks.values()) {
      if (task.status === "merged" && task.mr) void this.sync(task);
    }
    for (const task of [...this.tasks.values()].filter((item) => item.status === "queued").sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      this.enqueue(task);
    }
  }

  private context(runId: string, findingId: string, identity: InspectionExecutionIdentity) {
    this.options.validateIdentity(identity);
    const run = this.options.inspection.getRun(runId, identity);
    const finding = run?.result && [...run.result.findings, ...run.result.ruleResults.flatMap((rule) => rule.findings)].find((item) => item.id === findingId);
    if (!run || !finding?.jira?.key) throw new Error("巡检问题或关联的 Jira 不存在");
    if (run.maintainerId !== identity.maintainerId) throw new Error("请登录此巡检记录的维护人员账号");
    return { run, finding, key: finding.jira.key };
  }
  find(runId: string, findingId: string, identity: InspectionExecutionIdentity) {
    const { run, key } = this.context(runId, findingId, identity);
    const task = [...this.tasks.values()].find((item) => item.maintainerId === identity.maintainerId
      && item.projectId === run.projectId && item.targetBranch === run.branch && item.jiraKey === key);
    return task ? InspectionAiTaskSchema.parse(task) : null;
  }
  findJiraSource(jiraKey: string, identity: InspectionExecutionIdentity): InspectionJiraSource | null {
    this.options.validateIdentity(identity);
    return this.options.inspection.findJiraSource(jiraKey, identity);
  }
  start(runId: string, findingId: string, identity: InspectionExecutionIdentity) {
    if (this.closing) throw new Error("服务正在关闭");
    const { run, key } = this.context(runId, findingId, identity);
    const existing = this.find(runId, findingId, identity);
    if (existing) {
      if (!this.options.store.claimJira(existing.jiraKey, existing.id, identity.maintainerId!)) throw new InspectionAiConflictError();
      return existing;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const task: StoredInspectionAiTask = {
      id, identity: { ...identity }, maintainerId: identity.maintainerId!, jiraKey: key,
      title: "", description: "", jiraUrl: "", projectId: run.projectId, projectPath: run.projectPath,
      targetBranch: run.branch, sourceBranch: `ai/inspection-${key.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${id.slice(0, 12)}`,
      status: "queued", phase: "已进入 AI 处理队列", createdAt: now, updatedAt: now,
      editSessionId: null, assistantRunId: null, commitSha: null, mr: null, error: null, syncedAt: null, syncError: null,
      preReview: null, verification: null, resolution: null, gitlabUserId: null, gitlabApiBaseUrl: null, conversationId: randomUUID(), editCompleted: false,
    };
    if (!this.options.store.claimJira(task.jiraKey, task.id, task.maintainerId)) throw new InspectionAiConflictError();
    try {
      this.options.store.save(task);
    } catch (error) {
      this.options.store.releaseJiraClaim(task.jiraKey, task.id);
      throw error;
    }
    this.tasks.set(id, task);
    this.enqueue(task);
    return InspectionAiTaskSchema.parse(task);
  }
  async detail(id: string, identity: InspectionExecutionIdentity): Promise<InspectionAiTaskDetail> {
    const task = this.authorized(id, identity);
    await this.sync(task);
    return { task: InspectionAiTaskSchema.parse(task),
      execution: task.assistantRunId ? this.options.assistant.getRun(task.assistantRunId, 0, this.owner(task)) : null,
      executions: this.options.assistant.listRuns(task.conversationId, this.owner(task)),
      editSession: task.editSessionId ? await this.options.edits.getSession(task.editSessionId, this.owner(task)) : null };
  }
  async reprocess(id: string, identity: InspectionExecutionIdentity): Promise<InspectionAiReprocessResponse> {
    const task = this.authorized(id, identity);
    if (this.closing) throw new Error("服务正在关闭");
    if (task.status !== "merged" || !task.mr) throw new Error("只有已合并的 MR 可以 AI 重新处理");
    await this.sync(task);
    if (task.status !== "merged" || !task.mr) throw new Error("当前 MR 已不再是已合并状态，无法 AI 重新处理");
    const deps = await this.checkedDependencies(task);
    const resolutionStatus = await this.syncMergedResolution(task, deps.gitlab);
    if (resolutionStatus === "reverted") {
      return { task: this.retry(id, identity), action: "restarted" as const, resolutionStatus };
    }
    return { task: InspectionAiTaskSchema.parse(task), action: "skipped" as const, resolutionStatus };
  }
  retry(id: string, identity: InspectionExecutionIdentity) {
    const task = this.authorized(id, identity);
    if (this.closing) throw new Error("服务正在关闭");
    if (this.active.has(id) || task.status === "queued") return InspectionAiTaskSchema.parse(task);
    const rerunAfterRollback = task.status === "merged" && task.resolution?.status === "reverted";
    if (!["failed", "canceled"].includes(task.status) && !rerunAfterRollback) throw new Error("当前任务不能重试");
    if (!this.options.store.claimJira(task.jiraKey, task.id, identity.maintainerId!)) throw new InspectionAiConflictError();
    const verification = task.verification ? { ...task.verification, reviewStatus: "pending" as const, report: null, feedback: null, reviewNoteId: null, repairAttempts: 0 } : null;
    if (rerunAfterRollback) {
      this.update(task, { identity: { ...identity }, status: "queued", phase: "修复已回滚，重新进入 AI 处理队列", error: null, syncError: null,
        sourceBranch: `ai/inspection-${task.jiraKey.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${randomUUID().slice(0, 12)}`,
        editSessionId: null, assistantRunId: null, commitSha: null, mr: null, preReview: null, verification: null, resolution: null,
        conversationId: randomUUID(), editCompleted: false });
    } else {
      this.update(task, { identity: { ...identity }, status: "queued", phase: task.mr ? "已重新进入 MR 验证队列" : task.editSessionId ? "已保留现有工作区，重新进入 AI 处理队列" : "已重新进入 AI 处理队列", error: null,
        syncError: null, preReview: task.mr ? task.preReview : null, verification, assistantRunId: null });
    }
    this.enqueue(task);
    return InspectionAiTaskSchema.parse(task);
  }
  cancel(id: string, identity: InspectionExecutionIdentity) {
    const task = this.authorized(id, identity);
    if (task.status === "queued") {
      this.queuedIds.delete(id);
      this.update(task, { status: "canceled", phase: "已停止", error: "已停止 AI 处理" });
      this.pump();
      return InspectionAiTaskSchema.parse(task);
    }
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new Error("已停止 AI 处理"));
      if (task.assistantRunId) this.options.execution.cancel(task.assistantRunId);
      this.update(task, { phase: "正在停止，请稍候" });
    }
    return InspectionAiTaskSchema.parse(task);
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    for (const [id, active] of this.active) {
      active.controller.abort();
      const task = this.tasks.get(id)!;
      if (task.assistantRunId) this.options.execution.cancel(task.assistantRunId);
    }
    await Promise.allSettled([...this.active.values()].map((item) => item.promise));
    await Promise.allSettled([...this.syncing.values()]);
  }
  private authorized(id: string, identity: InspectionExecutionIdentity) {
    this.options.validateIdentity(identity);
    const task = this.tasks.get(id);
    if (!task || task.maintainerId !== identity.maintainerId) throw new Error("AI 任务不存在或不属于当前维护人员");
    return task;
  }
  private owner(task: StoredInspectionAiTask) { return `inspection:${task.maintainerId}`; }
  private update(task: StoredInspectionAiTask, patch: Partial<StoredInspectionAiTask>) {
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.options.store.save(task);
  }
  private enqueue(task: StoredInspectionAiTask) {
    if (this.closing || task.status !== "queued" || this.active.has(task.id) || this.queuedIds.has(task.id)) return;
    this.queue.push(task.id);
    this.queuedIds.add(task.id);
    this.pump();
  }
  private pump() {
    if (this.closing) return;
    while (this.active.size < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.queuedIds.delete(id);
      const task = this.tasks.get(id);
      if (!task || task.status !== "queued") continue;
      const active = { controller: new AbortController(), promise: Promise.resolve() };
      this.active.set(task.id, active);
      this.update(task, { status: "preparing", phase: task.editSessionId ? "正在恢复已有工作区并继续处理" : "正在读取 Jira 和准备工作区" });
      active.promise = this.execute(task, active.controller.signal).finally(() => {
        this.active.delete(task.id);
        this.pump();
      });
    }
  }
  private async checkedDependencies(task: StoredInspectionAiTask): Promise<CheckedDependencies> {
    this.options.validateIdentity(task.identity);
    const deps = await this.options.dependencies(task.identity);
    const user = await deps.gitlab.getCurrentUser?.();
    this.options.validateIdentity(task.identity);
    if (!user?.id) throw new Error("无法确认维护人员的 GitLab 身份，请重新连接");
    if (task.gitlabUserId && (task.gitlabUserId !== String(user.id) || task.gitlabApiBaseUrl !== deps.connection.apiBaseUrl)) {
      throw new Error("维护人员的 GitLab 连接已更换，请恢复此任务使用的账号后重试");
    }
    if (!deps.gitlab.createMergeRequest || !deps.gitlab.listMergeRequests || !deps.gitlab.getMergeRequestDetails
      || !deps.gitlab.listPipelines || !deps.gitlab.listPipelineJobs || !deps.gitlab.getPipelineJobTrace) {
      throw new Error("GitLab 不支持创建 MR 或读取 Pipeline Review 结果");
    }
    return { ...deps, user };
  }
  private async execute(task: StoredInspectionAiTask, signal: AbortSignal) {
    const ownerKey = this.owner(task);
    const validate = () => { signal.throwIfAborted(); this.options.validateIdentity(task.identity); };
    try {
      let deps = await this.checkedDependencies(task);
      validate();
      if (!task.gitlabUserId) {
        if (!deps.jira) throw new Error("请先连接维护人员的 Jira 账号");
        const issue = await deps.jira.getIssue(task.jiraKey);
        validate();
        const title = ensureMergeRequestTitleJiraKey(shortenInspectionFindingTitle(issue.summary.replace(/[\r\n]+/g, " ")), issue.key);
        this.update(task, { title, description: issue.description ?? "", jiraUrl: issue.webUrl,
          gitlabUserId: String(deps.user.id), gitlabApiBaseUrl: deps.connection.apiBaseUrl });
      }
      if (!task.editSessionId) {
        const session = await this.options.edits.createSession({ ownerKey, projectId: task.projectId,
          projectPath: task.projectPath, baseRef: task.targetBranch }, deps.connection, { signal });
        this.update(task, { editSessionId: session.id });
        await this.options.edits.setRetentionMode(session.id, ownerKey, "pinned");
      }
      validate();
      if (!task.mr) {
        if (!task.editCompleted && !task.commitSha) {
          const prompt = `请在当前项目中解决以下 Jira 问题，直接使用助手现有的代码编辑工具完成修改。\n项目：${task.projectPath}\n目标分支：${task.targetBranch}\nJira：${task.jiraKey}\n标题：${task.title}\n\n以下是 Jira 描述数据：\n${task.description}\n\n请先核对代码中是否存在该问题，保留已有正确改动。结束时说明实际修改、验证和限制。提交、推送和 MR 由系统在你完成后处理。`;
          await this.runAssistantEdit(task, ownerKey, prompt, "助手正在分析和修改代码", signal, validate);
          this.update(task, { editCompleted: true });
        }
        if (!task.commitSha) {
          await this.ensurePreSubmitReview(task, ownerKey, signal, validate);
        }
        this.update(task, { status: "publishing", phase: "正在提交代码并创建 MR" });
        deps = await this.checkedDependencies(task);
        validate();
        // Recover an MR whose creation succeeded remotely before a response or restart was observed.
        const existing = await this.findRemoteMr(task, deps.gitlab);
        if (existing) {
          await this.applyMr(task, existing, deps.gitlab);
        } else {
          const email = deps.user.commit_email || deps.user.email;
          if (!email) throw new Error("GitLab 未返回提交邮箱，请完善维护人员 GitLab 账号的邮箱后重试");
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
            commitMessage: task.description,
            jiraDescription: task.description,
          };
          let mrDescription = buildDefaultMergeRequestDescription(mrPromptInput);
          if (this.options.promptRunner) {
            try {
              mrDescription = normalizeMergeRequestDescription(
                await this.options.promptRunner.generateMergeRequestDescription(mrPromptInput, { signal, ownerId: task.maintainerId }),
                mrPromptInput,
              );
            } catch (error) {
              this.update(task, { error: `MR 描述提示词生成失败，已使用内置规范：${safeErrorMessage(error, "无法生成 MR 描述")}` });
            }
          }
          validate();
          this.update(task, { title: mrTitle });
          await this.options.edits.publish(task.editSessionId!, ownerKey, {
            branch: task.sourceBranch, title: mrTitle, description: mrDescription,
            author: { name: deps.user.name || deps.user.username || String(deps.user.id), email },
            connection: deps.connection, signal, validate,
            onCommitted: (commitSha) => this.update(task, { commitSha, phase: "代码已提交，正在发布分支和 MR" }),
          });
          deps = await this.checkedDependencies(task);
          validate();
          const mr = await deps.gitlab.createMergeRequest!(GitLabCreateMergeRequestInputSchema.parse({
            targetProjectId: task.projectId, sourceProjectId: task.projectId,
            sourceBranch: task.sourceBranch, targetBranch: task.targetBranch, title: draftMrTitle,
            description: mrDescription,
            assigneeIds: [task.gitlabUserId!],
            labels: [INSPECTION_AI_MERGE_REQUEST_LABEL],
          }));
          // Always retain an acknowledged remote side effect, including when cancellation races with it.
          await this.applyMr(task, mr, deps.gitlab);
        }
      }
      if (task.mr) deps = await this.recoverPendingRepairPublication(task, ownerKey, deps, signal, validate);
      await this.verifyAndRepair(task, ownerKey, deps, signal, validate);
    } catch (error) {
      this.update(task, { status: signal.aborted ? "canceled" : "failed", phase: signal.aborted ? "已停止" : task.mr && task.verification ? task.phase : "处理失败",
        error: signal.aborted ? "已停止 AI 处理，已有改动和发布记录已保留" : safeErrorMessage(error, "AI 处理失败") });
    } finally {
      if (task.mr && task.editSessionId) await this.options.edits.setRetentionMode(task.editSessionId, ownerKey, "auto").catch(() => undefined);
    }
  }
  private makeVerification(task: StoredInspectionAiTask, patch: Partial<InspectionAiVerification> = {}): InspectionAiVerification {
    const current = task.verification ?? null;
    return {
      headSha: patch.headSha !== undefined ? patch.headSha : current?.headSha ?? null,
      pipelineId: patch.pipelineId !== undefined ? patch.pipelineId : current?.pipelineId ?? null,
      pipelineStatus: patch.pipelineStatus !== undefined ? patch.pipelineStatus : current?.pipelineStatus ?? null,
      pipelineWebUrl: patch.pipelineWebUrl !== undefined ? patch.pipelineWebUrl : current?.pipelineWebUrl ?? null,
      reviewJobId: patch.reviewJobId !== undefined ? patch.reviewJobId : current?.reviewJobId ?? null,
      reviewJobName: patch.reviewJobName !== undefined ? patch.reviewJobName : current?.reviewJobName ?? null,
      reviewJobStatus: patch.reviewJobStatus !== undefined ? patch.reviewJobStatus : current?.reviewJobStatus ?? null,
      reviewJobWebUrl: patch.reviewJobWebUrl !== undefined ? patch.reviewJobWebUrl : current?.reviewJobWebUrl ?? null,
      reviewNoteId: patch.reviewNoteId !== undefined ? patch.reviewNoteId : current?.reviewNoteId ?? null,
      reviewStatus: patch.reviewStatus !== undefined ? patch.reviewStatus : current?.reviewStatus ?? "pending",
      report: patch.report !== undefined ? patch.report : current?.report ?? null,
      feedback: patch.feedback !== undefined ? patch.feedback : current?.feedback ?? null,
      repairAttempts: patch.repairAttempts !== undefined ? patch.repairAttempts : current?.repairAttempts ?? 0,
    };
  }
  private setVerification(task: StoredInspectionAiTask, patch: Partial<InspectionAiVerification>, status: StoredInspectionAiTask["status"], phase: string): InspectionAiVerification {
    const verification = this.makeVerification(task, patch);
    this.update(task, { verification, status, phase, error: null, syncError: null, syncedAt: new Date().toISOString() });
    return verification;
  }
  private async runAssistantEdit(task: StoredInspectionAiTask, ownerKey: string, prompt: string, phase: string, signal: AbortSignal, validate: () => void): Promise<void> {
    const editSession = await this.options.edits.getRunnerContext(task.editSessionId!, ownerKey);
    if (!editSession) throw new Error("编辑工作区已不可用，无法继续处理");
    const message = { id: randomUUID(), role: "user" as const, content: prompt, createdAt: new Date().toISOString() };
    this.options.assistant.appendMessage(task.conversationId, message, task.title, ownerKey);
    const { run } = this.options.execution.createRun(task.conversationId, message.id);
    this.update(task, { assistantRunId: run.id, status: "running", phase });
    validate();
    await this.options.execution.start(run, { messages: [message], editSession,
      runtimeContext: { editSession, validateWrite: validate, productUsername: ownerKey,
        getGitLabClient: async () => { validate(); return (await this.checkedDependencies(task)).gitlab; },
        getJiraClient: async () => { validate(); return (await this.checkedDependencies(task)).jira; } } });
    validate();
    const result = this.options.assistant.getRun(run.id);
    if (result?.status !== "completed") throw new Error(result?.error || "助手未完成代码修改");
    if (!(await this.options.edits.getDiff(task.editSessionId!, ownerKey)).changedFiles) throw new Error("助手没有产生代码改动");
  }
  private async ensurePreSubmitReview(task: StoredInspectionAiTask, ownerKey: string, signal: AbortSignal, validate: () => void, externalFeedback: string | null = null): Promise<void> {
    const runner = this.options.preSubmitReview;
    const loadProfile = this.options.reviewProfile;
    if (!runner || !loadProfile) throw new Error("提交前 Review 能力未配置，未允许发布代码");
    const editSession = await this.options.edits.getRunnerContext(task.editSessionId!, ownerKey);
    if (!editSession) throw new Error("编辑工作区已不可用，无法进行提交前 Review");
    let repairAttempts = 0;
    for (;;) {
      validate();
      const snapshot = await this.options.edits.getDiff(task.editSessionId!, ownerKey);
      if (!snapshot.changedFiles) throw new Error("助手没有产生代码改动");
      const diffSha = createHash("sha256").update(snapshot.diff, "utf8").digest("hex");
      if (!externalFeedback && task.preReview?.status === "passed" && task.preReview.diffSha === diffSha) return;
      const attempt = repairAttempts + 1;
      const progress = createPreSubmitReviewProgressRecorder({ taskId: task.id, attempt, diffSha, getPhase: () => task.phase, update: (patch) => this.update(task, patch) });
      this.update(task, {
        status: "running",
        phase: `正在进行提交前 Review（第 ${attempt} 轮）`,
        error: null,
        preReview: progress.initial,
      });
      let parsed;
      try {
        const profile = await loadProfile(task.projectPath);
        validate();
        const raw = await runner.runPreSubmitReview({
          projectPath: task.projectPath,
          jiraKey: task.jiraKey,
          jiraTitle: task.title,
          jiraDescription: task.description,
          targetBranch: task.targetBranch,
          baseSha: editSession.baseSha,
          diff: snapshot.diff,
          profile,
          workspacePath: editSession.workspacePath,
          externalFeedback,
        }, {
          signal,
          ownerId: task.maintainerId,
          onProgress: progress.onProgress,
        });
        validate();
        parsed = parsePreSubmitReviewOutput(raw, profile.rules);
      } catch (error) {
        if (signal.aborted) throw error;
        const message = safeErrorMessage(error, "提交前 Review 执行失败");
        this.update(task, {
          preReview: InspectionAiPreReviewSchema.parse({
            status: "failed", report: null, feedback: message, diffSha, attempt,
            blockingFindingCount: 0, unmetRequirementCount: 0, missingRequirementCount: 0, unclearRequirementCount: 0, progress: progress.events,
          }),
          error: `提交前 Review 失败：${message}`,
        });
        throw new Error(`提交前 Review 失败：${message}`, { cause: error });
      }
      const gate = preSubmitReviewGate(parsed);
      const report = renderPreSubmitReviewReport({ jiraKey: task.jiraKey, diffSha, result: parsed });
      const feedback = renderPreSubmitReviewFeedback(parsed);
      this.update(task, {
        preReview: {
          status: gate.gate === "passed" ? "passed" : "findings",
          report,
          feedback: gate.gate === "passed" ? null : feedback,
          diffSha,
          attempt,
          blockingFindingCount: gate.blockingFindingCount,
          unmetRequirementCount: gate.unmetRequirementCount,
          missingRequirementCount: gate.missingRequirementCount,
          unclearRequirementCount: gate.unclearRequirementCount,
          progress: progress.events,
        },
        error: null,
        syncError: null,
        phase: gate.gate === "passed" ? gate.unclearRequirementCount > 0 ? "提交前 Review 已通过，待 Pipeline 验证" : "提交前 Review 已通过" : "提交前 Review 发现问题",
      });
      if (gate.gate === "passed") return;
      if (repairAttempts >= this.maxPreSubmitRepairAttempts) {
        this.update(task, {
          phase: "提交前 Review 仍有问题，交由 Pipeline 验证",
          error: null,
          syncError: null,
        });
        return;
      }
      repairAttempts += 1;
      this.update(task, {
        status: "running",
        phase: `正在根据提交前 Review 修复问题（第 ${repairAttempts}/${this.maxPreSubmitRepairAttempts} 轮）`,
      });
      const repairPrompt = `请修复当前项目中的代码，解决 Jira 问题并通过提交前 Review。只能修改与当前 Jira 相关的代码，不要修改 CI 配置或无关历史问题。

项目：${task.projectPath}
Jira：${task.jiraKey}
标题：${task.title}

Jira 描述：
${task.description}

提交前 Review 反馈：
${feedback}
${externalFeedback ? `
此前的 Pipeline 或 Pipeline Review 反馈：
${externalFeedback}
` : ""}
请逐条核对反馈后直接使用现有代码编辑工具完成修复。不要只解释问题；结束时说明实际修改和未能验证的内容，提交、推送和 MR 由系统处理。`;
      await this.runAssistantEdit(task, ownerKey, repairPrompt, `助手正在根据提交前 Review 修复问题（第 ${repairAttempts}/${this.maxPreSubmitRepairAttempts} 轮）`, signal, validate);
      this.update(task, { editCompleted: true });
    }
  }
  private async recoverPendingRepairPublication(task: StoredInspectionAiTask, ownerKey: string, deps: CheckedDependencies, signal: AbortSignal, validate: () => void): Promise<CheckedDependencies> {
    if (!task.commitSha || !task.verification?.repairAttempts) return deps;
    const detail = await deps.gitlab.getMergeRequestDetails!(task.mr!.projectId, task.mr!.iid);
    validate();
    if (!detail.headSha || detail.headSha === task.commitSha) return deps;
    const email = deps.user.commit_email || deps.user.email;
    if (!email) throw new Error("GitLab 未返回提交邮箱，请完善维护人员 GitLab 账号的邮箱后重试");
    const expectedRemoteSha = detail.headSha;
    const fixTitle = `修复验证问题 ${task.jiraKey}`;
    const fixMessage = task.verification.reviewStatus === "findings"
      ? "根据目标仓库 Pipeline Review 机器人评论修复代码。"
      : "根据目标仓库 Pipeline 失败日志修复代码。";
    let recoveredSha: string | null = null;
    await this.options.edits.publish(task.editSessionId!, ownerKey, {
      branch: task.sourceBranch, title: fixTitle, description: fixMessage, expectedRemoteSha,
      author: { name: deps.user.name || deps.user.username || String(deps.user.id), email },
      connection: deps.connection, signal, validate,
      onCommitted: (commitSha) => { recoveredSha = commitSha; this.update(task, { commitSha, phase: "正在恢复已提交的验证修复" }); },
    });
    if (recoveredSha !== task.commitSha) throw new Error("恢复验证修复时提交 SHA 不一致，已停止发布");
    return await this.checkedDependencies(task);
  }
  private async verifyAndRepair(task: StoredInspectionAiTask, ownerKey: string, initialDeps: CheckedDependencies, signal: AbortSignal, validate: () => void): Promise<void> {
    const budget = { deadline: Date.now() + this.verificationTimeoutMs, activeObserved: false };
    let deps = initialDeps;
    for (;;) {
      const outcome = await this.waitForVerification(task, deps, signal, validate, budget);
      if (outcome.kind === "terminal" || outcome.kind === "passed") return;
      if (outcome.kind === "pending") continue;
      if (outcome.kind === "blocked") throw new Error(outcome.error);
      const repairAttempts = (task.verification?.repairAttempts ?? 0) + 1;
      if (!budget.activeObserved && Date.now() >= budget.deadline) {
        const message = outcome.reason === "review"
          ? "Pipeline Review 反馈已返回，但整体验证已超时，未继续开启下一轮修复"
          : "Pipeline 失败反馈已返回，但整体验证已超时，未继续开启下一轮修复";
        this.update(task, { status: "failed", phase: "验证超时", error: message,
          verification: this.makeVerification(task, { ...outcome.evidence, reviewStatus: "failed", feedback: outcome.feedback }) });
        throw new Error(message);
      }
      this.update(task, { status: "review_fixing", phase: outcome.reason === "review"
        ? `正在根据 Pipeline Review 修复问题（第 ${repairAttempts} 轮）`
        : `正在根据 Pipeline 失败日志修复问题（第 ${repairAttempts} 轮）`,
      error: null, syncError: null, verification: this.makeVerification(task, {
        ...outcome.evidence, repairAttempts, feedback: outcome.feedback,
      }) });
      deps = await this.repairFromVerification(task, ownerKey, deps, signal, validate, outcome, repairAttempts);
    }
  }
  private async repairFromVerification(task: StoredInspectionAiTask, ownerKey: string, deps: CheckedDependencies, signal: AbortSignal, validate: () => void, outcome: Extract<AiVerificationOutcome, { kind: "repair" }>, repairAttempts: number): Promise<CheckedDependencies> {
    const prompt = `请继续修复当前项目中的代码，目标是让同一个 Merge Request 在最新提交上通过目标仓库的 Pipeline 和 Pipeline Review。只能修改与当前 Jira/MR 问题相关的代码，不要修改 CI 配置或无关历史问题。

项目：${task.projectPath}
Jira：${task.jiraKey}
MR：${task.mr?.iid ?? "未知"}
当前提交：${outcome.evidence.headSha ?? task.commitSha ?? "未知"}
问题类型：${outcome.reason === "review" ? "Pipeline Review 机器人评论" : "Pipeline 失败"}

下面是目标仓库针对当前提交产生的真实反馈，请逐条核对代码后直接使用现有代码编辑工具修复：
    ${outcome.feedback}

不要只解释问题；必须在工作区完成必要修改。结束时说明实际修改和未能验证的内容，提交、推送和 MR 由系统处理。`;
    await this.runAssistantEdit(task, ownerKey, prompt, "助手正在根据 Pipeline 反馈修复代码", signal, validate);
    this.update(task, { editCompleted: true });
    await this.ensurePreSubmitReview(task, ownerKey, signal, validate, outcome.feedback);
    this.update(task, { status: "publishing", phase: "正在发布 Pipeline 验证修复" });
    deps = await this.checkedDependencies(task);
    validate();
    const email = deps.user.commit_email || deps.user.email;
    if (!email) throw new Error("GitLab 未返回提交邮箱，请完善维护人员 GitLab 账号的邮箱后重试");
    const expectedRemoteSha = outcome.evidence.headSha ?? task.commitSha;
    if (!expectedRemoteSha) throw new Error("无法确认 MR 当前提交，未继续发布验证修复");
    const fixTitle = `修复验证问题 ${task.jiraKey}`;
    const fixMessage = outcome.reason === "review"
      ? "根据目标仓库 Pipeline Review 机器人评论修复代码。"
      : "根据目标仓库 Pipeline 失败日志修复代码。";
    let newCommitSha: string | null = null;
    await this.options.edits.publish(task.editSessionId!, ownerKey, {
      branch: task.sourceBranch, title: fixTitle, description: fixMessage,
      expectedRemoteSha,
      author: { name: deps.user.name || deps.user.username || String(deps.user.id), email },
      connection: deps.connection, signal, validate,
      onCommitted: (commitSha) => { newCommitSha = commitSha; this.update(task, { commitSha, phase: "验证修复已提交，正在启动新的 Pipeline" }); },
    });
    if (!newCommitSha) throw new Error("发布验证修复后未得到新的提交 SHA");
    this.update(task, { verification: this.makeVerification(task, {
      headSha: newCommitSha, pipelineId: null, pipelineStatus: null, pipelineWebUrl: null,
      reviewJobId: null, reviewJobName: null, reviewJobStatus: null, reviewJobWebUrl: null,
      reviewNoteId: null, reviewStatus: "pending", report: null, feedback: null, repairAttempts,
    }), status: "pipeline_pending", phase: "验证修复已发布，等待新的 Pipeline", error: null, syncError: null });
    return await this.checkedDependencies(task);
  }
  private async waitForVerification(task: StoredInspectionAiTask, deps: CheckedDependencies, signal: AbortSignal, validate: () => void, budget: { deadline: number; activeObserved: boolean }): Promise<AiVerificationOutcome> {
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
  private async inspectVerification(task: StoredInspectionAiTask, deps: CheckedDependencies, signal: AbortSignal, validate: () => void): Promise<AiVerificationOutcome> {
    return inspectAiVerification({
      task: { mr: task.mr ? { projectId: task.mr.projectId, iid: task.mr.iid } : null, commitSha: task.commitSha, verification: task.verification },
      gitlab: deps.gitlab,
      reviewJobNames: this.reviewJobNames,
      signal,
      reviewDecisionRunner: this.options.reviewDecisionRunner,
      validate,
      setVerification: (patch, status, phase) => this.setVerification(task, patch, status, phase),
      refreshMr: (mr) => this.refreshMr(task, mr),
      applyMr: (mr) => this.applyMr(task, mr, deps.gitlab),
      findBaselineFailure: (failedJobs, currentTraces) => this.findBaselineFailure(task, deps, failedJobs, currentTraces),
    });
  }
  private async findBaselineFailure(task: StoredInspectionAiTask, deps: CheckedDependencies, failedJobs: GitLabPipelineJob[], currentTraces: Map<string, string | null>): Promise<{ pipeline: GitLabPipelineSummary; job: GitLabPipelineJob } | null> {
    const session = task.editSessionId ? await this.options.edits.getSession(task.editSessionId, this.owner(task)) : null;
    if (!session?.baseSha) return null;
    const pipelines = await deps.gitlab.listPipelines!(task.projectId, { ref: task.targetBranch, page: 1, perPage: 100 }).catch(() => []);
    const baselinePipeline = pipelines.find((pipeline) => pipeline.sha === session.baseSha && pipeline.status?.trim().toLowerCase() === "failed");
    if (!baselinePipeline) return null;
    const baselineJobs = await deps.gitlab.listPipelineJobs!(task.projectId, baselinePipeline.id).catch(() => []);
    for (const failedJob of failedJobs) {
      const baselineJob = baselineJobs.find((job) => job.name === failedJob.name && job.status?.trim().toLowerCase() === "failed");
      if (!baselineJob) continue;
      const currentTrace = currentTraces.get(failedJob.id);
      if (!currentTrace) continue;
      const baselineTrace = await deps.gitlab.getPipelineJobTrace!(task.projectId, baselineJob.id).catch(() => null);
      if (baselineTrace && failureTracesMatch(currentTrace, baselineTrace)) return { pipeline: baselinePipeline, job: baselineJob };
    }
    return null;
  }
  private refreshMr(task: StoredInspectionAiTask, mr: GitLabMergeRequestDetails): void {
    this.update(task, { mr: { ...task.mr, projectId: mr.projectId, iid: mr.iid, webUrl: mr.webUrl, state: mr.state },
      commitSha: task.commitSha ?? mr.headSha, syncedAt: new Date().toISOString(), syncError: null });
  }
  private async findRemoteMr(task: StoredInspectionAiTask, gitlab: GitLabClientPort) {
    const items = await gitlab.listMergeRequests!({ projectId: task.projectId, sourceBranch: task.sourceBranch,
      scope: "all", state: "all", page: 1, perPage: 100 });
    return items.find((mr) => mr.projectId === task.projectId && mr.sourceBranch === task.sourceBranch && mr.targetBranch === task.targetBranch);
  }
  private async applyMr(task: StoredInspectionAiTask, mr: GitLabMergeRequestSummary | GitLabMergeRequestDetails, gitlab?: GitLabClientPort): Promise<void> {
    const status = mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "mr_open";
    const preservePhase = ["pipeline_pending", "review_pending", "review_fixing"].includes(task.status);
    const preserveFailure = task.status === "failed" && Boolean(task.mr);
    const nextStatus = status === "merged" || status === "closed" ? status : preservePhase || preserveFailure ? task.status : "pipeline_pending";
    const previousMr = task.mr;
    const discoveredPaths = "changes" in mr
      ? [...new Set(mr.changes.flatMap((change) => [change.oldPath, change.newPath].filter((path): path is string => Boolean(path?.trim())).map((path) => path.trim())))].sort()
      : [];
    const changedPaths = discoveredPaths.length > 0 ? discoveredPaths : previousMr?.changedPaths ?? [];
    const nextMr = {
      projectId: mr.projectId, iid: mr.iid, webUrl: mr.webUrl, state: mr.state,
      mergeCommitSha: mr.mergeCommitSha ?? previousMr?.mergeCommitSha ?? null,
      squashCommitSha: mr.squashCommitSha ?? previousMr?.squashCommitSha ?? null,
      mergeBaseSha: mr.mergeBaseSha ?? previousMr?.mergeBaseSha ?? null,
      mergedAt: mr.mergedAt ?? previousMr?.mergedAt ?? null,
      changedPaths,
    };
    const metadataChanged = previousMr?.mergeCommitSha !== nextMr.mergeCommitSha
      || previousMr?.squashCommitSha !== nextMr.squashCommitSha
      || previousMr?.mergeBaseSha !== nextMr.mergeBaseSha
      || previousMr?.mergedAt !== nextMr.mergedAt
      || JSON.stringify(previousMr?.changedPaths ?? []) !== JSON.stringify(changedPaths);
    this.update(task, { mr: nextMr, status: nextStatus,
      phase: status === "merged" ? "MR 已合并" : status === "closed" ? "MR 已关闭" : preservePhase || preserveFailure ? task.phase : "MR 已创建，等待 Pipeline 验证",
      error: null, syncError: null, syncedAt: new Date().toISOString(), resolution: status === "merged" && !metadataChanged ? task.resolution ?? null : null });
    if (status === "merged") this.markFindingAiResolution(task, "merged");
  }

  private markFindingAiResolution(task: StoredInspectionAiTask, status: "merged" | "reverted" | "unknown"): void {
    try {
      this.options.inspection.markFindingAiResolution(task.identity, task.jiraKey, status);
    } catch (error) {
      this.update(task, { syncError: safeErrorMessage(error, "巡检问题状态暂时无法同步") });
    }
  }

  private async syncMergedResolution(task: StoredInspectionAiTask, gitlab?: GitLabClientPort): Promise<InspectionAiResolutionStatus> {
    const checkedAt = new Date().toISOString();
    const previous = task.resolution;
    let targetHeadSha: string | null = null;
    const unknown = (error: string, files = previous?.files ?? []) => {
      this.update(task, { resolution: { status: "unknown", checkedAt, targetHeadSha, error, files } });
      return "unknown" as const;
    };
    if (!gitlab?.listRepositoryCommits || !gitlab.getRepositoryFile) {
      return unknown("当前 GitLab 连接不支持读取目标分支文件，暂无法确认修复是否仍生效。");
    }
    const mergeSha = task.mr?.mergeCommitSha ?? task.mr?.squashCommitSha ?? null;
    const baseSha = task.mr?.mergeBaseSha ?? null;
    const paths = task.mr?.changedPaths ?? [];
    if (!mergeSha || !baseSha || paths.length === 0) {
      return unknown("缺少合并提交、合并前提交或变更文件信息，暂无法确认修复是否仍生效。");
    }
    try {
      const [targetHead] = await gitlab.listRepositoryCommits(task.projectId, { ref: task.targetBranch, page: 1, perPage: 1 });
      targetHeadSha = targetHead?.id ?? null;
      if (!targetHeadSha) {
        return unknown("无法读取目标分支当前提交，暂无法确认修复是否仍生效。");
      }
      const samePaths = previous?.files.length === paths.length && paths.every((path, index) => previous.files[index]?.path === path);
      if (samePaths && previous?.targetHeadSha === targetHeadSha && previous.status !== "unknown") return previous.status;
      const files = samePaths && previous?.files.length
        ? previous.files
        : await Promise.all(paths.map(async (path) => {
          const [baseFile, mergedFile] = await Promise.all([
            gitlab.getRepositoryFile!(task.projectId, path, baseSha),
            gitlab.getRepositoryFile!(task.projectId, path, mergeSha),
          ]);
          return { path, baseBlobId: baseFile?.blobId ?? null, mergedBlobId: mergedFile?.blobId ?? null };
        }));
      const currentFiles = await Promise.all(paths.map((path) => gitlab.getRepositoryFile!(task.projectId, path, task.targetBranch)));
      const sameAsMerged = files.every((file, index) => (currentFiles[index]?.blobId ?? null) === file.mergedBlobId);
      const sameAsBase = files.every((file, index) => (currentFiles[index]?.blobId ?? null) === file.baseBlobId);
      const status: InspectionAiResolutionStatus = sameAsMerged ? "active" : sameAsBase ? "reverted" : "unknown";
      const error = status === "unknown" ? "目标分支在合并后发生了额外修改，暂无法确认修复是否仍生效。" : null;
      this.update(task, { resolution: { status, checkedAt, targetHeadSha, error, files } });
      if (status === "active") this.markFindingAiResolution(task, "merged");
      if (status === "reverted") this.markFindingAiResolution(task, "reverted");
      return status;
    } catch (error) {
      return unknown(`合并后修复状态检查失败：${safeErrorMessage(error, "无法读取目标分支文件")}`);
    }
  }

  private sync(task: StoredInspectionAiTask): Promise<void> {
    if (!task.mr || this.closing) return Promise.resolve();
    if (this.active.has(task.id)) return Promise.resolve();
    const pending = this.syncing.get(task.id);
    if (pending) return pending;
    const promise = (async () => {
      try {
        const deps = await this.checkedDependencies(task);
        const validate = () => this.options.validateIdentity(task.identity);
        const outcome = await this.inspectVerification(task, deps, new AbortController().signal, validate);
        if (outcome.kind === "repair") {
          this.update(task, { status: "failed", phase: "验证未通过，可继续处理", error: outcome.reason === "review"
            ? "Pipeline Review 发现机器人评论，请继续处理以修复后重新验证"
            : "Pipeline 未通过，请继续处理以修复后重新验证" });
        } else if (outcome.kind === "blocked") {
          this.update(task, { status: "failed", phase: "验证未通过", error: outcome.error });
        }
      } catch (error) { this.update(task, { syncError: safeErrorMessage(error, "无法同步 MR 状态") }); }
    })().finally(() => this.syncing.delete(task.id));
    this.syncing.set(task.id, promise);
    return promise;
  }
  private async syncAll() {
    for (const task of this.tasks.values()) {
      if (this.closing) break;
      if (task.mr && task.status !== "closed") await this.sync(task);
    }
  }
}
