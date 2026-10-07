import { z } from "zod";

export const ReviewStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "superseded",
  "canceled",
]);

export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

const nullableStringResponse = z.string().nullable();
const primitiveResponse = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ReviewRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  order: z.number().int().nonnegative(),
  file: z.string(),
  sharedBy: z.array(z.string()),
  content: z.string(),
});

export type ReviewRule = z.infer<typeof ReviewRuleSchema>;

export const ReviewRuleProfileSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  isDefault: z.boolean(),
  rules: z.array(ReviewRuleSchema),
});

export type ReviewRuleProfile = z.infer<typeof ReviewRuleProfileSchema>;

export const ReviewRulesResponseSchema = z.object({
  profiles: z.array(ReviewRuleProfileSchema),
});

export type ReviewRulesResponse = z.infer<typeof ReviewRulesResponseSchema>;

export const ResolvedMergeRequestSchema = z.object({
  projectId: z.string(),
  projectPath: z.string(),
  mrIid: z.string(),
  headSha: nullableStringResponse,
  targetBranch: nullableStringResponse,
});

export type ResolvedMergeRequest = z.infer<typeof ResolvedMergeRequestSchema>;

export const ReviewGateStatusSchema = z.enum(["passed", "failed"]);
export type ReviewGateStatus = z.infer<typeof ReviewGateStatusSchema>;

export const ReviewResultSummarySchema = z.object({
  format: z.enum(["structured", "raw"]),
  summary: z.string(),
  ruleFindingCount: z.number().int().nonnegative(),
  findingCount: z.number().int().nonnegative(),
  headSha: nullableStringResponse,
  gate: ReviewGateStatusSchema.optional(),
  blockingFindingCount: z.number().int().nonnegative().optional(),
  blockingSeverities: z.array(z.string()).optional(),
});

export type ReviewResultSummary = z.infer<typeof ReviewResultSummarySchema>;

export const InspectionStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
]);
export type InspectionStatus = z.infer<typeof InspectionStatusSchema>;

export const InspectionSourceSchema = z.enum(["manual", "schedule"]);
export type InspectionSource = z.infer<typeof InspectionSourceSchema>;

export const InspectionJiraModeSchema = z.enum(["off", "manual", "auto"]);
export type InspectionJiraMode = z.infer<typeof InspectionJiraModeSchema>;

export const DEFAULT_INSPECTION_RULE_IDS = [
  "abstraction-reuse",
  "file-line-limit",
  "performance",
  "security",
  "hidden-bug",
] as const;

export const InspectionRuleOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  enabledByDefault: z.boolean(),
  order: z.number().int().nonnegative(),
});

export type InspectionRuleOption = z.infer<typeof InspectionRuleOptionSchema>;

export const InspectionPromptRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  order: z.number().int().nonnegative(),
  file: z.string(),
  sharedBy: z.array(z.string()),
  content: z.string(),
});

export type InspectionPromptRule = z.infer<typeof InspectionPromptRuleSchema>;

export const InspectionPromptProfileSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  isDefault: z.boolean(),
  rules: z.array(InspectionPromptRuleSchema),
});

export type InspectionPromptProfile = z.infer<typeof InspectionPromptProfileSchema>;

export const InspectionRulesResponseSchema = z.object({
  profiles: z.array(InspectionPromptProfileSchema),
});

export type InspectionRulesResponse = z.infer<typeof InspectionRulesResponseSchema>;

export const InspectionPromptSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});

export type InspectionPromptSummary = z.infer<typeof InspectionPromptSummarySchema>;

export const InspectionPromptSchema = InspectionPromptSummarySchema.extend({
  content: z.string(),
});

export type InspectionPrompt = z.infer<typeof InspectionPromptSchema>;

export const InspectionPromptsResponseSchema = z.object({
  prompts: z.array(InspectionPromptSummarySchema),
});

export type InspectionPromptsResponse = z.infer<typeof InspectionPromptsResponseSchema>;

export const InspectionPromptResponseSchema = z.object({
  prompt: InspectionPromptSchema,
});

export type InspectionPromptResponse = z.infer<typeof InspectionPromptResponseSchema>;

// Kept for clients using the original single-prompt endpoint.
export const InspectionOwnerPromptResponseSchema = z.object({
  prompt: z.string(),
});

export type InspectionOwnerPromptResponse = z.infer<typeof InspectionOwnerPromptResponseSchema>;

export const InspectionAuthorSchema = z.object({
  name: z.string(),
  email: nullableStringResponse,
  assignee: nullableStringResponse,
});
export type InspectionAuthor = z.infer<typeof InspectionAuthorSchema>;

export const InspectionFindingScopeSchema = z.enum(["line", "file", "cross_file"]);

export const InspectionOwnershipSchema = z.object({
  status: z.enum(["resolved", "uncertain"]),
  assignee: z.string().nullable(),
  reason: z.string(),
  checkedAt: z.string(),
  evidence: z.array(z.object({
    id: z.string(),
    source: z.enum(["file_history", "file_source", "jira_search", "jira_issue", "merge_requests", "merge_request", "jira_users"]),
    title: z.string(),
    url: z.string().nullable(),
    checkedAt: z.string(),
  })),
});
export type InspectionOwnership = z.infer<typeof InspectionOwnershipSchema>;

export const InspectionJiraLinkSchema = z.object({
  status: z.enum(["not_created", "created", "skipped", "failed"]),
  key: nullableStringResponse,
  url: nullableStringResponse,
  assignee: nullableStringResponse,
  assigneeName: z.string().nullable().optional(),
  assignmentSource: z.enum(["ai", "manual"]).optional(),
  ownership: InspectionOwnershipSchema.optional(),
  error: nullableStringResponse,
  issueStatus: z.string().nullable().optional(),
  issueStatusCategory: z.string().nullable().optional(),
  // Independent from Jira's workflow: records whether the AI MR is still effective.
  aiResolutionStatus: z.enum(["merged", "reverted", "unknown"]).optional(),
  syncedAt: z.string().nullable().optional(),
  syncError: z.string().nullable().optional(),
});
export type InspectionJiraLink = z.infer<typeof InspectionJiraLinkSchema>;

export const InspectionFindingSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  tracking: z.object({
    id: z.string(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    occurrenceCount: z.number().int().positive(),
  }).optional(),
  severity: z.string(),
  category: z.string(),
  path: z.string(),
  line: z.number().int().positive().nullable(),
  issue: z.string(),
  suggestion: z.string(),
  scope: InspectionFindingScopeSchema.optional(),
  relatedPaths: z.array(z.string()).optional(),
  /** @deprecated Historical GitLab author snapshot. The current inspection owner is jira.ownership. */
  author: InspectionAuthorSchema.nullable(),
  jira: InspectionJiraLinkSchema,
});
export type InspectionFinding = z.infer<typeof InspectionFindingSchema>;

export function isInspectionFindingCompleted(finding: Pick<InspectionFinding, "jira">): boolean {
  return finding.jira.status === "created"
    && finding.jira.aiResolutionStatus !== "reverted"
    && (finding.jira.issueStatusCategory === "done" || finding.jira.aiResolutionStatus === "merged");
}

export const InspectionRuleResultSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  conclusion: z.string(),
  findings: z.array(InspectionFindingSchema),
});
export type InspectionRuleResult = z.infer<typeof InspectionRuleResultSchema>;

export const InspectionResultSummarySchema = z.object({
  format: z.enum(["structured", "raw"]),
  summary: z.string(),
  ruleFindingCount: z.number().int().nonnegative(),
  findingCount: z.number().int().nonnegative(),
  headSha: nullableStringResponse,
  gate: ReviewGateStatusSchema.optional(),
  blockingFindingCount: z.number().int().nonnegative().optional(),
  blockingSeverities: z.array(z.string()).optional(),
  ruleResults: z.array(InspectionRuleResultSchema),
  findings: z.array(InspectionFindingSchema),
});
export type InspectionResultSummary = z.infer<typeof InspectionResultSummarySchema>;

