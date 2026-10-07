import { z } from "zod";
import type { InspectionOwnershipInput, InspectionOwnershipResult } from "./inspection-ownership.js";
import type { InspectionDuplicateInput, InspectionDuplicateDecision } from "./inspection-duplicates.js";
import { DEFAULT_INSPECTION_RULE_IDS, FeedbackCategorySchema, InspectionFindingScopeSchema, InspectionJiraModeSchema } from "./api-contracts.js";

export { buildInspectionJiraSummary, shortenInspectionFindingTitle } from "./inspection-title.js";

export {
  InspectionFindingScopeSchema,
  AssistantChatMessageInputSchema,
  AssistantAuthCardSchema,
  AssistantCardSchema,
  AssistantConversationListResponseSchema,
  AssistantConversationMessageSchema,
  AssistantConversationResponseSchema,
  AssistantConversationSummarySchema,
  AssistantEditOperationSchema,
  AssistantEditOperationStatusSchema,
  AssistantEditSessionSchema,
  AssistantEditSessionStatusSchema,
  AssistantFocusContextSchema,
  AssistantReviewTaskActionSchema,
  AssistantReviewTaskReferenceSchema,
  AssistantRunEventSchema,
  AssistantRunResponseSchema,
  AssistantRunStatusSchema,
  AssistantStreamEventSchema,
  AuthResponseSchema,
  BrowserSessionResponseSchema,
  CancelResponseSchema,
  ClaudeSettingsTestResponseSchema,
  CreateUserInputSchema,
  DeleteResponseSchema,
  FeedbackCategorySchema,
  FeedbackAttachmentSchema,
  FeedbackDetailSchema,
  FeedbackImageMimeTypeSchema,
  FeedbackListItemSchema,
  FeedbackListResponseSchema,
  FeedbackSubmitResponseSchema,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  GitLabBranchOptionSchema,
  GitLabConnectionResponseSchema,
  GitLabConnectionTestResponseSchema,
  GitLabCreateMergeRequestInputSchema,
  GitLabUpdateMergeRequestInputSchema,
  GitLabGenerateMergeRequestDescriptionInputSchema,
  GitLabGenerateMergeRequestDescriptionResponseSchema,
  GitLabMergeMergeRequestInputSchema,
  JiraConnectionResponseSchema,
  JiraConnectionTokenResponseSchema,
  JiraConnectionTestResponseSchema,
  JiraAttachmentSchema,
  JiraAttachmentUploadResponseSchema,
  JiraBoardColumnIdSchema,
  JiraBoardColumnSchema,
  JiraBoardMemberSchema,
  JiraBoardResponseSchema,
  JIRA_BOARD_STATUS_IDS,
  JIRA_MAX_ISSUE_ATTACHMENTS,
  JIRA_MAX_ISSUE_ATTACHMENT_BYTES,
  JiraCommentResponseSchema,
  JiraCommentSchema,
  GitLabIdentitySchema,
  GitLabMergeRequestChangeSchema,
  GitLabLabelOptionSchema,
  GitLabMergeRequestDetailsSchema,
  GitLabMergeRequestListResponseSchema,
  GitLabMergeRequestNoteSchema,
  GitLabMergeRequestCreateOptionsSchema,
  GitLabMergeRequestSchema,
  GitLabNoteBodySchema,
  GitLabNoteResponseSchema,
  GitLabMrAiRepairStatusSchema,
  GitLabMrAiRepairTaskSchema,
  GitLabMrAiRepairTaskResponseSchema,
  GitLabMrAiRepairTaskDetailSchema,
  GitLabMrAiRepairTaskActionResponseSchema,
  GitLabOAuthStatusSchema,
  GitLabOverviewResponseSchema,
  GitLabPipelineJobSchema,
  GitLabPipelineJobsResponseSchema,
  GitLabPipelineSchema,
  GitLabPipelinesResponseSchema,
  GitLabProfileOptionSchema,
  GitLabProjectConfigSchema,
  GitLabProjectsResponseSchema,
  GitLabProjectSchema,
  GitLabRecentPushResponseSchema,
  GitLabRecentPushSchema,
  GitLabMilestoneOptionSchema,
  JiraIdentitySchema,
  JiraOAuthStatusSchema,
  JiraIssueDetailsSchema,
  JiraCreateIssueInputSchema,
  JiraCreateIssueOptionSchema,
  JiraCreateIssueCustomFieldIdsSchema,
  JiraCreateIssueAdvancedOptionsSchema,
  JiraCreateIssueSupportingOptionsSchema,
  JiraCreateIssueSupportingPatchSchema,
  JiraCreateIssueOptionsSchema,
  JiraIssueListResponseSchema,
  JiraIssueTransitionSchema,
  JiraIssueTransitionsResponseSchema,
  JiraIssueSchema,
  JiraOverviewResponseSchema,
  HealthResponseSchema,
  ReviewCreateResponseSchema,
  ReviewConcurrencySchema,
  ReviewJobSchema,
  ReviewListResponseSchema,
  ReviewProfileResponseSchema,
  ReviewProfileSchema,
  ReviewProgressEventSchema,
  ReviewProgressKindSchema,
  ReviewProgressMetaSchema,
  ReviewGateStatusSchema,
  ReviewResultSummarySchema,
  InspectionAuthorSchema,
  InspectionFindingSchema,
  InspectionJiraLinkSchema,
  isInspectionFindingCompleted,
  InspectionOwnershipSchema,
  type InspectionOwnership,
  InspectionJiraModeSchema,
  InspectionPromptProfileSchema,
  InspectionPromptRuleSchema,
  InspectionPromptSchema,
  InspectionPromptSummarySchema,
  InspectionPromptResponseSchema,
  InspectionPromptsResponseSchema,
  InspectionOwnerPromptResponseSchema,
  InspectionRuleOptionSchema,
  InspectionRulesResponseSchema,
  InspectionProjectResponseSchema,
  InspectionProjectSchema,
  InspectionProjectsResponseSchema,
  InspectionResultSummarySchema,
  InspectionRuleResultSchema,
  InspectionRunResponseSchema,
  InspectionRunSchema,
  InspectionRunsResponseSchema,
  InspectionSourceSchema,
  InspectionStatusSchema,
  ReviewRuleProfileSchema,
  ReviewRuleSchema,
  ReviewRulesResponseSchema,
  ReviewSettingsSchema,
  ReviewSettingsResponseSchema,
  ReviewStatsSchema,
  ResolvedMergeRequestSchema,
  ReviewStatusSchema,
  UpdateUserInputSchema,
  UserListItemSchema,
  UserListResponseSchema,
  UserResponseSchema,
  UserRoleSchema,
  TrackUserActivityBodySchema,
  UserActivityActionSchema,
  UserActivityActionCountSchema,
  UserActivityRecentEventSchema,
  UserActivityResponseSchema,
  UserActivitySummarySchema,
  UserActivityTrackResponseSchema,
  UserActivityTrendRowSchema,
  UserActivityUserSummarySchema,
  USER_ACTIVITY_ACTIONS,
  UpdateReviewSettingsBodySchema,
  REVIEW_CONCURRENCY_MAX,
  REVIEW_CONCURRENCY_MIN,
  DEFAULT_INSPECTION_RULE_IDS,
  OrdinaryJiraAiCheckIdSchema,
  OrdinaryJiraAiCheckSchema,
  OrdinaryJiraAiImplementationBriefSchema,
  OrdinaryJiraAiPrecheckStatusSchema,
  OrdinaryJiraAiPrecheckSchema,
  OrdinaryJiraAiPrecheckResponseSchema,
  OrdinaryJiraAiPrecheckLookupResponseSchema,
  OrdinaryJiraAiSupplementStatusSchema,
  OrdinaryJiraAiSupplementSchema,
  OrdinaryJiraAiSupplementResponseSchema,
  OrdinaryJiraAiTaskStatusSchema,
  OrdinaryJiraAiTaskSchema,
  OrdinaryJiraAiPrecheckSummarySchema,
  OrdinaryJiraAiTaskSummarySchema,
  OrdinaryJiraAiTaskSummaryResponseSchema,
  OrdinaryJiraAiTaskDetailSchema,
} from "./api-contracts.js";

