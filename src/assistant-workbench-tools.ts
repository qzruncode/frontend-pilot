import {
  GitLabCreateMergeRequestInputSchema,
  GitLabMergeMergeRequestInputSchema,
  GitLabNoteBodySchema,
  GitLabUpdateMergeRequestInputSchema,
  type GitLabCreateMergeRequestInput,
  type GitLabMergeMergeRequestInput,
  type GitLabUpdateMergeRequestInput,
} from "./contracts.js";
import type { GitLabProject, GitLabRepositoryCommit, GitLabMergeRequestCreateOptions, GitLabMergeRequestDetails, GitLabMergeRequestSummary, GitLabPipelineJob, GitLabPipelineSummary } from "./gitlab-workbench.js";
import { GitLabApiError, type GitLabCurrentUser } from "./gitlab-client.js";
import { clip, failure, result, type AssistantToolContext, type AssistantToolResult, type AssistantWorkbenchGitLabClient } from "./assistant-tools.js";

const PROJECT_PAGE_SIZE = 50;
const MAX_PROJECT_PAGES = 50;
const MAX_PROJECTS = MAX_PROJECT_PAGES * PROJECT_PAGE_SIZE;
const COMMIT_PAGE_SIZE = 100;
const MAX_COMMIT_PAGES_PER_PROJECT = 20;
const MAX_DETAILED_COMMITS = 40;
const MAX_COMMIT_SCAN_MS = 90_000;
const MAX_CONCURRENT_REPOSITORIES = 12;
const MAX_GITLAB_CREATE_OPTIONS = 100;

export {
  getJiraCurrentUser,
  getJiraCreateOptions,
  getJiraIssue,
  getJiraIssueTransitions,
  createJiraIssue,
  listJiraIssues,
  listMyJiraTodos,
} from "./assistant-jira-tools.js";

function authRequired(provider: "gitlab" | "jira"): AssistantToolResult {
  const isGitLab = provider === "gitlab";
  return result({
    authRequired: {
      kind: "auth_required",
      provider,
      title: isGitLab ? "需要连接 GitLab" : "需要连接 Jira",
      description: isGitLab
        ? "这项任务需要读取你的 GitLab 个人数据，请先连接或重新连接 GitLab 账号。"
        : "这项任务需要读取你的 Jira 个人数据，请先连接或重新连接 Jira 账号。",
      actionLabel: isGitLab ? "去连接 GitLab" : "去连接 Jira",
      actionPath: isGitLab ? "/gitlab-workbench" : "/jira-workbench",
    },
  });
}

async function gitlabClient(context: AssistantToolContext): Promise<AssistantWorkbenchGitLabClient | null> {
  return context.gitlabWorkbench ? context.gitlabWorkbench() : null;
}

function gitlabIdentityFailure(error: unknown, fallback: string): AssistantToolResult {
  const status = error instanceof GitLabApiError ? error.status : undefined;
  if (status === 401 || status === 403) return authRequired("gitlab");
  return failure(error, fallback);
}

function mergeRequestSummary(mergeRequest: GitLabMergeRequestSummary): Record<string, unknown> {
  return {
    projectId: mergeRequest.projectId,
    projectPath: mergeRequest.projectPath,
    iid: mergeRequest.iid,
    title: clip(mergeRequest.title, 500),
    description: mergeRequest.description ? clip(mergeRequest.description, 4_000) : null,
    state: mergeRequest.state,
    draft: mergeRequest.draft,
    headSha: mergeRequest.headSha,
    mergeError: mergeRequest.mergeError ?? null,
    author: mergeRequest.author,
    assignees: mergeRequest.assignees,
    reviewers: mergeRequest.reviewers,
    milestone: mergeRequest.milestone,
    labels: mergeRequest.labels.slice(0, 50),
    sourceBranch: mergeRequest.sourceBranch,
    targetBranch: mergeRequest.targetBranch,
    updatedAt: mergeRequest.updatedAt,
    webUrl: mergeRequest.webUrl,
  };
}

