import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type {
  GitLabClientPort,
} from "./gitlab-client.js";
import type { GitLabRepositoryBlame, GitLabRepositoryCommit } from "./gitlab-workbench.js";
import type { JiraClientPort } from "./jira-client.js";
import type { JiraIdentity } from "./jira-workbench.js";
import {
  type InspectionAuthor,
  type InspectionRunner,
  type InspectionOwnership,
  InspectionFindingReportInputSchema,
  type InspectionFindingReportResult,
  type InspectionFinding,
  type InspectionJiraLink,
  type InspectionProject,
  type InspectionRuleOption,
  type InspectionResultSummary,
  type InspectionRuleResult,
  type InspectionRun,
  type InspectionSource,
  type InspectionPromptProfile,
  type ReviewProgressEvent,
  type ReviewProgressInput,
  type JiraCreateIssueOptions,
  type JiraCreateIssueOption,
  type JiraIssue,
} from "./contracts.js";
import { parseReviewOutput, type ReviewFinding } from "./review-prompt.js";
import { safeErrorMessage } from "./errors.js";
import { InspectionStore } from "./inspection-store.js";
import {
  findingFingerprint,
  InspectionDuplicateInvalidAssociationError,
  InspectionDuplicateUncertainError,
  InspectionFindingTracker,
} from "./inspection-findings.js";
import { inspectionRepositoryPath, jiraAuthorSearchQueries, jiraIdentityForAuthor, mergeFindingScope } from "./inspection-ownership.js";
import { InspectionRulesStore, type InspectionRulesStoreConfig, type InspectionRulesStorePort } from "./inspection-rules.js";
import type { RepositoryWorkspaceProvider, ReviewWorkspace } from "./review-workspace.js";
import {
  buildDefaultInspectionJiraDescription,
  normalizeInspectionJiraCreatePlan,
  type InspectionJiraCreatePromptInput,
  type ManagedPromptRunner,
} from "./prompt-generation.js";
import { buildInspectionJiraSummary } from "./inspection-title.js";

const TERMINAL_STATUSES = new Set<InspectionRun["status"]>(["completed", "failed", "canceled"]);
const DEFAULT_SCHEDULE_CRON = "0 0 * * *";
const DEFAULT_INSPECTION_JIRA_ISSUE_TYPE = "缺陷";
const JIRA_STATUS_SYNC_INTERVAL_MS = 60_000;
const PROGRESS_PERSIST_DEBOUNCE_MS = 250;
const PROGRESS_PERSIST_BATCH_SIZE = 32;
const INSPECTION_SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
type InspectionSeverity = (typeof INSPECTION_SEVERITY_ORDER)[number];
const INSPECTION_JIRA_ISSUE_TYPE_ALIASES: readonly string[] = ["bug", "defect", "缺陷", "故障", "错误"];
const INSPECTION_JIRA_PRIORITY_ALIASES: Record<InspectionSeverity, readonly string[]> = {
  critical: ["top", "highest", "veryhigh", "blocker", "critical", "urgent", "p0", "最高", "紧急", "严重"],
  high: ["high", "major", "important", "p1", "高", "重要"],
  medium: ["medium", "normal", "minor", "p2", "中", "一般", "普通", "次要"],
  low: ["low", "lowest", "trivial", "p3", "低", "轻微", "最低"],
};

function parseInspectionCron(expression: string): Cron {
  const normalized = expression.trim();
  if (!normalized) throw new Error("巡检周期 Cron 表达式不能为空。");
  try {
    return new Cron(normalized);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`巡检周期 Cron 表达式无效：${detail}`);
  }
}

function nextInspectionRunAt(cron: Cron, now: Date): string {
  const next = cron.nextRun(now);
  if (!next) throw new Error("巡检周期 Cron 表达式没有可执行的时间。");
  return next.toISOString();
}

