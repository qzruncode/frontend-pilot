import { randomUUID } from "node:crypto";
import { type GitLabClientPort, type GitLabNote } from "./gitlab-client.js";
import { loadReviewProfile } from "./profiles.js";
import type { ReviewWorkspaceProvider } from "./review-workspace.js";
import { ReviewStore } from "./review-store.js";
import {
  REVIEW_CONCURRENCY_MAX,
  REVIEW_CONCURRENCY_MIN,
  ReviewConcurrencySchema,
} from "./contracts.js";
import type {
  CreateReviewInput,
  ReviewJob,
  ReviewProgressEvent,
  ReviewProgressInput,
  ReviewProfile,
  ReviewRunner,
  ReviewSettings,
  ReviewStats,
  ReviewStatus,
} from "./contracts.js";
import type { AppConfig } from "./config.js";
import { safeErrorMessage } from "./errors.js";
import { executeReviewJob } from "./review-service-execution.js";
import { renderReviewProgressNote, reviewProgressNoteMarker, reviewReportNoteMarker } from "./review-note.js";
import type { InternalJob, ProgressListener, ReviewCiBinding } from "./review-service-types.js";

const TERMINAL_STATUSES = new Set<ReviewStatus>(["completed", "failed", "superseded", "canceled"]);
const MAX_PROGRESS_EVENTS = 1_000;
const MAX_IN_MEMORY_JOBS = 2_000;
const REVIEW_CONCURRENCY_SETTING_KEY = "review.concurrency";
const REVIEW_AUTO_SEND_COMMENTS_SETTING_KEY = "review.auto_send_comments";
const DEFAULT_AUTO_SEND_COMMENTS = true;
const DEFAULT_REVIEW_CLEANUP_INTERVAL_MS = 15 * 60 * 1_000;
const TERMINAL_MERGE_REQUEST_STATES = new Set(["merged", "closed"]);

type ReviewServiceConfig = Pick<AppConfig, "reviewConcurrency" | "rulesDir" | "profileConfigPath"> & {
  autoSendComments: boolean;
};

function parsePersistedConcurrency(value: string | null): number | null {
  if (value === null) return null;
  const parsed = ReviewConcurrencySchema.safeParse(Number(value));
  return parsed.success ? parsed.data : null;
}