function pipelineSummary(pipeline: GitLabPipelineSummary): Record<string, unknown> {
  return {
    id: pipeline.id,
    status: pipeline.status,
    ref: pipeline.ref,
    sha: pipeline.sha,
    source: pipeline.source,
    updatedAt: pipeline.updatedAt,
    webUrl: pipeline.webUrl,
  };
}

function limitedGitLabValues<T>(values: readonly T[]): { values: T[]; truncated: boolean } {
  return { values: values.slice(0, MAX_GITLAB_CREATE_OPTIONS), truncated: values.length > MAX_GITLAB_CREATE_OPTIONS };
}

function gitlabCreateOptionsSummary(options: GitLabMergeRequestCreateOptions): Record<string, unknown> {
  const branches = limitedGitLabValues(options.branches);
  const members = limitedGitLabValues(options.members);
  const milestones = limitedGitLabValues(options.milestones);
  const labels = limitedGitLabValues(options.labels);
  return {
    currentUser: gitlabUserSummary(options.currentUser),
    requiredFields: ["sourceProjectId", "targetProjectId", "sourceBranch", "targetBranch", "title"],
    branches: branches.values.map((branch) => ({ name: branch.name, isDefault: branch.isDefault, isProtected: branch.isProtected, commitSha: branch.commitSha, commitTitle: branch.commitTitle ? clip(branch.commitTitle, 300) : null, commitMessage: branch.commitMessage ? clip(branch.commitMessage, 2_000) : null })),
    members: members.values.map(gitlabUserSummary),
    milestones: milestones.values.map((milestone) => ({ id: milestone.id, title: milestone.title, state: milestone.state, dueDate: milestone.dueDate })),
    labels: labels.values.map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description ? clip(label.description, 300) : null })),
    truncated: { branches: branches.truncated, members: members.truncated, milestones: milestones.truncated, labels: labels.truncated },
  };
}

function schemaIssueMessage(issues: readonly { message: string }[]): string {
  return [...new Set(issues.map((issue) => issue.message).filter(Boolean))].join("；") || "请检查 GitLab 参数";
}

function invalidGitLabInput(issues: readonly { message: string }[], fallback: string): AssistantToolResult {
  return failure(new Error(schemaIssueMessage(issues)), fallback);
}

function missingGitLabCapability(capability: string): AssistantToolResult {
  return failure(new Error(`当前 GitLab 客户端不支持${capability}`), `无法${capability}`);
}