function normalizeInspectionJiraOption(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function resolveInspectionJiraIssueType(issueTypes: JiraCreateIssueOption[]): string | undefined {
  return issueTypes.find((issueType) => INSPECTION_JIRA_ISSUE_TYPE_ALIASES.includes(normalizeInspectionJiraOption(issueType.name)))?.id;
}

export function resolveInspectionJiraPriority(severity: string, priorities: JiraCreateIssueOption[]): string | undefined {
  const normalizedSeverity = normalizeInspectionJiraOption(severity);
  const matchedSeverity = INSPECTION_SEVERITY_ORDER.find((candidate) => candidate === normalizedSeverity);
  const aliases = matchedSeverity ? INSPECTION_JIRA_PRIORITY_ALIASES[matchedSeverity] : undefined;
  const matched = aliases
    ? priorities.find((priority) => aliases.includes(normalizeInspectionJiraOption(priority.name)))
    : undefined;
  return matched && /^\d+$/.test(matched.id) ? matched.id : undefined;
}

function inspectionOwnerResolutionKey(finding: InspectionFinding): string {
  return JSON.stringify({
    severity: finding.severity,
    category: finding.category,
    path: finding.path,
    line: finding.line,
    issue: finding.issue,
    suggestion: finding.suggestion,
    scope: finding.scope ?? null,
    relatedPaths: [...(finding.relatedPaths ?? [])].sort(),
    jiraKey: finding.jira.key ?? null,
  });
}

export class InspectionDeleteError extends Error {
  constructor(message = "只有已结束的巡检任务可以删除") {
    super(message);
    this.name = "InspectionDeleteError";
  }
}

export type InspectionExecutionIdentity = Pick<InspectionRun, "maintainerId" | "maintainerName" | "operatorId" | "operatorName">;

export class InspectionOwnershipError extends Error {
  constructor(message = "巡检记录不属于当前维护人员") {
    super(message);
    this.name = "InspectionOwnershipError";
  }
}

function projectScopeKey(projectId: string, maintainerId: string | null | undefined): string {
  return `${maintainerId ?? ""}\u0000${String(projectId)}`;
}

function sameMaintainerScope(left: InspectionExecutionIdentity, right: InspectionExecutionIdentity): boolean {
  return (left.maintainerId ?? null) === (right.maintainerId ?? null);
}

export interface InspectionJiraSource {
  runId: string;
  findingId: string;
}
export interface InspectionDependencies {
  gitlab: GitLabClientPort;
  jira?: JiraClientPort;
  jiraProjectKey: () => string;
  workspaceProvider?: RepositoryWorkspaceProvider;
}

interface InternalInspectionRun extends InspectionRun {
  dependencies?: InspectionDependencies;
  jiraOptions?: Map<string, Promise<JiraCreateIssueOptions>>;
  jiraAuthors?: Map<string, Promise<JiraIdentity[]>>;
  findingSources?: Map<string, Promise<GitLabRepositoryBlame[] | null>>;
  findingWrites?: Promise<unknown>;
  ownerResolutions?: Map<string, { key: string; promise: Promise<void> }>;
  ownerResolutionKeys?: Map<string, string>;
  controller: AbortController | null;
  findingLimit: number | null;
  findingLimitReached: boolean;
  progressSequence: number;
  listeners: Set<(event: ReviewProgressEvent) => void>;
}

interface InspectionAuthorLookupCache {
  blame: Map<string, Promise<GitLabRepositoryBlame[] | null>>;
  commits: Map<string, Promise<GitLabRepositoryCommit[] | null>>;
}

interface PendingProgressWrite {
  run: InternalInspectionRun;
  events: Array<{ sequence: number; event: ReviewProgressEvent }>;
  timer: ReturnType<typeof setTimeout> | null;
  flush: Promise<void> | null;
}

export interface InspectionServiceOptions {
  resolveDependencies?: (identity: InspectionExecutionIdentity) => Promise<InspectionDependencies>;
  resolveJiraClient?: (identity: InspectionExecutionIdentity) => JiraClientPort | null;
  validateIdentity?: (identity: InspectionExecutionIdentity) => void;
  gitlab?: GitLabClientPort;
  runner: InspectionRunner;
  store?: InspectionStore;
  workspaceProvider?: RepositoryWorkspaceProvider;
  jira?: JiraClientPort;
  jiraProjectKey?: () => string;
  config: InspectionRulesStoreConfig;
  inspectionRulesStore?: InspectionRulesStorePort;
  promptRunner?: ManagedPromptRunner;
  now?: () => Date;
  schedulerIntervalMs?: number;
}

export interface InspectionProjectInput extends InspectionExecutionIdentity {
  projectId: string;
  projectPath: string;
  projectName: string;
  branch: string;
  findingLimit?: number | null;
  enabled: boolean;
  scheduleEnabled: boolean;
  scheduleCron: string;
  jiraMode: InspectionProject["jiraMode"];
  jiraComponent: string | null;
  jiraFixVersion: string | null;
  /** @deprecated Kept only so older clients and persisted projects remain readable. */
  jiraIssueType?: string;
  inspectionRuleIds: string[];
}

export interface InspectionEnqueueOptions {
  findingLimit?: number | null;
}

function normalizeFindingLimit(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("问题发现数量必须是大于等于 1 的整数，留空表示不限制。");
  return value;
}

export class InspectionService {
  private readonly resolveDependencies?: InspectionServiceOptions["resolveDependencies"];
  private readonly resolveJiraClient?: InspectionServiceOptions["resolveJiraClient"];
  private readonly validateIdentity?: InspectionServiceOptions["validateIdentity"];
  private readonly gitlab: GitLabClientPort | undefined;
  private readonly runner: InspectionServiceOptions["runner"];
  private readonly promptRunner: ManagedPromptRunner | undefined;
  private readonly workspaceProvider: RepositoryWorkspaceProvider | undefined;
  private readonly jira: JiraClientPort | undefined;
  private readonly jiraProjectKey: () => string;
  private readonly inspectionRulesStore: InspectionRulesStorePort;
  private readonly store: InspectionStore;
  private readonly findingTracker: InspectionFindingTracker;
  private readonly ownsStore: boolean;
  private readonly now: () => Date;
  private readonly projects = new Map<string, InspectionProject>();
  private readonly runs = new Map<string, InternalInspectionRun>();
  private readonly queuedRuns: InternalInspectionRun[] = [];
  private readonly retryingRuns = new Set<string>();
  private readonly authorRefreshes = new Map<string, Promise<InspectionRun>>();
  private readonly ownershipRefreshes = new Map<string, Promise<InspectionRun>>();
  private readonly jiraStatusRefreshes = new Map<string, Promise<void>>();
  private readonly jiraCreations = new Map<string, Promise<void>>();
  private readonly jiraStatusCheckedAt = new Map<string, number>();
  private readonly jiraSyncIdentities = new Map<string, InspectionExecutionIdentity>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly pendingProgressWrites = new Map<string, PendingProgressWrite>();
  private readonly schedulerTimer: ReturnType<typeof setInterval>;
  private active = 0;
  private closing = false;

  constructor({
    gitlab,
    resolveDependencies,
    resolveJiraClient,
    validateIdentity,
    runner,
    store,
    workspaceProvider,
    jira,
    jiraProjectKey,
    config,
    inspectionRulesStore = new InspectionRulesStore(config),
    promptRunner,
    now = () => new Date(),
    schedulerIntervalMs = 30_000,
  }: InspectionServiceOptions) {
    if (!gitlab && !resolveDependencies) throw new Error("gitlab client or inspection dependency resolver is required");
    if (!runner) throw new Error("inspection runner is required");
    this.resolveDependencies = resolveDependencies;
    this.resolveJiraClient = resolveJiraClient;
    this.validateIdentity = validateIdentity;
    this.gitlab = gitlab;
    this.runner = runner;
    this.promptRunner = promptRunner;
    this.workspaceProvider = workspaceProvider;
    this.jira = jira;
    this.jiraProjectKey = jiraProjectKey ?? (() => "");
    this.inspectionRulesStore = inspectionRulesStore;
    this.store = store ?? new InspectionStore(":memory:");
    this.findingTracker = new InspectionFindingTracker(this.store);
    this.ownsStore = !store;
    this.now = now;

    for (const project of this.store.loadProjects()) {
      this.projects.set(projectScopeKey(project.projectId, project.maintainerId), { ...project, jiraIssueType: DEFAULT_INSPECTION_JIRA_ISSUE_TYPE });
    }
    for (const run of this.store.loadRuns()) {
      const internal = this.toInternalRun(run);
      if (internal.status === "queued" || internal.status === "running") {
        internal.status = "failed";
        internal.error = "服务重启，未完成的巡检已停止。";
        internal.finishedAt = this.now().toISOString();
        this.store.saveRun(internal, internal.progressSequence);
      }
      this.runs.set(internal.id, internal);
      if (internal.maintainerId && !this.jiraSyncIdentities.has(internal.maintainerId)) {
        this.jiraSyncIdentities.set(internal.maintainerId, this.executionIdentity(internal));
      }
    }
    for (const { context } of this.findingTracker.list()) {
      if (context.maintainerId && !this.jiraSyncIdentities.has(context.maintainerId)) {
        this.jiraSyncIdentities.set(context.maintainerId, this.executionIdentity(context));
      }
    }

    this.schedulerTimer = setInterval(() => {
      void this.scheduleDueProjects();
      for (const identity of this.jiraSyncIdentities.values()) void this.syncJiraStatuses(identity);
    }, schedulerIntervalMs);
    if (typeof this.schedulerTimer === "object" && "unref" in this.schedulerTimer) {
      this.schedulerTimer.unref();
    }
  }

  listProjects(identity?: InspectionExecutionIdentity): InspectionProject[] {
    return [...this.projects.values()]
      .filter((project) => !identity || project.maintainerId === identity.maintainerId)
      .sort((left, right) => left.projectName.localeCompare(right.projectName, "zh-CN"));
  }

  getProject(projectId: string, identity?: InspectionExecutionIdentity): InspectionProject | null {
    return this.projectFor(projectId, identity) ?? null;
  }

  async listRules(identity?: InspectionExecutionIdentity): Promise<InspectionRuleOption[]> {
    const defaultProfile = (await this.inspectionRulesStore.list(identity?.maintainerId ?? undefined)).find((profile) => profile.isDefault);
    return (defaultProfile?.rules ?? []).map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      category: "提示词规则",
      enabledByDefault: rule.enabled,
      order: rule.order,
    }));
  }

  async upsertProject(input: InspectionProjectInput): Promise<InspectionProject> {
    this.validateIdentity?.(input);
    const profile = await this.inspectionRulesStore.readForProject(input.projectPath, input.maintainerId ?? undefined);
    const current = this.projectFor(input.projectId, input);
    const scheduleCron = parseInspectionCron(input.scheduleCron || DEFAULT_SCHEDULE_CRON);
    const scheduleEnabled = Boolean(input.scheduleEnabled);
    const nextRunAt = scheduleEnabled
      ? nextInspectionRunAt(scheduleCron, this.now())
      : null;
    const findingLimit = input.findingLimit === undefined
      ? current?.findingLimit ?? null
      : normalizeFindingLimit(input.findingLimit);
    const project: InspectionProject = {
      ...input,
      findingLimit,
      authorizationError: null,
      jiraIssueType: DEFAULT_INSPECTION_JIRA_ISSUE_TYPE,
      scheduleCron: input.scheduleCron.trim(),
      nextRunAt,
      lastRunAt: current?.lastRunAt ?? null,
      lastRunStatus: current?.lastRunStatus ?? null,
      lastHeadSha: current?.lastHeadSha ?? null,
      ruleSetName: profile.name,
      ruleCount: profile.rules.filter((rule) => rule.enabled).length,
      inspectionRuleIds: profile.rules.filter((rule) => rule.enabled).map((rule) => rule.id),
    };
    this.projects.set(projectScopeKey(project.projectId, project.maintainerId), project);
    this.store.saveProject(project);
    return project;
  }

  listRuns(limit = 100, identity?: InspectionExecutionIdentity): InspectionRun[] {
    return [...this.runs.values()]
      .filter((run) => !identity || run.maintainerId === identity.maintainerId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((run) => this.publicRun(run));
  }

  getRun(id: string, identity?: InspectionExecutionIdentity): InspectionRun | null {
    const run = this.runs.get(id);
    return run && (!identity || run.maintainerId === identity.maintainerId) ? this.publicRun(run) : null;
  }

  findJiraSource(jiraKey: string, identity: InspectionExecutionIdentity): InspectionJiraSource | null {
    const normalizedKey = jiraKey.trim().toLowerCase();
    if (!normalizedKey) return null;
    const runs = [...this.runs.values()]
      .filter((run) => run.maintainerId === identity.maintainerId && run.result)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    for (const run of runs) {
      const findings = [...run.result!.findings, ...run.result!.ruleResults.flatMap((rule) => rule.findings)];
      const finding = findings.find((candidate) => candidate.jira.status === "created"
        && candidate.jira.key?.trim().toLowerCase() === normalizedKey);
      if (finding) return { runId: run.id, findingId: finding.id };
    }
    return null;
  }

  getProgressEvents(id: string, identity?: InspectionExecutionIdentity): ReviewProgressEvent[] | null {
    const run = this.runs.get(id);
    return run && (!identity || run.maintainerId === identity.maintainerId) ? [...run.progress] : null;
  }

  subscribeToProgress(id: string, listener: (event: ReviewProgressEvent) => void, identity?: InspectionExecutionIdentity): () => void {
    const run = this.runs.get(id);
    if (!run || identity && run.maintainerId !== identity.maintainerId) return () => undefined;
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  async enqueue(projectId: string, source: InspectionSource = "manual", identity?: InspectionExecutionIdentity, options: InspectionEnqueueOptions = {}): Promise<{ run: InspectionRun; deduplicated: boolean }> {
    if (this.closing) throw new Error("inspection service is shutting down");
    const project = this.projectFor(projectId, identity);
    if (!project) throw new Error("巡检项目不存在，请先保存项目配置。");
    if (source === "schedule" && (!project.enabled || !project.scheduleEnabled)) {
      throw new Error("巡检项目当前未启用定期巡检。");
    }
    if (!project.enabled) throw new Error("巡检项目当前已停用。");
    const findingLimit = options.findingLimit === undefined
      ? project.findingLimit
      : normalizeFindingLimit(options.findingLimit);

    const activeRun = [...this.runs.values()].find((candidate) =>
      candidate.projectId === project.projectId && sameMaintainerScope(candidate, project) && !TERMINAL_STATUSES.has(candidate.status));
    if (activeRun) return { run: this.publicRun(activeRun), deduplicated: true };

    const executionIdentity = identity ?? project;
    const dependencies = await this.dependenciesFor(executionIdentity);
    const head = await this.latestProjectCommit(project, dependencies.gitlab);

    if (this.closing) throw new Error("inspection service is shutting down");
    // Fetching the commit yields: another request or retry may have queued this project meanwhile.
    const activeRunAfterFetch = [...this.runs.values()].find((candidate) =>
      candidate.projectId === project.projectId && sameMaintainerScope(candidate, project) && !TERMINAL_STATUSES.has(candidate.status));
    if (activeRunAfterFetch) return { run: this.publicRun(activeRunAfterFetch), deduplicated: true };

    const now = this.now().toISOString();
    const run: InternalInspectionRun = {
      id: randomUUID(),
      ...this.executionIdentity(executionIdentity),
      dependencies,
      projectId: project.projectId,
      projectPath: project.projectPath,
      projectName: project.projectName,
      branch: project.branch,
      source,
      status: "queued",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      headSha: head.id,
      error: null,
      result: null,
      findingLimit,
      findingLimitReached: false,
      progress: [],
      controller: null,
      progressSequence: 0,
      listeners: new Set(),
    };
    this.runs.set(run.id, run);
    if (run.maintainerId) this.jiraSyncIdentities.set(run.maintainerId, this.executionIdentity(run));
    this.store.saveRun(run, 0);
    this.appendProgress(run, {
      kind: "stage",
      message: "巡检任务已进入队列",
      detail: `${project.projectPath} · ${project.branch} · ${head.id.slice(0, 12)}`,
      meta: { projectId: project.projectId, headSha: head.id, source },
    });
    if (source === "schedule") {
      this.saveProject({ ...project, nextRunAt: nextInspectionRunAt(parseInspectionCron(project.scheduleCron), this.now()) });
    }
    this.queuedRuns.push(run);
    this.pump();
    return { run: this.publicRun(run), deduplicated: false };
  }

  async retry(runId: string, identity?: InspectionExecutionIdentity): Promise<InspectionRun> {
    if (this.closing) throw new Error("inspection service is shutting down");
    const run = this.requireRun(runId, identity);
    if (!TERMINAL_STATUSES.has(run.status)) throw new Error("当前巡检仍在进行中，不能重试。");
    if (this.retryingRuns.has(run.id)) throw new Error("该巡检记录正在准备重试，请稍候。");

    const project = this.projectFor(run.projectId, run);
    if (!project) throw new Error("巡检项目配置不存在。");
    if (!project.enabled) throw new Error("巡检项目当前已停用。");
    const activeRun = [...this.runs.values()].find((candidate) =>
      candidate.id !== run.id && candidate.projectId === project.projectId && sameMaintainerScope(candidate, project) && !TERMINAL_STATUSES.has(candidate.status));
    if (activeRun) throw new Error("该项目已有巡检任务正在执行，请稍后再试。");

    this.retryingRuns.add(run.id);
    try {
      const executionIdentity = identity ?? run;
      const dependencies = await this.dependenciesFor(executionIdentity);
      const head = await this.latestProjectCommit(project, dependencies.gitlab);
      Object.assign(run, this.executionIdentity(executionIdentity), { dependencies, jiraOptions: undefined, jiraAuthors: undefined });
      const activeRunAfterFetch = [...this.runs.values()].find((candidate) =>
        candidate.id !== run.id && candidate.projectId === project.projectId && sameMaintainerScope(candidate, project) && !TERMINAL_STATUSES.has(candidate.status));
      if (activeRunAfterFetch) throw new Error("该项目已有巡检任务正在执行，请稍后再试。");

      const now = this.now().toISOString();
      run.projectPath = project.projectPath;
      run.projectName = project.projectName;
      run.branch = project.branch;
      run.status = "queued";
      run.createdAt = now;
      run.startedAt = null;
      run.finishedAt = null;
      run.headSha = head.id;
      run.error = null;
      run.result = null;
      run.progress = [];
      run.controller = null;
      run.findingLimit = project.findingLimit;
      run.findingLimitReached = false;
      run.progressSequence = 0;
      this.store.clearRunProgress(run.id);
      this.store.saveRun(run, 0);
      this.appendProgress(run, {
        kind: "stage",
        message: "巡检记录已重新进入队列",
        detail: `${project.projectPath} · ${project.branch} · ${head.id.slice(0, 12)}`,
        meta: { projectId: project.projectId, headSha: head.id, source: run.source, retry: true },
      });
      this.queuedRuns.push(run);
      this.pump();
      return this.publicRun(run);
    } finally {
      this.retryingRuns.delete(run.id);
    }
  }

  async cancel(runId: string, identity?: InspectionExecutionIdentity): Promise<InspectionRun | null> {
    const run = this.runFor(runId, identity);
    if (!run) return null;
    if (TERMINAL_STATUSES.has(run.status)) return this.publicRun(run);

    run.status = "canceled";
    run.finishedAt = this.now().toISOString();
    this.removeQueuedRun(run.id);
    this.appendProgress(run, {
      kind: "stage",
      message: "巡检已取消",
      detail: "正在停止当前执行并清理资源",
    });
    run.controller?.abort();
    this.pump();
    return this.publicRun(run);
  }

  async delete(runId: string, identity?: InspectionExecutionIdentity): Promise<boolean | null> {
    const run = this.runFor(runId, identity);
    if (!run) return null;
    if (!TERMINAL_STATUSES.has(run.status)) {
      throw new InspectionDeleteError("进行中的巡检任务不能删除，请先等待完成。");
    }
    this.runs.delete(run.id);
    this.removeQueuedRun(run.id);
    this.retryingRuns.delete(run.id);
    this.authorRefreshes.delete(run.id);
    this.ownershipRefreshes.delete(run.id);
    run.listeners.clear();
    const deleted = this.store.deleteRun(run.id);
    if (deleted) this.restoreLatestProjectRun(run.projectId, run.maintainerId);
    return deleted;
  }

  /** @deprecated Legacy compatibility for old clients. Current inspection owner resolution uses resolveOwners. */
  async resolveAuthors(runId: string, identity?: InspectionExecutionIdentity): Promise<InspectionRun> {
    if (this.closing) throw new Error("inspection service is shutting down");
    const run = this.requireRun(runId, identity);
    if (!TERMINAL_STATUSES.has(run.status)) throw new Error("巡检仍在进行中，请等待完成后再读取负责人信息。");
    if (!run.result) throw new Error("巡检结果尚未生成，完成后才能读取负责人信息。");

    const project = this.projectFor(run.projectId, run);
    if (!project) throw new Error("巡检项目配置不存在。");
    const existing = this.authorRefreshes.get(run.id);
    if (existing) return existing;

    await this.prepareDependencies(run);
    const refresh = this.enrichRecordedFindings(run, project, { includeFileCommits: true })
      .then(() => this.publicRun(run))
      .finally(() => this.authorRefreshes.delete(run.id));
    this.authorRefreshes.set(run.id, refresh);
    return refresh;
  }

  async resolveOwners(runId: string, identity?: InspectionExecutionIdentity): Promise<InspectionRun> {
    if (this.closing) throw new Error("inspection service is shutting down");
    const run = this.requireRun(runId, identity);
    if (!TERMINAL_STATUSES.has(run.status)) throw new Error("巡检仍在进行中，请等待完成后再确认负责人。");
    if (!run.result) throw new Error("巡检结果尚未生成，完成后才能确认负责人。");

    const existing = this.ownershipRefreshes.get(run.id);
    if (existing) return existing;
    await this.prepareDependencies(run);
    const refresh = (async () => {
      const findings = uniqueFindings([
        ...run.result!.findings,
        ...run.result!.ruleResults.flatMap((rule) => rule.findings),
      ]).filter((finding) => finding.jira.status !== "created"
        && (finding.jira.ownership?.status !== "resolved" || !finding.jira.ownership.assignee));
      for (let start = 0; start < findings.length; start += 8) {
        const batch = findings.slice(start, start + 8);
        await Promise.all(batch.map((finding) => this.resolveFindingOwner(run, finding, { allowTerminal: true, force: true })));
      }
      this.store.saveRun(run, run.progressSequence);
      return this.publicRun(run);
    })().finally(() => this.ownershipRefreshes.delete(run.id));
    this.ownershipRefreshes.set(run.id, refresh);
    return refresh;
  }

  async resolveOwner(runId: string, findingId: string, identity?: InspectionExecutionIdentity): Promise<InspectionRun> {
    if (this.closing) throw new Error("inspection service is shutting down");
    const run = this.requireRun(runId, identity);
    if (!TERMINAL_STATUSES.has(run.status)) throw new Error("巡检仍在进行中，请等待完成后再确认负责人。");
    if (!run.result) throw new Error("巡检结果尚未生成，完成后才能确认负责人。");

    const finding = this.findFinding(run.result, findingId);
    if (!finding) throw new Error("巡检问题不存在。");
    if (finding.jira.status === "created") return this.publicRun(run);

    await this.prepareDependencies(run);
    await this.resolveFindingOwner(run, finding, { allowTerminal: true, force: true });
    this.store.saveRun(run, run.progressSequence);
    return this.publicRun(run);
  }

  async createJira(runId: string, findingId: string, assignee?: string, identity?: InspectionExecutionIdentity): Promise<InspectionRun> {
    const run = this.requireRun(runId, identity);
    if (run.status !== "completed" || !run.result) throw new Error("巡检完成后才能创建 Jira。");
    const project = this.projectFor(run.projectId, run);
    if (!project) throw new Error("巡检项目配置不存在。");
    const finding = this.findFinding(run.result, findingId);
    if (!finding) throw new Error("巡检问题不存在。");
    if (finding.jira.status === "created") return this.publicRun(run);
    if (project.jiraMode === "off") throw new Error("该项目已关闭 Jira 创建。");
    await this.prepareDependencies(run);
    await this.createJiraForFinding(run, project, finding, assignee);
    this.store.saveRun(run, run.progressSequence);
    return this.publicRun(run);
  }

  async syncJiraStatuses(identity: InspectionExecutionIdentity): Promise<void> {
    if (this.closing) return;
    const scope = identity.maintainerId ?? "";
    this.jiraSyncIdentities.set(scope, this.executionIdentity(identity));
    const pending = this.jiraStatusRefreshes.get(scope);
    if (pending) return pending;
    const lastChecked = this.jiraStatusCheckedAt.get(scope);
    if (lastChecked !== undefined && this.now().getTime() - lastChecked < JIRA_STATUS_SYNC_INTERVAL_MS) return;
    const links = new Set(this.jiraLinkedFindings(identity).map(({ finding }) => finding.jira));
    const keys = [...new Set([...links].map((link) => link.key!))];
    if (!keys.length) return;
    this.jiraStatusCheckedAt.set(scope, this.now().getTime());
    const refresh = this.refreshJiraStatuses(identity, keys, links).finally(() => this.jiraStatusRefreshes.delete(scope));
    this.jiraStatusRefreshes.set(scope, refresh);
    return refresh;
  }

  updateJiraIssueStatus(identity: InspectionExecutionIdentity, issue: JiraIssue): void {
    this.validateIdentity?.(identity);
    this.applyJiraStatuses(identity, new Map([[issue.key, this.jiraIssueStatus(issue)]]));
  }

  markFindingAiResolution(identity: InspectionExecutionIdentity, jiraKey: string, status: "merged" | "reverted" | "unknown"): void {
    this.validateIdentity?.(identity);
    this.applyJiraStatuses(identity, new Map([[jiraKey, { aiResolutionStatus: status }]]));
  }

  markFindingAiMerged(identity: InspectionExecutionIdentity, jiraKey: string): void {
    this.markFindingAiResolution(identity, jiraKey, "merged");
  }

  private jiraLinkedFindings(identity: InspectionExecutionIdentity): Array<{ run?: InternalInspectionRun; finding: InspectionFinding }> {
    const findings: Array<{ run?: InternalInspectionRun; finding: InspectionFinding }> = [...this.runs.values()].flatMap((run) => {
      if (!run.result || run.maintainerId !== identity.maintainerId) return [];
      return [...run.result.findings, ...run.result.ruleResults.flatMap((rule) => rule.findings)]
        .filter((finding) => finding.jira.status === "created" && finding.jira.key)
        .map((finding) => ({ run, finding }));
    });
    for (const { context, finding } of this.findingTracker.list()) {
      if (context.maintainerId === identity.maintainerId && finding.jira.status === "created" && finding.jira.key) {
        findings.push({ finding });
      }
    }
    return findings;
  }

  private jiraIssueStatus(issue: JiraIssue): Partial<InspectionJiraLink> {
    return { issueStatus: issue.status, issueStatusCategory: issue.statusCategory,
      assignee: issue.assignee?.username ?? null, assigneeName: issue.assignee?.name ?? null,
      syncedAt: this.now().toISOString(), syncError: null };
  }

  private applyJiraStatuses(identity: InspectionExecutionIdentity, updates: Map<string, Partial<InspectionJiraLink>>, observedLinks?: Set<InspectionJiraLink>): void {
    const changedRuns = new Set<InternalInspectionRun>();
    for (const { run, finding } of this.jiraLinkedFindings(identity)) {
      const update = updates.get(finding.jira.key!);
      if (!update || observedLinks && !observedLinks.has(finding.jira)) continue;
      finding.jira = { ...finding.jira, ...update };
      if (run) changedRuns.add(run);
      else if (finding.tracking) this.findingTracker.saveJira(finding.tracking.id, finding.jira, identity.maintainerId);
    }
    for (const run of changedRuns) this.store.saveRun(run, run.progressSequence);
  }

  private async refreshJiraStatuses(identity: InspectionExecutionIdentity, keys: string[], observedLinks: Set<InspectionJiraLink>): Promise<void> {
    try {
      this.validateIdentity?.(identity);
      const jira = this.resolveJiraClient ? this.resolveJiraClient(identity) : this.jira;
      if (!jira) throw new Error("请连接维护人员的巡检 Jira 账号后同步状态。");
      for (let offset = 0; offset < keys.length && !this.closing; offset += 50) {
        const batch = keys.slice(offset, offset + 50);
        const updates = new Map<string, Partial<InspectionJiraLink>>();
        try {
          const result = await jira.listIssues({ scope: "all", state: "all", issueKeys: batch, page: 1, perPage: 50 });
          const issues = new Map(result.issues.map((issue) => [issue.key, issue]));
          for (const key of batch) {
            const issue = issues.get(key);
            updates.set(key, issue ? this.jiraIssueStatus(issue) : { syncError: "无法读取此 Jira，请检查问题是否存在及账号权限。" });
          }
        } catch {
          for (const key of batch) updates.set(key, { syncError: "Jira 状态同步失败，已保留上次结果，稍后自动重试。" });
        }
        // A detail read or transition may have updated a link while this request was in flight.
        this.validateIdentity?.(identity);
        if (!this.closing) this.applyJiraStatuses(identity, updates, observedLinks);
      }
    } catch (error) {
      if (!this.closing) this.applyJiraStatuses(identity, new Map(keys.map((key) => [key, { syncError: safeErrorMessage(error, "巡检 Jira 状态暂时无法同步。") }])), observedLinks);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.schedulerTimer);
    for (const run of this.runs.values()) run.controller?.abort();
    await Promise.allSettled([...this.executions.values(), ...this.authorRefreshes.values(), ...this.ownershipRefreshes.values(), ...this.jiraStatusRefreshes.values(), ...this.jiraCreations.values()]);
    await Promise.all([...this.runs.values()].map((run) => this.flushPendingProgress(run)));
    if (this.ownsStore) this.store.close();
  }

  private toInternalRun(run: InspectionRun): InternalInspectionRun {
    return {
      ...run,
      controller: null,
      findingLimit: null,
      findingLimitReached: false,
      progressSequence: run.progress.length,
      listeners: new Set(),
    };
  }

  private saveProject(project: InspectionProject): void {
    this.projects.set(projectScopeKey(project.projectId, project.maintainerId), project);
    this.store.saveProject(project);
  }

  private restoreLatestProjectRun(projectId: string, maintainerId: string | null | undefined): void {
    const project = this.projectFor(projectId, { maintainerId: maintainerId ?? null, maintainerName: null, operatorId: null, operatorName: null });
    if (!project) return;
    const latest = [...this.runs.values()]
      .filter((run) => run.projectId === projectId && sameMaintainerScope(run, project) && TERMINAL_STATUSES.has(run.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
    this.saveProject({
      ...project,
      lastRunAt: latest?.finishedAt ?? null,
      lastRunStatus: latest?.status ?? null,
      lastHeadSha: latest?.headSha ?? null,
    });
  }

  private async latestProjectCommit(project: InspectionProject, gitlab: GitLabClientPort) {
    if (!gitlab.listRepositoryCommits) {
      throw new Error("当前 GitLab 客户端不支持读取项目最新提交。");
    }
    const commits = await gitlab.listRepositoryCommits(project.projectId, {
      ref: project.branch,
      page: 1,
      perPage: 1,
    });
    const head = commits[0];
    if (!head?.id) throw new Error(`分支 ${project.branch} 没有可巡检的提交。`);
    return head;
  }

  private pump(): void {
    if (this.closing || this.active > 0) return;
    const run = this.queuedRuns.shift();
    if (!run) return;
    if (run.status !== "queued") {
      this.pump();
      return;
    }
    this.active += 1;
    const execution = this.execute(run);
    this.executions.set(run.id, execution);
    void execution.then(() => this.finishExecution(run.id), () => this.finishExecution(run.id));
  }

  private removeQueuedRun(runId: string): void {
    const index = this.queuedRuns.findIndex((run) => run.id === runId);
    if (index >= 0) this.queuedRuns.splice(index, 1);
  }

  private finishExecution(runId: string): void {
    this.executions.delete(runId);
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  private async execute(run: InternalInspectionRun): Promise<void> {
    const project = this.projectFor(run.projectId, run);
    if (!project) return;
    let workspace: ReviewWorkspace | null = null;
    run.status = "running";
    run.startedAt = this.now().toISOString();
    run.controller = new AbortController();
    this.store.saveRun(run, run.progressSequence);
    this.appendProgress(run, { kind: "stage", message: "巡检执行器已启动" });

    try {
      await this.prepareDependencies(run);
      const workspaceProvider = run.dependencies?.workspaceProvider;
      this.appendProgress(run, { kind: "stage", message: "加载项目巡检规则", detail: project.projectPath });
      const profile = await this.inspectionRulesStore.readForProject(project.projectPath, run.maintainerId ?? undefined);
      this.appendProgress(run, {
        kind: "stage",
        message: "巡检规则已就绪",
        detail: `${profile.displayName} · ${profile.rules.filter((rule) => rule.enabled).length} 条启用规则`,
        meta: { ruleSet: profile.name, ruleCount: profile.rules.filter((rule) => rule.enabled).length },
      });
      this.initializePartialResult(run, profile);

      if (run.status !== "running") return;

      if (workspaceProvider) {
        this.appendProgress(run, { kind: "stage", message: "创建独立代码工作区", detail: `检出 ${run.headSha?.slice(0, 12)}` });
        workspace = await workspaceProvider.createRepository({
          jobId: run.id,
          projectId: project.projectId,
          projectPath: project.projectPath,
          branch: project.branch,
          headSha: run.headSha!,
        }, { signal: run.controller.signal });
        this.appendProgress(run, { kind: "stage", message: "代码工作区已就绪", detail: workspace.path, meta: { workspacePath: workspace.path } });
      }

      if (run.status !== "running") return;

      this.appendProgress(run, { kind: "stage", message: "启动代码巡检", detail: "取证工具：Read · Grep · Glob · 逐条问题上报" });
      this.validateIdentity?.(run);
      const raw = await this.runner.runInspection({
        projectPath: project.projectPath,
        branch: project.branch,
        headSha: run.headSha!,
        profile,
        findingLimit: run.findingLimit,
        workspacePath: workspace?.path ?? null,
      }, {
        signal: run.controller.signal,
        onProgress: (event) => this.appendProgress(run, event),
        onInspectionFinding: (ruleId, finding) => this.recordAndResolveInspectionFinding(run, profile, project, ruleId, finding),
      });
      if (run.findingLimitReached) {
        await this.completeFindingLimitRun(run, project);
        return;
      }
      if (run.status !== "running") return;

      this.appendProgress(run, { kind: "stage", message: "校验巡检结果并补齐问题记录" });
      const parsed = parseReviewOutput(raw, profile.rules, "巡检");
      await this.reconcileFinalFindings(run, profile, project, parsed);
      if (run.findingLimitReached) {
        await this.completeFindingLimitRun(run, project);
        return;
      }
      // Current owner-aware runners resolve the single owner through AI. Keep
      // the old GitLab-author enrichment only for legacy runners that do not
      // provide the owner resolver.
      if (!this.runner.resolveInspectionOwners) await this.enrichRecordedFindings(run, project);
      if (run.status !== "running") return;
      run.result = this.finalizeInspectionResult(run, profile, parsed);
      this.store.saveRun(run, run.progressSequence);

      if (project.jiraMode === "auto") {
        const findings = uniqueFindings([...run.result.findings, ...run.result.ruleResults.flatMap((rule) => rule.findings)])
          .filter((finding) => finding.jira.status !== "created");
        for (const finding of findings) {
          if (run.status !== "running") return;
          await this.createJiraForFinding(run, project, finding, undefined, finding.jira.ownership);
        }
      }

      if (run.status !== "running") return;
      run.status = "completed";
      run.finishedAt = this.now().toISOString();
      run.controller = null;
      const currentProject = this.projectFor(run.projectId, run) ?? project;
      this.saveProject({
        ...currentProject,
        lastRunAt: run.finishedAt,
        lastRunStatus: run.status,
        lastHeadSha: run.headSha,
        nextRunAt: currentProject.scheduleEnabled
          ? nextInspectionRunAt(parseInspectionCron(currentProject.scheduleCron), this.now())
          : null,
      });
      this.store.saveRun(run, run.progressSequence);
      this.appendProgress(run, {
        kind: "result",
        message: "巡检完成",
        detail: `${run.result.findingCount} 个问题 · ${run.result.gate === "passed" ? "门禁通过" : "需要关注"}`,
        meta: { findingCount: run.result.findingCount, blockingFindingCount: run.result.blockingFindingCount ?? 0 },
      });
    } catch (error) {
      if (run.findingLimitReached) {
        await this.completeFindingLimitRun(run, project);
        return;
      }
      if (run.controller?.signal.aborted) return;
      run.status = "failed";
      run.error = safeErrorMessage(error, "巡检执行失败，请稍后重试。");
      run.finishedAt = this.now().toISOString();
      run.controller = null;
      this.saveProject({ ...project, lastRunAt: run.finishedAt, lastRunStatus: run.status, lastHeadSha: run.headSha });
      this.store.saveRun(run, run.progressSequence);
      this.appendProgress(run, { kind: "error", message: "巡检失败", detail: run.error });
    } finally {
      if (workspace) {
        try {
          await workspace.dispose();
        } catch (error) {
          this.appendProgress(run, { kind: "warning", message: "代码工作区清理遇到问题", detail: safeErrorMessage(error, "工作区未能完全清理") });
        }
      }
      run.controller = null;
      run.findingSources = undefined;
      run.findingWrites = undefined;
      this.appendProgress(run, { kind: "stage", message: "巡检资源已清理" });
      await this.flushPendingProgress(run);
    }
  }

  private initializePartialResult(run: InternalInspectionRun, profile: InspectionPromptProfile): void {
    const rules = profile.rules.filter((rule) => rule.enabled);
    run.ownerResolutions = new Map();
    run.ownerResolutionKeys = new Map();
    run.result = {
      format: "structured",
      summary: "巡检正在执行，已确认的问题会逐条记录。",
      ruleFindingCount: 0,
      findingCount: 0,
      headSha: run.headSha,
      ruleResults: rules.map((rule) => ({
        ruleId: rule.id,
        ruleName: rule.name,
        conclusion: "等待执行",
        findings: [],
      })),
      findings: [],
    };
    this.store.saveRun(run, run.progressSequence);
  }

  private async recordAndResolveInspectionFinding(
    run: InternalInspectionRun,
    profile: InspectionPromptProfile,
    project: InspectionProject,
    ruleId: string | null,
    input: unknown,
    { emitProgress = true }: { emitProgress?: boolean } = {},
  ): Promise<InspectionFindingReportResult> {
    if (run.findingLimitReached) {
      return { recorded: false, duplicate: false, findingId: "", message: "本次巡检已达到问题发现上限，已停止继续记录。" };
    }
    const recorded = await this.recordInspectionFinding(run, profile, ruleId, input);
    const finding = run.result ? this.findFinding(run.result, recorded.findingId) : null;
    if (finding && project.jiraMode !== "off") await this.resolveFindingOwner(run, finding);
    if (finding && emitProgress) this.emitInspectionFindingProgress(run, profile, ruleId, finding, recorded.duplicate);
    if (finding && recorded.recorded && !recorded.duplicate && run.findingLimit !== null
      && run.result?.findingCount !== undefined && run.result.findingCount >= run.findingLimit) {
      this.markFindingLimitReached(run);
    }
    return recorded;
  }

  private markFindingLimitReached(run: InternalInspectionRun): void {
    if (run.findingLimitReached || run.findingLimit === null || !run.result) return;
    run.findingLimitReached = true;
    this.appendProgress(run, {
      kind: "stage",
      message: "已达到问题发现上限，自动终止巡检",
      detail: `已记录 ${run.result.findingCount} 个去重问题，本次上限为 ${run.findingLimit} 个。`,
      meta: { findingLimit: run.findingLimit, findingCount: run.result.findingCount },
    });
    run.controller?.abort();
  }

  private async completeFindingLimitRun(run: InternalInspectionRun, project: InspectionProject): Promise<void> {
    if (!run.findingLimitReached || run.status !== "running" || !run.result || run.findingLimit === null) return;
    this.refreshInspectionResultCounts(run);
    const blocking = uniqueFindings([
      ...run.result.findings,
      ...run.result.ruleResults.flatMap((rule) => rule.findings),
    ]).filter((finding) => ["critical", "high"].includes(finding.severity.toLowerCase()));
    run.result.summary = `已发现 ${run.result.findingCount} 个问题，达到上限 ${run.findingLimit} 个，巡检自动终止。`;
    run.result.gate = blocking.length === 0 ? "passed" : "failed";
    run.result.blockingFindingCount = blocking.length;
    run.result.blockingSeverities = [...new Set(blocking.map((finding) => finding.severity))];
    run.status = "completed";
    run.finishedAt = this.now().toISOString();
    run.error = null;
    run.controller = null;
    const currentProject = this.projectFor(run.projectId, run) ?? project;
    this.saveProject({
      ...currentProject,
      lastRunAt: run.finishedAt,
      lastRunStatus: run.status,
      lastHeadSha: run.headSha,
      nextRunAt: currentProject.scheduleEnabled
        ? nextInspectionRunAt(parseInspectionCron(currentProject.scheduleCron), this.now())
        : null,
    });
    this.store.saveRun(run, run.progressSequence);

    if (project.jiraMode === "auto") {
      const findings = uniqueFindings([...run.result.findings, ...run.result.ruleResults.flatMap((rule) => rule.findings)])
        .filter((finding) => finding.jira.status !== "created");
      for (const finding of findings) await this.createJiraForFinding(run, project, finding, undefined, finding.jira.ownership);
      this.store.saveRun(run, run.progressSequence);
    }
    this.appendProgress(run, {
      kind: "result",
      message: "巡检完成",
      detail: `${run.result.findingCount} 个问题 · 达到问题发现上限后自动终止`,
      meta: { findingCount: run.result.findingCount, findingLimit: run.findingLimit, blockingFindingCount: run.result.blockingFindingCount ?? 0 },
    });
  }

  private recordInspectionFinding(run: InternalInspectionRun, profile: InspectionPromptProfile, ruleId: string | null,
    input: unknown): Promise<InspectionFindingReportResult> {
    const write = (run.findingWrites ?? Promise.resolve()).then(() => this.recordInspectionFindingOnce(run, profile, ruleId, input));
    run.findingWrites = write.catch(() => undefined);
    return write;
  }

  private async recordInspectionFindingOnce(
    run: InternalInspectionRun,
    profile: InspectionPromptProfile,
    ruleId: string | null,
    input: unknown,
  ): Promise<InspectionFindingReportResult> {
    if (!this.runs.has(run.id) || run.status !== "running") {
      throw new Error("当前巡检已结束，不能继续记录问题。");
    }
    const parsed = InspectionFindingReportInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`问题上报格式无效：${parsed.error.message}`);
    }
    const rule = ruleId ? profile.rules.find((candidate) => candidate.id === ruleId && candidate.enabled) : null;
    if (ruleId && !rule) throw new Error("问题所属的巡检规则无效或未启用。");
    if (!run.result) this.initializePartialResult(run, profile);
    const result = run.result!;
    const normalized = { ...parsed.data, path: inspectionRepositoryPath(parsed.data.path) ?? parsed.data.path.trim() };
    const fingerprint = findingFingerprint(normalized);
    const existing = uniqueFindings([
      ...result.findings,
      ...result.ruleResults.flatMap((candidate) => candidate.findings),
    ]).find((candidate) => candidate.fingerprint === fingerprint);
    const ruleResult = ruleId
      ? result.ruleResults.find((candidate) => candidate.ruleId === ruleId)
      : null;

    if (existing) {
      mergeFindingScope(existing, normalized);
      if (ruleResult && !ruleResult.findings.some((candidate) => candidate.fingerprint === fingerprint)) {
        ruleResult.findings.push(existing);
        this.refreshInspectionResultCounts(run);
      }
      this.store.saveRun(run, run.progressSequence);
      return {
        recorded: true,
        duplicate: true,
        findingId: existing.id,
        message: "该问题已经记录，本次已关联到当前规则。",
      };
    }

    let finding: InspectionFinding = {
      id: randomUUID(),
      fingerprint,
      severity: normalized.severity,
      category: normalized.category,
      path: normalized.path,
      line: normalized.line,
      issue: normalized.issue,
      suggestion: normalized.suggestion,
      scope: normalized.scope,
      relatedPaths: normalized.relatedPaths,
      author: null,
      jira: emptyJiraLink(null),
    };
    try {
      finding = await this.findingTracker.track(run, ruleId, finding, {
        readLines: (ref, filePath) => this.readFindingLines(run, ref, filePath),
        resolveDuplicates: async (input) => {
          if (!this.runner.resolveInspectionDuplicates) throw new Error("当前巡检模型未提供问题去重核对能力，已停止建单。");
          this.appendProgress(run, { kind: "stage", message: "正在核对是否为已有问题", detail: finding.path });
          try {
            return await this.runner.resolveInspectionDuplicates(input, { signal: run.controller?.signal, ownerId: run.maintainerId ?? undefined });
          } catch (error) {
            throw new Error(`问题去重核对失败，已停止建单：${safeErrorMessage(error, "请稍后重试")}`);
          }
        },
        authorizeLegacy: async (legacy) => {
          if (legacy.jira.status !== "created" || !legacy.jira.key) return true;
          try {
            this.validateIdentity?.(run);
            const issue = await run.dependencies?.jira?.getIssue(legacy.jira.key);
            if (!issue) return false;
            this.validateIdentity?.(run);
            legacy.jira = { ...legacy.jira, ...this.jiraIssueStatus(issue) };
            return true;
          } catch { return false; }
        },
        validate: () => {
          this.validateIdentity?.(run);
          if (run.status !== "running" || run.result !== result || !this.runs.has(run.id)) throw new Error("当前巡检已结束，不能继续记录问题。");
        },
      });
    } catch (error) {
      const duplicateCheck = error instanceof InspectionDuplicateInvalidAssociationError ? "invalid" : "uncertain";
      if (!(error instanceof InspectionDuplicateUncertainError) && !(error instanceof InspectionDuplicateInvalidAssociationError)) throw error;
      this.appendProgress(run, {
        kind: "warning",
        message: "异常问题候选已隔离，继续处理其他问题",
        detail: `${finding.path}${finding.line ? `:${finding.line}` : ""}：${error.reason}`,
        meta: { findingId: finding.id, duplicateCheck },
      });
      return {
        recorded: false,
        duplicate: false,
        findingId: finding.id,
        message: "问题去重未确认，已隔离该候选，继续处理其他问题。",
      };
    }
    const sameProblem = [...result.findings, ...result.ruleResults.flatMap((candidate) => candidate.findings)]
      .find((candidate) => candidate.tracking?.id === finding.tracking?.id);
    if (sameProblem) {
      mergeFindingScope(sameProblem, finding);
      if (ruleResult && !ruleResult.findings.some((candidate) => candidate.id === sameProblem.id)) ruleResult.findings.push(sameProblem);
      this.refreshInspectionResultCounts(run);
      this.store.saveRun(run, run.progressSequence);
      return { recorded: true, duplicate: true, findingId: sameProblem.id, message: "该问题已经记录，已沿用原问题关联。" };
    }
    if (ruleResult) ruleResult.findings.push(finding);
    else result.findings.push(finding);
    this.refreshInspectionResultCounts(run);
    this.store.saveRun(run, run.progressSequence);
    return {
      recorded: true,
      duplicate: false,
      findingId: finding.id,
      message: "问题已记录，请继续检查当前规则。",
    };
  }

  private emitInspectionFindingProgress(
    run: InternalInspectionRun,
    profile: InspectionPromptProfile,
    ruleId: string | null,
    finding: InspectionFinding,
    duplicate: boolean,
  ): void {
    const rule = ruleId ? profile.rules.find((candidate) => candidate.id === ruleId && candidate.enabled) : null;
    this.appendProgress(run, {
      kind: "finding",
      message: duplicate
        ? "巡检问题已关联到规则"
        : (finding.tracking?.occurrenceCount ?? 1) > 1 ? "已更新已有巡检问题" : "已记录巡检问题",
      detail: `${finding.category} · ${finding.path}${finding.line ? `:${finding.line}` : ""}`,
      finding,
      meta: {
        inspectionRuleId: ruleId,
        inspectionRuleName: rule?.name ?? null,
        findingId: finding.id,
        duplicate,
        ...(duplicate ? {} : { recurring: (finding.tracking?.occurrenceCount ?? 1) > 1 }),
        severity: finding.severity,
      },
    });
  }

  private readFindingLines(run: InternalInspectionRun, ref: string, filePath: string): Promise<string[] | null> {
    const read = run.dependencies?.gitlab.getRepositoryFileBlame;
    if (!read || !ref) return Promise.resolve(null);
    run.findingSources ??= new Map();
    const key = JSON.stringify([ref, filePath]);
    let pending = run.findingSources.get(key);
    if (!pending) {
      // Reuse the existing GitLab file API at the pinned commit; never read local paths supplied by the model.
      pending = read.call(run.dependencies!.gitlab, run.projectId, filePath, ref).catch(() => null);
      run.findingSources.set(key, pending);
    }
    return pending.then((ranges) => ranges?.flatMap((range) => range.lines) ?? null);
  }

  private refreshInspectionResultCounts(run: InternalInspectionRun): void {
    if (!run.result) return;
    const ruleFindings = uniqueFindings(run.result.ruleResults.flatMap((rule) => rule.findings));
    const allFindings = uniqueFindings([...run.result.findings, ...ruleFindings]);
    const blocking = allFindings.filter((finding) => ["critical", "high"].includes(finding.severity.toLowerCase()));
    run.result.ruleFindingCount = ruleFindings.length;
    run.result.findingCount = allFindings.length;
    run.result.blockingFindingCount = blocking.length;
    run.result.blockingSeverities = [...new Set(blocking.map((finding) => finding.severity))];
  }

  private async reconcileFinalFindings(
    run: InternalInspectionRun,
    profile: InspectionPromptProfile,
    project: InspectionProject,
    parsed: ReturnType<typeof parseReviewOutput>,
  ): Promise<void> {
    const candidates: Array<{ ruleId: string | null; finding: ReviewFinding }> = [];
    for (const rule of parsed.ruleResults) {
      for (const finding of rule.findings) candidates.push({ ruleId: rule.ruleId, finding });
    }
    for (const finding of parsed.findings) {
      const owner = parsed.ruleResults.find((rule) => rule.findings.some((candidate) => findingFingerprint(candidate) === findingFingerprint(finding)));
      candidates.push({ ruleId: owner?.ruleId ?? null, finding });
    }

    for (const candidate of candidates) {
      const ruleId = profile.rules.some((rule) => rule.enabled && rule.id === candidate.ruleId) ? candidate.ruleId : null;
      await this.recordAndResolveInspectionFinding(run, profile, project, ruleId, candidate.finding, { emitProgress: false });
    }
  }

  private async enrichRecordedFindings(run: InternalInspectionRun, project: InspectionProject, { includeFileCommits = false }: { includeFileCommits?: boolean } = {}): Promise<void> {
    if (!run.result) return;
    const cache: InspectionAuthorLookupCache = {
      blame: new Map(),
      commits: new Map(),
    };
    const findings = uniqueFindings([
      ...run.result.findings,
      ...run.result.ruleResults.flatMap((rule) => rule.findings),
    ]);
    await Promise.all(findings.map(async (finding) => {
      const author = await this.resolveAuthor(run, project, finding, cache, { includeFileCommits });
      finding.author = author;
    }));
    this.store.saveRun(run, run.progressSequence);
  }

  private finalizeInspectionResult(
    run: InternalInspectionRun,
    profile: InspectionPromptProfile,
    parsed: ReturnType<typeof parseReviewOutput>,
  ): InspectionResultSummary {
    const current = run.result ?? {
      format: "structured" as const,
      summary: "巡检已完成。",
      ruleFindingCount: 0,
      findingCount: 0,
      headSha: run.headSha,
      ruleResults: [],
      findings: [],
    };
    const ruleResults: InspectionRuleResult[] = profile.rules.filter((rule) => rule.enabled).map((rule) => {
      const parsedRule = parsed.ruleResults.find((candidate) => candidate.ruleId === rule.id || candidate.ruleName === rule.name);
      const currentRule = current.ruleResults.find((candidate) => candidate.ruleId === rule.id);
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        conclusion: parsedRule?.conclusion ?? currentRule?.conclusion ?? "未返回该规则的独立结论。",
        findings: currentRule?.findings ?? [],
      };
    });
    const findings = current.findings;
    const ruleFindings = uniqueFindings(ruleResults.flatMap((rule) => rule.findings));
    const allFindings = uniqueFindings([...findings, ...ruleFindings]);
    const blocking = allFindings.filter((finding) => ["critical", "high"].includes(finding.severity.toLowerCase()));
    return {
      format: parsed.format,
      summary: parsed.summary || current.summary,
      ruleFindingCount: ruleFindings.length,
      findingCount: allFindings.length,
      headSha: run.headSha,
      gate: parsed.format === "structured" && blocking.length === 0 ? "passed" : "failed",
      blockingFindingCount: blocking.length,
      blockingSeverities: [...new Set(blocking.map((finding) => finding.severity))],
      ruleResults,
      findings,
    };
  }

  private async resolveAuthor(
    run: InternalInspectionRun,
    project: InspectionProject,
    finding: ReviewFinding,
    cache: InspectionAuthorLookupCache,
    { includeFileCommits = false }: { includeFileCommits?: boolean } = {},
  ): Promise<InspectionAuthor | null> {
    if (finding.scope === "cross_file") return null;
    const fileKey = `${run.projectId}:${run.headSha}:${finding.path}`;
    if (finding.scope !== "file" && finding.line && run.dependencies!.gitlab.getRepositoryFileBlame) {
      const source = await run.findingSources?.get(JSON.stringify([run.headSha, finding.path]));
      let endLine = 0;
      const sourceRange = source?.find((range) => { endLine += range.lines.length; return endLine >= finding.line!; });
      if (sourceRange) return this.resolveJiraAuthor(run, project, authorFromBlame(sourceRange));
      const blameKey = `${fileKey}:${finding.line}`;
      let blame = cache.blame.get(blameKey);
      if (!blame) {
        blame = run.dependencies!.gitlab.getRepositoryFileBlame(run.projectId, finding.path, run.headSha!, finding.line).catch(() => null);
        cache.blame.set(blameKey, blame);
      }
      const ranges = await blame;
      const range = ranges?.[0];
      if (range) return this.resolveJiraAuthor(run, project, authorFromBlame(range));
    }

    if (!includeFileCommits || !run.dependencies!.gitlab.listRepositoryCommits) return null;
    let commits = cache.commits.get(fileKey);
    if (!commits) {
      commits = run.dependencies!.gitlab.listRepositoryCommits(run.projectId, {
        path: finding.path,
        ref: run.headSha!,
        page: 1,
        perPage: 1,
      }).catch(() => null);
      cache.commits.set(fileKey, commits);
    }
    const commit = (await commits)?.[0];
    if (commit) return this.resolveJiraAuthor(run, project, authorFromCommit(commit));

    return null;
  }

  private async resolveJiraAuthor(run: InternalInspectionRun, project: InspectionProject, author: InspectionAuthor): Promise<InspectionAuthor> {
    if (!run.dependencies!.jira || project.jiraMode === "off") return author;
    try {
      const matched = await this.searchJiraAuthor(run, author);
      return { ...author, assignee: matched?.username ?? null };
    } catch {
      return { ...author, assignee: null };
    }
  }

  private async searchJiraAuthor(run: InternalInspectionRun, author: InspectionAuthor): Promise<JiraIdentity | null> {
    if (!run.dependencies!.jira) return null;
    const results = await Promise.all(jiraAuthorSearchQueries(author).map((query) => this.searchInspectionJiraAssignees(run, query)));
    return jiraIdentityForAuthor(author, results.flat());
  }

  private resolveFindingOwner(
    run: InternalInspectionRun,
    finding: InspectionFinding,
    { allowTerminal = false, force = false }: { allowTerminal?: boolean; force?: boolean } = {},
  ): Promise<void> {
    const key = inspectionOwnerResolutionKey(finding);
    const pending = run.ownerResolutions?.get(finding.id);
    if (pending?.key === key) return pending.promise;
    if (!force && run.ownerResolutionKeys?.get(finding.id) === key && finding.jira.ownership) return Promise.resolve();

    run.ownerResolutions ??= new Map();
    run.ownerResolutionKeys ??= new Map();
    let promise!: Promise<void>;
    const request = this.analyzeFindingOwnership(run, [finding], allowTerminal);
    promise = request
      .then(() => {
        const current = run.ownerResolutions?.get(finding.id);
        if (current?.promise === promise) run.ownerResolutionKeys!.set(finding.id, key);
      })
      .finally(() => {
        if (run.ownerResolutions?.get(finding.id)?.promise === promise) run.ownerResolutions.delete(finding.id);
      });
    run.ownerResolutions.set(finding.id, { key, promise });
    return promise;
  }

  private async analyzeFindingOwnership(run: InternalInspectionRun, findings: InspectionFinding[], allowTerminal = false): Promise<void> {
    if (!findings.length) return;
    const result = run.result;
    const validate = () => {
      this.validateIdentity?.(run);
      const statusAllowed = ["running", "completed"].includes(run.status) || allowTerminal && TERMINAL_STATUSES.has(run.status);
      if (run.result !== result || run.controller?.signal.aborted || !this.runs.has(run.id) || !statusAllowed) throw new Error("当前巡检已结束或变更，停止查询负责人。");
    };
    validate();
    const uncertain = (reason: string): InspectionOwnership => ({ status: "uncertain", assignee: null, reason, evidence: [], checkedAt: this.now().toISOString() });
    const decisions = new Map<string, InspectionOwnership>();
    const candidates = findings.filter((finding) => {
      if ([finding.path, ...(finding.relatedPaths ?? [])].some((path) => !inspectionRepositoryPath(path))) {
        decisions.set(finding.id, uncertain("问题文件路径无效，AI 无法判断负责人，请修正问题范围后重试。"));
        return false;
      }
      return true;
    });
    this.appendProgress(run, { kind: "stage", message: "AI 正在查询问题负责人", detail: `结合最新代码历史、Jira 和 MR 判断 ${findings.length} 个问题的归属` });
    try {
      if (!this.runner.resolveInspectionOwners) throw new Error("当前巡检模型未提供负责人判断能力。");
      if (!run.dependencies?.jira) throw new Error("Jira 尚未连接，无法查询负责人。");
      if (candidates.length) {
        const resolved = await this.runner.resolveInspectionOwners({
          projectId: run.projectId, projectPath: run.projectPath, branch: run.branch, headSha: run.headSha!,
          jiraProjectKey: run.dependencies.jiraProjectKey(), gitlab: run.dependencies.gitlab, jira: run.dependencies.jira, validate,
          findings: candidates.map(({ id, path, line, scope, relatedPaths, issue, suggestion, jira }) => ({ id, path, line, scope, relatedPaths, issue, suggestion, jiraKey: jira.key })),
        }, { signal: run.controller?.signal, ownerId: run.maintainerId ?? undefined, onProgress: (event) => { validate(); this.appendProgress(run, event); } });
        for (const finding of candidates) {
          const matches = resolved.filter((entry) => entry.findingId === finding.id);
          decisions.set(finding.id, matches.length === 1 ? matches[0]!.ownership : uncertain("AI 未返回该问题的唯一负责人判断，请重试。"));
        }
      }
    } catch (error) {
      validate();
      const reason = safeErrorMessage(error, "AI 查询负责人失败，请稍后重试。");
      for (const finding of candidates) decisions.set(finding.id, uncertain(reason));
      this.appendProgress(run, { kind: "warning", message: "部分问题负责人尚未确定", detail: reason });
    }
    validate();
    for (const finding of findings) {
      const ownership = decisions.get(finding.id)!;
      finding.jira = { ...finding.jira, ownership, assignee: ownership.assignee, assigneeName: null,
        assignmentSource: ownership.status === "resolved" ? "ai" : undefined,
        status: ownership.status === "resolved" ? "not_created" : "skipped", error: ownership.status === "resolved" ? null : ownership.reason };
    }
    this.store.saveRun(run, run.progressSequence);
  }

  private async resolveFindingAssignee(run: InternalInspectionRun, finding: InspectionFinding, selectedAssignee?: string, freshOwnership?: InspectionOwnership): Promise<Partial<InspectionJiraLink>> {
    // Owner confirmation is a separate operation. Jira creation may validate the
    // already confirmed account, but it must never trigger another AI judgment.
    const owner = freshOwnership ?? finding.jira.ownership;
    const username = selectedAssignee?.trim() || (owner?.status === "resolved" ? owner.assignee : null);
    const unresolved = (error: string): Partial<InspectionJiraLink> => ({ status: "skipped", assignee: null, assigneeName: null, assignmentSource: undefined, error });
    if (!username) return unresolved(owner?.reason ?? "问题负责人尚未确定，请先确认负责人。");
    if (!run.dependencies?.jira) return unresolved("Jira 尚未连接，无法验证负责人，请连接后重试。");
    try {
      // Revalidate assignability at creation time rather than trusting cached ownership results.
      const users = await run.dependencies.jira.listAssignableUsers(run.dependencies.jiraProjectKey(), username);
      const matched = users.filter((user) => user.username.trim().toLowerCase() === username.toLowerCase());
      if (matched.length !== 1) return unresolved(`无法确认 Jira 账号 ${username} 在当前项目可分派，请重新确认负责人。`);
      return { status: "not_created", assignee: matched[0]!.username, assigneeName: matched[0]!.name,
        assignmentSource: selectedAssignee ? "manual" : "ai", error: null };
    } catch {
      return unresolved("Jira 负责人验证失败，请稍后重试创建 Jira。");
    }
  }

  private async searchInspectionJiraAssignees(run: InternalInspectionRun, query: string): Promise<JiraIdentity[]> {
    if (!run.dependencies!.jira) return [];
    const projectKey = run.dependencies!.jiraProjectKey();
    const cacheKey = `${projectKey}\u0000${query.trim().toLowerCase()}`;
    const cache = run.jiraAuthors ??= new Map();
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const request = run.dependencies!.jira.listAssignableUsers(projectKey, query).catch((error) => {
      cache.delete(cacheKey);
      throw error;
    });
    cache.set(cacheKey, request);
    return request;
  }

  private async createJiraForFinding(run: InternalInspectionRun, project: InspectionProject, finding: InspectionFinding, assignee?: string, freshOwnership?: InspectionOwnership): Promise<void> {
    const id = finding.tracking?.id;
    const key = id ?? JSON.stringify([run.maintainerId, run.projectId, run.branch, finding.fingerprint]);
    const pending = this.jiraCreations.get(key);
    if (pending) {
      await pending;
      const saved = id ? this.findingTracker.get(id, run.maintainerId)?.finding.jira : null;
      if (saved) finding.jira = { ...saved };
      return;
    }
    const creation = this.createTrackedJira(run, this.projectFor(project.projectId, run) ?? project, finding, assignee, freshOwnership).finally(() => this.jiraCreations.delete(key));
    this.jiraCreations.set(key, creation);
    return creation;
  }

  private async createTrackedJira(run: InternalInspectionRun, project: InspectionProject, finding: InspectionFinding, selectedAssignee?: string, freshOwnership?: InspectionOwnership): Promise<void> {
    this.validateIdentity?.(run);
    const result = run.result;
    if (finding.jira.status === "created") return;
    const duplicate = finding.tracking ? this.findingTracker.get(finding.tracking.id, run.maintainerId)?.finding.jira : null;
    if (duplicate?.status === "created") {
      finding.jira = { ...duplicate };
      return;
    }
    if (project.jiraMode === "off") return;
    if (!run.dependencies!.jira) {
      finding.jira = { ...finding.jira, status: "failed", error: "Jira 服务尚未连接。" };
      this.appendProgress(run, { kind: "warning", message: "Jira 创建跳过", detail: finding.jira.error });
      return;
    }
    if (!project.jiraComponent || !project.jiraFixVersion) {
      finding.jira = { ...finding.jira, status: "skipped", error: "请先配置 Jira 模块和修复版本。" };
      this.appendProgress(run, { kind: "warning", message: "Jira 创建跳过", detail: finding.jira.error });
      return;
    }

    this.appendProgress(run, { kind: "stage", message: "正在创建 Jira 问题", detail: `${finding.path}${finding.line ? `:${finding.line}` : ""}` });
    try {
      const assignment = await this.resolveFindingAssignee(run, finding, selectedAssignee, freshOwnership);
      finding.jira = { ...finding.jira, ...assignment };
      const assignee = finding.jira.assignee;
      if (!assignee) {
        this.appendProgress(run, { kind: "warning", message: "Jira 负责人待确认", detail: finding.jira.error });
        return;
      }
      const jiraOptions = await this.getInspectionJiraCreateOptions(run);
      const issueType = resolveInspectionJiraIssueType(jiraOptions.issueTypes);
      if (!issueType) throw new Error("Jira 当前项目没有可用的缺陷问题类型，无法同步巡检问题。");
      const issueTypeOptions = await this.getInspectionJiraCreateOptions(run, issueType);
      const priority = resolveInspectionJiraPriority(finding.severity, issueTypeOptions.priorities);
      if (!priority) {
        const availablePriorities = issueTypeOptions.priorities.map((option) => option.name).join("、") || "无";
        throw new Error(`Jira 缺陷类型没有与巡检级别“${finding.severity}”匹配的优先级；当前可选：${availablePriorities}。`);
      }
      this.validateIdentity?.(run);
      if (run.result !== result || run.controller?.signal.aborted || !this.runs.has(run.id) || !["running", "completed"].includes(run.status)) return;
      const promptInput: InspectionJiraCreatePromptInput = {
        projectPath: project.projectPath,
        branch: run.branch,
        headSha: run.headSha ?? "unknown",
        createdAt: run.createdAt,
        finding: {
          severity: finding.severity,
          category: finding.category,
          path: finding.path,
          line: finding.line,
          issue: finding.issue,
          suggestion: finding.suggestion,
          scope: finding.scope,
          relatedPaths: finding.relatedPaths,
        },
        owner: {
          username: assignee,
          name: finding.jira.assigneeName ?? null,
          reason: finding.jira.ownership?.reason ?? "负责人已通过人工确认。",
          evidence: finding.jira.ownership?.evidence ?? [],
          source: finding.jira.assignmentSource === "manual" ? "manual" : "ai",
        },
      };
      let createPlan = normalizeInspectionJiraCreatePlan({
        description: buildDefaultInspectionJiraDescription(promptInput),
        labels: [],
        dueDate: null,
      }, promptInput);
      if (this.promptRunner) {
        try {
          createPlan = normalizeInspectionJiraCreatePlan(
            await this.promptRunner.generateInspectionJiraCreatePlan(promptInput, { signal: run.controller?.signal, ownerId: run.maintainerId ?? undefined }),
            promptInput,
          );
        } catch (error) {
          this.appendProgress(run, {
            kind: "warning",
            message: "Jira 提示词生成失败，已使用内置规范",
            detail: safeErrorMessage(error, "无法生成 Jira 描述和字段"),
          });
        }
      }
      const issue = await run.dependencies!.jira.createIssue(run.dependencies!.jiraProjectKey(), {
        summary: buildInspectionJiraSummary(finding.severity, finding.issue, finding.path, finding.line),
        issueType,
        components: [project.jiraComponent],
        fixVersions: [project.jiraFixVersion],
        priority,
        description: createPlan.description,
        dueDate: createPlan.dueDate ?? undefined,
        assignee: assignee ?? undefined,
        customFields: {},
        labels: createPlan.labels,
      });
      finding.jira = {
        ...finding.jira,
        status: "created",
        key: issue.key,
        url: issue.webUrl ?? null,
        assignee,
        error: null,
        ...this.jiraIssueStatus(issue),
      };
      if (finding.tracking) {
        this.findingTracker.saveJira(finding.tracking.id, finding.jira, run.maintainerId);
        for (const related of this.runs.values()) {
          if (!related.result || related.maintainerId !== run.maintainerId) continue;
          let changed = false;
          for (const copy of [...related.result.findings, ...related.result.ruleResults.flatMap((rule) => rule.findings)]) {
            if (copy.tracking?.id === finding.tracking.id) { copy.jira = { ...finding.jira }; changed = true; }
          }
          if (changed) this.store.saveRun(related, related.progressSequence);
        }
      }
      this.appendProgress(run, { kind: "stage", message: "Jira 问题已创建", detail: issue.key, meta: { jiraKey: issue.key } });
    } catch (error) {
      finding.jira = { ...finding.jira, status: "failed", error: safeErrorMessage(error, "Jira 创建失败") };
      this.appendProgress(run, { kind: "warning", message: "Jira 创建失败，但巡检结果已保留", detail: finding.jira.error });
    }
  }

  private async getInspectionJiraCreateOptions(run: InternalInspectionRun, issueTypeId?: string): Promise<JiraCreateIssueOptions> {
    if (!run.dependencies!.jira) throw new Error("Jira 服务尚未连接。");
    const projectKey = run.dependencies!.jiraProjectKey();
    const cacheKey = issueTypeId?.trim() ?? "";
    const cache = run.jiraOptions ??= new Map();
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const request = run.dependencies!.jira.getCreateIssueOptions(projectKey, issueTypeId).catch((error) => {
      cache.delete(cacheKey);
      throw error;
    });
    cache.set(cacheKey, request);
    return request;
  }

  private findFinding(result: InspectionResultSummary, findingId: string): InspectionFinding | null {
    return [...result.findings, ...result.ruleResults.flatMap((rule) => rule.findings)]
      .find((finding) => finding.id === findingId) ?? null;
  }

  private appendProgress(run: InternalInspectionRun, input: ReviewProgressInput): void {
    if (this.closing || !this.runs.has(run.id)) return;
    const event: ReviewProgressEvent = {
      id: `${run.id}:${run.progressSequence += 1}`,
      at: this.now().toISOString(),
      ...input,
    };
    run.progress.push(event);
    if (run.progress.length > 1_000) run.progress.shift();
    this.queueProgressPersistence(run, run.progressSequence, event);
    for (const listener of run.listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected event stream must not affect the inspection worker.
      }
    }
  }

  private queueProgressPersistence(run: InternalInspectionRun, sequence: number, event: ReviewProgressEvent): void {
    let pending = this.pendingProgressWrites.get(run.id);
    if (!pending) {
      pending = { run, events: [], timer: null, flush: null };
      this.pendingProgressWrites.set(run.id, pending);
    }
    pending.events.push({ sequence, event });
    if (pending.events.length >= PROGRESS_PERSIST_BATCH_SIZE) {
      this.scheduleProgressFlush(pending);
      return;
    }
    if (pending.timer || pending.flush) return;
    pending.timer = setTimeout(() => {
      pending!.timer = null;
      this.scheduleProgressFlush(pending!);
    }, PROGRESS_PERSIST_DEBOUNCE_MS);
    pending.timer.unref?.();
  }

  private scheduleProgressFlush(pending: PendingProgressWrite): Promise<void> {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (pending.flush) return pending.flush;
    const flush = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => {
        const events = pending.events.splice(0);
        if (events.length === 0) return;
        this.store.saveRunBatch(pending.run, events);
      })
      .catch((error) => {
        if (!this.closing) process.stderr.write(`[frontend-pilot] 巡检进度持久化失败：${safeErrorMessage(error, "未知错误")}\n`);
      })
      .finally(() => {
        pending.flush = null;
        if (!this.closing && pending.events.length > 0) this.scheduleProgressFlush(pending);
        else if (this.pendingProgressWrites.get(pending.run.id) === pending) this.pendingProgressWrites.delete(pending.run.id);
      });
    pending.flush = flush;
    return flush;
  }

  private async flushPendingProgress(run: InternalInspectionRun): Promise<void> {
    const pending = this.pendingProgressWrites.get(run.id);
    if (!pending) return;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    while (pending.flush || pending.events.length > 0) {
      if (pending.flush) {
        await pending.flush;
        continue;
      }
      const events = pending.events.splice(0);
      if (events.length > 0) this.store.saveRunBatch(run, events);
    }
    if (this.pendingProgressWrites.get(run.id) === pending) this.pendingProgressWrites.delete(run.id);
  }

  private async scheduleDueProjects(): Promise<void> {
    if (this.closing) return;
    const now = this.now().getTime();
    for (const project of this.projects.values()) {
      if (!project.enabled || !project.scheduleEnabled || !project.nextRunAt) continue;
      if (Date.parse(project.nextRunAt) > now) continue;
      try {
        await this.enqueue(project.projectId, "schedule", project);
      } catch (error) {
        this.saveProject({ ...project, authorizationError: safeErrorMessage(error, "巡检授权不可用"), nextRunAt: nextInspectionRunAt(parseInspectionCron(project.scheduleCron), new Date(now)) });
        process.stderr.write(`[frontend-pilot] 定期巡检 ${project.projectPath} 触发失败：${safeErrorMessage(error, "未知错误")}\n`);
      }
    }
  }

  private projectFor(projectId: string, identity?: InspectionExecutionIdentity): InspectionProject | undefined {
    if (identity) return this.projects.get(projectScopeKey(projectId, identity.maintainerId));
    const legacy = this.projects.get(projectScopeKey(projectId, null));
    if (legacy) return legacy;
    const matches = [...this.projects.values()].filter((project) => project.projectId === String(projectId));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private runFor(runId: string, identity?: InspectionExecutionIdentity): InternalInspectionRun | undefined {
    const run = this.runs.get(String(runId));
    return run && (!identity || run.maintainerId === identity.maintainerId) ? run : undefined;
  }

  private requireRun(runId: string, identity?: InspectionExecutionIdentity): InternalInspectionRun {
    const run = this.runs.get(String(runId));
    if (!run) throw new Error("巡检记录不存在。");
    if (identity && run.maintainerId !== identity.maintainerId) throw new InspectionOwnershipError();
    return run;
  }

  private executionIdentity(identity: InspectionExecutionIdentity): InspectionExecutionIdentity {
    return { maintainerId: identity.maintainerId ?? null, maintainerName: identity.maintainerName ?? null,
      operatorId: identity.operatorId ?? null, operatorName: identity.operatorName ?? null };
  }

  private async dependenciesFor(identity: InspectionExecutionIdentity): Promise<InspectionDependencies> {
    this.validateIdentity?.(identity);
    if (this.resolveDependencies) return this.resolveDependencies(identity);
    if (!this.gitlab) throw new Error("巡检 GitLab 客户端未配置");
    return {
      gitlab: this.gitlab, jira: this.jira, jiraProjectKey: this.jiraProjectKey, workspaceProvider: this.workspaceProvider,
    };
  }

  private async prepareDependencies(run: InternalInspectionRun): Promise<void> {
    run.dependencies = await this.dependenciesFor(run);
    run.jiraOptions = undefined;
    run.jiraAuthors = undefined;
  }

  private publicRun(run: InternalInspectionRun): InspectionRun {
    return {
      id: run.id,
      ...this.executionIdentity(run),
      projectId: run.projectId,
      projectPath: run.projectPath,
      projectName: run.projectName,
      branch: run.branch,
      source: run.source,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      headSha: run.headSha,
      error: run.error,
      result: run.result,
      progress: [...run.progress],
    };
  }
}

function emptyJiraLink(assignee: string | null): InspectionJiraLink {
  return { status: "not_created", key: null, url: null, assignee, error: null };
}

function uniqueFindings(findings: InspectionFinding[]): InspectionFinding[] {
  const unique = new Map<string, InspectionFinding>();
  for (const finding of findings) unique.set(finding.fingerprint, finding);
  return [...unique.values()];
}

function authorFromBlame(range: GitLabRepositoryBlame): InspectionAuthor {
  return authorFromIdentity(range.authorName, range.authorEmail);
}

function authorFromCommit(commit: GitLabRepositoryCommit): InspectionAuthor {
  return authorFromIdentity(commit.authorName, commit.authorEmail);
}

function authorFromIdentity(authorName: string, authorEmail: string): InspectionAuthor {
  const name = authorName || "未知作者";
  const email = authorEmail || null;
  return { name, email, assignee: null };
}
