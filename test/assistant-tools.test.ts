import { describe, expect, it } from "vitest";
import type { ReviewJob, ReviewProgressEvent } from "../src/contracts.js";
import {
  getMergeRequest,
  getReviewDetail,
  getReviewProgress,
  getReviewRules,
  getReviewStats,
  listReviews,
  cancelReview,
  startReview,
  startReviewFromUrl,
  type AssistantToolContext,
} from "../src/assistant-tools.js";
import { createAssistantToolServer } from "../src/assistant-tool-server.js";
import { cancelGitLabPipeline, createGitLabMergeRequest, createGitLabMergeRequestNote, createJiraIssue, getGitLabCommitActivity, getGitLabCurrentUser, getGitLabMergeRequestCreateOptions, getGitLabPipelineJobs, getJiraCreateOptions, getJiraCurrentUser, getJiraIssue, getJiraIssueTransitions, listGitLabProjectCommits, listJiraIssues, listMyGitLabContributedProjects, listMyJiraTodos, mergeGitLabMergeRequest, retryGitLabPipeline, searchGitLabProjectMembers, updateGitLabMergeRequest } from "../src/assistant-workbench-tools.js";
import { GitLabApiError } from "../src/gitlab-client.js";
import { JiraApiError } from "../src/jira-client.js";
import type { JiraIssueDetails, JiraIssueSummary } from "../src/jira-workbench.js";

const progress = Array.from({ length: 30 }, (_, index): ReviewProgressEvent => ({
  id: `review-1:${index + 1}`,
  at: `2026-08-13T00:00:${String(index).padStart(2, "0")}Z`,
  kind: "stage",
  message: `阶段 ${index + 1}`,
  detail: `详情 ${index + 1}`,
}));

const review: ReviewJob = {
  id: "review-1",
  projectId: "group/project",
  projectPath: "group/project",
  mrIid: "7",
  headSha: "head-sha",
  targetBranch: "main",
  source: "assistant",
  status: "running",
  createdAt: "2026-08-13T00:00:00Z",
  startedAt: "2026-08-13T00:00:01Z",
  finishedAt: null,
  noteId: null,
  error: null,
  result: null,
  progress,
};

const context: AssistantToolContext = {
  reviewService: {
    stats: () => ({ queued: 0, running: 1, completed: 2, failed: 0, superseded: 0, canceled: 0 }),
    listJobs: () => [review],
    getJob: (id) => id === review.id ? review : null,
    getProgressEvents: (id) => id === review.id ? progress : null,
    async enqueue() { return { job: review, deduplicated: false }; },
    async cancel(id) {
      return id === review.id ? { ...review, status: "canceled", finishedAt: "2026-08-13T00:01:00Z" } : null;
    },
  },
  gitlab: {
    async getMergeRequest() {
      return {
        target_branch: "main",
        diff_refs: { head_sha: "head-sha" },
        target_project: { path_with_namespace: "group/project" },
        source_project: { path_with_namespace: "group/project-feature" },
      };
    },
    async resolveMergeRequestUrl() {
      return {
        projectId: "group/project",
        projectPath: "group/project",
        mrIid: "7",
        headSha: "head-sha",
        targetBranch: "main",
      };
    },
  },
  reviewRules: {
    async list() {
      return [{
        name: "group/project",
        displayName: "group/project",
        isDefault: false,
        rules: [{
          id: "project-rule",
          name: "项目规则",
          description: "检查项目约束",
          enabled: true,
          order: 0,
          file: "rules.md",
          sharedBy: ["group/project"],
          content: "a".repeat(9_000),
        }],
      }];
    },
    async readForProject() {
      return (await this.list())[0];
    },
  },
};

const jiraIssue: JiraIssueSummary = {
  id: "428812",
  key: "AIP-113931",
  summary: "配置部署调整",
  description: "调整部署配置",
  status: "处理中",
  statusId: "3",
  statusCategory: "indeterminate",
  issueType: "任务",
  priority: "重要",
  projectKey: "AIP",
  projectName: "Sophon",
  webUrl: "https://jira.example.com/browse/AIP-113931",
  createdAt: "2026-08-19T01:00:00Z",
  updatedAt: "2026-08-20T01:00:00Z",
  resolution: null,
  labels: ["frontend"],
  assignee: { username: "jira-user", name: "Jira User", avatarUrl: null },
  reporter: { username: "jira-user", name: "Jira User", avatarUrl: null },
};