function memberMatchesQuery(member: GitLabMergeRequestCreateOptions["members"][number], query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  return `${member.username} ${member.name}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
}

function pipelineJobSummary(job: GitLabPipelineJob): Record<string, unknown> {
  return {
    id: job.id,
    name: clip(job.name, 300),
    stage: clip(job.stage, 200),
    status: job.status,
    webUrl: job.webUrl,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    duration: job.duration,
    allowFailure: job.allowFailure,
    failureReason: job.failureReason ? clip(job.failureReason, 500) : null,
  };
}

function detailSummary(detail: GitLabMergeRequestDetails): Record<string, unknown> {
  return {
    ...mergeRequestSummary(detail),
    description: detail.description ? clip(detail.description, 4_000) : null,
    labels: detail.labels,
    changes: detail.changes.slice(0, 40).map((change) => ({
      oldPath: change.oldPath,
      newPath: change.newPath,
      changeType: change.changeType,
      diff: clip(change.diff, 1_500),
    })),
    notes: detail.notes.slice(-20).map((note) => ({
      author: note.author,
      body: clip(note.body, 1_000),
      createdAt: note.createdAt,
      system: note.system,
    })),
    pipelines: detail.pipelines.map(pipelineSummary),
  };
}

export async function getGitLabCurrentUser(context: AssistantToolContext): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client?.getCurrentUser) return authRequired("gitlab");
  try {
    return result({ provider: "gitlab", user: await client.getCurrentUser() });
  } catch (error) {
    return gitlabIdentityFailure(error, "无法读取当前 GitLab 用户");
  }
}

export async function listMyGitLabMergeRequests(
  context: AssistantToolContext,
  input: { scope: "assigned_to_me" | "created_by_me" | "review_requested" | "all"; state: "opened" | "closed" | "merged" | "all"; limit: number },
): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client?.listMergeRequests) return authRequired("gitlab");
  try {
    const user = client.getCurrentUser ? await client.getCurrentUser() : null;
    const mergeRequests = await client.listMergeRequests({
      scope: input.scope,
      state: input.state,
      page: 1,
      perPage: input.limit,
      reviewerUsername: input.scope === "review_requested" ? user?.username ?? undefined : undefined,
    });
    return result({ provider: "gitlab", user, mergeRequests: mergeRequests.map(mergeRequestSummary) });
  } catch (error) {
    return failure(error, "无法读取我的 GitLab Merge Request");
  }
}

export async function getGitLabMergeRequestDetails(context: AssistantToolContext, input: { projectId: string; mrIid: string }): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client?.getMergeRequestDetails) return authRequired("gitlab");
  try {
    return result({ provider: "gitlab", mergeRequest: detailSummary(await client.getMergeRequestDetails(input.projectId, input.mrIid)) });
  } catch (error) {
    return failure(error, "无法读取 GitLab Merge Request 详情");
  }
}

export async function listGitLabPipelines(context: AssistantToolContext, input: { projectId: string; ref?: string; status?: string; limit: number }): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client?.listPipelines) return authRequired("gitlab");
  try {
    const pipelines = await client.listPipelines(input.projectId, { ref: input.ref, status: input.status, page: 1, perPage: input.limit });
    return result({ provider: "gitlab", projectId: input.projectId, pipelines: pipelines.map(pipelineSummary) });
  } catch (error) {
    return failure(error, "无法读取 GitLab Pipeline");
  }
}

export async function getGitLabMergeRequestCreateOptions(context: AssistantToolContext, input: { projectId: string }): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client) return authRequired("gitlab");
  if (!client.getMergeRequestCreateOptions) return missingGitLabCapability("读取 Merge Request 创建选项");
  try {
    return result({ provider: "gitlab", projectId: input.projectId, ...gitlabCreateOptionsSummary(await client.getMergeRequestCreateOptions(input.projectId)) });
  } catch (error) {
    return gitlabIdentityFailure(error, "无法读取 GitLab Merge Request 创建选项");
  }
}

export async function searchGitLabProjectMembers(context: AssistantToolContext, input: { projectId: string; query: string }): Promise<AssistantToolResult> {
  const query = input.query.trim();
  if (!query) return failure(new Error("GitLab 成员搜索关键词不能为空"), "请输入要搜索的经办人或 Reviewer");
  const client = await gitlabClient(context);
  if (!client) return authRequired("gitlab");
  if (!client.searchProjectMembers && !client.getMergeRequestCreateOptions) return missingGitLabCapability("搜索 GitLab 项目成员");
  try {
    const members = client.searchProjectMembers
      ? await client.searchProjectMembers(input.projectId, query)
      : client.getMergeRequestCreateOptions
        ? (await client.getMergeRequestCreateOptions(input.projectId)).members
        : [];
    const matches = members.filter((member) => memberMatchesQuery(member, query));
    const limited = limitedGitLabValues(matches);
    return result({ provider: "gitlab", projectId: input.projectId, query, total: matches.length, truncated: limited.truncated, matches: limited.values.map(gitlabUserSummary) });
  } catch (error) {
    return gitlabIdentityFailure(error, "无法搜索 GitLab 项目成员");
  }
}

export async function createGitLabMergeRequest(context: AssistantToolContext, input: GitLabCreateMergeRequestInput): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client) return authRequired("gitlab");
  if (!client.createMergeRequest) return missingGitLabCapability("创建 Merge Request");
  const parsed = GitLabCreateMergeRequestInputSchema.safeParse(input);
  if (!parsed.success) return invalidGitLabInput(parsed.error.issues, "GitLab Merge Request 创建参数不完整");
  try {
    const mergeRequest = await client.createMergeRequest(parsed.data);
    return result({ provider: "gitlab", created: true, mergeRequest: mergeRequestSummary(mergeRequest) });
  } catch (error) {
    return gitlabIdentityFailure(error, "无法创建 GitLab Merge Request");
  }
}

export async function updateGitLabMergeRequest(context: AssistantToolContext, input: { projectId: string; mrIid: string } & GitLabUpdateMergeRequestInput): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client) return authRequired("gitlab");
  if (!client.updateMergeRequest) return missingGitLabCapability("更新 Merge Request");
  const { projectId, mrIid, ...changes } = input;
  const parsed = GitLabUpdateMergeRequestInputSchema.safeParse(changes);
  if (!parsed.success) return invalidGitLabInput(parsed.error.issues, "GitLab Merge Request 更新参数不完整");
  try {
    const mergeRequest = await client.updateMergeRequest(projectId, mrIid, parsed.data);
    return result({ provider: "gitlab", updated: true, mergeRequest: mergeRequestSummary(mergeRequest) });
  } catch (error) {
    return gitlabIdentityFailure(error, "无法更新 GitLab Merge Request");
  }
}

export async function mergeGitLabMergeRequest(context: AssistantToolContext, input: { projectId: string; mrIid: string } & GitLabMergeMergeRequestInput): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client) return authRequired("gitlab");
  if (!client.mergeMergeRequest) return missingGitLabCapability("合并 Merge Request");
  const { projectId, mrIid, ...mergeOptions } = input;
  const parsed = GitLabMergeMergeRequestInputSchema.safeParse(mergeOptions);
  if (!parsed.success) return invalidGitLabInput(parsed.error.issues, "GitLab Merge Request 合并参数不完整");
  try {
    const mergeRequest = await client.mergeMergeRequest(projectId, mrIid, parsed.data);
    const merged = mergeRequest.state === "merged";
    return result({ provider: "gitlab", merged, mergeWhenPipelineSucceeds: parsed.data.mergeWhenPipelineSucceeds, mergeRequest: mergeRequestSummary(mergeRequest) });
  } catch (error) {
    return gitlabIdentityFailure(error, "无法合并 GitLab Merge Request");
  }
}

export async function createGitLabMergeRequestNote(context: AssistantToolContext, input: { projectId: string; mrIid: string; body: string }): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client) return authRequired("gitlab");
  if (!client.createNote) return missingGitLabCapability("发布 Merge Request 评论");
  const parsed = GitLabNoteBodySchema.safeParse({ body: input.body });
  if (!parsed.success) return invalidGitLabInput(parsed.error.issues, "GitLab 评论内容不能为空或过长");
  try {
    const note = await client.createNote(input.projectId, input.mrIid, parsed.data.body);
    return result({ provider: "gitlab", created: true, projectId: input.projectId, mrIid: input.mrIid, note: { id: String(note.id), body: clip(note.body ?? parsed.data.body, 4_000) } });
  } catch (error) {
    return gitlabIdentityFailure(error, "无法发布 GitLab Merge Request 评论");
  }
}

export async function getGitLabPipelineJobs(context: AssistantToolContext, input: { projectId: string; pipelineId: string }): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client) return authRequired("gitlab");
  if (!client.listPipelineJobs) return missingGitLabCapability("读取 Pipeline Job");
  try {
    const jobs = await client.listPipelineJobs(input.projectId, input.pipelineId);
    return result({ provider: "gitlab", projectId: input.projectId, pipelineId: input.pipelineId, jobs: jobs.slice(0, MAX_GITLAB_CREATE_OPTIONS).map(pipelineJobSummary), truncated: jobs.length > MAX_GITLAB_CREATE_OPTIONS });
  } catch (error) {
    return gitlabIdentityFailure(error, "无法读取 GitLab Pipeline Job");
  }
}

async function runGitLabPipelineAction(context: AssistantToolContext, input: { projectId: string; pipelineId: string }, action: "retry" | "cancel"): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client) return authRequired("gitlab");
  const operation = action === "retry" ? client.retryPipeline?.bind(client) : client.cancelPipeline?.bind(client);
  if (!operation) return missingGitLabCapability(action === "retry" ? "重试 Pipeline" : "取消 Pipeline");
  try {
    const pipeline = await operation(input.projectId, input.pipelineId);
    return result({ provider: "gitlab", projectId: input.projectId, pipeline: pipelineSummary(pipeline), action });
  } catch (error) {
    return gitlabIdentityFailure(error, action === "retry" ? "无法重试 GitLab Pipeline" : "无法取消 GitLab Pipeline");
  }
}

export async function retryGitLabPipeline(context: AssistantToolContext, input: { projectId: string; pipelineId: string }): Promise<AssistantToolResult> {
  return runGitLabPipelineAction(context, input, "retry");
}

export async function cancelGitLabPipeline(context: AssistantToolContext, input: { projectId: string; pipelineId: string }): Promise<AssistantToolResult> {
  return runGitLabPipelineAction(context, input, "cancel");
}

type GitLabCommitRange = { since: string; until: string; label: string };

function normalizeCommitRange(since: string, until: string): GitLabCommitRange {
  const normalizedSince = since.trim();
  const normalizedUntil = until.trim();
  const sinceTime = Date.parse(normalizedSince);
  const untilTime = Date.parse(normalizedUntil);
  if (!Number.isFinite(sinceTime) || !Number.isFinite(untilTime) || sinceTime >= untilTime) {
    throw new Error("GitLab 提交时间范围无效，since 必须早于 until");
  }
  return { since: normalizedSince, until: normalizedUntil, label: `${normalizedSince.slice(0, 10)} 至 ${normalizedUntil.slice(0, 10)}` };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

type ProjectScanResult = {
  projects: GitLabProject[];
  truncated: boolean;
  source: "user_contributed_projects" | "user_membership_projects" | "unavailable";
};

async function scanAccessibleProjects(client: AssistantWorkbenchGitLabClient): Promise<{ projects: GitLabProject[]; truncated: boolean }> {
  if (!client.listProjects) throw new Error("GitLab 项目列表能力不可用");
  const projects: GitLabProject[] = [];
  for (let page = 1; page <= MAX_PROJECT_PAGES; page += 1) {
    const next = await client.listProjects({ page, perPage: PROJECT_PAGE_SIZE });
    projects.push(...next);
    if (next.length < PROJECT_PAGE_SIZE) return { projects, truncated: false };
  }
  return { projects: projects.slice(0, MAX_PROJECTS), truncated: true };
}

async function listProjects(client: AssistantWorkbenchGitLabClient, user: { id?: string | number; username?: string | null }): Promise<ProjectScanResult> {
  let accessibleProjectsError: unknown;
  if (client.listProjects) {
    try {
      const scan = await scanAccessibleProjects(client);
      return { ...scan, source: "user_membership_projects" };
    } catch (error) {
      accessibleProjectsError = error;
    }
  }
  const userId = user.id ?? user.username?.trim();
  if (client.listContributedProjects && userId) {
    try {
      const projects = await client.listContributedProjects(String(userId));
      return { projects, truncated: false, source: "user_contributed_projects" };
    } catch (error) {
      if (!accessibleProjectsError) accessibleProjectsError = error;
    }
  }
  if (accessibleProjectsError) throw accessibleProjectsError;
  return { projects: [], truncated: true, source: "unavailable" };
}

function normalizeIdentity(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function gitlabUserSummary(user: { id?: string | number | null; username?: string | null; name?: string | null }): Record<string, unknown> {
  return { id: user.id ?? null, username: user.username ?? null, name: user.name ?? null };
}

function gitlabProjectSummary(project: GitLabProject): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    pathWithNamespace: project.pathWithNamespace,
    webUrl: project.webUrl,
    defaultBranch: project.defaultBranch,
    lastActivityAt: project.lastActivityAt,
  };
}

function gitlabCommitSummary(commit: GitLabRepositoryCommit): Record<string, unknown> {
  return {
    sha: commit.id,
    shortSha: commit.shortId,
    title: clip(commit.title, 300),
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    authoredAt: commit.authoredAt,
    committedAt: commit.committedAt,
    webUrl: commit.webUrl,
  };
}

export async function listMyGitLabContributedProjects(context: AssistantToolContext): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client?.getCurrentUser || (!client.listProjects && !client.listContributedProjects)) return authRequired("gitlab");
  let user: GitLabCurrentUser;
  try {
    user = await client.getCurrentUser();
  } catch (error) {
    return gitlabIdentityFailure(error, "无法读取当前 GitLab 用户");
  }
  try {
    const projectResult = await listProjects(client, user);
    return result({
      provider: "gitlab",
      scope: projectResult.source === "user_contributed_projects" ? "current_user_contributed_projects" : "current_user_projects",
      user: gitlabUserSummary(user),
      projectSource: projectResult.source,
      projectScopeNote: projectResult.source === "user_membership_projects"
        ? "当前 GitLab 实例未提供 contributed_projects，已使用当前账号可访问的成员项目列表。"
        : null,
      total: projectResult.projects.length,
      truncated: projectResult.truncated,
      projects: projectResult.projects.map(gitlabProjectSummary),
    });
  } catch (error) {
    return failure(error, "无法读取当前用户参与过的 GitLab 项目");
  }
}

export async function listGitLabProjectCommits(
  context: AssistantToolContext,
  input: { projectId: string; since: string; until: string; author?: string; page: number; perPage: number },
): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client?.listRepositoryCommits) return authRequired("gitlab");
  try {
    const period = normalizeCommitRange(input.since, input.until);
    const commits = await client.listRepositoryCommits(input.projectId, {
      since: period.since,
      until: period.until,
      author: input.author,
      all: true,
      page: input.page,
      perPage: input.perPage,
    });
    return result({
      provider: "gitlab",
      scope: "project_commits",
      projectId: input.projectId,
      period,
      page: input.page,
      perPage: input.perPage,
      hasNextPage: commits.length >= input.perPage,
      commits: commits.map(gitlabCommitSummary),
    });
  } catch (error) {
    return failure(error, "无法读取 GitLab 项目提交");
  }
}

function matchesUser(commit: GitLabRepositoryCommit, user: { name?: string | null; username?: string | null; email?: string | null; commit_email?: string | null }): boolean {
  const authors = new Set([user.name, user.username, user.email, user.commit_email].map(normalizeIdentity).filter(Boolean));
  return authors.has(normalizeIdentity(commit.authorName)) || authors.has(normalizeIdentity(commit.authorEmail));
}

type CommitScanResult = {
  commits: GitLabRepositoryCommit[];
  truncated: boolean;
  skipped: boolean;
};

async function commitsForProject(client: AssistantWorkbenchGitLabClient, project: GitLabProject, range: { since: string; until: string }, deadline: number): Promise<CommitScanResult> {
  if (!client.listRepositoryCommits) return { commits: [], truncated: true, skipped: true };
  const commits: GitLabRepositoryCommit[] = [];
  for (let page = 1; page <= MAX_COMMIT_PAGES_PER_PROJECT; page += 1) {
    if (Date.now() >= deadline) return { commits, truncated: true, skipped: true };
    try {
      const next = await client.listRepositoryCommits(project.id, {
        since: range.since,
        until: range.until,
        all: true,
        page,
        perPage: COMMIT_PAGE_SIZE,
      });
      commits.push(...next);
      if (next.length < COMMIT_PAGE_SIZE) return { commits, truncated: false, skipped: false };
    } catch {
      return { commits, truncated: true, skipped: true };
    }
  }
  return { commits, truncated: true, skipped: true };
}

type CommitActivityCommit = {
  projectId: string;
  projectPath: string;
  projectName: string;
  sha: string;
  shortSha: string;
  title: string;
  authoredAt: string | null;
  committedAt: string | null;
  webUrl: string | null;
};

function activityCommit(project: GitLabProject, commit: GitLabRepositoryCommit): CommitActivityCommit {
  return {
    projectId: project.id,
    projectPath: project.pathWithNamespace,
    projectName: project.name,
    sha: commit.id,
    shortSha: commit.shortId,
    title: clip(commit.title, 300),
    authoredAt: commit.authoredAt,
    committedAt: commit.committedAt,
    webUrl: commit.webUrl,
  };
}

function buildCommitActivityResult(
  user: { id?: string | number; username?: string | null; name?: string | null },
  period: GitLabCommitRange,
  projectResult: ProjectScanResult,
  commitsByProject: Array<{ project: GitLabProject; scan: CommitScanResult }>,
  maxDetails: number,
): Record<string, unknown> {
  const commits = commitsByProject
    .flatMap(({ project, scan }) => scan.commits.filter((commit) => matchesUser(commit, user)).map((commit) => activityCommit(project, commit)))
    .sort((left, right) => (right.committedAt ?? right.authoredAt ?? "").localeCompare(left.committedAt ?? left.authoredAt ?? ""));
  const repositories = new Map<string, { projectId: string; projectPath: string; projectName: string; commitCount: number; commitTitles: string[] }>();
  commits.forEach((commit) => {
    const current = repositories.get(commit.projectId) ?? { projectId: commit.projectId, projectPath: commit.projectPath, projectName: commit.projectName, commitCount: 0, commitTitles: [] };
    current.commitCount += 1;
    if (current.commitTitles.length < 8) current.commitTitles.push(commit.title);
    repositories.set(commit.projectId, current);
  });
  const returnedCommits = commits.slice(0, maxDetails);
  const commitPaginationTruncated = commitsByProject.some(({ scan }) => scan.truncated);
  const skippedProjects = commitsByProject.filter(({ scan }) => scan.skipped).length;
  const scanTruncated = projectResult.truncated || commitPaginationTruncated;
  return {
    provider: "gitlab",
    scope: "current_user_commits",
    user: gitlabUserSummary(user),
    period,
    projectSource: projectResult.source,
    projectScopeNote: projectResult.source === "user_membership_projects"
      ? "当前 GitLab 实例未提供 contributed_projects，已使用当前账号可访问的成员项目列表。"
      : null,
    repositoriesScanned: projectResult.projects.length,
    skippedProjects,
    repositoriesWithActivity: repositories.size,
    totalCommits: commits.length,
    returnedCommitCount: returnedCommits.length,
    truncated: scanTruncated,
    detailsTruncated: commits.length > maxDetails,
    completeness: {
      projectsComplete: !projectResult.truncated,
      commitsComplete: !commitPaginationTruncated,
      detailedCommitsComplete: commits.length <= maxDetails,
    },
    repositories: [...repositories.values()],
    commits: returnedCommits,
  };
}

async function runGitLabCommitActivity(
  context: AssistantToolContext,
  input: { since: string; until: string; maxDetails?: number },
  fallbackMessage: string,
): Promise<AssistantToolResult> {
  const client = await gitlabClient(context);
  if (!client?.getCurrentUser || (!client.listContributedProjects && !client.listProjects) || !client.listRepositoryCommits) return authRequired("gitlab");
  let range: GitLabCommitRange;
  try {
    range = normalizeCommitRange(input.since, input.until);
  } catch (error) {
    return failure(error, fallbackMessage);
  }
  const maxDetails = Math.min(Math.max(Math.floor(input.maxDetails ?? MAX_DETAILED_COMMITS), 1), MAX_DETAILED_COMMITS);
  let user: GitLabCurrentUser;
  try {
    user = await client.getCurrentUser();
  } catch (error) {
    return gitlabIdentityFailure(error, "无法读取当前 GitLab 用户");
  }
  try {
    const projectResult = await listProjects(client, user);
    const deadline = Date.now() + MAX_COMMIT_SCAN_MS;
    const commitsByProject = await mapWithConcurrency(projectResult.projects, MAX_CONCURRENT_REPOSITORIES, async (project) => ({ project, scan: await commitsForProject(client, project, range, deadline) }));
    return result(buildCommitActivityResult(user, range, projectResult, commitsByProject, maxDetails));
  } catch (error) {
    return failure(error, fallbackMessage);
  }
}

export async function getGitLabCommitActivity(context: AssistantToolContext, input: { since: string; until: string; maxDetails?: number }): Promise<AssistantToolResult> {
  return runGitLabCommitActivity(context, input, "无法读取 GitLab 提交活动");
}