export type {
  AssistantChatMessageInput,
  AssistantAuthCard,
  AssistantCard,
  AssistantConversationMessage,
  AssistantConversationResponse,
  AssistantConversationSummary,
  AssistantEditOperation,
  AssistantEditOperationStatus,
  AssistantEditSession,
  AssistantEditSessionStatus,
  AssistantFocusContext,
  AssistantReviewTaskAction,
  AssistantReviewTaskReference,
  AssistantRunEvent,
  AssistantRunResponse,
  AssistantRunStatus,
  AssistantStreamEvent,
  AuthResponse,
  BrowserSessionResponse,
  ClaudeSettingsTestResponse,
  CreateUserInput,
  FeedbackAttachment,
  FeedbackCategory,
  FeedbackDetail,
  FeedbackImageMimeType,
  FeedbackListItem,
  FeedbackListResponse,
  FeedbackSubmitResponse,
  GitLabBranchOption,
  GitLabConnectionResponse,
  GitLabConnectionTestResponse,
  GitLabCreateMergeRequestInput,
  GitLabUpdateMergeRequestInput,
  GitLabGenerateMergeRequestDescriptionInput,
  GitLabGenerateMergeRequestDescriptionResponse,
  GitLabMergeMergeRequestInput,
  JiraConnectionResponse,
  JiraConnectionTokenResponse,
  JiraConnectionTestResponse,
  JiraAttachment,
  JiraAttachmentUploadResponse,
  JiraBoardColumn,
  JiraBoardColumnId,
  JiraBoardMember,
  JiraBoardResponse,
  JiraComment,
  JiraCommentResponse,
  GitLabIdentity,
  GitLabMergeRequest,
  GitLabMergeRequestChange,
  GitLabLabelOption,
  GitLabMergeRequestDetails,
  GitLabMergeRequestListResponse,
  GitLabMergeRequestNote,
  GitLabMergeRequestCreateOptions,
  GitLabNoteResponse,
  GitLabNoteBody,
  GitLabMrAiRepairStatus,
  GitLabMrAiRepairTask,
  GitLabMrAiRepairTaskResponse,
  GitLabMrAiRepairTaskDetail,
  GitLabMrAiRepairTaskActionResponse,
  GitLabOAuthStatus,
  GitLabOverviewResponse,
  GitLabPipeline,
  GitLabPipelineJob,
  GitLabPipelineJobsResponse,
  GitLabPipelinesResponse,
  GitLabProfileOption,
  GitLabProject,
  GitLabProjectConfig,
  GitLabProjectsResponse,
  GitLabRecentPush,
  GitLabMilestoneOption,
  JiraIdentity,
  JiraOAuthStatus,
  JiraIssue,
  JiraIssueDetails,
  JiraCreateIssueInput,
  JiraCreateIssueOption,
  JiraCreateIssueCustomFieldIds,
  JiraCreateIssueAdvancedOptions,
  JiraCreateIssueSupportingOptions,
  JiraCreateIssueSupportingPatch,
  JiraCreateIssueOptions,
  JiraIssueListResponse,
  JiraIssueTransition,
  JiraIssueTransitionsResponse,
  JiraOverviewResponse,
  HealthResponse,
  ReviewCreateResponse,
  ReviewSettings,
  ReviewSettingsResponse,
  ReviewJob,
  ReviewListResponse,
  ReviewProfile,
  ReviewProgressEvent,
  ReviewProgressInput,
  ReviewProgressKind,
  ReviewProgressMeta,
  ReviewGateStatus,
  ReviewResultSummary,
  InspectionAuthor,
  InspectionFinding,
  InspectionJiraLink,
  InspectionJiraMode,
  InspectionPromptProfile,
  InspectionPromptRule,
  InspectionPrompt,
  InspectionPromptSummary,
  InspectionPromptResponse,
  InspectionPromptsResponse,
  InspectionOwnerPromptResponse,
  InspectionRuleOption,
  InspectionRulesResponse,
  InspectionProject,
  InspectionProjectsResponse,
  InspectionResultSummary,
  InspectionRuleResult,
  InspectionRun,
  InspectionRunsResponse,
  InspectionSource,
  InspectionStatus,
  ReviewRule,
  ReviewRuleProfile,
  ReviewRulesResponse,
  ReviewStats,
  ResolvedMergeRequest,
  ReviewStatus,
  UpdateUserInput,
  UserListItem,
  UserListResponse,
  UserResponse,
  UserRole,
  TrackUserActivityInput,
  UserActivityAction,
  UserActivityActionCount,
  UserActivityRecentEvent,
  UserActivityResponse,
  UserActivitySummary,
  UserActivityTrackResponse,
  UserActivityTrendRow,
  UserActivityUserSummary,
  UpdateReviewSettingsBody,
  OrdinaryJiraAiCheckId,
  OrdinaryJiraAiCheck,
  OrdinaryJiraAiImplementationBrief,
  OrdinaryJiraAiPrecheckStatus,
  OrdinaryJiraAiPrecheck,
  OrdinaryJiraAiPrecheckResponse,
  OrdinaryJiraAiPrecheckLookupResponse,
  OrdinaryJiraAiSupplementStatus,
  OrdinaryJiraAiSupplement,
  OrdinaryJiraAiSupplementResponse,
  OrdinaryJiraAiTaskStatus,
  OrdinaryJiraAiTask,
  OrdinaryJiraAiTaskSummary,
  OrdinaryJiraAiPrecheckSummary,
  OrdinaryJiraAiTaskSummaryResponse,
  OrdinaryJiraAiTaskDetail,
} from "./api-contracts.js";

