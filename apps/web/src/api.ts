import {
  AssistantConversationListResponseSchema,
  AssistantConversationResponseSchema,
  AssistantStreamEventSchema,
  AssistantEditOperationSchema,
  AssistantEditSessionSchema,
  AuthResponseSchema,
  CancelResponseSchema,
  ClaudeCliPreviewPortsResponseSchema,
  ClaudeCliProjectSchema,
  ClaudeCliProjectListResponseSchema,
  ClaudeCliSessionSchema,
  ClaudeSettingsSchema,
  ClaudeSettingsTestResponseSchema,
  DeleteResponseSchema,
  FeedbackDetailSchema,
  FeedbackListResponseSchema,
  FeedbackSubmitResponseSchema,
  GitLabConnectionResponseSchema,
  GitLabConnectionTestResponseSchema,
  GitLabCreateMergeRequestInputSchema,
  GitLabGenerateMergeRequestDescriptionInputSchema,
  GitLabGenerateMergeRequestDescriptionResponseSchema,
  GitLabMergeMergeRequestInputSchema,
  GitLabUpdateMergeRequestInputSchema,
  GitLabMergeRequestCreateOptionsSchema,
  GitLabMergeRequestDetailsSchema,
  GitLabMergeRequestSchema,
  GitLabMergeRequestListResponseSchema,
  GitLabNoteResponseSchema,
  GitLabMrAiRepairTaskActionResponseSchema,
  GitLabMrAiRepairTaskDetailSchema,
  GitLabMrAiRepairTaskResponseSchema,
  GitLabOAuthStatusSchema,
  GitLabOverviewResponseSchema,
  GitLabPipelineJobsResponseSchema,
  GitLabPipelineSchema,
  GitLabPipelinesResponseSchema,
  GitLabRecentPushResponseSchema,
  GitLabProjectsResponseSchema,
  JiraBoardResponseSchema,
  JiraCommentResponseSchema,
  JiraConnectionResponseSchema,
  JiraConnectionTokenResponseSchema,
  JiraConnectionTestResponseSchema,
  JiraOAuthStatusSchema,
  JiraAttachmentUploadResponseSchema,
  JiraCreateIssueInputSchema,
  JiraCreateIssueAdvancedOptionsSchema,
  JiraCreateIssueSupportingOptionsSchema,
  JiraCreateIssueSupportingPatchSchema,
  JiraCreateIssueOptionsSchema,
  JiraIssueDetailsSchema,
  JiraIssueListResponseSchema,
  JiraIssueTransitionsResponseSchema,
  JiraOverviewResponseSchema,
  OrdinaryJiraAiPrecheckLookupResponseSchema,
  OrdinaryJiraAiPrecheckResponseSchema,
  OrdinaryJiraAiSupplementResponseSchema,
  OrdinaryJiraAiTaskDetailSchema,
  OrdinaryJiraAiTaskSchema,
  OrdinaryJiraAiTaskSummaryResponseSchema,
  HealthResponseSchema,
  InspectionProjectResponseSchema,
  InspectionProjectsResponseSchema,
  InspectionPromptResponseSchema,
  InspectionPromptProfileSchema,
  InspectionPromptsResponseSchema,
  InspectionRulesResponseSchema,
  InspectionRunSchema,
  InspectionRunResponseSchema,
  InspectionRunsResponseSchema,
  ReviewCreateResponseSchema,
  ReviewJobSchema,
  ReviewListResponseSchema,
  ReviewProgressEventSchema,
  ReviewProfileResponseSchema,
  ReviewRulesResponseSchema,
  ReviewSettingsResponseSchema,
  ResolvedMergeRequestSchema,
  UserListResponseSchema,
  UserActivityResponseSchema,
  UserActivityTrackResponseSchema,
  UserResponseSchema,
} from "@contracts";
import type {
  AssistantConversationMessage,
  AssistantConversationResponse,
  AssistantConversationSummary,
  AssistantEditOperation,
  AssistantEditSession,
  AssistantFocusContext,
  AssistantReviewTaskReference,
  AssistantRunEvent,
  AssistantRunResponse,
  AssistantRunStatus,
  AssistantStreamEvent,
  AuthResponse,
  ClaudeCliPreviewPort,
  ClaudeCliPreviewPortsResponse,
  ClaudeCliProject,
  ClaudeCliProjectListResponse,
  ClaudeCliSession,
  ClaudeSettings,
  ClaudeSettingsTestResponse,
  CreateUserInput,
  FeedbackCategory,
  FeedbackDetail,
  FeedbackListItem,
  FeedbackListResponse,
  FeedbackSubmitResponse,
  CreateReviewProfileInput,
  CreateReviewRuleInput,
  CreateInspectionProfileInput,
  CreateInspectionRuleInput,
  DeleteInspectionProfileInput,
  DeleteInspectionRuleInput,
  DeleteReviewProfileInput,
  DeleteReviewRuleInput,
  GitLabConnectionInput,
  GitLabConnectionResponse,
  GitLabConnectionTestResponse,
  GitLabCreateMergeRequestInput,
  GitLabGenerateMergeRequestDescriptionInput,
  GitLabGenerateMergeRequestDescriptionResponse,
  GitLabMergeMergeRequestInput,
  GitLabUpdateMergeRequestInput,
  GitLabMergeRequest,
  GitLabMergeRequestCreateOptions,
  GitLabMergeRequestDetails,
  GitLabMergeRequestListResponse,
  GitLabNoteResponse,
  GitLabMrAiRepairTaskActionResponse,
  GitLabMrAiRepairTaskDetail,
  GitLabMrAiRepairTaskResponse,
  GitLabOAuthStatus,
  GitLabOverviewResponse,
  GitLabPipelineJobsResponse,
  GitLabPipeline,
  GitLabPipelinesResponse,
  GitLabRecentPush,
  GitLabProjectsResponse,
  JiraBoardResponse,
  JiraCommentResponse,
  JiraConnectionInput,
  JiraConnectionResponse,
  JiraConnectionTokenResponse,
  JiraConnectionTestResponse,
  JiraCredentialInput,
  JiraAttachmentUploadResponse,
  JiraCreateIssueAdvancedOptions,
  JiraCreateIssueInput,
  JiraCreateIssueOptions,
  JiraCreateIssueSupportingOptions,
  JiraCreateIssueSupportingPatch,
  JiraOAuthStatus,
  JiraIssueDetails,
  JiraIssueListResponse,
  JiraIssueTransition,
  JiraIssueTransitionsResponse,
  JiraOverviewResponse,
  OrdinaryJiraAiPrecheckLookupResponse,
  OrdinaryJiraAiPrecheck,
  OrdinaryJiraAiSupplement,
  OrdinaryJiraAiTask,
  OrdinaryJiraAiTaskSummaryResponse,
  OrdinaryJiraAiTaskDetail,
  HealthResponse,
  InspectionProject,
  InspectionProjectsResponse,
  InspectionPrompt,
  InspectionPromptProfile,
  InspectionPromptSummary,
  InspectionPromptsResponse,
  InspectionRulesResponse,
  InspectionRun,
  InspectionRunsResponse,
  StartInspectionInput,
  UpsertInspectionProjectInput,
  ReviewCreateResponse,
  ReviewJob,
  ReviewProgressEvent,
  ReviewRuleProfile,
  ReviewListResponse,
  ReviewRulesResponse,
  ReviewSettings,
  ReviewSettingsResponse,
  ReviewStatus,
  ResolvedMergeRequest,
  ReorderReviewRulesInput,
  ReorderInspectionRulesInput,
  UpdateInspectionRuleInput,
  SubmitFeedbackInput,
  UpdateReviewRuleInput,
  UpdateUserInput,
  UserListItem,
  UserListResponse,
  UserActivityResponse,
  UserActivityTrackResponse,
  UserActivityAction,
  UserResponse,
} from "@contracts";
import { z, type ZodType } from "zod";