function parsePersistedBoolean(value: string | null, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export class ReviewRetryError extends Error {
  constructor(message = "只有失败的 Review 任务可以重试") {
    super(message);
    this.name = "ReviewRetryError";
  }
}

export class ReviewDeleteError extends Error {
  constructor(message = "只有已结束的 Review 任务可以删除") {
    super(message);
    this.name = "ReviewDeleteError";
  }
}

export class ReviewTerminalError extends Error {
  readonly state: string;

  constructor(state: string) {
    super(`MR 当前状态为 ${state}，不能启动 Review。`);
    this.name = "ReviewTerminalError";
    this.state = state;
  }
}

export interface ReviewServiceOptions {
  gitlab: GitLabClientPort;
  runner: ReviewRunner;
  store?: ReviewStore;
  workspaceProvider?: ReviewWorkspaceProvider;
  config: Pick<AppConfig, "reviewConcurrency" | "rulesDir" | "profileConfigPath">;
  profileLoader?: (projectPath: string, config: Pick<AppConfig, "rulesDir" | "profileConfigPath">) => Promise<ReviewProfile>;
  now?: () => Date;
  deleteReviewSession?: (sessionId: string) => Promise<void>;
  cleanupIntervalMs?: number;
}

export interface ReviewEnqueueOptions {
  ciBinding?: ReviewCiBinding;
}

function normalizeInput(input: Partial<CreateReviewInput> & { source?: string }): CreateReviewInput & { source: string } {
  if (input.projectId === undefined || input.projectId === null || String(input.projectId).trim() === "") {
    throw new Error("projectId is required");
  }
  if (input.mrIid === undefined || input.mrIid === null || String(input.mrIid).trim() === "") {
    throw new Error("mrIid is required");
  }
  return {
    projectId: String(input.projectId).trim(),
    projectPath: input.projectPath ? String(input.projectPath).trim() : null,
    mrIid: String(input.mrIid).trim(),
    headSha: input.headSha ? String(input.headSha).trim() : null,
    targetBranch: input.targetBranch ? String(input.targetBranch).trim() : null,
    source: input.source ? String(input.source).trim() : "api",
  };
}

function isNumericProjectId(projectId: string): boolean {
  return /^\d+$/.test(projectId);
}

function currentHead(mergeRequest: { diff_refs?: { head_sha?: string | null } | null; sha?: string | null }): string | null {
  return mergeRequest.sha?.trim() || mergeRequest.diff_refs?.head_sha?.trim() || null;
}

function currentTargetBranch(mergeRequest: { target_branch?: string | null }): string | null {
  const targetBranch = mergeRequest.target_branch?.trim();
  return targetBranch || null;
}

export class ReviewService {
  private readonly gitlab: GitLabClientPort;
  private readonly runner: ReviewRunner;
  private readonly workspaceProvider: ReviewWorkspaceProvider | undefined;
  private readonly config: ReviewServiceConfig;
  private readonly profileLoader: NonNullable<ReviewServiceOptions["profileLoader"]>;
  private readonly now: () => Date;
  private readonly store: ReviewStore;
  private readonly deleteReviewSession: ReviewServiceOptions["deleteReviewSession"];
  private readonly cleanupTimer: NodeJS.Timeout | null;
  private readonly mergeRequestCleanups = new Map<string, Promise<void>>();
  private readonly terminalMergeRequests = new Set<string>();
  private cleanupSweep: Promise<void> | null = null;
  private readonly jobs = new Map<string, InternalJob>();
  private readonly jobsByKey = new Map<string, InternalJob>();
  private readonly latestByMergeRequest = new Map<string, InternalJob>();
  private readonly queuedByProject = new Map<string, InternalJob[]>();
  private readonly projectQueueOrder: string[] = [];
  private readonly activeByProject = new Map<string, number>();
  private queueCursor = 0;
  private lastDispatchedProject: string | null = null;
  private readonly executions = new Map<string, Promise<void>>();
  private readonly mergeRequestExecutionChains = new Map<string, Promise<void>>();
  private readonly noteWrites = new Map<string, Promise<void>>();
  private readonly lastNoteProgress = new Map<string, number>();
  private active = 0;
  private closing = false;

  constructor({
    gitlab,
    runner,
    store,
    workspaceProvider,
    config,
    profileLoader = loadReviewProfile,
    now = () => new Date(),
    deleteReviewSession,
    cleanupIntervalMs = DEFAULT_REVIEW_CLEANUP_INTERVAL_MS,
  }: ReviewServiceOptions) {
    if (!gitlab) throw new Error("gitlab client is required");
    if (!runner) throw new Error("review runner is required");
    this.gitlab = gitlab;
    this.runner = runner;
    this.store = store ?? new ReviewStore(":memory:");
    this.workspaceProvider = workspaceProvider;
    const configuredConcurrency = ReviewConcurrencySchema.safeParse(
      config.reviewConcurrency ?? REVIEW_CONCURRENCY_MIN,
    );
    const defaultConcurrency = configuredConcurrency.success
      ? configuredConcurrency.data
      : REVIEW_CONCURRENCY_MIN;
    this.config = {
      reviewConcurrency: parsePersistedConcurrency(this.store.getSetting(REVIEW_CONCURRENCY_SETTING_KEY))
        ?? defaultConcurrency,
      rulesDir: config.rulesDir,
      profileConfigPath: config.profileConfigPath,
      autoSendComments: parsePersistedBoolean(
        this.store.getSetting(REVIEW_AUTO_SEND_COMMENTS_SETTING_KEY),
        DEFAULT_AUTO_SEND_COMMENTS,
      ),
    };
    this.profileLoader = profileLoader;
    this.now = now;
    this.deleteReviewSession = deleteReviewSession;
    this.cleanupTimer = cleanupIntervalMs > 0
      ? setInterval(() => {
        void this.sweepMergedReviewSessions();
      }, cleanupIntervalMs)
      : null;
    this.cleanupTimer?.unref();
    this.restoreJobs();
  }

  stats(): ReviewStats {
    return {
      queued: this.count("queued"),
      running: this.count("running"),
      completed: this.count("completed"),
      failed: this.count("failed"),
      superseded: this.count("superseded"),
      canceled: this.count("canceled"),
    };
  }

  getSettings(): ReviewSettings {
    return {
      reviewConcurrency: this.config.reviewConcurrency,
      autoSendComments: this.config.autoSendComments,
      minReviewConcurrency: REVIEW_CONCURRENCY_MIN,
      maxReviewConcurrency: REVIEW_CONCURRENCY_MAX,
    };
  }

  updateSettings(reviewConcurrency: number, autoSendComments = this.config.autoSendComments): ReviewSettings {
    const parsed = ReviewConcurrencySchema.safeParse(reviewConcurrency);
    if (!parsed.success) {
      throw new Error(`Review 并发数必须在 ${REVIEW_CONCURRENCY_MIN} 到 ${REVIEW_CONCURRENCY_MAX} 之间。`);
    }
    if (typeof autoSendComments !== "boolean") {
      throw new Error("Review 评论自动发送配置必须是布尔值。");
    }
    this.store.setSetting(REVIEW_CONCURRENCY_SETTING_KEY, String(parsed.data));
    this.store.setSetting(REVIEW_AUTO_SEND_COMMENTS_SETTING_KEY, String(autoSendComments));
    this.config.reviewConcurrency = parsed.data;
    this.config.autoSendComments = autoSendComments;
    this.pump();
    return this.getSettings();
  }

  listJobs(limit = 50): ReviewJob[] {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((job) => this.publicJob(job));
  }

  getJob(id: string): ReviewJob | null {
    const job = this.jobs.get(id);
    return job ? this.publicJob(job) : null;
  }

  getProgressEvents(id: string): ReviewProgressEvent[] | null {
    const job = this.jobs.get(id);
    return job ? [...job.progress] : null;
  }

  subscribeToProgress(id: string, listener: ProgressListener): () => void {
    const job = this.jobs.get(id);
    if (!job) return () => undefined;
    job.listeners.add(listener);
    return () => {
      job.listeners.delete(listener);
      if (job.listeners.size === 0) this.jobs.get(id)?.listeners.clear();
    };
  }

  async enqueue(
    input: Partial<CreateReviewInput> & { source?: string },
    options: ReviewEnqueueOptions = {},
  ): Promise<{ job: ReviewJob; deduplicated: boolean }> {
    if (this.closing) throw new Error("review service is shutting down");
    let normalized = normalizeInput(input);
    if (!isNumericProjectId(normalized.projectId) && this.gitlab.getProject) {
      const project = await this.gitlab.getProject(normalized.projectId);
      normalized = {
        ...normalized,
        projectId: project.id.trim(),
        projectPath: normalized.projectPath ?? project.pathWithNamespace,
      };
    }
    const currentMergeRequest = await this.gitlab.getMergeRequest(normalized.projectId, normalized.mrIid);
    const currentState = String(currentMergeRequest.state ?? "").trim().toLowerCase();
    if (TERMINAL_MERGE_REQUEST_STATES.has(currentState)) throw new ReviewTerminalError(currentState);
    if (!normalized.headSha) {
      const headSha = currentHead(currentMergeRequest);
      if (!headSha) throw new Error("无法确定 Merge Request 当前提交，不能启动 Review。");
      normalized = {
        ...normalized,
        headSha,
        targetBranch: currentTargetBranch(currentMergeRequest) ?? normalized.targetBranch,
      };
    }
    if (!normalized.targetBranch) {
      normalized = { ...normalized, targetBranch: currentTargetBranch(currentMergeRequest) };
    }
    const key = this.jobKey(normalized);
    const mergeRequestKey = this.mergeRequestKey(normalized);
    if (this.terminalMergeRequests.has(mergeRequestKey)) {
      throw new ReviewTerminalError(currentState || "terminal");
    }
    const existing = this.jobsByKey.get(key);
    if (existing) {
      const canReuse = !TERMINAL_STATUSES.has(existing.status)
        || (existing.status === "completed" && (!options.ciBinding || Boolean(existing.result?.gate)));
      if (canReuse) {
        if (options.ciBinding) {
          existing.ciBinding = options.ciBinding;
          this.store.saveJob(existing);
          this.appendProgress(existing, {
            kind: "status",
            message: "CI Job 已接入当前审核",
            detail: `job ${options.ciBinding.jobId}`,
          });
        }
        return { job: this.publicJob(existing), deduplicated: true };
      }
    }

    this.supersedeOlderJobs(normalized);
    const job: InternalJob = {
      id: randomUUID(),
      ...normalized,
      key,
      status: "queued",
      createdAt: this.now().toISOString(),
      startedAt: null,
      finishedAt: null,
      noteId: null,
      error: null,
      result: null,
      ciBinding: options.ciBinding ?? null,
      progress: [],
      progressSequence: 0,
      listeners: new Set(),
      suppressProgressNotes: false,
      controller: null,
    };
    this.jobs.set(job.id, job);
    this.jobsByKey.set(key, job);
    this.latestByMergeRequest.set(this.mergeRequestKey(job), job);
    this.appendProgress(job, {
      kind: "stage",
      message: "任务已进入队列",
      detail: `${normalized.projectPath ?? normalized.projectId}!${normalized.mrIid} · 等待执行器`,
    });
    this.enqueueQueuedJob(job);
    this.pruneTerminalJobs();
    this.pump();
    return { job: this.publicJob(job), deduplicated: false };
  }

  async cancel(id: string): Promise<ReviewJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (TERMINAL_STATUSES.has(job.status)) return this.publicJob(job);
    job.status = "canceled";
    job.finishedAt = this.now().toISOString();
    this.appendProgress(job, { kind: "stage", message: "任务已取消", detail: "正在停止当前执行并清理资源" });
    job.controller?.abort();
    return this.publicJob(job);
  }

  getCiJob(id: string, tokenHash: string): ReviewJob | null {
    const job = this.jobs.get(id);
    return job?.ciBinding?.tokenHash === tokenHash ? this.publicJob(job) : null;
  }

  async retry(id: string): Promise<{ job: ReviewJob; deduplicated: boolean } | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status !== "failed") throw new ReviewRetryError();
    return this.enqueue({
      projectId: job.projectId,
      projectPath: job.projectPath,
      mrIid: job.mrIid,
      headSha: job.headSha,
      targetBranch: job.targetBranch,
      source: "retry",
    });
  }

  async delete(id: string): Promise<boolean | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!TERMINAL_STATUSES.has(job.status)) throw new ReviewDeleteError("进行中的 Review 任务不能删除，请先取消任务");
    this.jobs.delete(id);
    this.removeQueuedJob(id);
    if (this.jobsByKey.get(job.key)?.id === id) this.restoreLatestJobForKey(job.key);
    if (this.latestByMergeRequest.get(this.mergeRequestKey(job))?.id === id) this.restoreLatestReview(job.projectId, job.mrIid);
    job.listeners.clear();
    return this.store.deleteJob(id);
  }

  async cleanupMergeRequest(
    projectId: string,
    mrIid: string,
    action: "merge" | "close" = "merge",
  ): Promise<void> {
    if (this.closing) return;
    const requestedProjectId = projectId.trim();
    const canonicalProjectId = await this.canonicalizeProjectId(requestedProjectId);
    const key = `${canonicalProjectId}:${mrIid}`;
    const existing = this.mergeRequestCleanups.get(key);
    if (existing) {
      await existing;
      return;
    }
    if (this.terminalMergeRequests.has(key)) {
      const inFlight = this.mergeRequestCleanups.get(key);
      if (inFlight) await inFlight;
      return;
    }

    this.terminalMergeRequests.add(key);
    let cleanup!: Promise<void>;
    cleanup = (async () => {
      const projectAliases = await this.findProjectAliases(canonicalProjectId, mrIid, requestedProjectId);
      await this.cleanupMergeRequestNow(canonicalProjectId, mrIid, action, projectAliases);
    })().finally(() => {
      if (this.mergeRequestCleanups.get(key) === cleanup) this.mergeRequestCleanups.delete(key);
      this.terminalMergeRequests.delete(key);
    });
    this.mergeRequestCleanups.set(key, cleanup);
    await cleanup;
  }

  private async canonicalizeProjectId(projectId: string): Promise<string> {
    const normalized = projectId.trim();
    if (isNumericProjectId(normalized) || !this.gitlab.getProject) return normalized;
    const project = await this.gitlab.getProject(normalized);
    return project.id.trim() || normalized;
  }

  private async findProjectAliases(
    canonicalProjectId: string,
    mrIid: string,
    requestedProjectId: string,
  ): Promise<string[]> {
    const candidates = new Set<string>();
    if (requestedProjectId && requestedProjectId !== canonicalProjectId) candidates.add(requestedProjectId);
    for (const job of this.jobs.values()) {
      if (job.mrIid === mrIid && job.projectId !== canonicalProjectId) candidates.add(job.projectId);
    }
    for (const session of this.store.listReviewSessions()) {
      if (session.mrIid === mrIid && session.projectId !== canonicalProjectId) candidates.add(session.projectId);
    }
    for (const workspace of this.store.listReviewWorkspaces()) {
      if (workspace.mrIid === mrIid && workspace.projectId !== canonicalProjectId) candidates.add(workspace.projectId);
    }

    const aliases: string[] = [];
    for (const candidate of candidates) {
      if (!this.gitlab.getProject || isNumericProjectId(candidate)) continue;
      try {
        if (await this.canonicalizeProjectId(candidate) === canonicalProjectId) aliases.push(candidate);
      } catch {
        // An old project alias that can no longer be resolved must not make
        // cleanup for the canonical MR fail or touch an unrelated project.
      }
    }
    return aliases;
  }

  async close(): Promise<void> {
    if (this.closing) {
      await Promise.allSettled(this.executions.values());
      return;
    }
    this.closing = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    const cleanupSweep = this.cleanupSweep;
    if (cleanupSweep) await cleanupSweep.catch((error) => this.reportCleanupError(error));
    await Promise.allSettled(this.mergeRequestCleanups.values());
    const shutdownError = "服务正在关闭，任务未完成。";
    for (const job of this.jobs.values()) {
      if (job.status !== "running" && job.status !== "queued") continue;
      const wasQueued = job.status === "queued";
      job.status = wasQueued ? "canceled" : "failed";
      job.error = shutdownError;
      job.finishedAt = this.now().toISOString();
      this.appendProgress(job, {
        kind: "error",
        message: wasQueued ? "排队中的审查因服务关闭取消" : "审查因服务关闭中断",
        detail: shutdownError,
      });
      job.controller?.abort();
    }
    await Promise.allSettled(this.executions.values());
    this.store.close();
  }

  private count(status: ReviewStatus): number {
    return [...this.jobs.values()].filter((job) => job.status === status).length;
  }

  private restoreJobs(): void {
    const persistedJobs = this.store.loadJobs().sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
    for (const persisted of persistedJobs) {
      const job: InternalJob = {
        ...persisted,
        ciBinding: persisted.ciBinding ?? null,
        listeners: new Set(),
        suppressProgressNotes: false,
        controller: null,
      };
      this.jobs.set(job.id, job);
      const mergeRequestKey = this.mergeRequestKey(job);
      const latestReview = this.latestByMergeRequest.get(mergeRequestKey);
      if (!latestReview
        || job.createdAt.localeCompare(latestReview.createdAt) > 0
        || (job.createdAt === latestReview.createdAt && job.id.localeCompare(latestReview.id) > 0)) {
        this.latestByMergeRequest.set(mergeRequestKey, job);
      }
      const latestForKey = this.jobsByKey.get(job.key);
      if (!latestForKey || job.createdAt > latestForKey.createdAt) this.jobsByKey.set(job.key, job);
      if (job.status === "running") {
        job.status = "failed";
        job.error = "服务重启时任务中断，请重新提交审查。";
        job.finishedAt = this.now().toISOString();
        this.appendProgress(job, { kind: "error", message: "审查因服务重启中断", detail: job.error });
      } else if (job.status === "queued") {
        this.enqueueQueuedJob(job);
      }
    }
    this.pump();
  }

  private jobKey(input: CreateReviewInput): string {
    return `${input.projectId}:${input.mrIid}:${input.headSha ?? "latest"}`;
  }

  private mergeRequestKey(input: Pick<CreateReviewInput, "projectId" | "mrIid">): string {
    return `${input.projectId}:${input.mrIid}`;
  }

  private pruneTerminalJobs(): void {
    if (this.jobs.size <= MAX_IN_MEMORY_JOBS) return;
    const removable = [...this.jobs.values()]
      .filter((job) => TERMINAL_STATUSES.has(job.status) && job.listeners.size === 0)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const job of removable) {
      if (this.jobs.size <= MAX_IN_MEMORY_JOBS) break;
      this.jobs.delete(job.id);
      if (this.jobsByKey.get(job.key)?.id === job.id) this.jobsByKey.delete(job.key);
    }
  }

  private restoreLatestJobForKey(key: string): void {
    const latest = [...this.jobs.values()]
      .filter((job) => job.key === key)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
    if (latest) this.jobsByKey.set(key, latest);
    else this.jobsByKey.delete(key);
  }

  private supersedeOlderJobs(input: CreateReviewInput): void {
    for (const job of this.jobs.values()) {
      if (job.projectId !== input.projectId || job.mrIid !== input.mrIid) continue;
      if (job.headSha === input.headSha || TERMINAL_STATUSES.has(job.status)) continue;
      if (job.status === "queued" || job.status === "running") {
        job.status = "superseded";
        job.finishedAt = this.now().toISOString();
        this.appendProgress(job, { kind: "stage", message: "任务已被新提交替代", detail: "当前审查将停止，不会写回旧结果" });
        job.controller?.abort();
      }
    }
  }

  private enqueueQueuedJob(job: InternalJob): void {
    const projectQueue = this.queuedByProject.get(job.projectId);
    if (projectQueue) {
      projectQueue.push(job);
      return;
    }
    this.queuedByProject.set(job.projectId, [job]);
    this.projectQueueOrder.push(job.projectId);
    const lastIndex = this.lastDispatchedProject === null
      ? -1
      : this.projectQueueOrder.indexOf(this.lastDispatchedProject);
    if (lastIndex >= 0) this.queueCursor = (lastIndex + 1) % this.projectQueueOrder.length;
  }

  private removeQueuedJob(id: string): void {
    for (let index = this.projectQueueOrder.length - 1; index >= 0; index -= 1) {
      const projectId = this.projectQueueOrder[index];
      const projectQueue = this.queuedByProject.get(projectId);
      if (!projectQueue) {
        this.removeProjectQueue(index);
        continue;
      }
      const remaining = projectQueue.filter((queuedJob) => queuedJob.id !== id);
      this.queuedByProject.set(projectId, remaining);
      if (remaining.length === 0) this.cleanupProjectQueue(projectId);
    }
  }

  private removeProjectQueue(index: number): void {
    const projectId = this.projectQueueOrder[index];
    if (projectId !== undefined) this.queuedByProject.delete(projectId);
    this.projectQueueOrder.splice(index, 1);
    if (projectId === this.lastDispatchedProject) this.lastDispatchedProject = null;
    if (index < this.queueCursor) this.queueCursor -= 1;
    if (this.queueCursor >= this.projectQueueOrder.length) this.queueCursor = 0;
  }

  private dequeueNextQueuedJob(): InternalJob | null {
    const projectCount = this.projectQueueOrder.length;
    for (let offset = 0; offset < projectCount; offset += 1) {
      if (this.queueCursor >= this.projectQueueOrder.length) this.queueCursor = 0;
      const index = (this.queueCursor + offset) % this.projectQueueOrder.length;
      const projectId = this.projectQueueOrder[index];
      const projectQueue = projectId === undefined ? undefined : this.queuedByProject.get(projectId);
      while (projectQueue?.length) {
        const job = projectQueue.shift();
        if (job?.status !== "queued") continue;
        this.queueCursor = (index + 1) % this.projectQueueOrder.length;
        this.lastDispatchedProject = job.projectId;
        return job;
      }
    }
    return null;
  }

  private cleanupProjectQueue(projectId: string): void {
    if ((this.activeByProject.get(projectId) ?? 0) > 0) return;
    const projectQueue = this.queuedByProject.get(projectId);
    if (projectQueue && projectQueue.length > 0) return;
    const index = this.projectQueueOrder.indexOf(projectId);
    if (index >= 0) this.removeProjectQueue(index);
  }

  private pump(): void {
    if (this.closing) return;
    while (this.active < this.config.reviewConcurrency) {
      const job = this.dequeueNextQueuedJob();
      if (!job) break;
      this.active += 1;
      this.activeByProject.set(job.projectId, (this.activeByProject.get(job.projectId) ?? 0) + 1);
      const execution = this.execute(job);
      this.executions.set(job.id, execution);
      const finish = () => {
        this.executions.delete(job.id);
        this.active -= 1;
        const activeForProject = (this.activeByProject.get(job.projectId) ?? 1) - 1;
        if (activeForProject > 0) this.activeByProject.set(job.projectId, activeForProject);
        else this.activeByProject.delete(job.projectId);
        this.cleanupProjectQueue(job.projectId);
        this.pump();
      };
      void execution.then(finish, finish);
    }
  }

  private execute(job: InternalJob): Promise<void> {
    const mergeRequestKey = this.mergeRequestKey(job);
    const previous = this.mergeRequestExecutionChains.get(mergeRequestKey) ?? Promise.resolve();
    let execution!: Promise<void>;
    execution = previous
      .catch(() => undefined)
      .then(() => {
        if (job.status !== "queued") return;
        return executeReviewJob({
          gitlab: this.gitlab,
          runner: this.runner,
          workspaceProvider: this.workspaceProvider,
          config: this.config,
          profileLoader: this.profileLoader,
          now: this.now,
          isClosing: () => this.closing,
          appendProgress: this.appendProgress.bind(this),
          enqueueReplacement: (currentJob, headSha, source) => this.enqueue({ ...currentJob, headSha, source }).then(() => undefined),
          registerReviewWorkspace: (currentJob) => this.store.saveReviewWorkspace(currentJob.projectId, currentJob.mrIid),
          upsertNote: (currentJob, body) => this.writeNote(currentJob, body),
          shouldSendComments: () => this.config.autoSendComments,
          getReviewSession: (currentJob) => this.store.getReviewSession(currentJob.projectId, currentJob.mrIid),
          saveReviewSession: (currentJob, sessionId) => {
            // Same-MR executions are serialized above. A superseded job may be
            // the one that first receives the SDK session id, so do not discard
            // it merely because a newer head is already queued.
            this.store.saveReviewSession(currentJob.projectId, currentJob.mrIid, sessionId);
          },
        }, job);
      })
      .finally(() => {
        if (this.mergeRequestExecutionChains.get(mergeRequestKey) === execution) {
          this.mergeRequestExecutionChains.delete(mergeRequestKey);
        }
      });
    this.mergeRequestExecutionChains.set(mergeRequestKey, execution);
    return execution;
  }

  private appendProgress(job: InternalJob, input: ReviewProgressInput): void {
    if (!this.jobs.has(job.id)) return;
    this.syncJobKey(job);
    const event: ReviewProgressEvent = { id: `${job.id}:${job.progressSequence += 1}`, at: this.now().toISOString(), ...input };
    job.progress.push(event);
    if (job.progress.length > MAX_PROGRESS_EVENTS) job.progress.shift();
    this.store.saveJob(job, event);
    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected event stream must not affect the review worker.
      }
    }
    this.scheduleProgressNote(job, event);
  }

  private syncJobKey(job: InternalJob): void {
    const nextKey = this.jobKey(job);
    if (job.key === nextKey) return;

    const previousKey = job.key;
    if (this.jobsByKey.get(previousKey)?.id === job.id) {
      const previous = [...this.jobs.values()]
        .filter((candidate) => candidate.id !== job.id && candidate.key === previousKey)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
      if (previous) this.jobsByKey.set(previousKey, previous);
      else this.jobsByKey.delete(previousKey);
    }

    job.key = nextKey;
    const current = this.jobsByKey.get(nextKey);
    if (!current || current.id === job.id || current.createdAt.localeCompare(job.createdAt) <= 0) {
      this.jobsByKey.set(nextKey, job);
    }
  }

  private async upsertNoteDirect(job: InternalJob, body: string, kind: "progress" | "report") {
    const progressMarker = reviewProgressNoteMarker(job.projectId, job.mrIid);
    const existing = kind === "progress"
      ? await this.gitlab.findNoteByMarker(job.projectId, job.mrIid, progressMarker)
      : await this.gitlab.findNoteByMarker(job.projectId, job.mrIid, progressMarker)
        ?? await this.gitlab.findNoteByMarker(
          job.projectId,
          job.mrIid,
          reviewReportNoteMarker(job.projectId, job.mrIid, job.headSha),
        );
    return existing
      ? this.gitlab.updateNote(job.projectId, job.mrIid, existing.id, body)
      : this.gitlab.createNote(job.projectId, job.mrIid, body);
  }

  private writeNote(job: InternalJob, body: string, kind: "progress" | "report" = "report"): Promise<GitLabNote | null> {
    const key = `${job.projectId}:${job.mrIid}`;
    const previous = this.noteWrites.get(key) ?? Promise.resolve();
    const next = previous
      .catch((error: unknown) => this.reportNoteError(error))
      .then(async () => {
        if (!this.config.autoSendComments || !this.isLatestReview(job)) return null;
        const note = await this.upsertNoteDirect(job, body, kind);
        if (this.isLatestReview(job)) {
          job.noteId = note.id;
          this.store.saveJob(job);
        }
        return note;
      });
    this.noteWrites.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  private scheduleProgressNote(job: InternalJob, event: ReviewProgressEvent): void {
    if (job.suppressProgressNotes || !this.config.autoSendComments || !job.ciBinding) return;
    // A successful CI review has already converted its progress note into the
    // final report. Do not recreate a terminal progress note after that write.
    if (job.status === "completed") return;
    const force = event.message === "任务已进入队列" || TERMINAL_STATUSES.has(job.status);
    if (!force && !["stage", "thinking", "tool", "tool_result", "assistant", "warning", "error"].includes(event.kind)) return;

    const eventAt = Date.parse(event.at);
    const key = `${job.projectId}:${job.mrIid}`;
    const lastAt = this.lastNoteProgress.get(key) ?? 0;
    if (!force && Number.isFinite(eventAt) && eventAt - lastAt < 5_000) return;
    if (Number.isFinite(eventAt)) this.lastNoteProgress.set(key, eventAt);

    const body = renderReviewProgressNote({ job, event, jobUrl: job.ciBinding.jobUrl });
    void this.writeNote(job, body, "progress").catch((error: unknown) => this.reportNoteError(error));
  }

  private isLatestReview(job: InternalJob): boolean {
    return this.latestByMergeRequest.get(this.mergeRequestKey(job))?.id === job.id;
  }

  private restoreLatestReview(projectId: string, mrIid: string): void {
    const latest = [...this.jobs.values()]
      .filter((candidate) => candidate.projectId === projectId && candidate.mrIid === mrIid)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
    const key = `${projectId}:${mrIid}`;
    if (latest) this.latestByMergeRequest.set(key, latest);
    else this.latestByMergeRequest.delete(key);
  }

  private reportNoteError(error: unknown): void {
    process.stderr.write(`[frontend-pilot] MR 评论更新失败：${safeErrorMessage(error, "未知错误")}\n`);
  }

  private async cleanupMergeRequestNow(
    projectId: string,
    mrIid: string,
    action: "merge" | "close",
    projectAliases: string[] = [],
  ): Promise<void> {
    const projectIds = [...new Set([projectId, ...projectAliases.map((value) => value.trim()).filter(Boolean)])];
    const projectIdSet = new Set(projectIds);
    const keys = projectIds.map((value) => `${value}:${mrIid}`);
    const reason = action === "merge" ? "MR 已合并" : "MR 已关闭";
    const matchingJobs = [...this.jobs.values()].filter((job) => (
      projectIdSet.has(job.projectId)
      && job.mrIid === mrIid
    ));
    const affectedJobs = matchingJobs.filter((job) => job.status === "queued" || job.status === "running");
    const executionsToWait = new Set<Promise<void>>();
    for (const job of matchingJobs) {
      const execution = this.executions.get(job.id);
      if (execution) executionsToWait.add(execution);
    }
    for (const currentProjectId of projectIds) {
      const execution = this.mergeRequestExecutionChains.get(`${currentProjectId}:${mrIid}`);
      if (execution) executionsToWait.add(execution);
    }

    for (const key of keys) {
      this.latestByMergeRequest.delete(key);
      this.lastNoteProgress.delete(key);
    }
    for (const job of affectedJobs) {
      job.suppressProgressNotes = true;
      if (job.status === "queued") this.removeQueuedJob(job.id);
      job.status = "canceled";
      job.error = `${reason}，审查任务已取消。`;
      job.finishedAt = this.now().toISOString();
      this.appendProgress(job, {
        kind: "stage",
        message: `${reason}，审查任务已取消`,
        detail: "终态 MR 不再继续生成审查结果或评论",
      });
      job.controller?.abort();
    }
    this.pump();

    await Promise.allSettled(executionsToWait);

    try {
      const deletedSessionIds = new Set<string>();
      for (const currentProjectId of projectIds) {
        const sessionId = this.store.getReviewSession(currentProjectId, mrIid);
        if (!sessionId) continue;
        if (this.deleteReviewSession && !deletedSessionIds.has(sessionId)) {
          await this.deleteReviewSession(sessionId);
          deletedSessionIds.add(sessionId);
        }
        this.store.deleteReviewSession(currentProjectId, mrIid);
      }
    } finally {
      for (const currentProjectId of projectIds) {
        let workspaceDisposed = true;
        try {
          await this.workspaceProvider?.disposeReview?.({ projectId: currentProjectId, mrIid });
        } catch (error) {
          workspaceDisposed = false;
          this.reportCleanupError(error, `${currentProjectId}!${mrIid} Review workspace`);
        }
        if (workspaceDisposed) this.store.deleteReviewWorkspace(currentProjectId, mrIid);
      }
    }
  }

  private sweepMergedReviewSessions(): Promise<void> {
    if (this.cleanupSweep) return this.cleanupSweep;
    let sweep!: Promise<void>;
    sweep = this.sweepMergedReviewSessionsNow().finally(() => {
      if (this.cleanupSweep === sweep) this.cleanupSweep = null;
    });
    this.cleanupSweep = sweep;
    return sweep;
  }

  private async sweepMergedReviewSessionsNow(): Promise<void> {
    if (this.closing) return;
    const mergeRequests = new Map<string, { projectId: string; mrIid: string }>();
    for (const session of this.store.listReviewSessions()) {
      mergeRequests.set(`${session.projectId}:${session.mrIid}`, session);
    }
    for (const workspace of this.store.listReviewWorkspaces()) {
      mergeRequests.set(`${workspace.projectId}:${workspace.mrIid}`, workspace);
    }

    for (const mergeRequest of mergeRequests.values()) {
      if (this.closing) return;
      try {
        const currentMergeRequest = await this.gitlab.getMergeRequest(mergeRequest.projectId, mergeRequest.mrIid);
        const state = String(currentMergeRequest.state ?? "").trim().toLowerCase();
        if (TERMINAL_MERGE_REQUEST_STATES.has(state)) {
          await this.cleanupMergeRequest(
            mergeRequest.projectId,
            mergeRequest.mrIid,
            state === "merged" ? "merge" : "close",
          );
        }
      } catch (error) {
        this.reportCleanupError(error, `${mergeRequest.projectId}!${mergeRequest.mrIid}`);
      }
    }
  }

  private reportCleanupError(error: unknown, context = "MR session"): void {
    process.stderr.write(`[frontend-pilot] ${context} 清理失败：${safeErrorMessage(error, "未知错误")}\n`);
  }

  private publicJob(job: InternalJob): ReviewJob {
    return {
      id: job.id,
      projectId: job.projectId,
      projectPath: job.projectPath,
      mrIid: job.mrIid,
      headSha: job.headSha,
      targetBranch: job.targetBranch,
      source: job.source,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      noteId: job.noteId,
      error: job.error,
      result: job.result,
      progress: [...job.progress],
    };
  }
}