const jiraDetail: JiraIssueDetails = {
  ...jiraIssue,
  comments: [{ id: "11", body: "先看部署日志", author: jiraIssue.assignee, createdAt: "2026-08-19T01:00:00Z", updatedAt: null }],
  attachments: [{ id: "77", filename: "部署截图.png", url: "https://jira.example.com/secure/attachment/77/deploy.png", mimeType: "image/png", size: 2_048, createdAt: "2026-08-19T02:00:00Z", author: jiraIssue.reporter }],
};

const jiraCreateOptions = {
  issueTypes: [{ id: "10001", name: "任务" }],
  priorities: [{ id: "10002", name: "重要" }],
  priorityRequired: true,
  currentUser: { username: "jira-user", name: "Jira User", avatarUrl: null },
  assignees: [jiraIssue.assignee],
  reporters: [jiraIssue.reporter],
  components: [{ id: "10", name: "前端" }],
  fixVersions: [{ id: "20", name: "2026.08" }],
  customers: [],
  epics: [],
  sprints: [],
  linkableIssues: [],
  customFieldIds: { customerName: null, epicLink: null, sprint: null },
  labels: ["frontend", "backend"],
};

const jiraCreateSupportingOptions = {
  assignees: jiraCreateOptions.assignees,
  components: jiraCreateOptions.components,
  fixVersions: jiraCreateOptions.fixVersions,
  labels: jiraCreateOptions.labels,
};

const gitlabIdentity = { id: "42", username: "pilot", name: "Pilot", webUrl: null, avatarUrl: null };
const gitlabMergeRequest = {
  id: "mr-26",
  iid: "26",
  projectId: "7",
  projectPath: "group/project",
  title: "Improve assistant context",
  description: "MR description",
  state: "opened",
  draft: false,
  webUrl: "https://gitlab.invalid/group/project/-/merge_requests/26",
  createdAt: "2026-08-20T01:00:00Z",
  updatedAt: "2026-08-20T02:00:00Z",
  sourceBranch: "feature/context",
  targetBranch: "main",
  headSha: "head-sha",
  mergeError: null,
  author: gitlabIdentity,
  assignees: [],
  reviewers: [],
  milestone: null,
  labels: ["frontend"],
  pipeline: null,
};