export type {
  AssistantConversationMessage,
  AssistantConversationResponse,
  AssistantConversationSummary,
  AssistantEditOperation,
  AssistantEditSession,
  AssistantRunEvent,
  AssistantRunResponse,
  AssistantRunStatus,
  AssistantStreamEvent,
  AuthResponse,
  ClaudeCliPreviewPort,
  ClaudeCliPreviewPortsResponse,
  ClaudeCliProject,
  ClaudeCliProjectListResponse,
  ClaudeCliSession,
  ClaudeSettings,
  FeedbackCategory,
  FeedbackDetail,
  FeedbackListItem,
  FeedbackListResponse,
  FeedbackSubmitResponse,
  CreateReviewProfileInput,
  CreateReviewRuleInput,
  DeleteReviewProfileInput,
  DeleteReviewRuleInput,
  GitLabConnectionInput,
  JiraConnectionInput,
  JiraCredentialInput,
  JiraCreateIssueInput,
  JiraCreateIssueOptions,
  HealthResponse,
  InspectionPrompt,
  InspectionPromptSummary,
  InspectionPromptsResponse,
  ReviewCreateResponse,
  ReviewJob,
  ReviewProgressEvent,
  ReviewRuleProfile,
  ReviewRulesResponse,
  ReviewSettings,
  ReviewSettingsResponse,
  ReviewStatus,
  ResolvedMergeRequest,
  ReorderReviewRulesInput,
  SubmitFeedbackInput,
  CreateUserInput,
  UpdateReviewRuleInput,
  UpdateUserInput,
  UserListItem,
  UserListResponse,
  UserActivityResponse,
  UserActivityTrackResponse,
  UserResponse,
} from "@contracts";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? import.meta.env.BASE_URL).replace(/\/+$/, "");
const InspectionProfileResponseSchema = z.object({ profile: InspectionPromptProfileSchema });

export type {
  ClaudeSettingsTestResponse,
  GitLabConnectionResponse,
  GitLabConnectionTestResponse,
  GitLabCreateMergeRequestInput,
  GitLabMergeMergeRequestInput,
  GitLabUpdateMergeRequestInput,
  GitLabMergeRequest,
  GitLabMergeRequestCreateOptions,
  GitLabMergeRequestDetails,
  GitLabMergeRequestListResponse,
  GitLabNoteResponse,
  GitLabOAuthStatus,
  GitLabOverviewResponse,
  GitLabPipelineJobsResponse,
  GitLabPipeline,
  GitLabPipelinesResponse,
  GitLabRecentPush,
  GitLabProjectsResponse,
  JiraBoardResponse,
  JiraCommentResponse,
  JiraConnectionResponse,
  JiraConnectionTestResponse,
  JiraOAuthStatus,
  JiraIssueDetails,
  JiraIssueListResponse,
  JiraIssueTransition,
  JiraIssueTransitionsResponse,
  JiraOverviewResponse,
  ReviewListResponse,
} from "@contracts";

export interface CreateReviewBody {
  projectId: string;
  projectPath: string;
  mrIid: string;
  headSha: string;
  targetBranch: string;
}

export type AssistantChatMessageInput = { role: "user" | "assistant"; content: string };
export type MergeRequestResolveResponse = ResolvedMergeRequest;

export type GitLabMergeRequestListQuery = {
  scope: "assigned_to_me" | "created_by_me" | "review_requested" | "all";
  state: "opened" | "closed" | "merged" | "all";
  search?: string;
  page?: number;
  perPage?: number;
};

export type GitLabPipelineListQuery = {
  ref?: string;
  status?: string;
  page?: number;
  perPage?: number;
};

export type JiraIssueListQuery = {
  scope: "assigned_to_me" | "reported_by_me" | "all";
  state: "review" | "todo" | "in_progress" | "acceptance" | "done" | "all";
  search?: string;
  projectKey?: string;
  assignee?: string;
  page?: number;
  perPage?: number;
};

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

function isErrorPayload(value: unknown): value is { error?: unknown; details?: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function notifyAuthExpired(path: string, status: number): void {
  if (status !== 401 || typeof window === "undefined") return;
  const normalizedPath = path.split("?", 1)[0];
  if (normalizedPath === "/api/v1/auth/status" || normalizedPath === "/api/v1/session" || normalizedPath.endsWith("/auth/login") || normalizedPath.endsWith("/auth/logout")) return;
  window.dispatchEvent(new CustomEvent("frontend-pilot:auth-expired", { detail: { path: normalizedPath } }));
}

export async function request<T>(path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined && !(init.body instanceof FormData)) headers.set("content-type", "application/json");

  const fetchInit: RequestInit = {
    ...init,
    headers,
    credentials: "include",
    cache: init.cache ?? "no-store",
  };
  const send = () => fetch(`${API_BASE}${path}`, fetchInit);
  let response = await send();
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    notifyAuthExpired(path, response.status);
    const payload = isErrorPayload(body) ? body : null;
    const message = typeof payload?.error === "string" && payload.error
      ? payload.error
      : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, payload?.details);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("服务端返回了无法识别的数据", response.status, parsed.error.issues);
  }
  return parsed.data;
}

export function getHealth(): Promise<HealthResponse> {
  return request("/healthz", HealthResponseSchema);
}

