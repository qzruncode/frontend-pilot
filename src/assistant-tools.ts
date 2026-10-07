import type { ReviewJob, ReviewProgressEvent, ReviewRuleProfile } from "./contracts.js";
import type { GitLabClientPort, MergeRequestSnapshot } from "./gitlab-client.js";
import type { JiraClientPort } from "./jira-client.js";
import type { ReviewRulesStorePort } from "./review-rules.js";
import type { ReviewService } from "./review-service.js";
import { safeErrorMessage } from "./errors.js";

export const ASSISTANT_TOOL_SERVER_NAME = "frontend_pilot";
export const ASSISTANT_READ_ONLY_TOOL_NAMES = [
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_review_stats`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__list_reviews`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_review_detail`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_review_progress`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_merge_request`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_review_rules`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_jira_current_user`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__list_jira_issues`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__list_my_jira_todos`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_jira_issue`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_jira_issue_transitions`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_jira_create_options`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_gitlab_current_user`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__list_gitlab_contributed_projects`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__list_gitlab_project_commits`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_gitlab_commit_activity`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__list_my_gitlab_merge_requests`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_gitlab_merge_request_details`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_gitlab_merge_request_create_options`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__search_gitlab_project_members`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__list_gitlab_pipelines`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__get_gitlab_pipeline_jobs`,
] as const;
export const ASSISTANT_ACTION_TOOL_NAMES = [
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__start_review`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__start_review_from_url`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__cancel_review`,
] as const;
export const ASSISTANT_GITLAB_ACTION_TOOL_NAMES = [
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__create_gitlab_merge_request`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__update_gitlab_merge_request`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__merge_gitlab_merge_request`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__create_gitlab_merge_request_note`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__retry_gitlab_pipeline`,
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__cancel_gitlab_pipeline`,
] as const;
export const ASSISTANT_SIDE_EFFECT_TOOL_NAMES = [
  `mcp__${ASSISTANT_TOOL_SERVER_NAME}__create_jira_issue`,
  ...ASSISTANT_GITLAB_ACTION_TOOL_NAMES,
] as const;
export const ASSISTANT_CUSTOM_TOOL_NAMES = [
  ...ASSISTANT_READ_ONLY_TOOL_NAMES,
  ...ASSISTANT_ACTION_TOOL_NAMES,
  ...ASSISTANT_SIDE_EFFECT_TOOL_NAMES,
] as const;

const MAX_TOOL_TEXT_LENGTH = 20_000;
export const ASSISTANT_MAX_PROGRESS_EVENTS = 20;
const MAX_PROGRESS_MESSAGE_LENGTH = 240;
const MAX_PROGRESS_DETAIL_LENGTH = 800;
const MAX_RULE_CONTENT_LENGTH = 8_000;

type AssistantReviewService = Pick<ReviewService, "stats" | "listJobs" | "getJob" | "getProgressEvents" | "enqueue" | "cancel">;
type AssistantGitLabClient = Pick<GitLabClientPort, "getMergeRequest" | "resolveMergeRequestUrl">;
export type AssistantWorkbenchGitLabClient = Pick<GitLabClientPort, "getCurrentUser" | "listMergeRequests" | "getMergeRequestDetails" | "listPipelines" | "listProjects" | "listContributedProjects" | "listRepositoryCommits">
  & Partial<Pick<GitLabClientPort, "getMergeRequestCreateOptions" | "searchProjectMembers" | "createMergeRequest" | "updateMergeRequest" | "mergeMergeRequest" | "listPipelineJobs" | "retryPipeline" | "cancelPipeline" | "createNote">>;
export type AssistantJiraClient = Pick<
  JiraClientPort,
  "getCurrentUser" | "listIssues" | "getIssue" | "getTransitions" | "getCreateIssueOptions" | "getCreateIssueSupportingOptions" | "createIssue"
>;
type AssistantRulesStore = Pick<ReviewRulesStorePort, "list" | "readForProject">;

export interface AssistantToolContext {
  reviewService: AssistantReviewService;
  gitlab: AssistantGitLabClient;
  reviewRules: AssistantRulesStore;
  jira?: AssistantJiraClient;
  jiraConfigured?: () => boolean;
  jiraProjectKey?: () => string;
  gitlabWorkbench?: () => Promise<AssistantWorkbenchGitLabClient | null>;
}

export interface AssistantToolResult {
  [key: string]: unknown;
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ReviewIdToolInput {
  reviewId: string;
}

export interface ReviewListToolInput {
  limit: number;
}

export interface ReviewProgressToolInput extends ReviewIdToolInput {
  limit: number;
}

export interface MergeRequestToolInput {
  projectId: string;
  mrIid: string;
}

export interface ReviewRulesToolInput {
  projectPath?: string;
}

export interface StartReviewToolInput {
  projectId: string;
  mrIid: string;
  projectPath?: string;
  headSha?: string;
  targetBranch?: string;
}

export interface StartReviewFromUrlToolInput {
  url: string;
}

export function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
}

export function result(data: Record<string, unknown>): AssistantToolResult {
  const text = JSON.stringify(data, null, 2);
  if (text.length > MAX_TOOL_TEXT_LENGTH) {
    return { content: [{ type: "text", text: `${text.slice(0, MAX_TOOL_TEXT_LENGTH)}\n…（工具结果过长，已截断）` }] };
  }
  return { content: [{ type: "text", text }], structuredContent: data };
}

export function failure(error: unknown, fallback: string): AssistantToolResult {
  return {
    content: [{ type: "text", text: safeErrorMessage(error, fallback) }],
    isError: true,
  };
}

function reviewSummary(job: ReviewJob): Record<string, unknown> {
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
    error: job.error ? clip(job.error, 1_000) : null,
    result: job.result
      ? { ...job.result, summary: clip(job.result.summary, 2_000) }
      : null,
  };
}

function progressSummary(events: ReviewProgressEvent[]): Array<Record<string, unknown>> {
  return events.slice(-ASSISTANT_MAX_PROGRESS_EVENTS).map((event) => ({
    id: event.id,
    at: event.at,
    kind: event.kind,
    message: clip(event.message, MAX_PROGRESS_MESSAGE_LENGTH),
    detail: event.detail ? clip(event.detail, MAX_PROGRESS_DETAIL_LENGTH) : null,
    meta: event.meta,
  }));
}

function ruleSummary(profile: ReviewRuleProfile, includeContent: boolean): Record<string, unknown> {
  return {
    name: profile.name,
    displayName: profile.displayName,
    isDefault: profile.isDefault,
    rules: profile.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      enabled: rule.enabled,
      order: rule.order,
      file: rule.file,
      sharedBy: rule.sharedBy,
      ...(includeContent ? { content: clip(rule.content, MAX_RULE_CONTENT_LENGTH) } : {}),
    })),
  };
}

export function getReviewStats(context: AssistantToolContext): AssistantToolResult {
  try {
    return result({ stats: context.reviewService.stats() });
  } catch (error) {
    return failure(error, "无法读取 Review 统计");
  }
}

export function listReviews(context: AssistantToolContext, input: ReviewListToolInput): AssistantToolResult {
  try {
    return result({ reviews: context.reviewService.listJobs(input.limit).map(reviewSummary) });
  } catch (error) {
    return failure(error, "无法读取 Review 任务列表");
  }
}

export function getReviewDetail(context: AssistantToolContext, input: ReviewIdToolInput): AssistantToolResult {
  try {
    const job = context.reviewService.getJob(input.reviewId);
    if (!job) return failure(new Error(`未找到 Review 任务 ${input.reviewId}`), "无法读取 Review 任务");
    return result({ review: reviewSummary(job), progress: progressSummary(job.progress) });
  } catch (error) {
    return failure(error, "无法读取 Review 任务详情");
  }
}

export function getReviewProgress(context: AssistantToolContext, input: ReviewProgressToolInput): AssistantToolResult {
  try {
    const events = context.reviewService.getProgressEvents(input.reviewId);
    if (!events) return failure(new Error(`未找到 Review 任务 ${input.reviewId}`), "无法读取 Review 进度");
    return result({ reviewId: input.reviewId, progress: progressSummary(events.slice(-input.limit)) });
  } catch (error) {
    return failure(error, "无法读取 Review 进度");
  }
}

function mergeRequestSummary(mergeRequest: MergeRequestSnapshot): Record<string, unknown> {
  return {
    targetBranch: mergeRequest.target_branch ?? null,
    headSha: mergeRequest.sha?.trim() || mergeRequest.diff_refs?.head_sha?.trim() || null,
    targetProjectPath: mergeRequest.target_project?.path_with_namespace ?? null,
    sourceProjectPath: mergeRequest.source_project?.path_with_namespace ?? null,
  };
}

export async function getMergeRequest(
  context: AssistantToolContext,
  input: MergeRequestToolInput,
): Promise<AssistantToolResult> {
  try {
    const mergeRequest = await context.gitlab.getMergeRequest(input.projectId, input.mrIid);
    return result({ projectId: input.projectId, mrIid: input.mrIid, mergeRequest: mergeRequestSummary(mergeRequest) });
  } catch (error) {
    return failure(error, "无法读取 GitLab Merge Request");
  }
}

export async function getReviewRules(
  context: AssistantToolContext,
  input: ReviewRulesToolInput,
): Promise<AssistantToolResult> {
  try {
    if (input.projectPath) {
      const profile = await context.reviewRules.readForProject(input.projectPath);
      return result({ profile: ruleSummary(profile, true), matchedProjectPath: input.projectPath });
    }
    const profiles = await context.reviewRules.list();
    return result({ profiles: profiles.map((profile) => ruleSummary(profile, false)) });
  } catch (error) {
    return failure(error, "无法读取审查规则");
  }
}

export async function startReview(
  context: AssistantToolContext,
  input: StartReviewToolInput,
): Promise<AssistantToolResult> {
  try {
    const queued = await context.reviewService.enqueue({ ...input, source: "assistant" });
    return result({ accepted: true, deduplicated: queued.deduplicated, review: reviewSummary(queued.job) });
  } catch (error) {
    return failure(error, "无法启动 Review 任务");
  }
}

export async function startReviewFromUrl(
  context: AssistantToolContext,
  input: StartReviewFromUrlToolInput,
): Promise<AssistantToolResult> {
  try {
    if (!context.gitlab.resolveMergeRequestUrl) {
      return failure(new Error("当前 GitLab 客户端不支持解析 MR 地址"), "无法解析 MR 地址");
    }
    const resolved = await context.gitlab.resolveMergeRequestUrl(input.url);
    return startReview(context, {
      projectId: resolved.projectId,
      mrIid: resolved.mrIid,
      projectPath: resolved.projectPath,
      headSha: resolved.headSha ?? undefined,
      targetBranch: resolved.targetBranch ?? undefined,
    });
  } catch (error) {
    return failure(error, "无法解析并启动 Review 任务");
  }
}

export async function cancelReview(
  context: AssistantToolContext,
  input: ReviewIdToolInput,
): Promise<AssistantToolResult> {
  try {
    const job = await context.reviewService.cancel(input.reviewId);
    if (!job) return failure(new Error(`未找到 Review 任务 ${input.reviewId}`), "无法取消 Review 任务");
    return result({ canceled: true, review: reviewSummary(job) });
  } catch (error) {
    return failure(error, "无法取消 Review 任务");
  }
}