describe("assistant review tools", () => {
  it("returns current review data through bounded, structured results", async () => {
    expect(getReviewStats(context).structuredContent).toEqual({
      stats: { queued: 0, running: 1, completed: 2, failed: 0, superseded: 0, canceled: 0 },
    });
    expect(listReviews(context, { limit: 10 }).structuredContent).toMatchObject({ reviews: [{ id: "review-1", status: "running" }] });

    const detail = getReviewDetail(context, { reviewId: "review-1" });
    expect(detail.structuredContent).toMatchObject({ review: { id: "review-1" } });
    expect((detail.structuredContent?.progress as unknown[]).length).toBe(20);

    const recent = getReviewProgress(context, { reviewId: "review-1", limit: 3 });
    expect(recent.structuredContent?.progress).toHaveLength(3);
  });

  it("reads GitLab metadata and rule content without exposing diffs or writing", async () => {
    const mergeRequest = await getMergeRequest(context, { projectId: "group/project", mrIid: "7" });
    expect(mergeRequest.structuredContent).toEqual({
      projectId: "group/project",
      mrIid: "7",
      mergeRequest: {
        targetBranch: "main",
        headSha: "head-sha",
        targetProjectPath: "group/project",
        sourceProjectPath: "group/project-feature",
      },
    });

    const rules = await getReviewRules(context, { projectPath: "group/project" });
    const profile = rules.structuredContent?.profile as { rules: Array<{ content: string }> };
    expect(profile.rules[0]?.content).toHaveLength(8_000);
    expect(rules.isError).not.toBe(true);
  });

  it("starts and cancels tasks through ReviewService", async () => {
    const started = await startReview(context, {
      projectId: "group/project",
      mrIid: "7",
    });
    expect(started.structuredContent).toMatchObject({ accepted: true, review: { id: "review-1" } });

    const canceled = await cancelReview(context, { reviewId: "review-1" });
    expect(canceled.structuredContent).toMatchObject({ canceled: true, review: { status: "canceled" } });
  });

  it("resolves an MR URL before starting a task", async () => {
    const started = await startReviewFromUrl(context, {
      url: "https://gitlab.example/group/project/-/merge_requests/7",
    });
    expect(started.structuredContent).toMatchObject({
      accepted: true,
      review: { projectId: "group/project", mrIid: "7", headSha: "head-sha" },
    });
  });

  it("returns an error result for an unknown review", () => {
    const missing = getReviewDetail(context, { reviewId: "missing" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("未找到 Review 任务");
  });

  it("registers an in-process SDK MCP server", () => {
    const server = createAssistantToolServer(context);
    expect(server).toMatchObject({ type: "sdk", name: "frontend_pilot" });
    expect(server.instance).toBeDefined();
  });

  it("returns a connection card when personal workbench data is unavailable", async () => {
    const gitlab = await getGitLabCurrentUser({ ...context, gitlabWorkbench: async () => null });
    expect(gitlab.structuredContent?.authRequired).toMatchObject({ kind: "auth_required", provider: "gitlab", actionPath: "/gitlab-workbench" });

    const jira = await listMyJiraTodos({ ...context, jiraConfigured: () => false }, { state: "todo", limit: 10 });
    expect(jira.structuredContent?.authRequired).toMatchObject({ kind: "auth_required", provider: "jira", actionPath: "/jira-workbench" });
  });

  it("uses the current personal Jira client for Jira todos", async () => {
    const queries: Array<Record<string, unknown>> = [];
    const jira = {
      async getCurrentUser() { return { username: "chenglong.chen", name: "陈彪", avatarUrl: null }; },
      async listIssues(query: Record<string, unknown>) {
        queries.push(query);
        return { issues: [jiraIssue], page: Number(query.page), perPage: Number(query.perPage), total: 1 };
      },
      async getIssue() { return jiraDetail; },
      async getTransitions() { return []; },
      async getCreateIssueOptions() { return jiraCreateOptions; },
      async getCreateIssueSupportingOptions() { return jiraCreateSupportingOptions; },
      async createIssue() { return jiraDetail; },
    };
    const todos = await listMyJiraTodos({
      ...context,
      jira,
      jiraConfigured: () => true,
      jiraProjectKey: () => "AIP",
    }, { state: "todo", limit: 10 });

    expect(queries[0]).toMatchObject({ scope: "assigned_to_me", projectKey: "AIP" });
    expect(todos.structuredContent).toMatchObject({ user: { username: "chenglong.chen" }, scope: "assigned_to_me", issues: [{ key: "AIP-113931" }] });
  });

  it("exposes composable Jira issue, detail, and transition atoms with pagination", async () => {
    const queries: Array<Record<string, unknown>> = [];
    const jira = {
      async getCurrentUser() { return { username: "jira-user", name: "Jira User", avatarUrl: null }; },
      async listIssues(query: Record<string, unknown>) {
        queries.push(query);
        return { issues: [jiraIssue], page: Number(query.page), perPage: Number(query.perPage), total: 3 };
      },
      async getIssue() { return jiraDetail; },
      async getTransitions() { return [{ id: "11", name: "开始处理", toStatus: "处理中", toStatusId: "3" }]; },
      async getCreateIssueOptions() { return jiraCreateOptions; },
      async getCreateIssueSupportingOptions() { return jiraCreateSupportingOptions; },
      async createIssue() { return jiraDetail; },
    };
    const jiraContext = { ...context, jira, jiraConfigured: () => true, jiraProjectKey: () => "AIP" };

    const issues = await listJiraIssues(jiraContext, {
      scope: "reported_by_me",
      state: "all",
      search: "部署",
      assignee: "jira-user",
      page: 2,
      perPage: 1,
    });
    expect(issues.structuredContent).toMatchObject({
      query: { scope: "reported_by_me", state: "all", search: "部署", projectKey: "AIP", assignee: "jira-user" },
      page: 2,
      perPage: 1,
      total: 3,
      hasNextPage: true,
      issues: [{ key: "AIP-113931" }],
    });
    expect(queries[0]).toMatchObject({ scope: "reported_by_me", state: "all", search: "部署", projectKey: "AIP", assignee: "jira-user", page: 2, perPage: 1 });

    const todos = await listMyJiraTodos(jiraContext, { state: "todo", limit: 10, page: 2 });
    expect(todos.structuredContent).toMatchObject({ query: { scope: "assigned_to_me", state: "todo" }, page: 2, perPage: 10 });

    const detail = await getJiraIssue(jiraContext, { key: "AIP-113931" });
    expect(detail.structuredContent).toMatchObject({ issue: { comments: [{ id: "11" }], attachments: [{ id: "77" }] } });

    const transitions = await getJiraIssueTransitions(jiraContext, { key: "AIP-113931" });
    expect(transitions.structuredContent).toMatchObject({ key: "AIP-113931", transitions: [{ id: "11", toStatus: "处理中" }], truncated: false });
  });

  it("loads Jira creation options and creates only validated issues", async () => {
    let createdInput: unknown;
    const jira = {
      async getCurrentUser() { return jiraCreateOptions.currentUser; },
      async listIssues() { return { issues: [], page: 1, perPage: 1, total: 0 }; },
      async getIssue() { return jiraDetail; },
      async getTransitions() { return []; },
      async getCreateIssueOptions() { return jiraCreateOptions; },
      async getCreateIssueSupportingOptions() { return jiraCreateSupportingOptions; },
      async createIssue(_projectKey: string, input: unknown) {
        createdInput = input;
        return jiraDetail;
      },
    };
    const jiraContext = { ...context, jira, jiraConfigured: () => true, jiraProjectKey: () => "AIP" };

    const options = await getJiraCreateOptions(jiraContext);
    expect(options.structuredContent).toMatchObject({
      provider: "jira",
      projectKey: "AIP",
      requiredFields: ["summary", "issueType", "description", "components", "fixVersions", "priority"],
      issueTypes: [{ id: "10001", name: "任务" }],
      components: [{ id: "10", name: "前端" }],
      fixVersions: [{ id: "20", name: "2026.08" }],
    });

    const created = await createJiraIssue(jiraContext, {
      summary: "助手创建的问题",
      issueType: "10001",
      components: ["前端"],
      fixVersions: ["2026.08"],
      description: "由助手创建的描述",
      priority: "10002",
      assignee: "jira-user",
      labels: ["frontend"],
    });
    expect(created.structuredContent).toMatchObject({ created: true, projectKey: "AIP", issue: { key: "AIP-113931" } });
    expect(createdInput).toMatchObject({ summary: "助手创建的问题", components: ["前端"], fixVersions: ["2026.08"] });

    const invalid = await createJiraIssue(jiraContext, {
      summary: "缺少必填项",
      issueType: "10001",
      components: [],
      fixVersions: [],
      description: "",
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("请选择模块");
  });

  it("exposes GitLab MR and Pipeline operations with shared validation", async () => {
    const calls: string[] = [];
    const client = {
      async getCurrentUser() { return gitlabIdentity; },
      async getMergeRequestCreateOptions() {
        return {
          currentUser: gitlabIdentity,
          branches: [{ name: "main", isDefault: true, isProtected: true, commitSha: "main-sha", commitTitle: "Main", commitMessage: "Main" }, { name: "feature/context", isDefault: false, isProtected: false, commitSha: "head-sha", commitTitle: "Feature", commitMessage: "Feature\n\nFeature description" }],
          members: [gitlabIdentity, { ...gitlabIdentity, id: "43", username: "reviewer", name: "Reviewer" }],
          milestones: [{ id: "9", title: "2026.08", state: "active", dueDate: null }],
          labels: [{ id: "frontend", name: "frontend", color: "#00a", description: "Frontend" }],
        };
      },
      async searchProjectMembers() {
        return [
          { ...gitlabIdentity, id: "43", username: "yangting", name: "Yang Ting" },
          { ...gitlabIdentity, id: "44", username: "reviewer", name: "Review User" },
        ];
      },
      async createMergeRequest(input: { sourceBranch: string }) { calls.push(`create:${input.sourceBranch}`); return gitlabMergeRequest; },
      async updateMergeRequest(_projectId: string, _mrIid: string, input: { title?: string }) { calls.push(`update:${input.title ?? ""}`); return { ...gitlabMergeRequest, title: input.title ?? gitlabMergeRequest.title }; },
      async mergeMergeRequest() { calls.push("merge"); return { ...gitlabMergeRequest, state: "merged" }; },
      async createNote(_projectId: string, _mrIid: string, body: string) { calls.push(`note:${body}`); return { id: 77, body }; },
      async listPipelineJobs() { return [{ id: "88", name: "test", stage: "test", status: "failed", webUrl: null, createdAt: null, startedAt: null, finishedAt: null, duration: null, allowFailure: false, failureReason: "assertion failed" }]; },
      async retryPipeline() { calls.push("retry"); return { id: "321", status: "running", ref: "feature/context", sha: "head-sha", source: "api", webUrl: null, createdAt: null, updatedAt: null, duration: null, coverage: null }; },
      async cancelPipeline() { calls.push("cancel"); return { id: "321", status: "canceled", ref: "feature/context", sha: "head-sha", source: "api", webUrl: null, createdAt: null, updatedAt: null, duration: null, coverage: null }; },
    };
    const gitlabContext = { ...context, gitlabWorkbench: async () => client };
    const createInput = {
      targetProjectId: "7",
      sourceProjectId: "7",
      sourceBranch: "feature/context",
      targetBranch: "main",
      title: "New MR",
      description: "New description",
      assigneeIds: ["42"],
      reviewerIds: ["43"],
      milestoneId: "9",
      labels: ["frontend"],
      removeSourceBranch: true,
      squash: false,
    };

    const options = await getGitLabMergeRequestCreateOptions(gitlabContext, { projectId: "7" });
    expect(options.structuredContent).toMatchObject({ projectId: "7", requiredFields: ["sourceProjectId", "targetProjectId", "sourceBranch", "targetBranch", "title"], currentUser: { username: "pilot" } });
    expect(options.structuredContent?.branches).toEqual(expect.arrayContaining([expect.objectContaining({ name: "main" })]));
    expect(options.structuredContent?.members).toEqual(expect.arrayContaining([expect.objectContaining({ id: "42" })]));
    const memberSearch = await searchGitLabProjectMembers(gitlabContext, { projectId: "7", query: "yangting" });
    expect(memberSearch.structuredContent).toMatchObject({ query: "yangting", total: 1, matches: [{ id: "43", username: "yangting" }] });
    const invalid = await createGitLabMergeRequest(gitlabContext, { ...createInput, title: "" });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("请填写 Merge Request 标题");
    expect(calls).toEqual([]);

    const created = await createGitLabMergeRequest(gitlabContext, createInput);
    const updated = await updateGitLabMergeRequest(gitlabContext, { projectId: "7", mrIid: "26", title: "Updated MR" });
    const merged = await mergeGitLabMergeRequest(gitlabContext, { projectId: "7", mrIid: "26", sha: "head-sha" });
    const note = await createGitLabMergeRequestNote(gitlabContext, { projectId: "7", mrIid: "26", body: "请关注这个改动" });
    const jobs = await getGitLabPipelineJobs(gitlabContext, { projectId: "7", pipelineId: "321" });
    const retried = await retryGitLabPipeline(gitlabContext, { projectId: "7", pipelineId: "321" });
    const canceled = await cancelGitLabPipeline(gitlabContext, { projectId: "7", pipelineId: "321" });

    expect(created.structuredContent).toMatchObject({ created: true, mergeRequest: { iid: "26" } });
    expect(updated.structuredContent).toMatchObject({ updated: true, mergeRequest: { title: "Updated MR" } });
    expect(merged.structuredContent).toMatchObject({ merged: true, mergeRequest: { state: "merged" } });
    expect(note.structuredContent).toMatchObject({ created: true, note: { body: "请关注这个改动" } });
    expect(jobs.structuredContent).toMatchObject({ pipelineId: "321", jobs: [{ name: "test", failureReason: "assertion failed" }] });
    expect(retried.structuredContent).toMatchObject({ action: "retry", pipeline: { status: "running" } });
    expect(canceled.structuredContent).toMatchObject({ action: "cancel", pipeline: { status: "canceled" } });
    expect(calls).toEqual(["create:feature/context", "update:Updated MR", "merge", "note:请关注这个改动", "retry", "cancel"]);
  });

  it("turns Jira credential failures into a connection card", async () => {
    const jira = {
      async getCurrentUser() { throw new JiraApiError("Jira API request failed with 401", { status: 401 }); },
      async listIssues() { throw new JiraApiError("Jira API request failed with 403", { status: 403 }); },
      async getIssue() { throw new Error("not used"); },
      async getTransitions() { throw new Error("not used"); },
      async getCreateIssueOptions() { throw new Error("not used"); },
      async getCreateIssueSupportingOptions() { throw new Error("not used"); },
      async createIssue() { throw new Error("not used"); },
    };
    const jiraContext = { ...context, jira, jiraConfigured: () => true };

    const identity = await getJiraCurrentUser(jiraContext);
    expect(identity.isError).not.toBe(true);
    expect(identity.structuredContent?.authRequired).toMatchObject({ provider: "jira", actionPath: "/jira-workbench" });

    const issues = await listJiraIssues(jiraContext, { scope: "assigned_to_me", state: "todo", page: 1, perPage: 10 });
    expect(issues.isError).not.toBe(true);
    expect(issues.structuredContent?.authRequired).toMatchObject({ provider: "jira", actionPath: "/jira-workbench" });
  });

  it("turns an unauthorized GitLab identity into a connection card instead of a raw API error", async () => {
    const activity = await getGitLabCommitActivity({
      ...context,
      gitlabWorkbench: async () => ({
        async getCurrentUser() {
          throw new GitLabApiError("GitLab API request failed with 401", { status: 401 });
        },
        async listProjects() { return []; },
        async listRepositoryCommits() { return []; },
      }),
    }, { since: "2026-08-17", until: "2026-08-24" });

    expect(activity.isError).not.toBe(true);
    expect(activity.structuredContent?.authRequired).toMatchObject({ kind: "auth_required", provider: "gitlab", actionPath: "/gitlab-workbench" });
  });

  it("keeps a partial activity result when one project commit endpoint returns 404", async () => {
    const projects = [
      { id: "7", name: "Available", path: "available", pathWithNamespace: "group/available", nameWithNamespace: "Group / Available", webUrl: null, defaultBranch: "main", visibility: "private", lastActivityAt: null, avatarUrl: null },
      { id: "8", name: "Unavailable", path: "unavailable", pathWithNamespace: "group/unavailable", nameWithNamespace: "Group / Unavailable", webUrl: null, defaultBranch: "main", visibility: "private", lastActivityAt: null, avatarUrl: null },
    ];
    const activity = await getGitLabCommitActivity({
      ...context,
      gitlabWorkbench: async () => ({
        async getCurrentUser() { return { id: "42", username: "pilot", name: "Pilot" }; },
        async listProjects() { return projects; },
        async listRepositoryCommits(projectId) {
          if (projectId === "8") throw new GitLabApiError("GitLab API request failed with 404", { status: 404 });
          return [{ id: "sha-available", shortId: "sha-available", title: "Available commit", message: "Available commit", authorName: "Pilot", authorEmail: "pilot@example.com", authoredAt: "2026-08-18T10:00:00Z", committedAt: "2026-08-18T10:00:00Z", webUrl: null }];
        },
      }),
    }, { since: "2026-08-17", until: "2026-08-24" });

    expect(activity.isError).not.toBe(true);
    expect(activity.structuredContent).toMatchObject({
      projectSource: "user_membership_projects",
      totalCommits: 1,
      skippedProjects: 1,
      truncated: true,
      completeness: { projectsComplete: true, commitsComplete: false },
    });
  });

  it("collects commits across accessible repositories for an explicit range", async () => {
    const activity = await getGitLabCommitActivity({
      ...context,
      gitlabWorkbench: async () => ({
        async getCurrentUser() { return { username: "pilot", name: "Pilot" }; },
        async listProjects() { return [{ id: "7", name: "Project", path: "project", pathWithNamespace: "group/project", nameWithNamespace: "Group / Project", webUrl: null, defaultBranch: "main", visibility: "private", lastActivityAt: null, avatarUrl: null }]; },
        async listRepositoryCommits() { return [{ id: "sha-1", shortId: "sha-1", title: "Improve assistant context", message: "Improve assistant context", authorName: "Pilot", authorEmail: "pilot@example.com", authoredAt: "2026-08-17T10:00:00Z", committedAt: "2026-08-17T10:00:00Z", webUrl: "https://gitlab.invalid/group/project/-/commit/sha-1" }]; },
      }),
    }, { since: "2026-08-17", until: "2026-08-24" });
    expect(activity.structuredContent).toMatchObject({ provider: "gitlab", totalCommits: 1, repositoriesWithActivity: 1, commits: [{ projectPath: "group/project", title: "Improve assistant context" }] });
  });

  it("uses the user's contributed projects, paginates commits, and matches commit email", async () => {
    const project = { id: "7", name: "Project", path: "project", pathWithNamespace: "group/project", nameWithNamespace: "Group / Project", webUrl: null, defaultBranch: "main", visibility: "private", lastActivityAt: null, avatarUrl: null };
    const activity = await getGitLabCommitActivity({
      ...context,
      gitlabWorkbench: async () => ({
        async getCurrentUser() {
          return { id: "42", username: "pilot", name: "Pilot", email: "pilot@example.com", commit_email: "pilot@users.noreply.gitlab.com" };
        },
        async listContributedProjects(userId) {
          expect(userId).toBe("42");
          return [project];
        },
        async listRepositoryCommits(_projectId, query) {
          expect(query.author).toBeUndefined();
          expect(query.all).toBe(true);
          if (query.page === 1) {
            return Array.from({ length: 100 }, (_, index) => ({
              id: `sha-${index}`,
              shortId: `sha-${index}`,
              title: `Commit ${index}`,
              message: `Commit ${index}`,
              authorName: "GitLab Display Name",
              authorEmail: "pilot@users.noreply.gitlab.com",
              authoredAt: "2026-08-17T10:00:00Z",
              committedAt: "2026-08-17T10:00:00Z",
              webUrl: null,
            }));
          }
          return [{
            id: "sha-100",
            shortId: "sha-100",
            title: "Final commit",
            message: "Final commit",
            authorName: "Pilot",
            authorEmail: "pilot@example.com",
            authoredAt: "2026-08-18T10:00:00Z",
            committedAt: "2026-08-18T10:00:00Z",
            webUrl: null,
          }];
        },
      }),
    }, { since: "2026-08-17", until: "2026-08-24" });

    expect(activity.structuredContent).toMatchObject({
      projectSource: "user_contributed_projects",
      repositoriesScanned: 1,
      repositoriesWithActivity: 1,
      totalCommits: 101,
      returnedCommitCount: 40,
      truncated: false,
      detailsTruncated: true,
      completeness: { projectsComplete: true, commitsComplete: true, detailedCommitsComplete: false },
    });
    expect(activity.structuredContent?.commits).toHaveLength(40);
  });

  it("supports explicit time ranges through atomic GitLab commit tools", async () => {
    const project = { id: "7", name: "Project", path: "project", pathWithNamespace: "group/project", nameWithNamespace: "Group / Project", webUrl: "https://gitlab.invalid/group/project", defaultBranch: "main", visibility: "private", lastActivityAt: null, avatarUrl: null };
    const requests: Array<{ page: number; all?: boolean; since?: string; until?: string }> = [];
    const client = {
      async getCurrentUser() { return { id: "42", username: "pilot", name: "Pilot" }; },
      async listContributedProjects() { return [project]; },
      async listRepositoryCommits(_projectId: string, query: { page: number; all?: boolean; since?: string; until?: string }) {
        requests.push(query);
        return query.page === 1 ? [{ id: "sha-1", shortId: "sha-1", title: "Explicit range commit", message: "Explicit range commit", authorName: "Pilot", authorEmail: "pilot@example.com", authoredAt: "2026-08-03T10:00:00Z", committedAt: "2026-08-03T10:00:00Z", webUrl: project.webUrl + "/-/commit/sha-1" }] : [];
      },
    };
    const contextWithClient = { ...context, gitlabWorkbench: async () => client };

    const projects = await listMyGitLabContributedProjects(contextWithClient);
    const activity = await getGitLabCommitActivity(contextWithClient, { since: "2026-08-01", until: "2026-08-10" });
    const page = await listGitLabProjectCommits(contextWithClient, { projectId: "7", since: "2026-08-01", until: "2026-08-10", page: 1, perPage: 50 });

    expect(projects.structuredContent).toMatchObject({ scope: "current_user_contributed_projects", total: 1 });
    expect(activity.structuredContent).toMatchObject({ period: { since: "2026-08-01", until: "2026-08-10" }, totalCommits: 1 });
    expect(page.structuredContent).toMatchObject({ scope: "project_commits", projectId: "7", hasNextPage: false, commits: [{ shortSha: "sha-1" }] });
    expect(requests).toEqual([
      { since: "2026-08-01", until: "2026-08-10", all: true, page: 1, perPage: 100 },
      { since: "2026-08-01", until: "2026-08-10", author: undefined, all: true, page: 1, perPage: 50 },
    ]);
  });
});