import type { InspectionPromptProfile, ReviewProfile, ReviewProgressInput } from "./api-contracts.js";

export const InspectionFindingReportInputSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.string().trim().min(1).max(128),
  path: z.string().trim().min(1).max(1_000),
  line: z.number().int().positive().nullable().default(null),
  issue: z.string().trim().min(1).max(8_000),
  suggestion: z.string().trim().max(8_000).default(""),
  scope: InspectionFindingScopeSchema.optional().describe("问题范围：line 为具体代码行，file 为整文件，cross_file 为跨文件问题；整文件问题不要用第 1 行代表责任人。"),
  relatedPaths: z.array(z.string().trim().min(1).max(1_000)).max(30).optional().describe("跨文件问题涉及的其他全部文件路径，不含主 path；范围暂不明确时，由后续 AI 查询结合代码和相关记录核实。"),
}).strict();

export type InspectionFindingReportInput = z.infer<typeof InspectionFindingReportInputSchema>;

export interface InspectionFindingReportResult {
  recorded: boolean;
  duplicate: boolean;
  findingId: string;
  message: string;
}

const stringOrPositiveInt = z.union([
  z.string().trim().min(1).max(256),
  z.number().int().positive(),
]).transform(String);

function optionalString(maxLength: number) {
  return z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().min(1).max(maxLength).nullable().optional(),
  ).transform((value) => value ?? null);
}

