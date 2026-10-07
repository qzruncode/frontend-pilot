import type { InspectionAiVerification } from "./api-contracts.js";
import type { GitLabClientPort } from "./gitlab-client.js";
import type { GitLabMergeRequestNote, GitLabMergeRequestDetails, GitLabPipelineJob, GitLabPipelineSummary } from "./gitlab-workbench.js";
import { clearGitLabDraftTitle } from "./gitlab-mr-title.js";
import type { GitLabReviewDecision, GitLabReviewDecisionRunner } from "./gitlab-review-decision.js";

export const DEFAULT_INSPECTION_AI_REVIEW_JOB_NAMES = ["claude-mr-agent"] as const;
export const INSPECTION_AI_VERIFICATION_TIMEOUT_MS = 30 * 60 * 1_000;
export const INSPECTION_AI_VERIFICATION_POLL_INTERVAL_MS = 10 * 1_000;
export const INSPECTION_AI_MAX_PRE_SUBMIT_REPAIR_ATTEMPTS = 2;
export const CLAUDE_REVIEW_REPORT_HEADER = "## Claude 代码审查报告";

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const REVIEW_TRACE_OUTPUT_MARKER = "===== Claude Review 输出 =====";
const REVIEW_TRACE_END_MARKERS = ["发送评论到 MR...", "评论已发送到 MR"];
const ACTIVE_PIPELINE_STATUSES = new Set(["created", "waiting_for_resource", "preparing", "waiting_for_callback", "pending", "running", "canceling", "scheduled"]);
const SUCCESS_STATUS = "success";
const VERIFICATION_RETRY_DELAYS_MS = [300, 700, 1_500] as const;
const TRANSIENT_GITLAB_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_GITLAB_ERROR = /\b(fetch failed|network error|network request failed|timed out|timeout|econnreset|econnrefused|enotfound|socket hang up)\b/i;

export type AiVerificationTaskStatus = "failed" | "pipeline_pending" | "review_pending" | "review_fixing" | "mr_open";

export type AiVerificationOutcome =
  | { kind: "pending"; phase: string }
  | { kind: "passed"; evidence: InspectionAiVerification }
  | { kind: "repair"; evidence: InspectionAiVerification; reason: "pipeline" | "review"; feedback: string }
  | { kind: "blocked"; evidence: InspectionAiVerification; error: string }
  | { kind: "terminal"; state: "merged" | "closed" };

export interface AiVerificationTaskSnapshot {
  mr: { projectId: string; iid: string } | null;
  commitSha: string | null;
  verification?: Pick<InspectionAiVerification, "headSha" | "reviewStatus" | "report"> | null;
}

