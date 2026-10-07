import type { GitLabCreateMergeRequestInput, GitLabMergeMergeRequestInput, GitLabUpdateMergeRequestInput, ResolvedMergeRequest } from "./contracts.js";
import { z } from "zod";
import {
  GitLabRawChangesResponseSchema,
  GitLabRawMergeRequestResponseSchema,
  GitLabRawMergeRequestSchema,
  GitLabRawNotesResponseSchema,
  GitLabRawPipelineJobsResponseSchema,
  GitLabRawPipelineResponseSchema,
  GitLabRawPipelinesResponseSchema,
  GitLabRawLabelsResponseSchema,
  GitLabRawMembersResponseSchema,
  GitLabRawMilestonesResponseSchema,
  GitLabRawProjectSchema,
  GitLabRawProjectsResponseSchema,
  GitLabRawRepositoryBranchSchema,
  GitLabRawRepositoryBranchesResponseSchema,
  GitLabRawRepositoryBlameResponseSchema,
  GitLabRawRepositoryCommitsResponseSchema,
  GitLabRawRepositoryFileSchema,
  GitLabRawEventsResponseSchema,
  normalizeChange,
  normalizeBranch,
  normalizeIdentity,
  normalizeLabel,
  normalizeMergeRequest,
  normalizeMilestone,
  normalizeNote,
  normalizePipeline,
  normalizePipelineJob,
  normalizeProject,
  normalizeRepositoryCommit,
  normalizeRepositoryBlame,
  normalizeRepositoryFile,
  normalizeCurrentUser,
  type GitLabMergeRequestDetails,
  type GitLabMergeRequestListQuery,
  type GitLabMergeRequestCreateOptions,
  type GitLabMergeRequestSummary,
  type GitLabIdentity,
  type GitLabPipelineJob,
  type GitLabPipelineListQuery,
  type GitLabPipelineSummary,
  type GitLabProject,
  type GitLabRecentPush,
  type GitLabRepositoryCommit,
  type GitLabRepositoryBlame,
  type GitLabRepositoryFile,
} from "./gitlab-workbench.js";

const MergeRequestSnapshotSchema = z.object({
  state: z.string().optional(),
  target_branch: z.string().nullable().optional(),
  diff_refs: z.object({ head_sha: z.string().nullable().optional() }).passthrough().nullable().optional(),
  sha: z.string().nullable().optional(),
  target_project: z.object({ path_with_namespace: z.string().nullable().optional() }).passthrough().nullable().optional(),
  source_project: z.object({ path_with_namespace: z.string().nullable().optional() }).passthrough().nullable().optional(),
}).passthrough();

const MergeRequestChangeSchema = z.object({
  old_path: z.string().optional(),
  new_path: z.string().optional(),
  diff: z.string().optional(),
  new_file: z.boolean().optional(),
  deleted_file: z.boolean().optional(),
  renamed_file: z.boolean().optional(),
}).passthrough();

const MergeRequestChangesResponseSchema = z.object({
  changes: z.array(MergeRequestChangeSchema).optional(),
}).passthrough();

const GitLabNoteSchema = z.object({
  id: z.number().int(),
  body: z.string().optional(),
}).passthrough();

const GitLabProjectSnapshotSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  path_with_namespace: z.string().nullable().optional(),
}).passthrough();

const GitLabCurrentUserSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]).optional(),
  username: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  commit_email: z.string().nullable().optional(),
  web_url: z.string().nullable().optional(),
}).passthrough();

const GitLabNotesSchema = z.array(GitLabNoteSchema);
const GitLabCiJobSchema = z.object({
  id: z.number().int().positive(),
  commit: z.object({ id: z.string().min(1) }).passthrough(),
  pipeline: z.object({
    id: z.number().int().positive(),
    project_id: z.union([z.number().int().positive(), z.string().min(1)]),
    source: z.string().min(1),
  }).passthrough(),
  web_url: z.string().url().nullable().optional(),
}).passthrough();

const RECENT_PUSH_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const PUSH_EVENT_ACTION_NAMES = new Set(["pushed", "pushed new", "pushed to"]);