function httpUrl(maxLength: number) {
  return z.string().trim().url().max(maxLength).refine((value) => {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username
      && !parsed.password;
  }, "必须是没有用户名和密码的 HTTP(S) 地址");
}

export const CreateReviewBodySchema = z.object({
  projectId: stringOrPositiveInt,
  projectPath: optionalString(512),
  mrIid: stringOrPositiveInt,
  headSha: optionalString(128),
  targetBranch: optionalString(256),
}).strict();

export type CreateReviewInput = z.output<typeof CreateReviewBodySchema>;

const ciJobId = z.union([
  z.string().trim().min(1).max(128),
  z.number().int().positive(),
]).transform(String);

export const CreateCiReviewBodySchema = CreateReviewBodySchema.extend({
  headSha: z.string().trim().min(1).max(128),
  pipelineId: ciJobId,
  jobId: ciJobId,
  jobUrl: httpUrl(2_048),
}).strict();

export type CreateCiReviewInput = z.output<typeof CreateCiReviewBodySchema>;

export const ResolveMergeRequestBodySchema = z.object({
  url: httpUrl(2_048),
}).strict();

export type ResolveMergeRequestInput = z.output<typeof ResolveMergeRequestBodySchema>;

export const SubmitFeedbackBodySchema = z.object({
  category: FeedbackCategorySchema,
  rating: z.number().int().min(1).max(5),
  message: z.string().trim().min(1).max(4_000),
  contact: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().max(200).optional(),
  ),
}).strict();