export const InspectionProjectSchema = z.object({
  authorizationError: z.string().nullable().optional(),
  maintainerId: z.string().nullable().optional(),
  maintainerName: z.string().nullable().optional(),
  operatorId: z.string().nullable().optional(),
  operatorName: z.string().nullable().optional(),
  projectId: z.string(),
  projectPath: z.string(),
  projectName: z.string(),
  branch: z.string(),
  enabled: z.boolean(),
  scheduleEnabled: z.boolean(),
  scheduleCron: z.string(),
  findingLimit: z.number().int().min(1).nullable(),
  nextRunAt: nullableStringResponse,
  lastRunAt: nullableStringResponse,
  lastRunStatus: InspectionStatusSchema.nullable(),
  lastHeadSha: nullableStringResponse,
  ruleSetName: z.string(),
  ruleCount: z.number().int().nonnegative(),
  inspectionRuleIds: z.array(z.string()),
  jiraMode: InspectionJiraModeSchema,
  jiraComponent: nullableStringResponse,
  jiraFixVersion: nullableStringResponse,
  jiraIssueType: z.string(),
});
export type InspectionProject = z.infer<typeof InspectionProjectSchema>;

export const InspectionProjectsResponseSchema = z.object({
  projects: z.array(InspectionProjectSchema),
});
export type InspectionProjectsResponse = z.infer<typeof InspectionProjectsResponseSchema>;

export const InspectionProjectResponseSchema = z.object({ project: InspectionProjectSchema });

export const ReviewProgressKindSchema = z.enum([
  "stage",
  "system",
  "status",
  "thinking",
  "tool",
  "tool_result",
  "assistant",
  "finding",
  "result",
  "warning",
  "error",
]);

export type ReviewProgressKind = z.infer<typeof ReviewProgressKindSchema>;
export const ReviewProgressMetaSchema = z.record(z.string(), primitiveResponse);
export type ReviewProgressMeta = z.infer<typeof ReviewProgressMetaSchema>;

export const ReviewProgressEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: ReviewProgressKindSchema,
  message: z.string(),
  detail: z.string().nullable().optional(),
  meta: ReviewProgressMetaSchema.optional(),
  finding: InspectionFindingSchema.optional(),
});

export const InspectionRunSchema = z.object({
  maintainerId: z.string().nullable().optional(),
  maintainerName: z.string().nullable().optional(),
  operatorId: z.string().nullable().optional(),
  operatorName: z.string().nullable().optional(),
  id: z.string(),
  projectId: z.string(),
  projectPath: z.string(),
  projectName: z.string(),
  branch: z.string(),
  source: InspectionSourceSchema,
  status: InspectionStatusSchema,
  createdAt: z.string(),
  startedAt: nullableStringResponse,
  finishedAt: nullableStringResponse,
  headSha: nullableStringResponse,
  error: nullableStringResponse,
  result: InspectionResultSummarySchema.nullable(),
  progress: z.array(ReviewProgressEventSchema),
});
export type InspectionRun = z.infer<typeof InspectionRunSchema>;

export const InspectionRunsResponseSchema = z.object({
  runs: z.array(InspectionRunSchema),
});
export type InspectionRunsResponse = z.infer<typeof InspectionRunsResponseSchema>;

export const InspectionRunResponseSchema = z.object({ run: InspectionRunSchema });

export type ReviewProgressInput = {
  kind: ReviewProgressKind;
  message: string;
  detail?: string | null;
  meta?: ReviewProgressMeta;
  finding?: InspectionFinding;
};
export type ReviewProgressEvent = ReviewProgressInput & { id: string; at: string };

export const ReviewJobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectPath: nullableStringResponse,
  mrIid: z.string(),
  headSha: nullableStringResponse,
  targetBranch: nullableStringResponse,
  source: z.string(),
  status: ReviewStatusSchema,
  createdAt: z.string(),
  startedAt: nullableStringResponse,
  finishedAt: nullableStringResponse,
  noteId: z.number().int().nullable(),
  error: nullableStringResponse,
  result: ReviewResultSummarySchema.nullable(),
  progress: z.array(ReviewProgressEventSchema),
});

export type ReviewJob = z.infer<typeof ReviewJobSchema>;

export const AssistantReviewTaskActionSchema = z.enum(["started", "canceled"]);
export type AssistantReviewTaskAction = z.infer<typeof AssistantReviewTaskActionSchema>;

export const AssistantReviewTaskReferenceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectPath: nullableStringResponse,
  mrIid: z.string(),
  headSha: nullableStringResponse,
  targetBranch: nullableStringResponse,
  status: ReviewStatusSchema,
  error: nullableStringResponse,
  action: AssistantReviewTaskActionSchema,
  deduplicated: z.boolean(),
});

export type AssistantReviewTaskReference = z.infer<typeof AssistantReviewTaskReferenceSchema>;

export const ReviewStatsSchema = z.object({
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
});

export type ReviewStats = z.infer<typeof ReviewStatsSchema>;

export const REVIEW_CONCURRENCY_MIN = 1;
export const REVIEW_CONCURRENCY_MAX = 16;

export const ReviewConcurrencySchema = z.number().int().min(REVIEW_CONCURRENCY_MIN).max(REVIEW_CONCURRENCY_MAX);

export const INSPECTION_AI_CONCURRENCY_MIN = 1;
export const INSPECTION_AI_CONCURRENCY_MAX = 8;
export const INSPECTION_AI_CONCURRENCY_DEFAULT = 2;

export const InspectionAiConcurrencySchema = z.number().int()
  .min(INSPECTION_AI_CONCURRENCY_MIN)
  .max(INSPECTION_AI_CONCURRENCY_MAX);

export const ReviewSettingsSchema = z.object({
  reviewConcurrency: ReviewConcurrencySchema,
  autoSendComments: z.boolean(),
  minReviewConcurrency: z.literal(REVIEW_CONCURRENCY_MIN),
  maxReviewConcurrency: z.literal(REVIEW_CONCURRENCY_MAX),
});

export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>;

export const ReviewSettingsResponseSchema = z.object({
  settings: ReviewSettingsSchema,
});

export type ReviewSettingsResponse = z.infer<typeof ReviewSettingsResponseSchema>;

export const UpdateReviewSettingsBodySchema = z.object({
  reviewConcurrency: ReviewConcurrencySchema,
  autoSendComments: z.boolean().optional(),
}).strict();

export type UpdateReviewSettingsBody = z.infer<typeof UpdateReviewSettingsBodySchema>;

export const ReviewProfileSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  rules: z.array(ReviewRuleSchema),
});

export type ReviewProfile = z.infer<typeof ReviewProfileSchema>;