export type MergeRequestSnapshot = z.infer<typeof MergeRequestSnapshotSchema>;
export type MergeRequestChange = z.infer<typeof MergeRequestChangeSchema>;
export type GitLabNote = z.infer<typeof GitLabNoteSchema>;
export type GitLabProjectSnapshot = z.infer<typeof GitLabProjectSnapshotSchema>;
export type GitLabCurrentUser = z.infer<typeof GitLabCurrentUserSchema>;
export type GitLabCiJob = z.infer<typeof GitLabCiJobSchema>;
export interface ReviewSnapshot {
  mergeRequest: MergeRequestSnapshot;
  changes: MergeRequestChange[];
}

export type GitLabTokenAuthMode = "private-token" | "bearer";

export interface GitLabClientPort {
  getMergeRequest(projectId: string, iid: string): Promise<MergeRequestSnapshot>;
  getReviewSnapshot(projectId: string, iid: string): Promise<ReviewSnapshot>;
  getCurrentUser?(): Promise<GitLabCurrentUser>;
  getProject?(projectId: string): Promise<GitLabProject>;
  getRecentPush?(): Promise<GitLabRecentPush | null>;
  getMergeRequestCreateOptions?(projectId: string): Promise<GitLabMergeRequestCreateOptions>;
  searchProjectMembers?(projectId: string, query: string): Promise<GitLabIdentity[]>;
  createMergeRequest?(input: GitLabCreateMergeRequestInput): Promise<GitLabMergeRequestSummary>;
  updateMergeRequest?(projectId: string, iid: string, input: GitLabUpdateMergeRequestInput): Promise<GitLabMergeRequestSummary>;
  mergeMergeRequest?(projectId: string, iid: string, input: GitLabMergeMergeRequestInput): Promise<GitLabMergeRequestSummary>;
  listMergeRequests?(query: GitLabMergeRequestListQuery): Promise<GitLabMergeRequestSummary[]>;
  getMergeRequestDetails?(projectId: string, iid: string): Promise<GitLabMergeRequestDetails>;
  listPipelines?(projectId: string, query: GitLabPipelineListQuery): Promise<GitLabPipelineSummary[]>;
  listPipelineJobs?(projectId: string, pipelineId: string): Promise<GitLabPipelineJob[]>;
  getPipelineJobTrace?(projectId: string, jobId: string): Promise<string>;
  retryPipeline?(projectId: string, pipelineId: string): Promise<GitLabPipelineSummary>;
  cancelPipeline?(projectId: string, pipelineId: string): Promise<GitLabPipelineSummary>;
  listProjects?(query: { search?: string; page: number; perPage: number }): Promise<GitLabProject[]>;
  listContributedProjects?(userId: string): Promise<GitLabProject[]>;
  listRepositoryCommits?(projectId: string, query: { ref?: string; path?: string; since?: string; until?: string; author?: string; all?: boolean; page: number; perPage: number }): Promise<GitLabRepositoryCommit[]>;
  getRepositoryFile?(projectId: string, filePath: string, ref: string): Promise<GitLabRepositoryFile | null>;
  getRepositoryFileBlame?(projectId: string, filePath: string, ref: string, line?: number): Promise<GitLabRepositoryBlame[]>;
  getJobByToken?(token: string): Promise<GitLabCiJob>;
  resolveMergeRequestUrl?(url: string): Promise<ResolvedMergeRequest>;
  findNoteByMarker(projectId: string, iid: string, marker: string): Promise<GitLabNote | null>;
  createNote(projectId: string, iid: string, body: string): Promise<GitLabNote>;
  updateNote(projectId: string, iid: string, noteId: number, body: string): Promise<GitLabNote>;
}

export class GitLabApiError extends Error {
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, { status, body }: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = "GitLabApiError";
    this.status = status;
    this.body = body;
  }
}

const GitLabErrorKeys = ["message", "error", "errors", "error_description", "detail"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function gitlabErrorDetails(body: unknown): string | null {
  const messages: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || messages.length >= 3) return;
    if (typeof value === "string") {
      const message = value.trim();
      if (message && !messages.includes(message)) messages.push(message);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    for (const key of GitLabErrorKeys) {
      if (key in value) visit(value[key], depth + 1);
    }
    if (messages.length === 0) Object.values(value).forEach((item) => visit(item, depth + 1));
  };
  visit(body, 0);
  return messages.join("；").slice(0, 2_000) || null;
}

