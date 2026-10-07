import { z } from "zod";

const GitLabIdSchema = z.union([z.number().int(), z.string().trim().min(1)]);

const RawIdentitySchema = z.object({
  id: GitLabIdSchema.optional(),
  username: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  web_url: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
}).passthrough();

const RawPipelineSchema = z.object({
  id: GitLabIdSchema,
  status: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  sha: z.string().nullable().optional(),
  web_url: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  duration: z.number().nullable().optional(),
  coverage: z.number().nullable().optional(),
}).passthrough();

const RawMergeRequestChangeSchema = z.object({
  old_path: z.string().optional(),
  new_path: z.string().optional(),
  diff: z.string().optional(),
  new_file: z.boolean().optional(),
  deleted_file: z.boolean().optional(),
  renamed_file: z.boolean().optional(),
}).passthrough();

const RawMilestoneSchema = z.object({
  id: GitLabIdSchema,
  title: z.string().trim().min(1),
  state: z.string().trim().optional(),
  due_date: z.string().nullable().optional(),
}).passthrough();

const RawMergeRequestSchema = z.object({
  id: GitLabIdSchema,
  iid: GitLabIdSchema,
  project_id: GitLabIdSchema.optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  state: z.string().optional(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  web_url: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  source_branch: z.string().nullable().optional(),
  target_branch: z.string().nullable().optional(),
  sha: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  squash_commit_sha: z.string().nullable().optional(),
  merged_at: z.string().nullable().optional(),
  merge_error: z.string().nullable().optional(),
  diff_refs: z.object({
    head_sha: z.string().nullable().optional(),
    base_sha: z.string().nullable().optional(),
    start_sha: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  author: RawIdentitySchema.nullable().optional(),
  assignees: z.array(RawIdentitySchema).optional(),
  reviewers: z.array(RawIdentitySchema).optional(),
  milestone: RawMilestoneSchema.nullable().optional(),
  labels: z.array(z.string()).optional(),
  references: z.object({ full: z.string().nullable().optional() }).passthrough().nullable().optional(),
  source_project: z.object({ path_with_namespace: z.string().nullable().optional() }).passthrough().nullable().optional(),
  target_project: z.object({ path_with_namespace: z.string().nullable().optional() }).passthrough().nullable().optional(),
  pipeline: RawPipelineSchema.nullable().optional(),
  head_pipeline: RawPipelineSchema.nullable().optional(),
}).passthrough();

const RawNoteSchema = z.object({
  id: GitLabIdSchema,
  body: z.string().optional(),
  author: RawIdentitySchema.nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  system: z.boolean().optional(),
  resolvable: z.boolean().optional(),
}).passthrough();

const RawPipelineJobSchema = z.object({
  id: GitLabIdSchema,
  name: z.string().optional(),
  stage: z.string().optional(),
  status: z.string().nullable().optional(),
  web_url: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  duration: z.number().nullable().optional(),
  allow_failure: z.boolean().optional(),
  failure_reason: z.string().nullable().optional(),
}).passthrough();

const RawProjectSchema = z.object({
  id: GitLabIdSchema,
  name: z.string().optional(),
  path: z.string().optional(),
  path_with_namespace: z.string().optional(),
  name_with_namespace: z.string().optional(),
  web_url: z.string().nullable().optional(),
  default_branch: z.string().nullable().optional(),
  visibility: z.string().nullable().optional(),
  last_activity_at: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
}).passthrough();

const RawRepositoryCommitSchema = z.object({
  id: z.string().trim().min(1),
  short_id: z.string().trim().min(1).optional(),
  title: z.string().optional(),
  message: z.string().optional(),
  author_name: z.string().optional(),
  author_email: z.string().optional(),
  authored_date: z.string().nullable().optional(),
  committed_date: z.string().nullable().optional(),
  web_url: z.string().nullable().optional(),
}).passthrough();

const RawRepositoryBranchSchema = z.object({
  name: z.string().trim().min(1),
  default: z.boolean().optional(),
  protected: z.boolean().optional(),
  commit: z.object({
    id: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

const RawRepositoryFileSchema = z.object({
  file_path: z.string().optional(),
  blob_id: z.string().nullable().optional(),
  commit_id: z.string().nullable().optional(),
}).passthrough();

const RawRepositoryBlameSchema = z.object({
  commit: z.object({
    author_name: z.string().optional(),
    author_email: z.string().optional(),
  }).passthrough(),
  lines: z.array(z.string()),
}).passthrough();

const RawPushEventSchema = z.object({
  id: GitLabIdSchema.optional(),
  project_id: GitLabIdSchema.nullable().optional(),
  action_name: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  push_data: z.object({
    ref_type: z.string().nullable().optional(),
    ref: z.string().nullable().optional(),
    commit_to: z.string().nullable().optional(),
    commit_title: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

const RawLabelSchema = z.object({
  id: GitLabIdSchema.optional(),
  name: z.string().trim().min(1),
  color: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
}).passthrough();

export type RawGitLabMergeRequest = z.infer<typeof RawMergeRequestSchema>;
export type RawGitLabPipeline = z.infer<typeof RawPipelineSchema>;
export type RawGitLabMergeRequestChange = z.infer<typeof RawMergeRequestChangeSchema>;
export type RawGitLabNote = z.infer<typeof RawNoteSchema>;
export type RawGitLabPipelineJob = z.infer<typeof RawPipelineJobSchema>;
export type RawGitLabProject = z.infer<typeof RawProjectSchema>;
export type RawGitLabRepositoryCommit = z.infer<typeof RawRepositoryCommitSchema>;
export type RawGitLabRepositoryBranch = z.infer<typeof RawRepositoryBranchSchema>;
export type RawGitLabRepositoryFile = z.infer<typeof RawRepositoryFileSchema>;
export type RawGitLabRepositoryBlame = z.infer<typeof RawRepositoryBlameSchema>;
export type RawGitLabPushEvent = z.infer<typeof RawPushEventSchema>;
export type RawGitLabMilestone = z.infer<typeof RawMilestoneSchema>;
export type RawGitLabLabel = z.infer<typeof RawLabelSchema>;

export const GitLabRawMergeRequestResponseSchema = z.array(RawMergeRequestSchema);
export const GitLabRawMergeRequestSchema = RawMergeRequestSchema;
export const GitLabRawChangesResponseSchema = z.object({ changes: z.array(RawMergeRequestChangeSchema).optional() }).passthrough();
export const GitLabRawNotesResponseSchema = z.array(RawNoteSchema);
export const GitLabRawPipelinesResponseSchema = z.array(RawPipelineSchema);
export const GitLabRawPipelineJobsResponseSchema = z.array(RawPipelineJobSchema);
export const GitLabRawProjectsResponseSchema = z.array(RawProjectSchema);
export const GitLabRawProjectSchema = RawProjectSchema;
export const GitLabRawPipelineResponseSchema = RawPipelineSchema;
export const GitLabRawRepositoryCommitsResponseSchema = z.array(RawRepositoryCommitSchema);
export const GitLabRawRepositoryBranchesResponseSchema = z.array(RawRepositoryBranchSchema);
export const GitLabRawRepositoryBranchSchema = RawRepositoryBranchSchema;
export const GitLabRawRepositoryFileSchema = RawRepositoryFileSchema;
export const GitLabRawRepositoryBlameResponseSchema = z.array(RawRepositoryBlameSchema);
export const GitLabRawEventsResponseSchema = z.array(RawPushEventSchema);
export const GitLabRawMembersResponseSchema = z.array(RawIdentitySchema);
export const GitLabRawMilestonesResponseSchema = z.array(RawMilestoneSchema);
export const GitLabRawLabelsResponseSchema = z.array(RawLabelSchema);

export type GitLabMergeRequestScope = "assigned_to_me" | "created_by_me" | "review_requested" | "all";
export type GitLabMergeRequestState = "opened" | "closed" | "merged" | "all";

export interface GitLabMergeRequestListQuery {
  sourceBranch?: string;
  projectId?: string;
  scope: GitLabMergeRequestScope;
  state: GitLabMergeRequestState;
  search?: string;
  page: number;
  perPage: number;
  reviewerUsername?: string;
}

export interface GitLabPipelineListQuery {
  ref?: string;
  status?: string;
  page: number;
  perPage: number;
}

export interface GitLabIdentity {
  id: string | null;
  username: string;
  name: string;
  webUrl: string | null;
  avatarUrl: string | null;
}

export interface GitLabCurrentUser extends GitLabIdentity {}

export interface GitLabPipelineSummary {
  id: string;
  status: string | null;
  ref: string | null;
  sha: string | null;
  webUrl: string | null;
  source: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  duration: number | null;
  coverage: number | null;
}

export interface GitLabPipelineJob {
  id: string;
  name: string;
  stage: string;
  status: string | null;
  webUrl: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  duration: number | null;
  allowFailure: boolean;
  failureReason: string | null;
}

export interface GitLabMergeRequestChange {
  oldPath: string | null;
  newPath: string | null;
  diff: string;
  changeType: "added" | "deleted" | "renamed" | "modified";
}

export interface GitLabMergeRequestSummary {
  id: string;
  iid: string;
  projectId: string;
  projectPath: string;
  title: string;
  description: string | null;
  state: string;
  draft: boolean;
  webUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  headSha: string | null;
  mergeCommitSha?: string | null;
  squashCommitSha?: string | null;
  mergeBaseSha?: string | null;
  mergedAt?: string | null;
  mergeError?: string | null;
  author: GitLabIdentity | null;
  assignees: GitLabIdentity[];
  reviewers: GitLabIdentity[];
  milestone: GitLabMilestoneOption | null;
  labels: string[];
  pipeline: GitLabPipelineSummary | null;
}

export interface GitLabMergeRequestNote {
  id: string;
  body: string;
  author: GitLabIdentity | null;
  createdAt: string | null;
  updatedAt: string | null;
  system: boolean;
  resolvable: boolean;
}

export interface GitLabMergeRequestDetails extends GitLabMergeRequestSummary {
  changes: GitLabMergeRequestChange[];
  notes: GitLabMergeRequestNote[];
  pipelines: GitLabPipelineSummary[];
}

export interface GitLabRepositoryFile {
  path: string;
  blobId: string | null;
  commitId: string | null;
}

export interface GitLabProject {
  id: string;
  name: string;
  path: string;
  pathWithNamespace: string;
  nameWithNamespace: string;
  webUrl: string | null;
  defaultBranch: string | null;
  visibility: string | null;
  lastActivityAt: string | null;
  avatarUrl: string | null;
}

export interface GitLabRepositoryCommit {
  id: string;
  shortId: string;
  title: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string | null;
  committedAt: string | null;
  webUrl: string | null;
}

export interface GitLabRepositoryBlame {
  authorName: string;
  authorEmail: string;
  lines: string[];
}

export interface GitLabRecentPush {
  project: GitLabProject;
  sourceBranch: string;
  commitSha: string | null;
  commitTitle: string | null;
  createdAt: string;
}

export interface GitLabBranchOption {
  name: string;
  isDefault: boolean;
  isProtected: boolean;
  commitSha: string | null;
  commitTitle: string | null;
  commitMessage: string | null;
}

export interface GitLabMilestoneOption {
  id: string;
  title: string;
  state: string;
  dueDate: string | null;
}

export interface GitLabLabelOption {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}

export interface GitLabMergeRequestCreateOptions {
  currentUser: GitLabIdentity;
  branches: GitLabBranchOption[];
  members: GitLabIdentity[];
  milestones: GitLabMilestoneOption[];
  labels: GitLabLabelOption[];
}

function stringValue(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function identity(value: z.infer<typeof RawIdentitySchema> | null | undefined): GitLabIdentity | null {
  if (!value) return null;
  return {
    id: stringValue(value.id),
    username: value.username?.trim() ?? "",
    name: value.name?.trim() || value.username?.trim() || "未知用户",
    webUrl: value.web_url ?? null,
    avatarUrl: value.avatar_url ?? null,
  };
}

export function normalizeIdentity(value: z.infer<typeof RawIdentitySchema> | null | undefined): GitLabIdentity | null {
  return identity(value);
}

export function normalizeBranch(value: RawGitLabRepositoryBranch): GitLabBranchOption {
  return {
    name: value.name,
    isDefault: value.default ?? false,
    isProtected: value.protected ?? false,
    commitSha: value.commit?.id ?? null,
    commitTitle: value.commit?.title?.trim() || null,
    commitMessage: value.commit?.message?.trim() || null,
  };
}

export function normalizeRepositoryFile(value: RawGitLabRepositoryFile): GitLabRepositoryFile {
  return { path: value.file_path ?? "", blobId: value.blob_id ?? null, commitId: value.commit_id ?? null };
}

export function normalizeMilestone(value: RawGitLabMilestone): GitLabMilestoneOption {
  return {
    id: String(value.id),
    title: value.title,
    state: value.state?.trim() || "active",
    dueDate: value.due_date ?? null,
  };
}

export function normalizeLabel(value: RawGitLabLabel): GitLabLabelOption {
  return {
    id: stringValue(value.id) ?? value.name,
    name: value.name,
    color: value.color ?? null,
    description: value.description ?? null,
  };
}

export function normalizePipeline(value: RawGitLabPipeline | null | undefined): GitLabPipelineSummary | null {
  if (!value) return null;
  return {
    id: String(value.id),
    status: value.status ?? null,
    ref: value.ref ?? null,
    sha: value.sha ?? null,
    webUrl: value.web_url ?? null,
    source: value.source ?? null,
    createdAt: value.created_at ?? null,
    updatedAt: value.updated_at ?? null,
    duration: value.duration ?? null,
    coverage: value.coverage ?? null,
  };
}

function projectPathFromUrl(webUrl: string | null | undefined): string {
  if (!webUrl) return "";
  try {
    const path = new URL(webUrl).pathname;
    const markerIndex = path.indexOf("/-/merge_requests/");
    return markerIndex > 0 ? decodeURIComponent(path.slice(1, markerIndex)) : "";
  } catch {
    return "";
  }
}

function changeType(change: RawGitLabMergeRequestChange): GitLabMergeRequestChange["changeType"] {
  if (change.new_file) return "added";
  if (change.deleted_file) return "deleted";
  if (change.renamed_file) return "renamed";
  return "modified";
}

export function normalizeMergeRequest(value: RawGitLabMergeRequest, projectIdHint?: string): GitLabMergeRequestSummary {
  const webUrl = value.web_url ?? null;
  const projectPath = value.source_project?.path_with_namespace
    ?? value.target_project?.path_with_namespace
    ?? projectPathFromUrl(webUrl);
  return {
    id: String(value.id),
    iid: String(value.iid),
    projectId: stringValue(value.project_id) ?? projectIdHint ?? "",
    projectPath,
    title: value.title?.trim() ?? "未命名 Merge Request",
    description: value.description ?? null,
    state: value.state?.trim() ?? "unknown",
    draft: value.draft ?? value.work_in_progress ?? false,
    webUrl,
    createdAt: value.created_at ?? null,
    updatedAt: value.updated_at ?? null,
    sourceBranch: value.source_branch ?? null,
    targetBranch: value.target_branch ?? null,
    // GitLab may expose a stale diff_refs.head_sha immediately after a push;
    // the MR sha is the authoritative current source-branch head.
    headSha: stringValue(value.sha) ?? stringValue(value.diff_refs?.head_sha),
    mergeCommitSha: stringValue(value.merge_commit_sha),
    squashCommitSha: stringValue(value.squash_commit_sha),
    // `base_sha` is GitLab's merge-base commit. `start_sha` is the target
    // branch head when the diff was created, so it must not be used as the
    // pre-change snapshot for post-merge rollback detection.
    mergeBaseSha: stringValue(value.diff_refs?.base_sha) ?? stringValue(value.diff_refs?.start_sha),
    mergedAt: value.merged_at?.trim() || null,
    mergeError: value.merge_error ?? null,
    author: identity(value.author),
    assignees: (value.assignees ?? []).map((item) => identity(item)).filter((item): item is GitLabIdentity => Boolean(item)),
    reviewers: (value.reviewers ?? []).map((item) => identity(item)).filter((item): item is GitLabIdentity => Boolean(item)),
    milestone: value.milestone ? normalizeMilestone(value.milestone) : null,
    labels: value.labels ?? [],
    pipeline: normalizePipeline(value.head_pipeline ?? value.pipeline),
  };
}

export function normalizeChange(value: RawGitLabMergeRequestChange): GitLabMergeRequestChange {
  return {
    oldPath: value.old_path ?? null,
    newPath: value.new_path ?? null,
    diff: value.diff ?? "",
    changeType: changeType(value),
  };
}

export function normalizeNote(value: RawGitLabNote): GitLabMergeRequestNote {
  return {
    id: String(value.id),
    body: value.body ?? "",
    author: identity(value.author),
    createdAt: value.created_at ?? null,
    updatedAt: value.updated_at ?? null,
    system: value.system ?? false,
    resolvable: value.resolvable ?? false,
  };
}

export function normalizePipelineJob(value: RawGitLabPipelineJob): GitLabPipelineJob {
  return {
    id: String(value.id),
    name: value.name?.trim() ?? "未命名 Job",
    stage: value.stage?.trim() ?? "未知阶段",
    status: value.status ?? null,
    webUrl: value.web_url ?? null,
    createdAt: value.created_at ?? null,
    startedAt: value.started_at ?? null,
    finishedAt: value.finished_at ?? null,
    duration: value.duration ?? null,
    allowFailure: value.allow_failure ?? false,
    failureReason: value.failure_reason ?? null,
  };
}

export function normalizeProject(value: RawGitLabProject): GitLabProject {
  return {
    id: String(value.id),
    name: value.name?.trim() ?? value.path?.trim() ?? "未命名项目",
    path: value.path?.trim() ?? "",
    pathWithNamespace: value.path_with_namespace?.trim() ?? "",
    nameWithNamespace: value.name_with_namespace?.trim() ?? value.path_with_namespace?.trim() ?? "",
    webUrl: value.web_url ?? null,
    defaultBranch: value.default_branch ?? null,
    visibility: value.visibility ?? null,
    lastActivityAt: value.last_activity_at ?? null,
    avatarUrl: value.avatar_url ?? null,
  };
}

export function normalizeRepositoryCommit(value: RawGitLabRepositoryCommit): GitLabRepositoryCommit {
  return {
    id: value.id,
    shortId: value.short_id ?? value.id.slice(0, 8),
    title: value.title?.trim() ?? "未命名提交",
    message: value.message?.trim() ?? value.title?.trim() ?? "",
    authorName: value.author_name?.trim() ?? "未知作者",
    authorEmail: value.author_email?.trim() ?? "",
    authoredAt: value.authored_date ?? null,
    committedAt: value.committed_date ?? null,
    webUrl: value.web_url ?? null,
  };
}

export function normalizeRepositoryBlame(value: RawGitLabRepositoryBlame): GitLabRepositoryBlame {
  return {
    authorName: value.commit.author_name?.trim() ?? "未知作者",
    authorEmail: value.commit.author_email?.trim() ?? "",
    lines: value.lines,
  };
}

export function normalizeCurrentUser(value: z.infer<typeof RawIdentitySchema>): GitLabCurrentUser {
  return identity(value) ?? { id: null, username: "", name: "未知用户", webUrl: null, avatarUrl: null };
}

export const GitLabRawIdentitySchema = RawIdentitySchema;