export function testClaudeSettings(body: ClaudeSettings): Promise<ClaudeSettingsTestResponse> {
  return request("/api/v1/model-config/test", ClaudeSettingsTestResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getClaudeSettings(): Promise<ClaudeSettings> {
  return request("/api/v1/model-config", ClaudeSettingsSchema);
}

export function saveClaudeSettings(body: ClaudeSettings): Promise<ClaudeSettings> {
  return request("/api/v1/model-config", ClaudeSettingsSchema, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function getGitLabConnection(): Promise<GitLabConnectionResponse> {
  return request("/api/v1/gitlab-connection", GitLabConnectionResponseSchema);
}

export function saveGitLabConnection(body: GitLabConnectionInput): Promise<GitLabConnectionResponse> {
  return request("/api/v1/gitlab-connection", GitLabConnectionResponseSchema, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function testGitLabConnection(body: GitLabConnectionInput): Promise<GitLabConnectionTestResponse> {
  return request("/api/v1/gitlab-connection/test", GitLabConnectionTestResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getJiraConnection(): Promise<JiraConnectionResponse> {
  return request("/api/v1/jira-connection", JiraConnectionResponseSchema, { cache: "no-store" });
}

export function revealJiraConnectionToken(): Promise<JiraConnectionTokenResponse> {
  return request("/api/v1/jira-connection/reveal-token", JiraConnectionTokenResponseSchema, {
    method: "POST",
    cache: "no-store",
  });
}

export function saveJiraConnection(body: JiraConnectionInput): Promise<JiraConnectionResponse> {
  return request("/api/v1/jira-connection", JiraConnectionResponseSchema, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function testJiraConnection(body: JiraConnectionInput): Promise<JiraConnectionTestResponse> {
  return request("/api/v1/jira-connection/test", JiraConnectionTestResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getJiraOAuthStatus(): Promise<JiraOAuthStatus> {
  return request("/api/v1/jira/oauth/status", JiraOAuthStatusSchema, { cache: "no-store" });
}

export function startJiraOAuth(): void {
  window.location.assign(`${API_BASE}/api/v1/jira/oauth/start`);
}

export function disconnectJiraOAuth(): Promise<JiraOAuthStatus> {
  return request("/api/v1/jira/oauth/disconnect", JiraOAuthStatusSchema, { method: "POST", cache: "no-store" });
}

function queryPath(path: string, values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function getJiraOverview(): Promise<JiraOverviewResponse> {
  return request("/api/v1/jira/overview", JiraOverviewResponseSchema);
}

export function getOrdinaryJiraAiTask(jiraKey: string): Promise<{ task: OrdinaryJiraAiTask | null }> {
  return request(`/api/v1/jira/issues/${encodeURIComponent(jiraKey)}/ai-task`, z.object({ task: OrdinaryJiraAiTaskSchema.nullable() }), { cache: "no-store" });
}

export function getOrdinaryJiraAiTaskSummaries(jiraKeys: readonly string[], signal?: AbortSignal): Promise<OrdinaryJiraAiTaskSummaryResponse> {
  const keys = [...new Set(jiraKeys.map((key) => key.trim().toUpperCase()).filter(Boolean))];
  return request(queryPath("/api/v1/jira/ai-tasks", { keys: keys.join(",") }), OrdinaryJiraAiTaskSummaryResponseSchema, { cache: "no-store", signal });
}

export function getOrdinaryJiraAiPrecheck(jiraKey: string): Promise<OrdinaryJiraAiPrecheckLookupResponse> {
  return request(`/api/v1/jira/issues/${encodeURIComponent(jiraKey)}/ai-precheck`, OrdinaryJiraAiPrecheckLookupResponseSchema, { cache: "no-store" });
}

export function precheckOrdinaryJiraAi(jiraKey: string, body: { projectId: string; projectPath: string; targetBranch: string }): Promise<{ precheck: OrdinaryJiraAiPrecheck }> {
  return request(`/api/v1/jira/issues/${encodeURIComponent(jiraKey)}/ai-precheck`, OrdinaryJiraAiPrecheckResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function suggestOrdinaryJiraAiSupplement(jiraKey: string, body: { projectId: string; projectPath: string; targetBranch: string; precheckId: string; checkId: OrdinaryJiraAiSupplement["checkId"] }): Promise<{ supplement: OrdinaryJiraAiSupplement }> {
  return request(`/api/v1/jira/issues/${encodeURIComponent(jiraKey)}/ai-precheck/supplement`, OrdinaryJiraAiSupplementResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function confirmOrdinaryJiraAiSupplement(jiraKey: string, body: { projectId: string; projectPath: string; targetBranch: string; precheckId: string; checkId: OrdinaryJiraAiSupplement["checkId"]; supplement: string }): Promise<{ precheck: OrdinaryJiraAiPrecheck }> {
  return request(`/api/v1/jira/issues/${encodeURIComponent(jiraKey)}/ai-precheck/supplement/confirm`, OrdinaryJiraAiPrecheckResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function startOrdinaryJiraAi(jiraKey: string, body: { projectId: string; projectPath: string; targetBranch: string; precheckId: string; confirmed: true }): Promise<{ task: OrdinaryJiraAiTask }> {
  return request(`/api/v1/jira/issues/${encodeURIComponent(jiraKey)}/ai-tasks`, z.object({ task: OrdinaryJiraAiTaskSchema }), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getOrdinaryJiraAiTaskDetail(id: string, signal?: AbortSignal): Promise<OrdinaryJiraAiTaskDetail> {
  return request(`/api/v1/jira/ai-tasks/${encodeURIComponent(id)}`, OrdinaryJiraAiTaskDetailSchema, { cache: "no-store", signal });
}

export function retryOrdinaryJiraAi(id: string): Promise<{ task: OrdinaryJiraAiTask }> {
  return request(`/api/v1/jira/ai-tasks/${encodeURIComponent(id)}/retry`, z.object({ task: OrdinaryJiraAiTaskSchema }), { method: "POST" });
}

export function cancelOrdinaryJiraAi(id: string): Promise<{ task: OrdinaryJiraAiTask }> {
  return request(`/api/v1/jira/ai-tasks/${encodeURIComponent(id)}/cancel`, z.object({ task: OrdinaryJiraAiTaskSchema }), { method: "POST" });
}

export function getJiraBoard(member?: string): Promise<JiraBoardResponse> {
  return request(queryPath("/api/v1/jira/board", { member }), JiraBoardResponseSchema);
}

export function listJiraIssues(query: JiraIssueListQuery): Promise<JiraIssueListResponse> {
  return request(queryPath("/api/v1/jira/issues", {
    scope: query.scope,
    state: query.state,
    search: query.search,
    projectKey: query.projectKey,
    assignee: query.assignee,
    page: query.page ?? 1,
    perPage: query.perPage ?? 25,
  }), JiraIssueListResponseSchema);
}

export function getJiraCreateIssueSupportingOptions(): Promise<JiraCreateIssueSupportingOptions> {
  return request("/api/v1/jira/issues/create-options/supporting", JiraCreateIssueSupportingOptionsSchema);
}

export type JiraCreateIssueSupportingField = "assignees" | "components" | "fixVersions" | "labels";

export function getAuthStatus(): Promise<AuthResponse> {
  return request("/api/v1/auth/status", AuthResponseSchema);
}

export function renewSession(): Promise<AuthResponse> {
  return request("/api/v1/session", AuthResponseSchema, { method: "POST", cache: "no-store" });
}

export function login(username: string, password: string): Promise<AuthResponse> {
  return request("/api/v1/auth/login", AuthResponseSchema, {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logout(): Promise<AuthResponse> {
  return request("/api/v1/auth/logout", AuthResponseSchema, { method: "POST" });
}

export function listUsers(): Promise<UserListResponse> {
  return request("/api/v1/users", UserListResponseSchema);
}

export function createUser(body: CreateUserInput): Promise<UserResponse> {
  return request("/api/v1/users", UserResponseSchema, { method: "POST", body: JSON.stringify(body) });
}

export function updateUser(id: string, body: UpdateUserInput): Promise<UserResponse> {
  return request(`/api/v1/users/${encodeURIComponent(id)}`, UserResponseSchema, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteUser(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/v1/users/${encodeURIComponent(id)}`, DeleteResponseSchema, { method: "DELETE" });
}

export function trackUserActivity(path: string): Promise<UserActivityTrackResponse> {
  return request("/api/v1/user-activity", UserActivityTrackResponseSchema, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export type UserActivityQuery = {
  days: number;
  user?: string;
  action?: UserActivityAction;
  usersPage?: number;
  usersPageSize?: number;
  recentPage?: number;
  recentPageSize?: number;
};

export function getUserActivity(query: UserActivityQuery | number): Promise<UserActivityResponse> {
  const options = typeof query === "number" ? { days: query } : query;
  const params = new URLSearchParams({ days: String(options.days) });
  if (options.user) params.set("user", options.user);
  if (options.action) params.set("action", options.action);
  if (options.usersPage !== undefined) params.set("usersPage", String(options.usersPage));
  if (options.usersPageSize !== undefined) params.set("usersPageSize", String(options.usersPageSize));
  if (options.recentPage !== undefined) params.set("recentPage", String(options.recentPage));
  if (options.recentPageSize !== undefined) params.set("recentPageSize", String(options.recentPageSize));
  return request("/api/v1/user-activity?" + params.toString(), UserActivityResponseSchema);
}

export function submitFeedback(body: SubmitFeedbackInput, images: File[] = []): Promise<FeedbackSubmitResponse> {
  if (images.length > 0) {
    const formData = new FormData();
    formData.set("category", body.category);
    formData.set("rating", String(body.rating));
    formData.set("message", body.message);
    if (body.contact) formData.set("contact", body.contact);
    images.forEach((image) => formData.append("images", image, image.name));
    return request("/api/v1/feedback", FeedbackSubmitResponseSchema, { method: "POST", body: formData });
  }
  return request("/api/v1/feedback", FeedbackSubmitResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listFeedback(): Promise<FeedbackListResponse> {
  return request("/api/v1/feedback?limit=100", FeedbackListResponseSchema);
}

export function getFeedback(id: string): Promise<FeedbackDetail> {
  return request(`/api/v1/feedback/${encodeURIComponent(id)}`, FeedbackDetailSchema);
}

export function getFeedbackAttachmentUrl(feedbackId: string, attachmentId: string): string {
  return `${API_BASE}/api/v1/feedback/${encodeURIComponent(feedbackId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export function deleteFeedback(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/v1/feedback/${encodeURIComponent(id)}`, DeleteResponseSchema, { method: "DELETE" });
}

export function listReviews(): Promise<ReviewListResponse> {
  return request("/api/v1/reviews?limit=100", ReviewListResponseSchema);
}

export function listInspectionProjects(): Promise<InspectionProjectsResponse> {
  return request("/api/v1/inspections/projects", InspectionProjectsResponseSchema);
}

export function listInspectionRules(): Promise<InspectionRulesResponse> {
  return request("/api/v1/inspections/rules", InspectionRulesResponseSchema);
}

export function getInspectionRules(): Promise<InspectionRulesResponse> {
  return listInspectionRules();
}

export function getInspectionPrompts(): Promise<InspectionPromptsResponse> {
  return request("/api/v1/inspections/prompts", InspectionPromptsResponseSchema);
}

export function getInspectionPrompt(id: string): Promise<{ prompt: InspectionPrompt }> {
  return request(`/api/v1/inspections/prompts/${encodeURIComponent(id)}`, InspectionPromptResponseSchema);
}

export function saveInspectionPrompt(id: string, content: string): Promise<{ prompt: InspectionPrompt }> {
  return request(`/api/v1/inspections/prompts/${encodeURIComponent(id)}`, InspectionPromptResponseSchema, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

export function createInspectionProfile(body: CreateInspectionProfileInput): Promise<{ profile: InspectionPromptProfile }> {
  return request("/api/v1/inspections/profiles", InspectionProfileResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteInspectionProfile(body: DeleteInspectionProfileInput): Promise<{ deleted: boolean }> {
  return request("/api/v1/inspections/profiles", DeleteResponseSchema, {
    method: "DELETE",
    body: JSON.stringify(body),
  });
}

export function createInspectionRule(body: CreateInspectionRuleInput): Promise<{ profile: InspectionPromptProfile }> {
  return request("/api/v1/inspections/rules", InspectionProfileResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function saveInspectionRule(body: UpdateInspectionRuleInput): Promise<{ profile: InspectionPromptProfile }> {
  return request("/api/v1/inspections/rules", InspectionProfileResponseSchema, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function deleteInspectionRule(body: DeleteInspectionRuleInput): Promise<{ profile: InspectionPromptProfile }> {
  return request("/api/v1/inspections/rules", InspectionProfileResponseSchema, {
    method: "DELETE",
    body: JSON.stringify(body),
  });
}

export function reorderInspectionRules(body: ReorderInspectionRulesInput): Promise<{ profile: InspectionPromptProfile }> {
  return request("/api/v1/inspections/rules/order", InspectionProfileResponseSchema, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function saveInspectionProject(projectId: string, body: UpsertInspectionProjectInput): Promise<{ project: InspectionProject }> {
  return request(`/api/v1/inspections/projects/${encodeURIComponent(projectId)}`, InspectionProjectResponseSchema, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function listInspectionRuns(): Promise<InspectionRunsResponse> {
  return request("/api/v1/inspections/runs?limit=100", InspectionRunsResponseSchema);
}

export function getInspectionRun(id: string): Promise<{ run: InspectionRun }> {
  return request(`/api/v1/inspections/runs/${encodeURIComponent(id)}`, InspectionRunResponseSchema);
}

export function resolveInspectionRunOwners(id: string): Promise<{ run: InspectionRun }> {
  return request(`/api/v1/inspections/runs/${encodeURIComponent(id)}/owners`, InspectionRunResponseSchema, { method: "POST" });
}

export function resolveInspectionFindingOwner(runId: string, findingId: string): Promise<{ run: InspectionRun }> {
  return request(`/api/v1/inspections/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/owner`, InspectionRunResponseSchema, { method: "POST" });
}

export function startInspection(projectId: string, input?: StartInspectionInput): Promise<{ accepted: boolean; deduplicated: boolean; run: InspectionRun }> {
  return request(`/api/v1/inspections/projects/${encodeURIComponent(projectId)}/runs`, InspectionRunResponseSchema.extend({ accepted: z.boolean(), deduplicated: z.boolean() }), {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export function retryInspectionRun(id: string): Promise<{ accepted: boolean; run: InspectionRun }> {
  return request(`/api/v1/inspections/runs/${encodeURIComponent(id)}/retry`, InspectionRunResponseSchema.extend({ accepted: z.boolean() }), { method: "POST" });
}

export function cancelInspectionRun(id: string): Promise<InspectionRun> {
  return request(`/api/v1/inspections/runs/${encodeURIComponent(id)}/cancel`, InspectionRunSchema, { method: "POST" });
}

export function deleteInspectionRun(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/v1/inspections/runs/${encodeURIComponent(id)}`, DeleteResponseSchema, { method: "DELETE" });
}

export function createInspectionJira(runId: string, findingId: string): Promise<{ run: InspectionRun }> {
  return request(`/api/v1/inspections/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/jira`, InspectionRunResponseSchema, { method: "POST", body: JSON.stringify({}) });
}

export function getReviewSettings(): Promise<ReviewSettingsResponse> {
  return request("/api/v1/review-settings", ReviewSettingsResponseSchema);
}

export function saveReviewSettings(body: Pick<ReviewSettings, "reviewConcurrency" | "autoSendComments">): Promise<ReviewSettingsResponse> {
  return request("/api/v1/review-settings", ReviewSettingsResponseSchema, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function getReviewRules(): Promise<ReviewRulesResponse> {
  return request("/api/v1/review-rules", ReviewRulesResponseSchema);
}

export function createReviewProfile(body: CreateReviewProfileInput): Promise<{ profile: ReviewRuleProfile }> {
  return request("/api/v1/review-profiles", ReviewProfileResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteReviewProfile(body: DeleteReviewProfileInput): Promise<{ deleted: boolean }> {
  return request("/api/v1/review-profiles", DeleteResponseSchema, {
    method: "DELETE",
    body: JSON.stringify(body),
  });
}

export function createReviewRule(body: CreateReviewRuleInput): Promise<{ profile: ReviewRuleProfile }> {
  return request("/api/v1/review-rules", ReviewProfileResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function saveReviewRule(body: UpdateReviewRuleInput): Promise<{ profile: ReviewRuleProfile }> {
  return request("/api/v1/review-rules", ReviewProfileResponseSchema, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function deleteReviewRule(body: DeleteReviewRuleInput): Promise<{ profile: ReviewRuleProfile }> {
  return request("/api/v1/review-rules", ReviewProfileResponseSchema, {
    method: "DELETE",
    body: JSON.stringify(body),
  });
}

export function reorderReviewRules(body: ReorderReviewRulesInput): Promise<{ profile: ReviewRuleProfile }> {
  return request("/api/v1/review-rules/order", ReviewProfileResponseSchema, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function createReview(body: CreateReviewBody): Promise<ReviewCreateResponse> {
  return request("/api/v1/reviews", ReviewCreateResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listAssistantConversations(): Promise<{ conversations: AssistantConversationSummary[] }> {
  return request('/api/v1/assistant/conversations?limit=100', AssistantConversationListResponseSchema);
}

export function getAssistantConversation(id: string): Promise<AssistantConversationResponse> {
  return request(`/api/v1/assistant/conversations/${encodeURIComponent(id)}`, AssistantConversationResponseSchema);
}

export function deleteAssistantConversation(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/v1/assistant/conversations/${encodeURIComponent(id)}`, DeleteResponseSchema, { method: "DELETE" });
}

export function deleteAssistantMessage(conversationId: string, messageId: string): Promise<{ deleted: boolean }> {
  return request(`/api/v1/assistant/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`, DeleteResponseSchema, { method: "DELETE" });
}

export function rewindAssistantConversation(conversationId: string, messageId: string): Promise<{ deleted: boolean }> {
  return request(`/api/v1/assistant/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/rewind`, DeleteResponseSchema, { method: "POST" });
}

export function cancelAssistantRun(id: string): Promise<{ canceled: boolean }> {
  return request(`/api/v1/assistant/runs/${encodeURIComponent(id)}/cancel`, CancelResponseSchema, { method: "POST" });
}

export function listClaudeCliProjects(): Promise<ClaudeCliProjectListResponse> {
  return request("/api/v1/claude-cli/projects", ClaudeCliProjectListResponseSchema);
}

export function listClaudeCliPreviewPorts(projectId: string, sessionId: string): Promise<ClaudeCliPreviewPortsResponse> {
  return request(`/api/v1/claude-cli/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/preview-ports`, ClaudeCliPreviewPortsResponseSchema);
}

export function createClaudeCliProject(projectId: string): Promise<{ project: ClaudeCliProject }> {
  return request("/api/v1/claude-cli/projects", z.object({ project: ClaudeCliProjectSchema }), {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
}

export function renameClaudeCliProject(id: string, name: string): Promise<{ project: ClaudeCliProject }> {
  return request(`/api/v1/claude-cli/projects/${encodeURIComponent(id)}`, z.object({ project: ClaudeCliProjectSchema }), {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function stopClaudeCliProject(id: string): Promise<{ project: ClaudeCliProject }> {
  return request(`/api/v1/claude-cli/projects/${encodeURIComponent(id)}/stop`, z.object({ project: ClaudeCliProjectSchema }), { method: "POST" });
}

export function createClaudeCliSession(projectId: string): Promise<{ session: ClaudeCliSession }> {
  return request(`/api/v1/claude-cli/projects/${encodeURIComponent(projectId)}/sessions`, z.object({ session: ClaudeCliSessionSchema }), { method: "POST" });
}

export function renameClaudeCliSession(projectId: string, sessionId: string, name: string): Promise<{ project: ClaudeCliProject }> {
  return request(`/api/v1/claude-cli/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`, z.object({ project: ClaudeCliProjectSchema }), {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteClaudeCliSession(projectId: string, sessionId: string): Promise<{ project: ClaudeCliProject }> {
  return request(`/api/v1/claude-cli/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`, z.object({ project: ClaudeCliProjectSchema }), { method: "DELETE" });
}

export function stopClaudeCliSession(projectId: string, sessionId: string): Promise<{ project: ClaudeCliProject }> {
  return request(`/api/v1/claude-cli/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/stop`, z.object({ project: ClaudeCliProjectSchema }), { method: "POST" });
}

export function deleteClaudeCliProject(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/v1/claude-cli/projects/${encodeURIComponent(id)}`, DeleteResponseSchema, { method: "DELETE" });
}

export function claudeCliTerminalUrl(id: string, sessionId?: string, cols?: number, rows?: number, restart = false): string {
  const base = API_BASE.startsWith("http") ? API_BASE : `${window.location.origin}${API_BASE}`;
  const url = new URL(`${base}/api/v1/claude-cli/projects/${encodeURIComponent(id)}/terminal`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  if (Number.isInteger(cols) && Number.isInteger(rows)) {
    url.searchParams.set("cols", String(cols));
    url.searchParams.set("rows", String(rows));
  }
  if (restart) url.searchParams.set("restart", "1");
  return url.toString();
}

export function createAssistantEditSession(body: { projectId: string; projectPath?: string; baseRef?: string }): Promise<{ session: AssistantEditSession }> {
  return request("/api/v1/assistant/edit-sessions", z.object({ session: AssistantEditSessionSchema }), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listAssistantEditSessions(): Promise<{ sessions: AssistantEditSession[] }> {
  return request("/api/v1/assistant/edit-sessions", z.object({ sessions: z.array(AssistantEditSessionSchema) }));
}

export function getAssistantEditSession(id: string): Promise<{ session: AssistantEditSession }> {
  return request(`/api/v1/assistant/edit-sessions/${encodeURIComponent(id)}`, z.object({ session: AssistantEditSessionSchema }));
}

export function setAssistantEditSessionRetention(id: string, retentionMode: AssistantEditSession["retentionMode"]): Promise<{ session: AssistantEditSession }> {
  return request(`/api/v1/assistant/edit-sessions/${encodeURIComponent(id)}/retention`, z.object({ session: AssistantEditSessionSchema }), {
    method: "POST",
    body: JSON.stringify({ retentionMode }),
  });
}

export function getAssistantEditDiff(id: string, signal?: AbortSignal): Promise<{ session: AssistantEditSession; diff: string; changedFiles: number }> {
  return request(`/api/v1/assistant/edit-sessions/${encodeURIComponent(id)}/diff`, z.object({ session: AssistantEditSessionSchema, diff: z.string(), changedFiles: z.number().int().nonnegative() }), {
    cache: "no-store",
    signal,
  });
}

export function approveAssistantEditOperation(sessionId: string, operationId: string): Promise<{ operation: AssistantEditOperation; session: AssistantEditSession | null }> {
  return request(`/api/v1/assistant/edit-sessions/${encodeURIComponent(sessionId)}/operations/${encodeURIComponent(operationId)}/approve`, z.object({ operation: AssistantEditOperationSchema, session: AssistantEditSessionSchema.nullable() }), { method: "POST" });
}

export function rejectAssistantEditOperation(sessionId: string, operationId: string): Promise<{ operation: AssistantEditOperation; session: AssistantEditSession | null }> {
  return request(`/api/v1/assistant/edit-sessions/${encodeURIComponent(sessionId)}/operations/${encodeURIComponent(operationId)}/reject`, z.object({ operation: AssistantEditOperationSchema, session: AssistantEditSessionSchema.nullable() }), { method: "POST" });
}

export function closeAssistantEditSession(id: string): Promise<{ session: AssistantEditSession | null }> {
  return request(`/api/v1/assistant/edit-sessions/${encodeURIComponent(id)}/close`, z.object({ session: AssistantEditSessionSchema.nullable() }), { method: "POST" });
}

export async function streamAssistantMessage(
  body: {
    conversationId: string;
    messageId?: string;
    runId?: string;
    afterSequence?: number;
    message: string;
    history: AssistantChatMessageInput[];
    focusContext?: AssistantFocusContext;
    editSessionId?: string;
  },
  onEvent: (event: string, payload: AssistantStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const send = () => fetch(`${API_BASE}/api/v1/assistant/stream`, {
    method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
    signal,
  });
  let response = await send();
  if (!response.ok) {
    notifyAuthExpired("/api/v1/assistant/stream", response.status);
    const body: unknown = await response.json().catch(() => null);
    const message = isErrorPayload(body) && typeof body.error === "string"
      ? body.error
      : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, body);
  }
  if (!response.body) throw new ApiError("助手没有返回流式响应", 502);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consume = (chunk: string): void => {
    buffer += chunk;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice("event:".length).trim();
        if (line.startsWith("data:")) data.push(line.slice("data:".length).trim());
      }
      if (data.length === 0) continue;
      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(data.join("\n"));
      } catch {
        throw new ApiError("助手返回了无法解析的流式消息", 502);
      }
      const parsed = AssistantStreamEventSchema.safeParse(rawPayload);
      if (!parsed.success) throw new ApiError("助手返回了格式异常的流式消息", 502, parsed.error.issues);
      onEvent(event, parsed.data);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) consume(decoder.decode(value, { stream: !done }));
    if (done) break;
  }
  consume(decoder.decode());
}

export function resolveMergeRequest(url: string): Promise<MergeRequestResolveResponse> {
  return request("/api/v1/merge-requests/resolve", ResolvedMergeRequestSchema, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export function cancelReview(id: string): Promise<ReviewJob> {
  return request(`/api/v1/reviews/${encodeURIComponent(id)}/cancel`, ReviewJobSchema, { method: "POST" });
}

export function retryReview(id: string): Promise<ReviewCreateResponse> {
  return request(`/api/v1/reviews/${encodeURIComponent(id)}/retry`, ReviewCreateResponseSchema, { method: "POST" });
}

export function deleteReview(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/v1/reviews/${encodeURIComponent(id)}`, DeleteResponseSchema, { method: "DELETE" });
}

export function subscribeToReviewEvents(id: string, onEvent: (event: ReviewProgressEvent) => void): EventSource {
  const source = new EventSource(`${API_BASE}/api/v1/reviews/${encodeURIComponent(id)}/events`, { withCredentials: true });
  source.addEventListener("progress", (event) => {
    if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
    try {
      const parsed = ReviewProgressEventSchema.safeParse(JSON.parse(event.data));
      if (parsed.success) onEvent(parsed.data);
    } catch {
      // Ignore malformed progress frames; the regular task poll remains authoritative.
    }
  });
  return source;
}

export function subscribeToInspectionEvents(id: string, onEvent: (event: ReviewProgressEvent) => void): EventSource {
  const source = new EventSource(`${API_BASE}/api/v1/inspections/runs/${encodeURIComponent(id)}/events`, { withCredentials: true });
  source.addEventListener("progress", (event) => {
    if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
    try {
      const parsed = ReviewProgressEventSchema.safeParse(JSON.parse(event.data));
      if (parsed.success) onEvent(parsed.data);
    } catch {
      // The regular list request remains authoritative when a progress frame is malformed.
    }
  });
  return source;
}

export function statusLabel(status: ReviewStatus): string {
  const labels: Record<ReviewStatus, string> = {
    queued: "排队中",
    running: "审查中",
    completed: "已完成",
    failed: "失败",
    superseded: "已被新提交替代",
    canceled: "已取消",
  };
  return labels[status];
}

const integrationRequest = request;
export function createIntegrationApi(prefix = "/api/v1", maintainerId?: string) {
  const request = <T>(path: string, schema: ZodType<T>, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (maintainerId) headers.set("x-inspection-maintainer-id", maintainerId);
    return integrationRequest(path.replace(/^\/api\/v1/, prefix), schema, { ...init, headers });
  };
  function getGitLabOverview(): Promise<GitLabOverviewResponse> {
    return request("/api/v1/gitlab/overview", GitLabOverviewResponseSchema);
  }

  function listGitLabMergeRequests(query: GitLabMergeRequestListQuery): Promise<GitLabMergeRequestListResponse> {
    return request(queryPath("/api/v1/gitlab/merge-requests", {
      scope: query.scope,
      state: query.state,
      search: query.search,
      page: query.page ?? 1,
      perPage: query.perPage ?? 25,
    }), GitLabMergeRequestListResponseSchema);
  }

  function getGitLabMergeRequest(projectId: string, iid: string): Promise<GitLabMergeRequestDetails> {
    return request(`/api/v1/gitlab/merge-requests/${encodeURIComponent(projectId)}/${encodeURIComponent(iid)}`, GitLabMergeRequestDetailsSchema);
  }

  function getGitLabRecentPush(): Promise<GitLabRecentPush | null> {
    return request("/api/v1/gitlab/recent-push", GitLabRecentPushResponseSchema).then((response) => response.recentPush);
  }

  function createGitLabMergeRequest(body: GitLabCreateMergeRequestInput): Promise<GitLabMergeRequest> {
    const parsed = GitLabCreateMergeRequestInputSchema.parse(body);
    return request("/api/v1/gitlab/merge-requests", GitLabMergeRequestSchema, {
      method: "POST",
      body: JSON.stringify(parsed),
    });
  }

  function generateGitLabMergeRequestDescription(body: GitLabGenerateMergeRequestDescriptionInput): Promise<GitLabGenerateMergeRequestDescriptionResponse> {
    const parsed = GitLabGenerateMergeRequestDescriptionInputSchema.parse(body);
    return request("/api/v1/gitlab/merge-requests/description", GitLabGenerateMergeRequestDescriptionResponseSchema, {
      method: "POST",
      body: JSON.stringify(parsed),
    });
  }

  function updateGitLabMergeRequest(projectId: string, iid: string, body: GitLabUpdateMergeRequestInput): Promise<GitLabMergeRequest> {
    const parsed = GitLabUpdateMergeRequestInputSchema.parse(body);
    return request(`/api/v1/gitlab/merge-requests/${encodeURIComponent(projectId)}/${encodeURIComponent(iid)}`, GitLabMergeRequestSchema, {
      method: "PUT",
      body: JSON.stringify(parsed),
    });
  }

  function mergeGitLabMergeRequest(projectId: string, iid: string, body: GitLabMergeMergeRequestInput): Promise<GitLabMergeRequest> {
    const parsed = GitLabMergeMergeRequestInputSchema.parse(body);
    return request(`/api/v1/gitlab/merge-requests/${encodeURIComponent(projectId)}/${encodeURIComponent(iid)}/merge`, GitLabMergeRequestSchema, {
      method: "PUT",
      body: JSON.stringify(parsed),
    });
  }

  function listGitLabMergeRequestPipelines(projectId: string, iid: string): Promise<GitLabPipelinesResponse> {
    return request(`/api/v1/gitlab/merge-requests/${encodeURIComponent(projectId)}/${encodeURIComponent(iid)}/pipelines`, GitLabPipelinesResponseSchema);
  }

  function listGitLabPipelines(projectId: string, query: GitLabPipelineListQuery = {}): Promise<GitLabPipelinesResponse> {
    return request(queryPath(`/api/v1/gitlab/projects/${encodeURIComponent(projectId)}/pipelines`, {
      ref: query.ref,
      status: query.status,
      page: query.page ?? 1,
      perPage: query.perPage ?? 20,
    }), GitLabPipelinesResponseSchema);
  }

  function listGitLabPipelineJobs(projectId: string, pipelineId: string): Promise<GitLabPipelineJobsResponse> {
    return request(`/api/v1/gitlab/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(pipelineId)}/jobs`, GitLabPipelineJobsResponseSchema);
  }

  function retryGitLabPipeline(projectId: string, pipelineId: string): Promise<GitLabPipeline> {
    return request(`/api/v1/gitlab/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(pipelineId)}/retry`, GitLabPipelineSchema);
  }

  function cancelGitLabPipeline(projectId: string, pipelineId: string): Promise<GitLabPipeline> {
    return request(`/api/v1/gitlab/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(pipelineId)}/cancel`, GitLabPipelineSchema);
  }

  function createGitLabNote(projectId: string, iid: string, body: string): Promise<GitLabNoteResponse> {
    return request(`/api/v1/gitlab/merge-requests/${encodeURIComponent(projectId)}/${encodeURIComponent(iid)}/notes`, GitLabNoteResponseSchema, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  function startGitLabReview(projectId: string, iid: string): Promise<ReviewCreateResponse> {
    return request(`/api/v1/gitlab/merge-requests/${encodeURIComponent(projectId)}/${encodeURIComponent(iid)}/review`, ReviewCreateResponseSchema, { method: "POST" });
  }

  function getGitLabMrAiTask(projectId: string, iid: string, signal?: AbortSignal): Promise<GitLabMrAiRepairTaskResponse> {
    return request(`/api/v1/gitlab/merge-requests/${encodeURIComponent(projectId)}/${encodeURIComponent(iid)}/ai-task`, GitLabMrAiRepairTaskResponseSchema, { cache: "no-store", signal });
  }

  function getGitLabMrAiTaskDetail(id: string, signal?: AbortSignal): Promise<GitLabMrAiRepairTaskDetail> {
    return request(`/api/v1/gitlab/ai-tasks/${encodeURIComponent(id)}`, GitLabMrAiRepairTaskDetailSchema, { cache: "no-store", signal });
  }

  function startGitLabMrAiTask(projectId: string, iid: string): Promise<GitLabMrAiRepairTaskActionResponse> {
    return request(`/api/v1/gitlab/merge-requests/${encodeURIComponent(projectId)}/${encodeURIComponent(iid)}/ai-task`, GitLabMrAiRepairTaskActionResponseSchema, {
      method: "POST",
      body: JSON.stringify({ confirmed: true }),
    });
  }

  function retryGitLabMrAiTask(id: string): Promise<GitLabMrAiRepairTaskActionResponse> {
    return request(`/api/v1/gitlab/ai-tasks/${encodeURIComponent(id)}/retry`, GitLabMrAiRepairTaskActionResponseSchema, { method: "POST" });
  }

  function cancelGitLabMrAiTask(id: string): Promise<GitLabMrAiRepairTaskActionResponse> {
    return request(`/api/v1/gitlab/ai-tasks/${encodeURIComponent(id)}/cancel`, GitLabMrAiRepairTaskActionResponseSchema, { method: "POST" });
  }

  function testJiraAccount(body: JiraCredentialInput): Promise<JiraConnectionTestResponse> {
    return request("/api/v1/jira/account/test", JiraConnectionTestResponseSchema, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  function getGitLabMergeRequestCreateOptions(projectId: string): Promise<GitLabMergeRequestCreateOptions> {
    return request(`/api/v1/gitlab/projects/${encodeURIComponent(projectId)}/merge-request-options`, GitLabMergeRequestCreateOptionsSchema);
  }

  function listGitLabProjects(query: { search?: string; page?: number; perPage?: number } = {}): Promise<GitLabProjectsResponse> {
    return request(queryPath("/api/v1/gitlab/projects", {
      search: query.search,
      page: query.page ?? 1,
      perPage: query.perPage ?? 30,
    }), GitLabProjectsResponseSchema);
  }

  function getGitLabOAuthStatus(): Promise<GitLabOAuthStatus> {
    return request("/api/v1/gitlab/oauth/status", GitLabOAuthStatusSchema, { cache: "no-store" });
  }

  function startGitLabOAuth(returnTo?: string): void {
    const query = returnTo?.trim() ? `?${new URLSearchParams({ returnTo: returnTo.trim() }).toString()}` : "";
    window.location.assign(`${API_BASE}${prefix}/gitlab/oauth/start${query}`);
  }

  function disconnectGitLabOAuth(): Promise<GitLabOAuthStatus> {
    return request("/api/v1/gitlab/oauth/disconnect", GitLabOAuthStatusSchema, { method: "POST", cache: "no-store" });
  }

  function getJiraAccount(): Promise<JiraConnectionResponse> {
    return request("/api/v1/jira/account", JiraConnectionResponseSchema, { cache: "no-store" });
  }

  function saveJiraAccount(body: JiraCredentialInput): Promise<JiraConnectionResponse> {
    return request("/api/v1/jira/account", JiraConnectionResponseSchema, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  function disconnectJiraAccount(): Promise<JiraConnectionResponse> {
    return request("/api/v1/jira/account", JiraConnectionResponseSchema, { method: "DELETE", cache: "no-store" });
  }

  function getJiraIssue(key: string): Promise<JiraIssueDetails> {
    return request(`/api/v1/jira/issues/${encodeURIComponent(key)}`, JiraIssueDetailsSchema);
  }

  function getJiraIssueTransitions(key: string): Promise<JiraIssueTransitionsResponse> {
    return request(`/api/v1/jira/issues/${encodeURIComponent(key)}/transitions`, JiraIssueTransitionsResponseSchema);
  }

  function transitionJiraIssue(key: string, transitionId: string): Promise<JiraIssueDetails> {
    return request(`/api/v1/jira/issues/${encodeURIComponent(key)}/transitions`, JiraIssueDetailsSchema, {
      method: "POST",
      body: JSON.stringify({ transitionId }),
    });
  }

  function getJiraCreateIssueSupportingPatch(field: JiraCreateIssueSupportingField, query?: string): Promise<JiraCreateIssueSupportingPatch> {
    const search = query?.trim() ? `?${new URLSearchParams({ query: query.trim() })}` : "";
    return request(`/api/v1/jira/issues/create-options/supporting/${field}${search}`, JiraCreateIssueSupportingPatchSchema);
  }

  function getJiraCreateIssueOptions(): Promise<JiraCreateIssueOptions> {
    return request("/api/v1/jira/issues/create-options", JiraCreateIssueOptionsSchema);
  }

  function getJiraCreateIssueAdvancedOptions(): Promise<JiraCreateIssueAdvancedOptions> {
    return request("/api/v1/jira/issues/create-options/advanced", JiraCreateIssueAdvancedOptionsSchema);
  }

  function createJiraIssue(body: JiraCreateIssueInput): Promise<JiraIssueDetails> {
    return request("/api/v1/jira/issues", JiraIssueDetailsSchema, {
      method: "POST",
      body: JSON.stringify(JiraCreateIssueInputSchema.parse(body)),
    });
  }

  function uploadJiraIssueAttachments(issueKey: string, files: File[]): Promise<JiraAttachmentUploadResponse> {
    const formData = new FormData();
    files.forEach((file) => formData.append("file", file, file.name));
    return request(`/api/v1/jira/issues/${encodeURIComponent(issueKey)}/attachments`, JiraAttachmentUploadResponseSchema, { method: "POST", body: formData });
  }

  function addJiraIssueComment(key: string, body: string): Promise<JiraCommentResponse> {
    return request(`/api/v1/jira/issues/${encodeURIComponent(key)}/comments`, JiraCommentResponseSchema, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  function getJiraAttachmentPreviewUrl(issueKey: string, attachmentId: string): string {
    return `${API_BASE}${prefix}/jira/issues/${encodeURIComponent(issueKey)}/attachments/${encodeURIComponent(attachmentId)}`;
  }

  return { request, getGitLabOverview, listGitLabMergeRequests, getGitLabMergeRequest, getGitLabRecentPush, createGitLabMergeRequest, generateGitLabMergeRequestDescription, updateGitLabMergeRequest, mergeGitLabMergeRequest, listGitLabMergeRequestPipelines, listGitLabPipelines, listGitLabPipelineJobs, retryGitLabPipeline, cancelGitLabPipeline, createGitLabNote, startGitLabReview, getGitLabMrAiTask, getGitLabMrAiTaskDetail, startGitLabMrAiTask, retryGitLabMrAiTask, cancelGitLabMrAiTask, testJiraAccount, getGitLabMergeRequestCreateOptions, listGitLabProjects, getGitLabOAuthStatus, startGitLabOAuth, disconnectGitLabOAuth, getJiraAccount, saveJiraAccount, disconnectJiraAccount, getJiraIssue, getJiraIssueTransitions, transitionJiraIssue, getJiraCreateIssueSupportingPatch, getJiraCreateIssueOptions, getJiraCreateIssueAdvancedOptions, createJiraIssue, uploadJiraIssueAttachments, addJiraIssueComment, getJiraAttachmentPreviewUrl };
}
export const { getGitLabOverview, listGitLabMergeRequests, getGitLabMergeRequest, getGitLabRecentPush, createGitLabMergeRequest, generateGitLabMergeRequestDescription, updateGitLabMergeRequest, mergeGitLabMergeRequest, listGitLabMergeRequestPipelines, listGitLabPipelines, listGitLabPipelineJobs, retryGitLabPipeline, cancelGitLabPipeline, createGitLabNote, startGitLabReview, getGitLabMrAiTask, getGitLabMrAiTaskDetail, startGitLabMrAiTask, retryGitLabMrAiTask, cancelGitLabMrAiTask, testJiraAccount, getGitLabMergeRequestCreateOptions, listGitLabProjects, getGitLabOAuthStatus, startGitLabOAuth, disconnectGitLabOAuth, getJiraAccount, saveJiraAccount, disconnectJiraAccount, getJiraIssue, getJiraIssueTransitions, transitionJiraIssue, getJiraCreateIssueSupportingPatch, getJiraCreateIssueOptions, getJiraCreateIssueAdvancedOptions, createJiraIssue, uploadJiraIssueAttachments, addJiraIssueComment, getJiraAttachmentPreviewUrl } = createIntegrationApi();