export interface InspectAiVerificationOptions {
  task: AiVerificationTaskSnapshot;
  gitlab: GitLabClientPort;
  reviewJobNames: readonly string[];
  signal: AbortSignal;
  reviewDecisionRunner: GitLabReviewDecisionRunner;
  validate: () => void;
  setVerification: (patch: Partial<InspectionAiVerification>, status: AiVerificationTaskStatus, phase: string) => InspectionAiVerification;
  refreshMr: (mr: GitLabMergeRequestDetails) => void;
  applyMr: (mr: GitLabMergeRequestDetails) => Promise<void>;
  findBaselineFailure?: (failedJobs: GitLabPipelineJob[], currentTraces: Map<string, string | null>) => Promise<{ pipeline: GitLabPipelineSummary; job: GitLabPipelineJob } | null>;
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("处理已停止"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

export function truncatePipelineTrace(value: string, maxBytes = 20_000): string {
  const clean = stripAnsi(value).trim();
  if (Buffer.byteLength(clean, "utf8") <= maxBytes) return clean;
  const headBytes = Math.floor(maxBytes * 0.15);
  const tailBytes = maxBytes - headBytes;
  const head = Buffer.from(clean, "utf8").subarray(0, headBytes).toString("utf8");
  const tail = Buffer.from(clean, "utf8").subarray(-tailBytes).toString("utf8");
  return `${head}\n… [日志已截断] …\n${tail}`;
}

function firstIndexAfter(value: string, markers: readonly string[], startIndex: number): number {
  return markers
    .map((marker) => value.indexOf(marker, startIndex))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
}

function reportHeaderIndexes(value: string): number[] {
  const indexes: number[] = [];
  let searchFrom = 0;
  for (;;) {
    const index = value.indexOf(CLAUDE_REVIEW_REPORT_HEADER, searchFrom);
    if (index < 0) return indexes;
    const atLineStart = index === 0 || value[index - 1] === "\n";
    const lineEnd = value.indexOf("\n", index + CLAUDE_REVIEW_REPORT_HEADER.length);
    const suffix = value.slice(index + CLAUDE_REVIEW_REPORT_HEADER.length, lineEnd < 0 ? value.length : lineEnd);
    if (atLineStart && suffix.trim() === "") indexes.push(index);
    searchFrom = index + CLAUDE_REVIEW_REPORT_HEADER.length;
  }
}

/**
 * The shared CI script prints review.md in a known output section, then logs
 * the GitLab note API response. That response contains a second, escaped copy
 * of the report, so parsing the last header in the whole trace is incorrect.
 * Restrict extraction to the output section and only accept a real line-start
 * report header; this keeps shell tracing and JSON echoes out of the decision.
 */
export function extractClaudeReviewReport(trace: string): string | null {
  const clean = stripAnsi(trace).replace(/\r\n?/g, "\n");
  const outputMarkerIndex = clean.lastIndexOf(REVIEW_TRACE_OUTPUT_MARKER);
  const sectionStart = outputMarkerIndex >= 0 ? outputMarkerIndex : 0;
  const rawEndIndex = firstIndexAfter(clean, REVIEW_TRACE_END_MARKERS, sectionStart);
  const sectionEnd = rawEndIndex >= 0 ? clean.lastIndexOf("\n", rawEndIndex) + 1 : clean.length;
  const headerIndex = reportHeaderIndexes(clean.slice(sectionStart, sectionEnd)).at(-1);
  if (headerIndex === undefined) return null;
  const report = clean.slice(sectionStart + headerIndex, sectionEnd).trim();
  return report || null;
}

export function isActivePipelineStatus(status: string | null | undefined): boolean {
  return ACTIVE_PIPELINE_STATUSES.has(status?.trim().toLowerCase() ?? "");
}

export function isActiveVerification(verification: Pick<InspectionAiVerification, "pipelineStatus" | "reviewJobStatus"> | null | undefined): boolean {
  return isActivePipelineStatus(verification?.pipelineStatus) || isActivePipelineStatus(verification?.reviewJobStatus);
}

export function isSuccessfulJob(job: GitLabPipelineJob | null | undefined): boolean {
  return job?.status?.trim().toLowerCase() === SUCCESS_STATUS;
}

export function isTerminalPipelineStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toLowerCase() ?? "";
  return Boolean(normalized) && !isActivePipelineStatus(normalized);
}

export function isTransientGitLabReadError(error: unknown): boolean {
  if (error instanceof Error && TRANSIENT_GITLAB_ERROR.test(error.message)) return true;
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && TRANSIENT_GITLAB_STATUSES.has(status);
}

export async function retryTransientGitLabRead<T>(
  read: () => Promise<T>,
  options: {
    signal: AbortSignal;
    validate: () => void;
    deadline: number;
    retryDelayMs: number;
    onRetry: () => void;
  },
): Promise<{ ok: true; value: T } | { ok: false; timedOut: true }> {
  for (;;) {
    try {
      return { ok: true, value: await read() };
    } catch (error) {
      if (!isTransientGitLabReadError(error)) throw error;
      const remaining = options.deadline - Date.now();
      if (remaining <= 0) return { ok: false, timedOut: true };
      options.onRetry();
      await abortableDelay(Math.min(Math.max(options.retryDelayMs, 1), remaining), options.signal);
      options.validate();
    }
  }
}

function reviewJobTime(job: GitLabPipelineJob): number {
  for (const value of [job.createdAt, job.startedAt, job.finishedAt]) {
    const timestamp = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

export function reviewJobFor(jobs: GitLabPipelineJob[], names: readonly string[]): GitLabPipelineJob | null {
  const allowed = new Set(names.map((name) => name.trim()).filter(Boolean));
  return jobs
    .filter((job) => allowed.has(job.name.trim()))
    .sort((left, right) => reviewJobTime(right) - reviewJobTime(left) || right.id.localeCompare(left.id, undefined, { numeric: true }))
    .at(0) ?? null;
}

function reviewNoteTime(note: GitLabMergeRequestNote): number {
  const value = note.createdAt ?? note.updatedAt;
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function notesForReviewJob(
  notes: GitLabMergeRequestNote[],
  jobStartedAt: string | null,
  _jobFinishedAt: string | null,
): GitLabMergeRequestNote[] {
  if (!jobStartedAt) return [];
  const startedAt = Date.parse(jobStartedAt);
  if (!Number.isFinite(startedAt)) return [];
  return notes
    .filter((note) => !note.system && note.body.includes(CLAUDE_REVIEW_REPORT_HEADER))
    .filter((note) => {
      const createdAt = reviewNoteTime(note);
      // The note is written by the final curl after the report is printed. Do
      // not require it to land within a small post-finish window: GitLab note
      // visibility can lag while the current verification deadline bounds the
      // wait. Older notes remain excluded by the lower bound.
      return createdAt >= startedAt;
    })
    .sort((left, right) => reviewNoteTime(right) - reviewNoteTime(left)
      || right.id.localeCompare(left.id, undefined, { numeric: true }));
}

export function findLatestClaudeReviewNote(
  notes: GitLabMergeRequestNote[],
  jobStartedAt: string | null,
  jobFinishedAt: string | null = null,
): GitLabMergeRequestNote | null {
  return notesForReviewJob(notes, jobStartedAt, jobFinishedAt)[0] ?? null;
}

/**
 * The CI job posts the exact review.md body as an MR note. A note must be
 * created after this job started; otherwise a passing note from an older
 * commit could incorrectly authorize the current head. There is intentionally
 * no upper bound because GitLab can expose the note after the Job has ended.
 */
export function findClaudeReviewNote(
  notes: GitLabMergeRequestNote[],
  report: string,
  jobStartedAt: string | null,
  jobFinishedAt: string | null = null,
): GitLabMergeRequestNote | null {
  const compact = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const compactReport = compact(report);
  return notesForReviewJob(notes, jobStartedAt, jobFinishedAt)
    .find((note) => compact(note.body).includes(compactReport)) ?? null;
}

function meaningfulFailureLines(trace: string): string[] {
  return stripAnsi(trace)
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length >= 16)
    .filter((line) => /error|failed|failure|duplicate|already been declared|parse_error|assert|test files|lifecycle/.test(line))
    .filter((line) => !/job failed|command terminated|lifecycle|^error during build|^build failed with|^test files/.test(line))
    .map((line) => line.replace(/\b\d+\b/g, "#").replace(/\s+/g, " "))
    .slice(-80);
}

export function failureTracesMatch(left: string, right: string): boolean {
  const rightLines = new Set(meaningfulFailureLines(right));
  return meaningfulFailureLines(left).some((line) => rightLines.has(line));
}

export function formatPipelineJobTrace(job: GitLabPipelineJob, trace: string | null): string {
  const metadata = [
    `Job：${job.name}`,
    `状态：${job.status ?? "unknown"}`,
    job.failureReason ? `失败原因：${job.failureReason}` : "",
  ].filter(Boolean).join("\n");
  return `${metadata}\n${trace ? truncatePipelineTrace(trace) : "无法读取 Job 日志。"}`;
}

async function readVerificationMergeRequest(options: InspectAiVerificationOptions): Promise<GitLabMergeRequestDetails> {
  const { task, gitlab, signal, validate } = options;
  if (!task.mr) throw new Error("缺少 MR 信息，无法验证 Pipeline 和 Review");
  for (let attempt = 0; ; attempt += 1) {
    let detail: GitLabMergeRequestDetails;
    try {
      detail = await gitlab.getMergeRequestDetails!(task.mr.projectId, task.mr.iid);
    } catch (error) {
      if (!isTransientGitLabReadError(error) || attempt >= VERIFICATION_RETRY_DELAYS_MS.length) throw error;
      await abortableDelay(VERIFICATION_RETRY_DELAYS_MS[attempt], signal);
      continue;
    }
    validate();
    const headMatches = !task.commitSha || !detail.headSha || task.commitSha === detail.headSha;
    if (detail.state === "merged" || detail.state === "closed" || headMatches) return detail;
    if (attempt >= VERIFICATION_RETRY_DELAYS_MS.length) {
      throw new Error(`MR 分支已出现其他提交（当前 ${detail.headSha?.slice(0, 12) ?? "未知"}，任务记录 ${task.commitSha?.slice(0, 12) ?? "未知"}），为避免覆盖他人修改已停止处理`);
    }
    await abortableDelay(VERIFICATION_RETRY_DELAYS_MS[attempt], signal);
  }
}

async function inspectAiVerificationOnce(options: InspectAiVerificationOptions): Promise<AiVerificationOutcome> {
  const { task, gitlab, reviewJobNames, signal, reviewDecisionRunner, validate, setVerification, refreshMr, applyMr, findBaselineFailure } = options;
  if (!task.mr) throw new Error("缺少 MR 信息，无法验证 Pipeline 和 Review");
  const detail = await readVerificationMergeRequest(options);
  if (detail.state === "merged" || detail.state === "closed") {
    await applyMr(detail);
    return { kind: "terminal", state: detail.state };
  }
  refreshMr(detail);
  const headSha = detail.headSha;
  if (!headSha) {
    setVerification({ headSha: null, pipelineId: null, pipelineStatus: null, pipelineWebUrl: null, reviewJobId: null, reviewJobName: null, reviewJobStatus: null, reviewJobWebUrl: null, reviewNoteId: null, reviewStatus: "pending", report: null, feedback: null }, "pipeline_pending", "等待 GitLab 返回 MR 当前提交");
    return { kind: "pending", phase: "等待 GitLab 返回 MR 当前提交" };
  }
  const allPipelines: Array<GitLabPipelineSummary | null> = [...detail.pipelines, detail.pipeline];
  const matchingPipelines = allPipelines.filter((pipeline): pipeline is GitLabPipelineSummary => Boolean(pipeline && pipeline.sha === headSha));
  const mergeRequestPipelines = matchingPipelines.filter((pipeline) => pipeline.source === "merge_request_event");
  const pipelines = (mergeRequestPipelines.length > 0 ? mergeRequestPipelines : matchingPipelines)
    .filter((pipeline, index, items) => items.findIndex((item) => item.id === pipeline.id) === index);
  const pipeline = [...pipelines]
    .sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? "") - Date.parse(left.updatedAt ?? left.createdAt ?? ""))[0] ?? null;
  if (!pipeline) {
    setVerification({ headSha, pipelineId: null, pipelineStatus: null, pipelineWebUrl: null, reviewJobId: null, reviewJobName: null, reviewJobStatus: null, reviewJobWebUrl: null, reviewNoteId: null, reviewStatus: "pending", report: null, feedback: null }, "pipeline_pending", "等待当前提交的 GitLab Pipeline");
    return { kind: "pending", phase: "等待当前提交的 GitLab Pipeline" };
  }
  const jobs = await gitlab.listPipelineJobs!(task.mr.projectId, pipeline.id);
  validate();
  const reviewJob = reviewJobFor(jobs, reviewJobNames);
  const baseEvidence: Partial<InspectionAiVerification> = {
    headSha, pipelineId: pipeline.id, pipelineStatus: pipeline.status, pipelineWebUrl: pipeline.webUrl,
    reviewJobId: reviewJob?.id ?? null, reviewJobName: reviewJob?.name ?? null,
    reviewJobStatus: reviewJob?.status ?? null, reviewJobWebUrl: reviewJob?.webUrl ?? null,
    reviewNoteId: null,
  };
  if (!isTerminalPipelineStatus(pipeline.status)) {
    setVerification({ ...baseEvidence, reviewStatus: "pending", report: null, feedback: null }, "pipeline_pending", `正在等待 Pipeline 完成（#${pipeline.id}）`);
    return { kind: "pending", phase: `正在等待 Pipeline 完成（#${pipeline.id}）` };
  }
  if (pipeline.status?.trim().toLowerCase() !== SUCCESS_STATUS) {
    const failedJobs = jobs.filter((job) => !job.allowFailure && !isSuccessfulJob(job) && job.status?.trim().toLowerCase() !== "skipped");
    if (reviewJob && !isSuccessfulJob(reviewJob) && reviewJob.status?.trim().toLowerCase() !== "skipped") {
      const trace = await gitlab.getPipelineJobTrace!(task.mr.projectId, reviewJob.id).catch(() => null);
      const feedback = formatPipelineJobTrace(reviewJob, trace);
      const verification = setVerification({ ...baseEvidence, reviewStatus: "failed", report: null, feedback }, "failed", "Pipeline Review Job 未完成");
      return { kind: "blocked", evidence: verification, error: `Pipeline Review Job「${reviewJob.name}」未成功执行，无法确认机器人评论结果` };
    }
    if (failedJobs.length === 0) {
      const verification = setVerification({ ...baseEvidence, reviewStatus: reviewJob?.status?.trim().toLowerCase() === "skipped" ? "skipped" : "failed", report: null, feedback: `Pipeline #${pipeline.id} 状态为 ${pipeline.status ?? "未知"}，没有可修复的失败 Job。` }, "failed", "Pipeline 未通过");
      return { kind: "blocked", evidence: verification, error: `Pipeline #${pipeline.id} 未通过，且没有可用于修复的失败 Job` };
    }
    const traces = new Map<string, string | null>();
    const traceEntries = await Promise.all(failedJobs.slice(0, 5).map(async (job) => [job.id, await gitlab.getPipelineJobTrace!(task.mr!.projectId, job.id).catch(() => null)] as const));
    traceEntries.forEach(([jobId, trace]) => traces.set(jobId, trace));
    const feedback = failedJobs.slice(0, 5).map((job) => formatPipelineJobTrace(job, traces.get(job.id) ? truncatePipelineTrace(traces.get(job.id)!, 12_000) : null)).join("\n\n");
    if (!traceEntries.some(([, trace]) => Boolean(trace))) {
      const verification = setVerification({ ...baseEvidence, reviewStatus: "failed", report: null, feedback }, "failed", "无法读取 Pipeline 失败日志");
      return { kind: "blocked", evidence: verification, error: `Pipeline #${pipeline.id} 未通过，但无法读取失败 Job 日志，未自动修改代码` };
    }
    const baseline = await findBaselineFailure?.(failedJobs, traces);
    if (baseline) {
      const baselineMessage = `目标分支基线提交在 Pipeline #${baseline.pipeline.id} 的 Job「${baseline.job.name}」中复现了相同失败，属于基线问题；为避免修改无关代码，未自动修复。请先修复目标分支后重试。`;
      const verification = setVerification({ ...baseEvidence, reviewStatus: "skipped", report: null, feedback: `${baselineMessage}\n\n${feedback}` }, "failed", "目标分支基线未通过");
      return { kind: "blocked", evidence: verification, error: baselineMessage };
    }
    const verification = setVerification({ ...baseEvidence, reviewStatus: "failed", report: null, feedback }, "failed", `Pipeline #${pipeline.id} 未通过，准备分析失败日志`);
    return { kind: "repair", evidence: verification, reason: "pipeline", feedback };
  }
  if (!reviewJob) {
    const verification = setVerification({ ...baseEvidence, reviewStatus: "skipped", report: null, feedback: `Pipeline #${pipeline.id} 已成功，但没有找到配置的 Review Job（${reviewJobNames.join("、")}）。` }, "failed", "Pipeline Review Job 未执行");
    return { kind: "blocked", evidence: verification, error: `Pipeline #${pipeline.id} 已成功，但没有找到配置的 Review Job（${reviewJobNames.join("、")}）` };
  }
  const reviewStatus = reviewJob.status?.trim().toLowerCase() ?? "";
  if (!isSuccessfulJob(reviewJob)) {
    if (!isTerminalPipelineStatus(reviewJob.status)) {
      setVerification({ ...baseEvidence, reviewStatus: "pending", report: null, feedback: null }, "review_pending", `正在等待 Pipeline Review Job「${reviewJob.name}」完成`);
      return { kind: "pending", phase: `正在等待 Pipeline Review Job「${reviewJob.name}」完成` };
    }
    const trace = await gitlab.getPipelineJobTrace!(task.mr.projectId, reviewJob.id).catch(() => null);
    const feedback = formatPipelineJobTrace(reviewJob, trace);
    const verification = setVerification({ ...baseEvidence, reviewStatus: reviewStatus === "skipped" ? "skipped" : "failed", report: null, feedback }, "failed", "Pipeline Review Job 未通过");
    return { kind: "blocked", evidence: verification, error: `Pipeline Review Job「${reviewJob.name}」状态为 ${reviewJob.status ?? "未知"}，没有产生可确认的机器人评论` };
  }
  const trace = await gitlab.getPipelineJobTrace!(task.mr.projectId, reviewJob.id).catch(() => null);
  let report = extractClaudeReviewReport(trace ?? "");
  const reviewStartedAt = reviewJob.startedAt ?? reviewJob.createdAt;
  let reviewNote = report
    ? findClaudeReviewNote(detail.notes, report, reviewStartedAt, reviewJob.finishedAt)
    : null;
  if (!reviewNote) {
    const latestNote = findLatestClaudeReviewNote(detail.notes, reviewStartedAt, reviewJob.finishedAt);
    const noteReport = latestNote ? extractClaudeReviewReport(latestNote.body) : null;
    const isSameReport = report && latestNote
      ? findClaudeReviewNote([latestNote], report, reviewStartedAt, reviewJob.finishedAt) === latestNote
      : false;
    if (latestNote && noteReport && (!report || isSameReport)) {
      report = noteReport;
      reviewNote = latestNote;
    }
  }
  if (!report) {
    const feedback = trace ? truncatePipelineTrace(trace) : "Review Job 已成功，但暂时无法读取 Job 日志；正在等待当前机器人评论确认。";
    setVerification({ ...baseEvidence, reviewStatus: "pending", report: null, feedback }, "review_pending", "等待 Pipeline Review 报告或机器人评论确认");
    return { kind: "pending", phase: "等待 Pipeline Review 报告或机器人评论确认" };
  }
  if (!reviewNote) {
    setVerification({ ...baseEvidence, reviewStatus: "pending", report, feedback: "Review Job 已完成，正在等待当前机器人评论写入 MR。" }, "review_pending", "等待 Pipeline Review 机器人评论写入 MR");
    return { kind: "pending", phase: "等待 Pipeline Review 机器人评论写入 MR" };
  }
  const alreadyPassed = task.verification?.reviewStatus === "passed"
    && task.verification.headSha === headSha
    && task.verification.report === report;
  let decision: GitLabReviewDecision;
  if (alreadyPassed) {
    decision = { needsRepair: false, reason: "当前提交的 Review 报告已完成模型裁决。" };
  } else {
    setVerification({ ...baseEvidence, reviewNoteId: reviewNote.id, reviewStatus: "pending", report, feedback: null }, "review_pending", "正在调用模型判断 Pipeline Review 是否需要代码修复");
    validate();
    decision = await reviewDecisionRunner.judgeGitLabReview({
      projectPath: detail.projectPath ?? detail.projectId,
      mrIid: detail.iid,
      headSha,
      report,
    }, { signal });
    validate();
  }
  if (decision.needsRepair) {
    const verification = setVerification({ ...baseEvidence, reviewNoteId: reviewNote.id, reviewStatus: "findings", report, feedback: report }, "review_fixing", "Pipeline Review 发现问题，准备自动修复");
    return { kind: "repair", evidence: verification, reason: "review", feedback: report };
  }
  validate();
  const updatedMr = await clearGitLabDraftTitle(gitlab, detail);
  validate();
  if (updatedMr) {
    detail.title = updatedMr.title;
    detail.draft = updatedMr.draft;
    refreshMr(detail);
  }
  const verification = setVerification({ ...baseEvidence, reviewNoteId: reviewNote.id, reviewStatus: "passed", report, feedback: null }, "mr_open", "Pipeline 与 Pipeline Review 均已通过，等待维护人员审阅");
  return { kind: "passed", evidence: verification };
}

export async function inspectAiVerification(options: InspectAiVerificationOptions): Promise<AiVerificationOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await inspectAiVerificationOnce(options);
    } catch (error) {
      if (!isTransientGitLabReadError(error) || attempt >= VERIFICATION_RETRY_DELAYS_MS.length) throw error;
      options.validate();
      await abortableDelay(VERIFICATION_RETRY_DELAYS_MS[attempt], options.signal);
    }
  }
}