export const HealthResponseSchema = ReviewStatsSchema.extend({
  status: z.literal("ok"),
  dryRun: z.boolean(),
  gitlabConfigured: z.boolean(),
  claudeConfigured: z.boolean(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ClaudeSettingsTestResponseSchema = z.object({
  ok: z.literal(true),
  baseUrl: z.string(),
  model: z.string(),
  latencyMs: z.number().nonnegative(),
  message: z.string(),
});

export type ClaudeSettingsTestResponse = z.infer<typeof ClaudeSettingsTestResponseSchema>;

export const AuthResponseSchema = z.object({
  inspectionAccess: z.boolean().optional(),
  configured: z.boolean(),
  authenticated: z.boolean(),
  username: z.string().nullable(),
  role: z.enum(["admin", "user"]).nullable(),
});

export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const UserRoleSchema = z.enum(["admin", "user"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserListItemSchema = z.object({
  inspectionAccess: z.boolean().optional(),
  id: z.string(),
  username: z.string(),
  password: z.string().nullable(),
  role: UserRoleSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type UserListItem = z.infer<typeof UserListItemSchema>;

export const UserListResponseSchema = z.object({
  users: z.array(UserListItemSchema),
  total: z.number().int().nonnegative(),
});

export type UserListResponse = z.infer<typeof UserListResponseSchema>;

export const UserResponseSchema = z.object({ user: UserListItemSchema });
export type UserResponse = z.infer<typeof UserResponseSchema>;

export const CreateUserInputSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(8).max(512),
}).strict();

export type CreateUserInput = z.infer<typeof CreateUserInputSchema>;

export const UpdateUserInputSchema = z.object({
  inspectionAccess: z.boolean().optional(),
  username: z.string().trim().min(1).max(128).optional(),
  password: z.string().min(8).max(512).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => value.inspectionAccess !== undefined || value.username !== undefined || value.password !== undefined || value.enabled !== undefined, {
  message: "至少提供一个需要更新的字段",
});

export type UpdateUserInput = z.infer<typeof UpdateUserInputSchema>;

export const USER_ACTIVITY_ACTIONS = [
  "login",
  "logout",
  "page_view",
  "assistant_message",
  "assistant_cancel",
  "review_submit",
  "review_cancel",
  "review_retry",
  "gitlab_action",
  "gitlab_connect",
  "jira_action",
  "jira_connect",
  "feedback_submit",
  "user_management",
  "settings_update",
  "review_rules_update",
] as const;

export const UserActivityActionSchema = z.enum(USER_ACTIVITY_ACTIONS);
export type UserActivityAction = z.infer<typeof UserActivityActionSchema>;

export const TrackUserActivityBodySchema = z.object({
  path: z.string().trim().regex(/^\/[A-Za-z0-9/_-]*$/, "页面路径格式无效").max(256),
}).strict();

export type TrackUserActivityInput = z.infer<typeof TrackUserActivityBodySchema>;

export const UserActivityTrackResponseSchema = z.object({ tracked: z.literal(true) });
export type UserActivityTrackResponse = z.infer<typeof UserActivityTrackResponseSchema>;

export const UserActivitySummarySchema = z.object({
  totalEvents: z.number().int().nonnegative(),
  activeUsers: z.number().int().nonnegative(),
  loginCount: z.number().int().nonnegative(),
  pageViewCount: z.number().int().nonnegative(),
  assistantMessageCount: z.number().int().nonnegative(),
  reviewActionCount: z.number().int().nonnegative(),
  feedbackSubmitCount: z.number().int().nonnegative(),
  settingsUpdateCount: z.number().int().nonnegative(),
});

export type UserActivitySummary = z.infer<typeof UserActivitySummarySchema>;

export const UserActivityActionCountSchema = z.object({
  action: UserActivityActionSchema,
  count: z.number().int().nonnegative(),
});

export type UserActivityActionCount = z.infer<typeof UserActivityActionCountSchema>;

export const UserActivityTrendRowSchema = z.object({
  date: z.string(),
  total: z.number().int().nonnegative(),
  users: z.number().int().nonnegative(),
});

export type UserActivityTrendRow = z.infer<typeof UserActivityTrendRowSchema>;

export const UserActivityUserSummarySchema = z.object({
  username: z.string(),
  total: z.number().int().nonnegative(),
  loginCount: z.number().int().nonnegative(),
  pageViewCount: z.number().int().nonnegative(),
  assistantMessageCount: z.number().int().nonnegative(),
  reviewActionCount: z.number().int().nonnegative(),
  lastActiveAt: z.string().nullable(),
});

export type UserActivityUserSummary = z.infer<typeof UserActivityUserSummarySchema>;

export const UserActivityRecentEventSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  action: UserActivityActionSchema,
  path: z.string(),
  createdAt: z.string(),
});

export type UserActivityRecentEvent = z.infer<typeof UserActivityRecentEventSchema>;

export const UserActivityResponseSchema = z.object({
  days: z.number().int().min(1).max(90),
  from: z.string(),
  to: z.string(),
  summary: UserActivitySummarySchema,
  actionCounts: z.array(UserActivityActionCountSchema),
  trend: z.array(UserActivityTrendRowSchema),
  users: z.array(UserActivityUserSummarySchema),
  usersTotal: z.number().int().nonnegative(),
  usersPage: z.number().int().positive(),
  usersPageSize: z.number().int().positive(),
  recent: z.array(UserActivityRecentEventSchema),
  recentTotal: z.number().int().nonnegative(),
  recentPage: z.number().int().positive(),
  recentPageSize: z.number().int().positive(),
});

export type UserActivityResponse = z.infer<typeof UserActivityResponseSchema>;

// Kept as an alias for consumers that still refer to the old browser-session name.
export const BrowserSessionResponseSchema = AuthResponseSchema;
export type BrowserSessionResponse = AuthResponse;

export const GitLabConnectionResponseSchema = z.object({
  baseUrl: z.string(),
  apiBaseUrl: z.string(),
  token: z.string(),
  tokenConfigured: z.boolean(),
});

export type GitLabConnectionResponse = z.infer<typeof GitLabConnectionResponseSchema>;

export const GitLabConnectionTestResponseSchema = z.object({
  ok: z.literal(true),
  baseUrl: z.string(),
  apiBaseUrl: z.string(),
  userName: z.string(),
  username: z.string().nullable(),
  latencyMs: z.number().nonnegative(),
  message: z.string(),
});

export type GitLabConnectionTestResponse = z.infer<typeof GitLabConnectionTestResponseSchema>;

export const JiraConnectionResponseSchema = z.object({
  baseUrl: z.string(),
  apiBaseUrl: z.string(),
  projectKey: z.string(),
  username: z.string(),
  tokenConfigured: z.boolean(),
});

export type JiraConnectionResponse = z.infer<typeof JiraConnectionResponseSchema>;

export const JiraConnectionTokenResponseSchema = z.object({
  token: z.string().min(1).max(4_000),
});

export type JiraConnectionTokenResponse = z.infer<typeof JiraConnectionTokenResponseSchema>;

export const JiraConnectionTestResponseSchema = z.object({
  ok: z.literal(true),
  baseUrl: z.string(),
  apiBaseUrl: z.string(),
  projectKey: z.string(),
  userName: z.string(),
  username: z.string().nullable(),
  latencyMs: z.number().nonnegative(),
  message: z.string(),
});

export type JiraConnectionTestResponse = z.infer<typeof JiraConnectionTestResponseSchema>;

export const JiraIdentitySchema = z.object({
  email: z.string().nullable().optional(),
  username: z.string(),
  name: z.string(),
  avatarUrl: nullableStringResponse,
});

export type JiraIdentity = z.infer<typeof JiraIdentitySchema>;

export const JiraOAuthStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  identity: JiraIdentitySchema.nullable(),
});

export type JiraOAuthStatus = z.infer<typeof JiraOAuthStatusSchema>;

export const JiraBoardColumnIdSchema = z.enum(["review", "todo", "in_progress", "acceptance", "done"]);
export type JiraBoardColumnId = z.infer<typeof JiraBoardColumnIdSchema>;

// Status IDs configured on the native AIP board (rapidView 1252). Jira has
// several status names for the same board column, so transition selection and
// issue filtering must use these IDs instead of status labels/categories.
export const JIRA_BOARD_STATUS_IDS: Readonly<Record<JiraBoardColumnId, readonly string[]>> = {
  review: ["11203", "10613", "11205", "10611", "11202", "11207", "12202", "12102", "12201", "12002", "11018", "10802", "12406"],
  todo: ["10612", "11206", "1", "11208", "10902", "10101", "10605", "12405", "11003"],
  in_progress: ["3", "10617", "11301", "11006", "11211", "11501", "10701"],
  acceptance: ["11201", "10002", "10001", "12302", "12013", "11218", "12206", "12203"],
  done: ["10608", "6", "5", "11801", "10102", "12006", "11601", "11011", "11204", "11212"],
};

export const JiraBoardMemberSchema = JiraIdentitySchema.extend({
  accountUsername: z.string(),
});

export type JiraBoardMember = z.infer<typeof JiraBoardMemberSchema>;

export const JiraIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  summary: z.string(),
  description: nullableStringResponse,
  status: z.string(),
  statusId: nullableStringResponse,
  statusCategory: z.string(),
  issueType: z.string(),
  priority: z.string().nullable(),
  projectKey: z.string(),
  projectName: z.string(),
  webUrl: z.string(),
  createdAt: nullableStringResponse,
  updatedAt: nullableStringResponse,
  resolution: nullableStringResponse,
  labels: z.array(z.string()),
  assignee: JiraIdentitySchema.nullable(),
  reporter: JiraIdentitySchema.nullable(),
});

export type JiraIssue = z.infer<typeof JiraIssueSchema>;

const optionalJiraText = (maxLength: number) => z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().max(maxLength).optional(),
);

const optionalJiraDate = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式不正确").optional(),
);

const JiraIssueLinkTypeSchema = z.enum([
  "blocks",
  "is blocked by",
  "is children of",
  "is parent of",
  "clones",
  "is cloned by",
  "duplicates",
  "is duplicated by",
  "relates to",
  "causes",
  "is caused by",
  "tests",
  "tested by",
]);

const JiraCustomFieldValueSchema = z.union([
  z.string().trim().max(5_000),
  z.number().int().nonnegative().max(1_000_000_000),
  z.array(z.string().trim().min(1).max(255)).max(20),
]);