export type SubmitFeedbackInput = z.output<typeof SubmitFeedbackBodySchema>;

export const GitLabConnectionInputSchema = z.object({
  baseUrl: httpUrl(2_048),
  apiBaseUrl: httpUrl(2_048),
  token: z.string().trim().max(2_000).optional(),
}).strict();

export type GitLabConnectionInput = z.output<typeof GitLabConnectionInputSchema>;

export const JiraConnectionInputSchema = z.object({
  baseUrl: httpUrl(2_048),
  apiBaseUrl: httpUrl(2_048),
  projectKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "Jira Project Key 格式不正确"),
  username: z.string().trim().max(256),
  token: z.string().trim().max(4_000).optional(),
}).strict();

export type JiraConnectionInput = z.output<typeof JiraConnectionInputSchema>;

export const JiraCredentialInputSchema = z.object({
  username: z.string().trim().min(1).max(256),
  token: z.string().trim().max(4_000).optional(),
}).strict();

export type JiraCredentialInput = z.output<typeof JiraCredentialInputSchema>;

const ClaudeEnvSchema = z.record(
  z.string().trim().min(1).max(256),
  z.string().max(16_000),
).superRefine((env, context) => {
  if (Object.keys(env).length > 100) {
    context.addIssue({ code: "custom", message: "env 最多支持 100 个配置项" });
  }
});

export const ClaudeSettingsSchema = z.object({
  /** Optional model selector stored alongside the env-compatible settings. */
  model: z.string().trim().max(256).optional(),
  env: ClaudeEnvSchema.default({}),
}).passthrough();

export type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;

export const ClaudeCliSessionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(128),
  createdAt: z.string().datetime(),
  status: z.enum(["running", "stopped"]),
}).strict();

export type ClaudeCliSession = z.infer<typeof ClaudeCliSessionSchema>;

export const ClaudeCliPreviewPortSchema = z.object({
  port: z.number().int().min(1).max(65_535),
  url: z.string().url(),
}).strict();

export type ClaudeCliPreviewPort = z.infer<typeof ClaudeCliPreviewPortSchema>;

export const ClaudeCliPreviewPortsResponseSchema = z.object({
  ports: z.array(ClaudeCliPreviewPortSchema),
}).strict();

export type ClaudeCliPreviewPortsResponse = z.infer<typeof ClaudeCliPreviewPortsResponseSchema>;

export const ClaudeCliProjectSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(128),
  cwd: z.string().trim().min(1).max(2_048),
  createdAt: z.string().datetime(),
  status: z.enum(["running", "stopped"]),
  sessions: z.array(ClaudeCliSessionSchema),
}).strict();

export type ClaudeCliProject = z.infer<typeof ClaudeCliProjectSchema>;

export const ClaudeCliProjectListResponseSchema = z.object({
  projects: z.array(ClaudeCliProjectSchema),
}).strict();

export type ClaudeCliProjectListResponse = z.infer<typeof ClaudeCliProjectListResponseSchema>;

const reviewRepositoryPath = z.string().trim().min(1).max(512);
const reviewRuleName = z.string().trim().min(1).max(128);
const reviewRuleDescription = z.string().max(1_000);
const reviewRuleContent = z.string().max(120_000).refine((value) => value.trim().length > 0, "规则内容不能为空");

export const CreateReviewProfileBodySchema = z.object({
  profile: reviewRepositoryPath,
  displayName: z.string().trim().min(1).max(128).optional(),
}).strict();