export class InvalidMergeRequestUrlError extends Error {
  constructor(message = "Invalid GitLab merge request URL") {
    super(message);
    this.name = "InvalidMergeRequestUrlError";
  }
}

function projectPath(projectId: string): string {
  return encodeURIComponent(projectId);
}

function mergeRequestPath(projectId: string, iid: string): string {
  return `/projects/${projectPath(projectId)}/merge_requests/${encodeURIComponent(iid)}`;
}

function currentHead(mergeRequest: MergeRequestSnapshot): string | null {
  // `diff_refs.head_sha` can lag briefly after a push while GitLab recalculates
  // the MR diff. The MR `sha` is the source-branch head used for concurrency
  // and stale-result checks, so prefer it whenever GitLab provides both.
  return mergeRequest.sha?.trim() || mergeRequest.diff_refs?.head_sha?.trim() || null;
}

function mergeResponseError(mergeRequest: GitLabMergeRequestSummary, input: GitLabMergeMergeRequestInput): string | null {
  if (mergeRequest.state !== "opened") return null;
  if (mergeRequest.mergeError?.trim()) return `GitLab 合并失败：${mergeRequest.mergeError.trim()}`;
  if (!input.mergeWhenPipelineSucceeds) return "GitLab 未完成合并，Merge Request 仍处于开放状态，请刷新后重试";
  return null;
}

export function parseMergeRequestUrl(url: string): { projectPath: string; mrIid: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidMergeRequestUrlError("请输入有效的 GitLab MR 地址");
  }

  const marker = "/-/merge_requests/";
  const markerIndex = parsed.pathname.indexOf(marker);
  if (markerIndex <= 1) {
    throw new InvalidMergeRequestUrlError("地址中没有找到 GitLab 项目路径和 MR IID");
  }

  const encodedProjectPath = parsed.pathname.slice(1, markerIndex).replace(/\/+$/, "");
  const iidMatch = parsed.pathname.slice(markerIndex + marker.length).match(/^(\d+)(?:\/|$)/);
  if (!iidMatch) throw new InvalidMergeRequestUrlError("地址中没有找到有效的 MR IID");

  let projectPath: string;
  try {
    projectPath = decodeURIComponent(encodedProjectPath);
  } catch {
    throw new InvalidMergeRequestUrlError("GitLab 项目路径不是有效的 URL 编码");
  }
  if (!projectPath || projectPath.startsWith("/") || projectPath.endsWith("/")) {
    throw new InvalidMergeRequestUrlError("GitLab 项目路径无效");
  }
  return { projectPath, mrIid: iidMatch[1] };
}

export class GitLabClient implements GitLabClientPort {
  private baseUrl: string;
  private token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authMode: GitLabTokenAuthMode;

  constructor({ baseUrl, token = "", fetchImpl = fetch, authMode = "private-token" }: {
    baseUrl: string;
    token?: string;
    fetchImpl?: typeof fetch;
    authMode?: GitLabTokenAuthMode;
  }) {
    if (!baseUrl) throw new Error("GitLab API base URL is required");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.authMode = authMode;
  }