const JiraCustomFieldsSchema = z.record(
  z.string().regex(/^customfield_\d+$/),
  JiraCustomFieldValueSchema,
).superRefine((fields, context) => {
  if (Object.keys(fields).length > 8) context.addIssue({ code: z.ZodIssueCode.custom, message: "自定义字段过多" });
});

export const JiraCreateIssueInputSchema = z.object({
  summary: z.string().trim().min(1, "请填写问题标题").max(255),
  issueType: z.string().trim().min(1, "请填写问题类型").max(128).default("任务"),
  dueDate: optionalJiraDate,
  components: z.array(z.string().trim().min(1).max(128)).min(1, "请选择模块").max(50),
  fixVersions: z.array(z.string().trim().min(1).max(128)).min(1, "请选择修复的版本").max(50),
  description: z.string().trim().min(1, "请填写描述").max(50_000),
  priority: optionalJiraText(128),
  assignee: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().max(128).regex(/^[A-Za-z0-9._-]+$/, "经办人账号格式不正确").optional(),
  ),
  reporter: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().max(128).regex(/^[A-Za-z0-9._-]+$/, "报告人账号格式不正确").optional(),
  ),
  environment: optionalJiraText(50_000),
  originalEstimate: optionalJiraText(32),
  remainingEstimate: optionalJiraText(32),
  linkedIssueType: JiraIssueLinkTypeSchema.optional(),
  linkedIssueKey: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}-\d+$/, "关联问题格式不正确").optional(),
  ),
  customFields: JiraCustomFieldsSchema.default({}),
  labels: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
}).strict();

export type JiraCreateIssueInput = z.infer<typeof JiraCreateIssueInputSchema>;

export const JiraCreateIssueOptionSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
});

export type JiraCreateIssueOption = z.infer<typeof JiraCreateIssueOptionSchema>;

export const JiraCreateIssueCustomFieldIdsSchema = z.object({
  customerName: z.string().regex(/^customfield_\d+$/).nullable(),
  epicLink: z.string().regex(/^customfield_\d+$/).nullable(),
  sprint: z.string().regex(/^customfield_\d+$/).nullable(),
}).strict();

export type JiraCreateIssueCustomFieldIds = z.infer<typeof JiraCreateIssueCustomFieldIdsSchema>;

const JiraCreateIssueAdvancedOptionsShape = {
  customers: z.array(z.string().trim().min(1).max(255)).max(500),
  epics: z.array(JiraCreateIssueOptionSchema).max(500),
  sprints: z.array(JiraCreateIssueOptionSchema).max(500),
  linkableIssues: z.array(JiraCreateIssueOptionSchema).max(100),
  customFieldIds: JiraCreateIssueCustomFieldIdsSchema,
};

export const JiraCreateIssueAdvancedOptionsSchema = z.object(JiraCreateIssueAdvancedOptionsShape);

export type JiraCreateIssueAdvancedOptions = z.infer<typeof JiraCreateIssueAdvancedOptionsSchema>;

const JiraCreateIssueHotOptionsShape = {
  issueTypes: z.array(JiraCreateIssueOptionSchema).max(1000),
  priorities: z.array(JiraCreateIssueOptionSchema).max(1000),
  priorityRequired: z.boolean().default(false),
  currentUser: JiraIdentitySchema,
};

const JiraCreateIssueSupportingOptionsShape = {
  assignees: z.array(JiraIdentitySchema).max(1000),
  components: z.array(JiraCreateIssueOptionSchema).max(500),
  fixVersions: z.array(JiraCreateIssueOptionSchema).max(500),
  labels: z.array(z.string().trim().min(1).max(128)).max(1000),
};

export const JiraCreateIssueSupportingOptionsSchema = z.object(JiraCreateIssueSupportingOptionsShape);

export type JiraCreateIssueSupportingOptions = z.infer<typeof JiraCreateIssueSupportingOptionsSchema>;

export const JiraCreateIssueSupportingPatchSchema = JiraCreateIssueSupportingOptionsSchema.partial().strict();

export type JiraCreateIssueSupportingPatch = z.infer<typeof JiraCreateIssueSupportingPatchSchema>;

export const JiraCreateIssueOptionsSchema = z.object({
  ...JiraCreateIssueHotOptionsShape,
  ...JiraCreateIssueSupportingOptionsShape,
  reporters: z.array(JiraIdentitySchema).max(1000),
}).merge(JiraCreateIssueAdvancedOptionsSchema);

export type JiraCreateIssueOptions = z.infer<typeof JiraCreateIssueOptionsSchema>;

export const JIRA_MAX_ISSUE_ATTACHMENTS = 3;
export const JIRA_MAX_ISSUE_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const JiraCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: JiraIdentitySchema.nullable(),
  createdAt: nullableStringResponse,
  updatedAt: nullableStringResponse,
});

export type JiraComment = z.infer<typeof JiraCommentSchema>;

export const JiraAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  url: nullableStringResponse,
  mimeType: nullableStringResponse,
  size: z.number().int().nonnegative().nullable(),
  createdAt: nullableStringResponse,
  author: JiraIdentitySchema.nullable(),
});

export type JiraAttachment = z.infer<typeof JiraAttachmentSchema>;

export const JiraAttachmentUploadResponseSchema = z.object({
  uploaded: z.number().int().nonnegative().max(JIRA_MAX_ISSUE_ATTACHMENTS),
}).strict();

export type JiraAttachmentUploadResponse = z.infer<typeof JiraAttachmentUploadResponseSchema>;

export const JiraIssueDetailsSchema = JiraIssueSchema.extend({
  comments: z.array(JiraCommentSchema),
  attachments: z.array(JiraAttachmentSchema),
});

export type JiraIssueDetails = z.infer<typeof JiraIssueDetailsSchema>;

export const JiraIssueTransitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  toStatus: z.string(),
  toStatusId: nullableStringResponse,
});

export type JiraIssueTransition = z.infer<typeof JiraIssueTransitionSchema>;

export const JiraIssueTransitionsResponseSchema = z.object({
  transitions: z.array(JiraIssueTransitionSchema),
});

export type JiraIssueTransitionsResponse = z.infer<typeof JiraIssueTransitionsResponseSchema>;

export const JiraIssueListResponseSchema = z.object({
  issues: z.array(JiraIssueSchema),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});

export type JiraIssueListResponse = z.infer<typeof JiraIssueListResponseSchema>;