export type CreateReviewProfileInput = z.infer<typeof CreateReviewProfileBodySchema>;

export const DeleteReviewProfileBodySchema = z.object({
  profile: reviewRepositoryPath,
}).strict();

export type DeleteReviewProfileInput = z.infer<typeof DeleteReviewProfileBodySchema>;

export const CreateReviewRuleBodySchema = z.object({
  profile: reviewRepositoryPath,
  name: reviewRuleName,
  description: reviewRuleDescription.default(""),
  enabled: z.boolean().default(true),
  content: reviewRuleContent,
}).strict();

export type CreateReviewRuleInput = z.infer<typeof CreateReviewRuleBodySchema>;

export const UpdateReviewRuleBodySchema = CreateReviewRuleBodySchema.extend({
  ruleId: z.string().trim().min(1).max(128),
}).strict();

export type UpdateReviewRuleInput = z.infer<typeof UpdateReviewRuleBodySchema>;

export const DeleteReviewRuleBodySchema = z.object({
  profile: reviewRepositoryPath,
  ruleId: z.string().trim().min(1).max(128),
}).strict();

export type DeleteReviewRuleInput = z.infer<typeof DeleteReviewRuleBodySchema>;

export const ReorderReviewRulesBodySchema = z.object({
  profile: reviewRepositoryPath,
  ruleIds: z.array(z.string().trim().min(1).max(128)).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.ruleIds).size !== value.ruleIds.length) {
    context.addIssue({ code: "custom", path: ["ruleIds"], message: "规则顺序中不能有重复规则" });
  }
});

export type ReorderReviewRulesInput = z.infer<typeof ReorderReviewRulesBodySchema>;

export const CreateInspectionProfileBodySchema = z.object({
  profile: reviewRepositoryPath,
  displayName: z.string().trim().min(1).max(128).optional(),
}).strict();

export type CreateInspectionProfileInput = z.infer<typeof CreateInspectionProfileBodySchema>;

export const DeleteInspectionProfileBodySchema = z.object({
  profile: reviewRepositoryPath,
}).strict();

export type DeleteInspectionProfileInput = z.infer<typeof DeleteInspectionProfileBodySchema>;

export const SaveInspectionPromptBodySchema = z.object({
  content: z.string().trim().min(1).max(100_000),
}).strict();

export type SaveInspectionPromptInput = z.infer<typeof SaveInspectionPromptBodySchema>;

// Legacy request shape for /owner-prompt.
export const SaveInspectionOwnerPromptBodySchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
}).strict();

export type SaveInspectionOwnerPromptInput = z.infer<typeof SaveInspectionOwnerPromptBodySchema>;

export const CreateInspectionRuleBodySchema = z.object({
  profile: reviewRepositoryPath,
  name: reviewRuleName,
  description: reviewRuleDescription.default(""),
  enabled: z.boolean().default(true),
  content: reviewRuleContent,
}).strict();

export type CreateInspectionRuleInput = z.infer<typeof CreateInspectionRuleBodySchema>;

export const UpdateInspectionRuleBodySchema = CreateInspectionRuleBodySchema.extend({
  ruleId: z.string().trim().min(1).max(128),
}).strict();

export type UpdateInspectionRuleInput = z.infer<typeof UpdateInspectionRuleBodySchema>;

export const DeleteInspectionRuleBodySchema = z.object({
  profile: reviewRepositoryPath,
  ruleId: z.string().trim().min(1).max(128),
}).strict();

export type DeleteInspectionRuleInput = z.infer<typeof DeleteInspectionRuleBodySchema>;

export const ReorderInspectionRulesBodySchema = z.object({
  profile: reviewRepositoryPath,
  ruleIds: z.array(z.string().trim().min(1).max(128)).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.ruleIds).size !== value.ruleIds.length) {
    context.addIssue({ code: "custom", path: ["ruleIds"], message: "规则顺序中不能有重复规则" });
  }
});

export type ReorderInspectionRulesInput = z.infer<typeof ReorderInspectionRulesBodySchema>;