  updateConnection({ baseUrl, token }: { baseUrl: string; token: string }): void {
    if (!baseUrl) throw new Error("GitLab API base URL is required");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private async request<T>(path: string, schema: z.ZodType<T>, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers ?? {});
    headers.set("accept", "application/json");
    if (this.token && !headers.has("private-token") && !headers.has("authorization") && !headers.has("job-token")) {
      if (this.authMode === "bearer") headers.set("authorization", `Bearer ${this.token}`);
      else headers.set("private-token", this.token);
    }
    if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...options, headers });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Preserve non-JSON response bodies for diagnostics.
    }
    if (!response.ok) {
      const details = gitlabErrorDetails(body);
      throw new GitLabApiError(`GitLab API request failed with ${response.status}${details ? `: ${details}` : ""}`, {
        status: response.status,
        body,
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new GitLabApiError("GitLab API returned an invalid response", { status: response.status });
    return parsed.data;
  }

  private async requestText(path: string, options: RequestInit = {}): Promise<string> {
    const headers = new Headers(options.headers ?? {});
    headers.set("accept", "text/plain");
    if (this.token && !headers.has("private-token") && !headers.has("authorization") && !headers.has("job-token")) {
      if (this.authMode === "bearer") headers.set("authorization", `Bearer ${this.token}`);
      else headers.set("private-token", this.token);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...options, headers });
    const text = await response.text();
    if (!response.ok) {
      const details = gitlabErrorDetails(text)?.slice(0, 2_000);
      throw new GitLabApiError(`GitLab API request failed with ${response.status}${details ? `: ${details}` : ""}`, {
        status: response.status,
        body: text,
      });
    }
    return text;
  }

  getMergeRequest(projectId: string, iid: string): Promise<MergeRequestSnapshot> {
    return this.request(mergeRequestPath(projectId, iid), MergeRequestSnapshotSchema);
  }

  getJobByToken(token: string): Promise<GitLabCiJob> {
    if (!token) throw new Error("GitLab CI job token is required");
    return this.request("/job", GitLabCiJobSchema, {
      headers: { "job-token": token },
    });
  }

  getCurrentUser(): Promise<GitLabCurrentUser> {
    return this.request("/user", GitLabCurrentUserSchema);
  }

  private getRecentPushProject(projectId: string): Promise<GitLabProject> {
    return this.getProject(projectId);
  }

  getProject(projectId: string): Promise<GitLabProject> {
    return this.request(`/projects/${projectPath(projectId)}`, GitLabRawProjectSchema).then(normalizeProject);
  }

  async getRecentPush(): Promise<GitLabRecentPush | null> {
    const events = await this.request("/events?action=pushed&sort=desc&per_page=100", GitLabRawEventsResponseSchema);
    const now = Date.now();
    const candidates = events
      .map((event) => {
        const createdAt = event.created_at?.trim() ?? "";
        const sourceBranch = event.push_data?.ref?.replace(/^refs\/heads\//, "").trim() ?? "";
        return { event, createdAt, sourceBranch, createdAtMs: Date.parse(createdAt) };
      })
      .filter(({ event, createdAt, sourceBranch, createdAtMs }) => PUSH_EVENT_ACTION_NAMES.has(event.action_name?.trim() ?? "")
        && Boolean(event.project_id)
        && event.push_data?.ref_type === "branch"
        && Boolean(createdAt)
        && Boolean(sourceBranch)
        && Number.isFinite(createdAtMs)
        && createdAtMs > now - RECENT_PUSH_MAX_AGE_MS
        && createdAtMs <= now)
      .sort((left, right) => right.createdAtMs - left.createdAtMs);

    for (const candidate of candidates) {
      const projectId = String(candidate.event.project_id);
      const project = await this.getRecentPushProject(projectId).catch(() => null);
      const defaultBranch = project?.defaultBranch?.trim() ?? "";
      if (!project || !defaultBranch || candidate.sourceBranch === defaultBranch) continue;

      const mergeRequestParams = new URLSearchParams({ state: "opened", source_branch: candidate.sourceBranch, per_page: "1" });
      const [branch, openMergeRequests] = await Promise.all([
        this.request(`/projects/${projectPath(projectId)}/repository/branches/${encodeURIComponent(candidate.sourceBranch)}`, GitLabRawRepositoryBranchSchema).catch(() => null),
        this.request(`/projects/${projectPath(projectId)}/merge_requests?${mergeRequestParams.toString()}`, GitLabRawMergeRequestResponseSchema).catch(() => null),
      ]);
      if (!branch || !openMergeRequests || openMergeRequests.length > 0) continue;

      return {
        project,
        sourceBranch: candidate.sourceBranch,
        commitSha: candidate.event.push_data?.commit_to ?? branch.commit?.id ?? null,
        commitTitle: candidate.event.push_data?.commit_title?.trim() || branch.commit?.title?.trim() || null,
        createdAt: candidate.createdAt,
      };
    }
    return null;
  }

  async getMergeRequestCreateOptions(projectId: string): Promise<GitLabMergeRequestCreateOptions> {
    const project = projectPath(projectId);
    const [projectInfo, branches, members, milestones, labels, currentUser] = await Promise.all([
      this.getRecentPushProject(projectId).catch(() => null),
      this.request(`/projects/${project}/repository/branches?per_page=100`, GitLabRawRepositoryBranchesResponseSchema),
      this.request(`/projects/${project}/members/all?per_page=100&order_by=name&sort=asc`, GitLabRawMembersResponseSchema).catch(() => []),
      this.request(`/projects/${project}/milestones?state=all&per_page=100`, GitLabRawMilestonesResponseSchema).catch(() => []),
      this.request(`/projects/${project}/labels?per_page=100&with_counts=false`, GitLabRawLabelsResponseSchema).catch(() => []),
      this.getCurrentUser(),
    ]);
    const defaultBranch = projectInfo?.defaultBranch?.trim() ?? "";
    const defaultBranchOption = defaultBranch && !branches.some((branch) => branch.name === defaultBranch)
      ? await this.request(`/projects/${project}/repository/branches/${encodeURIComponent(defaultBranch)}`, GitLabRawRepositoryBranchSchema).catch(() => null)
      : null;
    const branchOptions = defaultBranchOption ? [defaultBranchOption, ...branches] : branches;
    return {
      currentUser: normalizeCurrentUser(currentUser),
      branches: branchOptions.map((branch) => {
        const normalized = normalizeBranch(branch);
        return defaultBranch && normalized.name === defaultBranch ? { ...normalized, isDefault: true } : normalized;
      }).sort((left, right) => left.name.localeCompare(right.name)),
      members: members.map(normalizeIdentity).filter((member): member is GitLabIdentity => Boolean(member)),
      milestones: milestones.map(normalizeMilestone),
      labels: labels.map(normalizeLabel),
    };
  }

  searchProjectMembers(projectId: string, query: string): Promise<GitLabIdentity[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return Promise.reject(new Error("GitLab 成员搜索关键词不能为空"));
    const params = new URLSearchParams({ query: normalizedQuery, per_page: "100", order_by: "name", sort: "asc" });
    return this.request(`/projects/${projectPath(projectId)}/members/all?${params.toString()}`, GitLabRawMembersResponseSchema)
      .then((members) => members.map(normalizeIdentity).filter((member): member is GitLabIdentity => Boolean(member)));
  }

  createMergeRequest(input: GitLabCreateMergeRequestInput): Promise<GitLabMergeRequestSummary> {
    const body: Record<string, unknown> = {
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      title: input.title,
      remove_source_branch: input.removeSourceBranch,
      squash: input.squash,
    };
    if (input.description) body.description = input.description;
    if (input.sourceProjectId !== input.targetProjectId) body.source_project_id = gitlabIdentifier(input.sourceProjectId);
    if (input.assigneeIds.length > 0) body.assignee_ids = input.assigneeIds.map((id) => Number(id));
    if (input.reviewerIds.length > 0) body.reviewer_ids = input.reviewerIds.map((id) => Number(id));
    if (input.milestoneId) body.milestone_id = Number(input.milestoneId);
    if (input.labels.length > 0) body.labels = input.labels.join(",");
    return this.request(`/projects/${projectPath(input.targetProjectId)}/merge_requests`, GitLabRawMergeRequestSchema, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((mergeRequest) => normalizeMergeRequest(mergeRequest, input.targetProjectId));
  }

  updateMergeRequest(projectId: string, iid: string, input: GitLabUpdateMergeRequestInput): Promise<GitLabMergeRequestSummary> {
    const body: Record<string, unknown> = {};
    if (input.targetBranch !== undefined) body.target_branch = input.targetBranch;
    if (input.title !== undefined) body.title = input.title;
    if (input.description !== undefined) body.description = input.description;
    if (input.assigneeIds !== undefined) body.assignee_ids = input.assigneeIds.map((id) => Number(id));
    if (input.reviewerIds !== undefined) body.reviewer_ids = input.reviewerIds.map((id) => Number(id));
    if (input.milestoneId !== undefined) body.milestone_id = input.milestoneId === null ? null : Number(input.milestoneId);
    if (input.labels !== undefined) body.labels = input.labels.join(",");
    if (input.squash !== undefined) body.squash = input.squash;
    return this.request(mergeRequestPath(projectId, iid), GitLabRawMergeRequestSchema, {
      method: "PUT",
      body: JSON.stringify(body),
    }).then((mergeRequest) => normalizeMergeRequest(mergeRequest, projectId));
  }

  async mergeMergeRequest(projectId: string, iid: string, input: GitLabMergeMergeRequestInput): Promise<GitLabMergeRequestSummary> {
    await this.updateMergeRequest(projectId, iid, { squash: input.squash });
    const body: Record<string, unknown> = {
      merge_when_pipeline_succeeds: input.mergeWhenPipelineSucceeds,
      should_remove_source_branch: input.shouldRemoveSourceBranch,
      squash: input.squash,
    };
    if (input.sha) body.sha = input.sha;
    const mergeRequest = await this.request(`${mergeRequestPath(projectId, iid)}/merge`, GitLabRawMergeRequestSchema, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const normalized = normalizeMergeRequest(mergeRequest, projectId);
    const failure = mergeResponseError(normalized, input);
    if (failure) throw new GitLabApiError(failure, { body: mergeRequest });
    return normalized;
  }

  private getProjectSnapshot(projectPathValue: string): Promise<GitLabProjectSnapshot> {
    return this.request(`/projects/${projectPath(projectPathValue)}`, GitLabProjectSnapshotSchema);
  }

  async resolveMergeRequestUrl(url: string): Promise<ResolvedMergeRequest> {
    const parsedUrl = new URL(url);
    const apiUrl = new URL(this.baseUrl);
    if (parsedUrl.hostname !== apiUrl.hostname || parsedUrl.port !== apiUrl.port) {
      throw new InvalidMergeRequestUrlError("MR 地址必须属于当前配置的 GitLab 实例");
    }

    const { projectPath: requestedProjectPath, mrIid } = parseMergeRequestUrl(url);
    const project = await this.getProjectSnapshot(requestedProjectPath);
    const projectId = String(project.id);
    const mergeRequest = await this.getMergeRequest(projectId, mrIid);
    return {
      projectId,
      projectPath: project.path_with_namespace ?? requestedProjectPath,
      mrIid,
      headSha: currentHead(mergeRequest),
      targetBranch: mergeRequest.target_branch ?? null,
    };
  }

  private getMergeRequestChanges(projectId: string, iid: string): Promise<{ changes?: MergeRequestChange[] }> {
    return this.request(`${mergeRequestPath(projectId, iid)}/changes`, MergeRequestChangesResponseSchema);
  }

  async getReviewSnapshot(projectId: string, iid: string): Promise<ReviewSnapshot> {
    const [mergeRequest, changeResponse] = await Promise.all([
      this.getMergeRequest(projectId, iid),
      this.getMergeRequestChanges(projectId, iid),
    ]);
    return { mergeRequest, changes: Array.isArray(changeResponse.changes) ? changeResponse.changes : [] };
  }

  listMergeRequests(query: GitLabMergeRequestListQuery): Promise<GitLabMergeRequestSummary[]> {
    const params = new URLSearchParams({
      scope: query.scope === "review_requested" ? "all" : query.scope,
      state: query.state,
      page: String(query.page),
      per_page: String(query.perPage),
      order_by: "updated_at",
      sort: "desc",
    });
    if (query.search) params.set("search", query.search);
    if (query.sourceBranch) params.set("source_branch", query.sourceBranch);
    if (query.scope === "review_requested" && query.reviewerUsername) params.set("reviewer_username", query.reviewerUsername);
    const endpoint = query.projectId ? `/projects/${encodeURIComponent(query.projectId)}/merge_requests` : "/merge_requests";
    return this.request(`${endpoint}?${params.toString()}`, GitLabRawMergeRequestResponseSchema)
      .then((items) => items.map((item) => normalizeMergeRequest(item)));
  }

  async getMergeRequestDetails(projectId: string, iid: string): Promise<GitLabMergeRequestDetails> {
    const [mergeRequest, changes, notes, pipelines] = await Promise.all([
      this.request(mergeRequestPath(projectId, iid), GitLabRawMergeRequestSchema),
      this.request(`${mergeRequestPath(projectId, iid)}/changes`, GitLabRawChangesResponseSchema),
      this.request(`${mergeRequestPath(projectId, iid)}/notes?per_page=100&sort=desc&order_by=created_at`, GitLabRawNotesResponseSchema),
      this.request(`${mergeRequestPath(projectId, iid)}/pipelines?per_page=20`, GitLabRawPipelinesResponseSchema),
    ]);
    return {
      ...normalizeMergeRequest(mergeRequest, projectId),
      changes: (changes.changes ?? []).map(normalizeChange),
      // GitLab's first page with descending order contains the newest notes;
      // reverse that page so the workbench keeps its historical oldest-to-newest
      // display order while the verification path can still see the latest bot note.
      notes: [...notes].reverse().map(normalizeNote),
      pipelines: pipelines.map((pipeline) => normalizePipeline(pipeline)).filter((pipeline): pipeline is GitLabPipelineSummary => Boolean(pipeline)),
    };
  }

  listPipelines(projectId: string, query: GitLabPipelineListQuery): Promise<GitLabPipelineSummary[]> {
    const params = new URLSearchParams({ page: String(query.page), per_page: String(query.perPage), order_by: "updated_at", sort: "desc" });
    if (query.ref) params.set("ref", query.ref);
    if (query.status) params.set("status", query.status);
    return this.request(`/projects/${projectPath(projectId)}/pipelines?${params.toString()}`, GitLabRawPipelinesResponseSchema)
      .then((items) => items.map((pipeline) => normalizePipeline(pipeline)).filter((pipeline): pipeline is GitLabPipelineSummary => Boolean(pipeline)));
  }

  listPipelineJobs(projectId: string, pipelineId: string): Promise<GitLabPipelineJob[]> {
    return this.request(`/projects/${projectPath(projectId)}/pipelines/${encodeURIComponent(pipelineId)}/jobs?per_page=100`, GitLabRawPipelineJobsResponseSchema)
      .then((items) => items.map(normalizePipelineJob));
  }

  getPipelineJobTrace(projectId: string, jobId: string): Promise<string> {
    return this.requestText(`/projects/${projectPath(projectId)}/jobs/${encodeURIComponent(jobId)}/trace`);
  }

  retryPipeline(projectId: string, pipelineId: string): Promise<GitLabPipelineSummary> {
    return this.request(`/projects/${projectPath(projectId)}/pipelines/${encodeURIComponent(pipelineId)}/retry`, GitLabRawPipelineResponseSchema, { method: "POST" })
      .then((pipeline) => normalizePipeline(pipeline))
      .then((pipeline) => pipeline ?? Promise.reject(new GitLabApiError("GitLab 返回了无效的 Pipeline")));
  }

  cancelPipeline(projectId: string, pipelineId: string): Promise<GitLabPipelineSummary> {
    return this.request(`/projects/${projectPath(projectId)}/pipelines/${encodeURIComponent(pipelineId)}/cancel`, GitLabRawPipelineResponseSchema, { method: "POST" })
      .then((pipeline) => normalizePipeline(pipeline))
      .then((pipeline) => pipeline ?? Promise.reject(new GitLabApiError("GitLab 返回了无效的 Pipeline")));
  }

  listProjects(query: { search?: string; page: number; perPage: number }): Promise<GitLabProject[]> {
    const params = new URLSearchParams({
      membership: "true",
      simple: "false",
      page: String(query.page),
      per_page: String(query.perPage),
      order_by: "last_activity_at",
      sort: "desc",
    });
    if (query.search) params.set("search", query.search);
    return this.request(`/projects?${params.toString()}`, GitLabRawProjectsResponseSchema).then((items) => items.map(normalizeProject));
  }

  listContributedProjects(userId: string): Promise<GitLabProject[]> {
    const params = new URLSearchParams({ simple: "false", order_by: "last_activity_at", sort: "desc" });
    return this.request(`/users/${encodeURIComponent(userId)}/contributed_projects?${params.toString()}`, GitLabRawProjectsResponseSchema)
      .then((items) => items.map(normalizeProject));
  }

  listRepositoryCommits(projectId: string, query: { ref?: string; path?: string; since?: string; until?: string; author?: string; all?: boolean; page: number; perPage: number }): Promise<GitLabRepositoryCommit[]> {
    const params = new URLSearchParams({ page: String(query.page), per_page: String(query.perPage), order: "topo" });
    if (query.ref) params.set("ref_name", query.ref);
    if (query.path) params.set("path", query.path);
    if (query.since) params.set("since", query.since);
    if (query.until) params.set("until", query.until);
    if (query.author) params.set("author", query.author);
    if (query.all) params.set("all", "true");
    return this.request(`/projects/${projectPath(projectId)}/repository/commits?${params.toString()}`, GitLabRawRepositoryCommitsResponseSchema)
      .then((items) => items.map(normalizeRepositoryCommit));
  }

  async getRepositoryFile(projectId: string, filePath: string, ref: string): Promise<GitLabRepositoryFile | null> {
    try {
      const params = new URLSearchParams({ ref });
      const file = await this.request(
        `/projects/${projectPath(projectId)}/repository/files/${encodeURIComponent(filePath)}?${params.toString()}`,
        GitLabRawRepositoryFileSchema,
      );
      return normalizeRepositoryFile(file);
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) return null;
      throw error;
    }
  }

  getRepositoryFileBlame(projectId: string, filePath: string, ref: string, line?: number): Promise<GitLabRepositoryBlame[]> {
    const params = new URLSearchParams({ ref });
    if (line) {
      params.set("range[start]", String(line));
      params.set("range[end]", String(line));
    }
    return this.request(
      `/projects/${projectPath(projectId)}/repository/files/${encodeURIComponent(filePath)}/blame?${params.toString()}`,
      GitLabRawRepositoryBlameResponseSchema,
    ).then((items) => items.map(normalizeRepositoryBlame));
  }

  private listNotes(projectId: string, iid: string): Promise<GitLabNote[]> {
    return this.request(`${mergeRequestPath(projectId, iid)}/notes?per_page=100&sort=desc&order_by=updated_at`, GitLabNotesSchema);
  }

  async findNoteByMarker(projectId: string, iid: string, marker: string): Promise<GitLabNote | null> {
    const notes = await this.listNotes(projectId, iid);
    return Array.isArray(notes)
      ? notes.find((note) => typeof note?.body === "string" && note.body.includes(marker)) ?? null
      : null;
  }

  createNote(projectId: string, iid: string, body: string): Promise<GitLabNote> {
    return this.request(`${mergeRequestPath(projectId, iid)}/notes`, GitLabNoteSchema, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  updateNote(projectId: string, iid: string, noteId: number, body: string): Promise<GitLabNote> {
    return this.request(`${mergeRequestPath(projectId, iid)}/notes/${encodeURIComponent(String(noteId))}`, GitLabNoteSchema, {
      method: "PUT",
      body: JSON.stringify({ body }),
    });
  }
}

function gitlabIdentifier(value: string): number | string {
  const numeric = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(numeric) ? numeric : value;
}

function changeLabel(change: MergeRequestChange): string {
  if (change.new_file) return "added";
  if (change.deleted_file) return "deleted";
  if (change.renamed_file) return "renamed";
  return "modified";
}

export function formatChanges(changes: MergeRequestChange[], maxBytes = 300_000): string {
  const sections: string[] = [];
  let byteLength = 0;
  for (const change of changes) {
    const oldPath = change.old_path ?? change.new_path ?? "unknown";
    const newPath = change.new_path ?? oldPath;
    const diff = typeof change.diff === "string" ? change.diff : "[diff unavailable]";
    const section = [
      `diff --git a/${oldPath} b/${newPath}`,
      `# ${changeLabel(change)}: ${newPath}`,
      diff,
    ].join("\n");
    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (byteLength + sectionBytes > maxBytes) {
      sections.push(`\n[diff truncated after ${byteLength} bytes; remaining files omitted]`);
      break;
    }
    sections.push(section);
    byteLength += sectionBytes;
  }
  return sections.join("\n\n") || "[MR contains no textual changes]";
}