export const JiraBoardColumnSchema = z.object({
  id: JiraBoardColumnIdSchema,
  label: z.string(),
  issues: z.array(JiraIssueSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export type JiraBoardColumn = z.infer<typeof JiraBoardColumnSchema>;

export const JiraBoardResponseSchema = z.object({
  projectKey: z.string(),
  members: z.array(JiraBoardMemberSchema),
  columns: z.array(JiraBoardColumnSchema),
  total: z.number().int().nonnegative(),
});

export type JiraBoardResponse = z.infer<typeof JiraBoardResponseSchema>;

export const JiraOverviewResponseSchema = z.object({
  user: JiraIdentitySchema,
  assigned: z.array(JiraIssueSchema),
  assignedTotal: z.number().int().nonnegative(),
  reported: z.array(JiraIssueSchema),
  reportedTotal: z.number().int().nonnegative(),
  recent: z.array(JiraIssueSchema),
  recentTotal: z.number().int().nonnegative(),
});

export type JiraOverviewResponse = z.infer<typeof JiraOverviewResponseSchema>;

export const JiraCommentResponseSchema = z.object({ comment: JiraCommentSchema });
export type JiraCommentResponse = z.infer<typeof JiraCommentResponseSchema>;

export const GitLabIdentitySchema = z.object({
  id: nullableStringResponse,
  username: z.string(),
  name: z.string(),
  webUrl: nullableStringResponse,
  avatarUrl: nullableStringResponse,
});

export type GitLabIdentity = z.infer<typeof GitLabIdentitySchema>;

const GitLabProjectIdentifierSchema = z.string().trim().min(1).max(128);
const GitLabUserIdentifierSchema = z.string().trim().regex(/^\d+$/, "GitLab 用户 ID 格式不正确").max(32);
const GitLabMilestoneIdentifierSchema = z.string().trim().regex(/^\d+$/, "GitLab Milestone ID 格式不正确").max(32);
const optionalGitLabMilestoneId = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  GitLabMilestoneIdentifierSchema.optional(),
);

export const GitLabCreateMergeRequestInputSchema = z.object({
  targetProjectId: GitLabProjectIdentifierSchema,
  sourceProjectId: GitLabProjectIdentifierSchema,
  sourceBranch: z.string().trim().min(1, "请选择源分支").max(255),
  targetBranch: z.string().trim().min(1, "请选择目标分支").max(255),
  title: z.string().trim().min(1, "请填写 Merge Request 标题").max(255),
  description: z.string().max(100_000).default(""),
  assigneeIds: z.array(GitLabUserIdentifierSchema).max(20).default([]),
  reviewerIds: z.array(GitLabUserIdentifierSchema).max(20).default([]),
  milestoneId: optionalGitLabMilestoneId,
  labels: z.array(z.string().trim().min(1).max(255)).max(50).default([]),
  removeSourceBranch: z.boolean().default(true),
  squash: z.boolean().default(false),
}).strict();

export type GitLabCreateMergeRequestInput = z.infer<typeof GitLabCreateMergeRequestInputSchema>;

export const GitLabUpdateMergeRequestInputSchema = z.object({
  targetBranch: z.string().trim().min(1, "请选择目标分支").max(255).optional(),
  title: z.string().trim().min(1, "请填写 Merge Request 标题").max(255).optional(),
  description: z.string().max(100_000).optional(),
  assigneeIds: z.array(GitLabUserIdentifierSchema).max(20).optional(),
  reviewerIds: z.array(GitLabUserIdentifierSchema).max(20).optional(),
  milestoneId: z.union([GitLabMilestoneIdentifierSchema, z.null()]).optional(),
  labels: z.array(z.string().trim().min(1).max(255)).max(50).optional(),
  squash: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少提供一个需要更新的字段");

export type GitLabUpdateMergeRequestInput = z.infer<typeof GitLabUpdateMergeRequestInputSchema>;

export const GitLabGenerateMergeRequestDescriptionInputSchema = z.object({
  projectPath: z.string().trim().min(1).max(512),
  jiraKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}-\d+$/, "Jira key 格式不正确"),
  jiraUrl: z.string().trim().url().max(2_048).nullable().optional(),
  sourceBranch: z.string().trim().min(1).max(255),
  targetBranch: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(255),
  commitTitle: z.string().trim().max(255).nullable().optional(),
  commitMessage: z.string().max(50_000).nullable().optional(),
  jiraDescription: z.string().max(50_000).nullable().optional(),
}).strict();

export type GitLabGenerateMergeRequestDescriptionInput = z.infer<typeof GitLabGenerateMergeRequestDescriptionInputSchema>;

export const GitLabGenerateMergeRequestDescriptionResponseSchema = z.object({
  description: z.string().min(1).max(100_000),
}).strict();

export type GitLabGenerateMergeRequestDescriptionResponse = z.infer<typeof GitLabGenerateMergeRequestDescriptionResponseSchema>;

export const GitLabMergeMergeRequestInputSchema = z.object({
  sha: z.string().trim().min(1).max(128).optional(),
  mergeWhenPipelineSucceeds: z.boolean().default(false),
  shouldRemoveSourceBranch: z.boolean().default(false),
  squash: z.boolean().default(false),
}).strict();

export type GitLabMergeMergeRequestInput = z.infer<typeof GitLabMergeMergeRequestInputSchema>;

export const GitLabBranchOptionSchema = z.object({
  name: z.string(),
  isDefault: z.boolean(),
  isProtected: z.boolean(),
  commitSha: nullableStringResponse,
  commitTitle: nullableStringResponse,
  commitMessage: nullableStringResponse,
});

export type GitLabBranchOption = z.infer<typeof GitLabBranchOptionSchema>;

export const GitLabMilestoneOptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.string(),
  dueDate: nullableStringResponse,
});

export type GitLabMilestoneOption = z.infer<typeof GitLabMilestoneOptionSchema>;

export const GitLabLabelOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: nullableStringResponse,
  description: nullableStringResponse,
});

export type GitLabLabelOption = z.infer<typeof GitLabLabelOptionSchema>;

export const GitLabMergeRequestCreateOptionsSchema = z.object({
  currentUser: GitLabIdentitySchema,
  branches: z.array(GitLabBranchOptionSchema),
  members: z.array(GitLabIdentitySchema),
  milestones: z.array(GitLabMilestoneOptionSchema),
  labels: z.array(GitLabLabelOptionSchema),
});

export type GitLabMergeRequestCreateOptions = z.infer<typeof GitLabMergeRequestCreateOptionsSchema>;

export const GitLabOAuthStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  identity: GitLabIdentitySchema.nullable(),
});

export type GitLabOAuthStatus = z.infer<typeof GitLabOAuthStatusSchema>;

export const GitLabPipelineSchema = z.object({
  id: z.string(),
  status: nullableStringResponse,
  ref: nullableStringResponse,
  sha: nullableStringResponse,
  webUrl: nullableStringResponse,
  source: nullableStringResponse,
  createdAt: nullableStringResponse,
  updatedAt: nullableStringResponse,
  duration: z.number().nullable(),
  coverage: z.number().nullable(),
});

export type GitLabPipeline = z.infer<typeof GitLabPipelineSchema>;

export const GitLabPipelineJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  stage: z.string(),
  status: nullableStringResponse,
  webUrl: nullableStringResponse,
  createdAt: nullableStringResponse,
  startedAt: nullableStringResponse,
  finishedAt: nullableStringResponse,
  duration: z.number().nullable(),
  allowFailure: z.boolean(),
  failureReason: nullableStringResponse,
});

export type GitLabPipelineJob = z.infer<typeof GitLabPipelineJobSchema>;

export const GitLabMergeRequestSchema = z.object({
  id: z.string(),
  iid: z.string(),
  projectId: z.string(),
  projectPath: z.string(),
  title: z.string(),
  description: nullableStringResponse,
  state: z.string(),
  draft: z.boolean(),
  webUrl: nullableStringResponse,
  createdAt: nullableStringResponse,
  updatedAt: nullableStringResponse,
  sourceBranch: nullableStringResponse,
  targetBranch: nullableStringResponse,
  headSha: nullableStringResponse,
  mergeError: nullableStringResponse.optional(),
  author: GitLabIdentitySchema.nullable(),
  assignees: z.array(GitLabIdentitySchema),
  reviewers: z.array(GitLabIdentitySchema),
  milestone: GitLabMilestoneOptionSchema.nullable(),
  labels: z.array(z.string()),
  pipeline: GitLabPipelineSchema.nullable(),
});

export type GitLabMergeRequest = z.infer<typeof GitLabMergeRequestSchema>;

export const GitLabMergeRequestChangeSchema = z.object({
  oldPath: nullableStringResponse,
  newPath: nullableStringResponse,
  diff: z.string(),
  changeType: z.enum(["added", "deleted", "renamed", "modified"]),
});

export type GitLabMergeRequestChange = z.infer<typeof GitLabMergeRequestChangeSchema>;

export const GitLabMergeRequestNoteSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: GitLabIdentitySchema.nullable(),
  createdAt: nullableStringResponse,
  updatedAt: nullableStringResponse,
  system: z.boolean(),
  resolvable: z.boolean(),
});

export type GitLabMergeRequestNote = z.infer<typeof GitLabMergeRequestNoteSchema>;

export const GitLabNoteBodySchema = z.object({
  body: z.string().trim().min(1).max(50_000),
}).strict();

export type GitLabNoteBody = z.infer<typeof GitLabNoteBodySchema>;

export const GitLabMergeRequestDetailsSchema = GitLabMergeRequestSchema.extend({
  changes: z.array(GitLabMergeRequestChangeSchema),
  notes: z.array(GitLabMergeRequestNoteSchema),
  pipelines: z.array(GitLabPipelineSchema),
});

export type GitLabMergeRequestDetails = z.infer<typeof GitLabMergeRequestDetailsSchema>;

export const GitLabMergeRequestListResponseSchema = z.object({
  mergeRequests: z.array(GitLabMergeRequestSchema),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
});

export type GitLabMergeRequestListResponse = z.infer<typeof GitLabMergeRequestListResponseSchema>;

export const GitLabOverviewResponseSchema = z.object({
  user: GitLabIdentitySchema,
  assigned: z.array(GitLabMergeRequestSchema),
  created: z.array(GitLabMergeRequestSchema),
  reviewRequested: z.array(GitLabMergeRequestSchema),
});