export const UpsertInspectionProjectBodySchema = z.object({
  projectPath: z.string().trim().min(1).max(512),
  projectName: z.string().trim().min(1).max(256),
  branch: z.string().trim().min(1).max(256),
  findingLimit: z.number().int().min(1).nullable().default(null),
  inspectionRuleIds: z.array(z.string().trim().min(1).max(128)).max(20).default([...DEFAULT_INSPECTION_RULE_IDS]),
  enabled: z.boolean().default(true),
  scheduleEnabled: z.boolean().default(false),
  scheduleCron: z.string().trim().min(1).max(128).default("0 0 * * *"),
  jiraMode: InspectionJiraModeSchema.default("manual"),
  jiraComponent: optionalString(128),
  jiraFixVersion: optionalString(128),
  // Kept as an optional compatibility field. Inspection Jira issue types are resolved from Jira metadata.
  jiraIssueType: z.string().trim().min(1).max(128).optional(),
}).strict();

export const CreateInspectionJiraBodySchema = z.object({
  assignee: z.string().trim().min(1).max(256).optional(),
}).strict();

export type UpsertInspectionProjectInput = z.output<typeof UpsertInspectionProjectBodySchema>;

export const StartInspectionBodySchema = z.object({
  findingLimit: z.number().int().min(1).nullable().optional(),
}).strict();

export type StartInspectionInput = z.infer<typeof StartInspectionBodySchema>;

export interface ReviewRunnerInput {
  projectPath: string;
  mrIid: string;
  profile: ReviewProfile;
  workspacePath?: string | null;
}

export interface ReviewRunner {
  run(input: ReviewRunnerInput, options?: ReviewRunnerRunOptions): Promise<string>;
}

export interface PreSubmitReviewInput {
  projectPath: string;
  jiraKey: string;
  jiraTitle: string;
  jiraDescription: string;
  targetBranch: string;
  baseSha: string;
  diff: string;
  profile: ReviewProfile;
  workspacePath?: string | null;
  externalFeedback?: string | null;
}

export interface PreSubmitReviewRunner {
  runPreSubmitReview(input: PreSubmitReviewInput, options?: ReviewRunnerRunOptions): Promise<string>;
}

export interface InspectionRunnerInput {
  projectPath: string;
  branch: string;
  headSha: string;
  profile: InspectionPromptProfile;
  findingLimit?: number | null;
  workspacePath?: string | null;
}

export interface InspectionRunner {
  runInspection(input: InspectionRunnerInput, options?: ReviewRunnerRunOptions): Promise<string>;
  resolveInspectionDuplicates?(input: InspectionDuplicateInput, options?: ReviewRunnerRunOptions): Promise<InspectionDuplicateDecision>;
  resolveInspectionOwners?(input: InspectionOwnershipInput, options?: ReviewRunnerRunOptions): Promise<InspectionOwnershipResult[]>;
}

export interface ReviewRunnerRunOptions {
  signal?: AbortSignal;
  /** Maintainer scope used to load inspection-owned prompt overrides. */
  ownerId?: string;
  /** Git authentication environment for the isolated review workspace. */
  gitEnvironment?: Record<string, string | undefined>;
  onProgress?: (event: ReviewProgressInput) => void;
  onInspectionFinding?: (ruleId: string, finding: InspectionFindingReportInput) => Promise<InspectionFindingReportResult>;
  /** Resume the persisted Claude Code conversation for the same MR. */
  resumeSessionId?: string | null;
  /** Receives the SDK session id as soon as Claude Code creates or resumes it. */
  onSessionId?: (sessionId: string) => void;
}

export { InspectionMaintainerSchema, InspectionLoginResponseSchema, InspectionAuthStatusSchema, type InspectionAuthStatus } from "./api-contracts.js";

export {
  InspectionAiTaskSchema,
  InspectionAiTaskDetailSchema,
  InspectionAiReprocessResponseSchema,
  type InspectionAiTask,
  type InspectionAiTaskDetail,
  type InspectionAiReprocessAction,
  type InspectionAiReprocessResponse,
} from "./api-contracts.js";