export type GitLabOverviewResponse = z.infer<typeof GitLabOverviewResponseSchema>;

export const GitLabPipelinesResponseSchema = z.object({
  pipelines: z.array(GitLabPipelineSchema),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
});

export type GitLabPipelinesResponse = z.infer<typeof GitLabPipelinesResponseSchema>;

export const GitLabPipelineJobsResponseSchema = z.object({
  jobs: z.array(GitLabPipelineJobSchema),
});

export type GitLabPipelineJobsResponse = z.infer<typeof GitLabPipelineJobsResponseSchema>;

export const GitLabProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  pathWithNamespace: z.string(),
  nameWithNamespace: z.string(),
  webUrl: nullableStringResponse,
  defaultBranch: nullableStringResponse,
  visibility: nullableStringResponse,
  lastActivityAt: nullableStringResponse,
  avatarUrl: nullableStringResponse,
});

export type GitLabProject = z.infer<typeof GitLabProjectSchema>;

export const GitLabRecentPushSchema = z.object({
  project: GitLabProjectSchema,
  sourceBranch: z.string().trim().min(1),
  commitSha: nullableStringResponse,
  commitTitle: nullableStringResponse,
  createdAt: z.string().trim().min(1),
});

export type GitLabRecentPush = z.infer<typeof GitLabRecentPushSchema>;

export const GitLabRecentPushResponseSchema = z.object({
  recentPush: GitLabRecentPushSchema.nullable(),
});

export type GitLabRecentPushResponse = z.infer<typeof GitLabRecentPushResponseSchema>;

export const GitLabProfileOptionSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  isDefault: z.boolean(),
  ruleCount: z.number().int().nonnegative(),
});

export type GitLabProfileOption = z.infer<typeof GitLabProfileOptionSchema>;

export const GitLabProjectConfigSchema = GitLabProjectSchema.extend({
  reviewProfileName: z.string(),
  reviewProfileDisplayName: z.string(),
  customReviewProfile: z.boolean(),
  reviewRuleCount: z.number().int().nonnegative(),
});

export type GitLabProjectConfig = z.infer<typeof GitLabProjectConfigSchema>;

export const GitLabProjectsResponseSchema = z.object({
  projects: z.array(GitLabProjectConfigSchema),
  profiles: z.array(GitLabProfileOptionSchema),
});

export type GitLabProjectsResponse = z.infer<typeof GitLabProjectsResponseSchema>;

export const GitLabNoteResponseSchema = z.object({ note: GitLabMergeRequestNoteSchema });
export type GitLabNoteResponse = z.infer<typeof GitLabNoteResponseSchema>;

export const ReviewListResponseSchema = z.object({
  jobs: z.array(ReviewJobSchema),
  stats: ReviewStatsSchema,
});

export type ReviewListResponse = z.infer<typeof ReviewListResponseSchema>;

export const ReviewCreateResponseSchema = z.object({
  accepted: z.boolean(),
  deduplicated: z.boolean(),
  job: ReviewJobSchema,
});

export type ReviewCreateResponse = z.infer<typeof ReviewCreateResponseSchema>;

export const FeedbackCategorySchema = z.enum(["bug", "feature", "experience", "other"]);
export type FeedbackCategory = z.infer<typeof FeedbackCategorySchema>;

export const FEEDBACK_MAX_ATTACHMENTS = 3;
export const FEEDBACK_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const FeedbackImageMimeTypeSchema = z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export type FeedbackImageMimeType = z.infer<typeof FeedbackImageMimeTypeSchema>;

export const FeedbackAttachmentSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1).max(180),
  mimeType: FeedbackImageMimeTypeSchema,
  size: z.number().int().positive().max(FEEDBACK_MAX_ATTACHMENT_BYTES),
});
export type FeedbackAttachment = z.infer<typeof FeedbackAttachmentSchema>;

export const FeedbackSubmitResponseSchema = z.object({
  accepted: z.literal(true),
  receivedAt: z.string(),
});

export type FeedbackSubmitResponse = z.infer<typeof FeedbackSubmitResponseSchema>;

export const FeedbackListItemSchema = z.object({
  id: z.string().uuid(),
  category: FeedbackCategorySchema,
  rating: z.number().int().min(1).max(5),
  message: z.string(),
  createdAt: z.string(),
});

export const FeedbackDetailSchema = FeedbackListItemSchema.extend({
  contact: z.string().max(200).optional(),
  attachments: z.array(FeedbackAttachmentSchema).optional(),
});

export const FeedbackListResponseSchema = z.object({
  items: z.array(FeedbackListItemSchema),
  total: z.number().int().nonnegative(),
});

export type FeedbackListItem = z.infer<typeof FeedbackListItemSchema>;
export type FeedbackDetail = z.infer<typeof FeedbackDetailSchema>;
export type FeedbackListResponse = z.infer<typeof FeedbackListResponseSchema>;

export const AssistantChatMessageInputSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export type AssistantChatMessageInput = z.infer<typeof AssistantChatMessageInputSchema>;

export const AssistantFocusContextSchema = z.object({
  provider: z.enum(["gitlab", "jira"]),
  resourceType: z.enum(["merge_request", "issue"]),
  resourceId: z.string().trim().min(1).max(256),
  projectId: z.string().trim().min(1).max(256).optional(),
  projectPath: z.string().trim().min(1).max(512).optional(),
  title: z.string().trim().max(500).optional(),
}).strict();

export type AssistantFocusContext = z.infer<typeof AssistantFocusContextSchema>;

export const AssistantEditSessionStatusSchema = z.enum(["active", "approval_pending", "closed", "failed", "expired"]);
export type AssistantEditSessionStatus = z.infer<typeof AssistantEditSessionStatusSchema>;

export const AssistantEditSessionRetentionModeSchema = z.enum(["auto", "pinned"]);
export type AssistantEditSessionRetentionMode = z.infer<typeof AssistantEditSessionRetentionModeSchema>;

export const AssistantEditOperationStatusSchema = z.enum(["pending", "applied", "rejected", "conflict", "failed"]);
export type AssistantEditOperationStatus = z.infer<typeof AssistantEditOperationStatusSchema>;

export const AssistantEditOperationSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  path: z.string(),
  summary: z.string(),
  diff: z.string(),
  status: AssistantEditOperationStatusSchema,
  beforeSha256: nullableStringResponse,
  afterSha256: nullableStringResponse,
  error: nullableStringResponse,
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export type AssistantEditOperation = z.infer<typeof AssistantEditOperationSchema>;

export const AssistantEditSessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectPath: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  status: AssistantEditSessionStatusSchema,
  retentionMode: AssistantEditSessionRetentionModeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  changedFiles: z.number().int().nonnegative(),
  pendingOperationCount: z.number().int().nonnegative(),
  operations: z.array(AssistantEditOperationSchema),
}).strict();

export type AssistantEditSession = z.infer<typeof AssistantEditSessionSchema>;

export const AssistantAuthCardSchema = z.object({
  kind: z.literal("auth_required"),
  provider: z.enum(["gitlab", "jira"]),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(1_000),
  actionLabel: z.string().trim().min(1).max(80),
  actionPath: z.string().trim().min(1).max(512),
}).strict();

export const AssistantCardSchema = z.discriminatedUnion("kind", [AssistantAuthCardSchema]);
export type AssistantAuthCard = z.infer<typeof AssistantAuthCardSchema>;
export type AssistantCard = z.infer<typeof AssistantCardSchema>;

export const AssistantConversationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
});

export type AssistantConversationSummary = z.infer<typeof AssistantConversationSummarySchema>;

export const AssistantConversationMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
});

export type AssistantConversationMessage = z.infer<typeof AssistantConversationMessageSchema>;

export const AssistantRunStatusSchema = z.enum(["running", "completed", "failed", "canceled"]);
export type AssistantRunStatus = z.infer<typeof AssistantRunStatusSchema>;

export const AssistantRunEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  event: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export type AssistantRunEvent = z.infer<typeof AssistantRunEventSchema>;

export const AssistantRunResponseSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  userMessageId: z.string(),
  assistantMessageId: z.string(),
  status: AssistantRunStatusSchema,
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: nullableStringResponse,
  error: nullableStringResponse,
  lastSequence: z.number().int().nonnegative(),
  events: z.array(AssistantRunEventSchema),
});

export type AssistantRunResponse = z.infer<typeof AssistantRunResponseSchema>;

export const InspectionAiReviewStatusSchema = z.enum(["pending", "passed", "findings", "failed", "skipped"]);
export type InspectionAiReviewStatus = z.infer<typeof InspectionAiReviewStatusSchema>;
export const InspectionAiPreReviewStatusSchema = z.enum(["pending", "passed", "findings", "failed"]);
export type InspectionAiPreReviewStatus = z.infer<typeof InspectionAiPreReviewStatusSchema>;
export const InspectionAiPreReviewSchema = z.object({
  status: InspectionAiPreReviewStatusSchema,
  report: nullableStringResponse,
  feedback: nullableStringResponse,
  diffSha: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  blockingFindingCount: z.number().int().nonnegative(),
  unmetRequirementCount: z.number().int().nonnegative(),
  missingRequirementCount: z.number().int().nonnegative().default(0),
  unclearRequirementCount: z.number().int().nonnegative().default(0),
  progress: z.array(ReviewProgressEventSchema).max(200).default([]),
});
export type InspectionAiPreReview = z.infer<typeof InspectionAiPreReviewSchema>;
export const InspectionAiVerificationSchema = z.object({
  headSha: z.string().nullable(),
  pipelineId: z.string().nullable(),
  pipelineStatus: nullableStringResponse,
  pipelineWebUrl: nullableStringResponse,
  reviewJobId: z.string().nullable(),
  reviewJobName: nullableStringResponse,
  reviewJobStatus: nullableStringResponse,
  reviewJobWebUrl: nullableStringResponse,
  reviewNoteId: z.string().nullable().default(null),
  reviewStatus: InspectionAiReviewStatusSchema,
  report: nullableStringResponse,
  feedback: nullableStringResponse,
  repairAttempts: z.number().int().nonnegative(),
});
export type InspectionAiVerification = z.infer<typeof InspectionAiVerificationSchema>;

export const GitLabMrAiRepairStatusSchema = z.enum([
  "queued",
  "preparing",
  "running",
  "publishing",
  "pipeline_pending",
  "review_pending",
  "review_fixing",
  "mr_open",
  "merged",
  "closed",
  "failed",
  "canceled",
]);
export type GitLabMrAiRepairStatus = z.infer<typeof GitLabMrAiRepairStatusSchema>;

export const GitLabMrAiRepairTaskSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  projectId: z.string(),
  projectPath: z.string(),
  sourceProjectId: z.string(),
  sourceProjectPath: z.string(),
  mrIid: z.string(),
  title: z.string(),
  mrUrl: nullableStringResponse,
  sourceBranch: z.string(),
  targetBranch: z.string(),
  status: GitLabMrAiRepairStatusSchema,
  phase: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  editSessionId: z.string().nullable(),
  assistantRunId: z.string().nullable(),
  commitSha: z.string().nullable(),
  verification: InspectionAiVerificationSchema.nullable().default(null),
  error: nullableStringResponse,
  syncedAt: nullableStringResponse,
  syncError: nullableStringResponse,
}).strict();
export type GitLabMrAiRepairTask = z.infer<typeof GitLabMrAiRepairTaskSchema>;

export const GitLabMrAiRepairTaskResponseSchema = z.object({
  task: GitLabMrAiRepairTaskSchema.nullable(),
}).strict();
export type GitLabMrAiRepairTaskResponse = z.infer<typeof GitLabMrAiRepairTaskResponseSchema>;

export const GitLabMrAiRepairTaskDetailSchema = z.object({
  task: GitLabMrAiRepairTaskSchema,
  execution: AssistantRunResponseSchema.nullable(),
  executions: z.array(AssistantRunResponseSchema).default([]),
  editSession: AssistantEditSessionSchema.nullable(),
}).strict();
export type GitLabMrAiRepairTaskDetail = z.infer<typeof GitLabMrAiRepairTaskDetailSchema>;

export const GitLabMrAiRepairTaskActionResponseSchema = z.object({
  task: GitLabMrAiRepairTaskSchema,
}).strict();
export type GitLabMrAiRepairTaskActionResponse = z.infer<typeof GitLabMrAiRepairTaskActionResponseSchema>;

export const InspectionAiResolutionStatusSchema = z.enum(["active", "reverted", "unknown"]);
export type InspectionAiResolutionStatus = z.infer<typeof InspectionAiResolutionStatusSchema>;
export const InspectionAiResolutionFileSchema = z.object({
  path: z.string(),
  baseBlobId: z.string().nullable(),
  mergedBlobId: z.string().nullable(),
});
export const InspectionAiResolutionSchema = z.object({
  status: InspectionAiResolutionStatusSchema,
  checkedAt: z.string(),
  targetHeadSha: z.string().nullable(),
  error: z.string().nullable(),
  files: z.array(InspectionAiResolutionFileSchema),
});
export type InspectionAiResolution = z.infer<typeof InspectionAiResolutionSchema>;

export const InspectionAiTaskSchema = z.object({
  id: z.string(), maintainerId: z.string(), jiraKey: z.string(), title: z.string(),
  projectId: z.string(), projectPath: z.string(), targetBranch: z.string(), sourceBranch: z.string(),
  status: z.enum(["queued", "preparing", "running", "publishing", "pipeline_pending", "review_pending", "review_fixing", "mr_open", "merged", "closed", "failed", "canceled"]),
  phase: z.string(), createdAt: z.string(), updatedAt: z.string(),
  editSessionId: z.string().nullable(), assistantRunId: z.string().nullable(), commitSha: z.string().nullable(),
  mr: z.object({
    projectId: z.string(), iid: z.string(), webUrl: z.string().nullable(), state: z.string(),
    mergeCommitSha: z.string().nullable().optional(), squashCommitSha: z.string().nullable().optional(),
    mergeBaseSha: z.string().nullable().optional(), mergedAt: z.string().nullable().optional(),
    changedPaths: z.array(z.string()).optional(),
  }).nullable(),
  preReview: InspectionAiPreReviewSchema.nullable().default(null),
  verification: InspectionAiVerificationSchema.nullable().default(null),
  resolution: InspectionAiResolutionSchema.nullable().default(null),
  error: z.string().nullable(), syncedAt: z.string().nullable(), syncError: z.string().nullable(),
});
export type InspectionAiTask = z.infer<typeof InspectionAiTaskSchema>;
export const InspectionAiTaskDetailSchema = z.object({
  task: InspectionAiTaskSchema,
  execution: AssistantRunResponseSchema.nullable(),
  executions: z.array(AssistantRunResponseSchema).default([]),
  editSession: AssistantEditSessionSchema.nullable(),
});
export type InspectionAiTaskDetail = z.infer<typeof InspectionAiTaskDetailSchema>;

export const InspectionAiReprocessActionSchema = z.enum(["restarted", "skipped"]);
export type InspectionAiReprocessAction = z.infer<typeof InspectionAiReprocessActionSchema>;
export const InspectionAiReprocessResponseSchema = z.object({
  task: InspectionAiTaskSchema,
  action: InspectionAiReprocessActionSchema,
  resolutionStatus: InspectionAiResolutionStatusSchema,
});
export type InspectionAiReprocessResponse = z.infer<typeof InspectionAiReprocessResponseSchema>;

// Ordinary Jira AI processing has a separate precheck contract.  It is
// intentionally not part of the inspection task contract: inspection Jira
// issues already have their own source and lifecycle.
export const OrdinaryJiraAiCheckIdSchema = z.enum([
  "problem",
  "expected",
  "scope",
  "reproduction",
  "acceptance",
  "constraints",
]);
export type OrdinaryJiraAiCheckId = z.infer<typeof OrdinaryJiraAiCheckIdSchema>;

export const OrdinaryJiraAiCheckSchema = z.object({
  id: OrdinaryJiraAiCheckIdSchema,
  label: z.string().trim().min(1).max(128),
  status: z.enum(["present", "missing"]),
  evidence: z.string().trim().max(2_000),
  detail: z.string().trim().max(2_000),
}).strict();
export type OrdinaryJiraAiCheck = z.infer<typeof OrdinaryJiraAiCheckSchema>;

export const OrdinaryJiraAiImplementationBriefSchema = z.object({
  problem: z.string().trim().max(8_000),
  expected: z.string().trim().max(8_000),
  scope: z.string().trim().max(8_000),
  reproduction: z.string().trim().max(8_000),
  acceptance: z.string().trim().max(8_000),
  constraints: z.string().trim().max(8_000),
}).strict();
export type OrdinaryJiraAiImplementationBrief = z.infer<typeof OrdinaryJiraAiImplementationBriefSchema>;

export const OrdinaryJiraAiPrecheckStatusSchema = z.enum(["passed", "needs_input", "failed"]);
export type OrdinaryJiraAiPrecheckStatus = z.infer<typeof OrdinaryJiraAiPrecheckStatusSchema>;

export const OrdinaryJiraAiPrecheckSchema = z.object({
  id: z.string().uuid(),
  jiraKey: z.string(),
  jiraUpdatedAt: nullableStringResponse,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.string(),
  status: OrdinaryJiraAiPrecheckStatusSchema,
  checks: z.array(OrdinaryJiraAiCheckSchema).length(6),
  summary: z.string().trim().max(4_000),
  implementationBrief: OrdinaryJiraAiImplementationBriefSchema,
  projectPath: z.string().trim().min(1).max(512),
  targetBranch: z.string().trim().min(1).max(255),
  error: nullableStringResponse,
}).strict();
export type OrdinaryJiraAiPrecheck = z.infer<typeof OrdinaryJiraAiPrecheckSchema>;

export const OrdinaryJiraAiPrecheckResponseSchema = z.object({
  precheck: OrdinaryJiraAiPrecheckSchema,
}).strict();
export type OrdinaryJiraAiPrecheckResponse = z.infer<typeof OrdinaryJiraAiPrecheckResponseSchema>;

export const OrdinaryJiraAiPrecheckLookupResponseSchema = z.object({
  status: z.enum(["idle", "processing", "ready"]),
  precheck: OrdinaryJiraAiPrecheckSchema.nullable(),
  projectId: z.string().nullable(),
}).strict();
export type OrdinaryJiraAiPrecheckLookupResponse = z.infer<typeof OrdinaryJiraAiPrecheckLookupResponseSchema>;

export const OrdinaryJiraAiSupplementStatusSchema = z.enum(["resolvable", "needs_user"]);
export type OrdinaryJiraAiSupplementStatus = z.infer<typeof OrdinaryJiraAiSupplementStatusSchema>;

export const OrdinaryJiraAiSupplementSchema = z.object({
  checkId: OrdinaryJiraAiCheckIdSchema,
  label: z.string().trim().min(1).max(128),
  status: OrdinaryJiraAiSupplementStatusSchema,
  suggestion: z.string().trim().max(4_000),
  evidence: z.string().trim().max(2_000),
  reason: z.string().trim().max(2_000),
}).strict();
export type OrdinaryJiraAiSupplement = z.infer<typeof OrdinaryJiraAiSupplementSchema>;

export const OrdinaryJiraAiSupplementResponseSchema = z.object({
  supplement: OrdinaryJiraAiSupplementSchema,
}).strict();
export type OrdinaryJiraAiSupplementResponse = z.infer<typeof OrdinaryJiraAiSupplementResponseSchema>;

export const OrdinaryJiraAiTaskStatusSchema = z.enum(["queued", "preparing", "running", "publishing", "pipeline_pending", "review_pending", "review_fixing", "mr_open", "merged", "closed", "failed", "canceled"]);
export type OrdinaryJiraAiTaskStatus = z.infer<typeof OrdinaryJiraAiTaskStatusSchema>;

export const OrdinaryJiraAiTaskSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  jiraKey: z.string(),
  title: z.string(),
  jiraUrl: z.string().nullable(),
  projectId: z.string(),
  projectPath: z.string(),
  targetBranch: z.string(),
  sourceBranch: z.string(),
  status: OrdinaryJiraAiTaskStatusSchema,
  phase: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  editSessionId: z.string().nullable(),
  assistantRunId: z.string().nullable(),
  commitSha: z.string().nullable(),
  mr: z.object({
    projectId: z.string(),
    iid: z.string(),
    webUrl: z.string().nullable(),
    state: z.string(),
    mergeCommitSha: z.string().nullable().optional(),
    squashCommitSha: z.string().nullable().optional(),
    mergeBaseSha: z.string().nullable().optional(),
    mergedAt: z.string().nullable().optional(),
    changedPaths: z.array(z.string()).optional(),
  }).nullable(),
  precheck: OrdinaryJiraAiPrecheckSchema,
  preReview: InspectionAiPreReviewSchema.nullable().default(null),
  verification: InspectionAiVerificationSchema.nullable().default(null),
  error: z.string().nullable(),
  syncedAt: z.string().nullable(),
  syncError: z.string().nullable(),
}).strict();
export type OrdinaryJiraAiTask = z.infer<typeof OrdinaryJiraAiTaskSchema>;

export const OrdinaryJiraAiTaskSummarySchema = z.object({
  id: z.string().uuid(),
  jiraKey: z.string(),
  status: OrdinaryJiraAiTaskStatusSchema,
  phase: z.string(),
  updatedAt: z.string(),
  hasMr: z.boolean(),
}).strict();
export type OrdinaryJiraAiTaskSummary = z.infer<typeof OrdinaryJiraAiTaskSummarySchema>;

export const OrdinaryJiraAiPrecheckSummarySchema = z.object({
  jiraKey: z.string(),
  status: z.enum(["processing", "ready"]),
  precheckStatus: OrdinaryJiraAiPrecheckStatusSchema.nullable(),
}).strict();
export type OrdinaryJiraAiPrecheckSummary = z.infer<typeof OrdinaryJiraAiPrecheckSummarySchema>;

export const OrdinaryJiraAiTaskSummaryResponseSchema = z.object({
  tasks: z.array(OrdinaryJiraAiTaskSummarySchema),
  prechecks: z.array(OrdinaryJiraAiPrecheckSummarySchema),
}).strict();
export type OrdinaryJiraAiTaskSummaryResponse = z.infer<typeof OrdinaryJiraAiTaskSummaryResponseSchema>;

export const OrdinaryJiraAiTaskDetailSchema = z.object({
  task: OrdinaryJiraAiTaskSchema,
  execution: AssistantRunResponseSchema.nullable(),
  executions: z.array(AssistantRunResponseSchema).default([]),
  editSession: AssistantEditSessionSchema.nullable(),
}).strict();
export type OrdinaryJiraAiTaskDetail = z.infer<typeof OrdinaryJiraAiTaskDetailSchema>;

export const AssistantConversationResponseSchema = AssistantConversationSummarySchema.extend({
  messages: z.array(AssistantConversationMessageSchema),
  activeRun: AssistantRunResponseSchema.optional(),
  latestRun: AssistantRunResponseSchema.optional(),
});

export type AssistantConversationResponse = z.infer<typeof AssistantConversationResponseSchema>;

export const AssistantStreamEventSchema = z.object({
  message: z.string().optional(),
  detail: z.string().nullable().optional(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  runId: z.string().optional(),
  activityId: z.string().nullable().optional(),
  toolName: z.string().nullable().optional(),
  toolInput: z.unknown().optional(),
  phase: z.enum(["start", "running", "complete", "error"]).optional(),
  meta: z.record(z.string(), primitiveResponse).optional(),
  reviewTask: AssistantReviewTaskReferenceSchema.optional(),
  card: AssistantCardSchema.optional(),
  editSessionId: z.string().optional(),
  editOperation: AssistantEditOperationSchema.optional(),
});

export type AssistantStreamEvent = z.infer<typeof AssistantStreamEventSchema>;

export const AssistantConversationListResponseSchema = z.object({
  conversations: z.array(AssistantConversationSummarySchema),
});

export const DeleteResponseSchema = z.object({ deleted: z.boolean() });
export const CancelResponseSchema = z.object({ canceled: z.boolean() });
export const ReviewProfileResponseSchema = z.object({ profile: ReviewRuleProfileSchema });

export const InspectionMaintainerSchema = z.object({ id: z.string(), username: z.string(), enabled: z.boolean() });
export const InspectionLoginResponseSchema = z.object({ maintainer: InspectionMaintainerSchema });
export const InspectionAuthStatusSchema = z.object({
  maintainer: InspectionMaintainerSchema.nullable(),
  operator: z.object({ id: z.string(), username: z.string() }),
  canManage: z.boolean(),
});
export type InspectionAuthStatus = z.infer<typeof InspectionAuthStatusSchema>;
