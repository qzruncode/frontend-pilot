import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { GitLabClientPort } from "../src/gitlab-client.js";
import type { GitLabOAuthServicePort } from "../src/gitlab-oauth.js";
import type { GitLabCreateMergeRequestInput, GitLabMergeMergeRequestInput, GitLabUpdateMergeRequestInput } from "../src/contracts.js";
import type { GitLabMergeRequestCreateOptions, GitLabMergeRequestDetails, GitLabMergeRequestListQuery } from "../src/gitlab-workbench.js";
import { config, service } from "./app-fixtures.js";

const pipeline = {
  id: "321",
  status: "failed",
  ref: "feature/review",
  sha: "head-2",
  webUrl: "https://gitlab.example.com/pipelines/321",
  source: "merge_request_event",
  createdAt: "2026-08-19T01:00:00Z",
  updatedAt: "2026-08-19T01:10:00Z",
  duration: 42,
  coverage: 88.5,
};

const detail: GitLabMergeRequestDetails = {
  id: "1002",
  iid: "2",
  projectId: "7",
  projectPath: "group/project",
  title: "Add GitLab workbench",
  description: "description",
  state: "opened",
  draft: false,
  webUrl: "https://gitlab.example.com/group/project/-/merge_requests/2",
  createdAt: "2026-08-18T01:00:00Z",
  updatedAt: "2026-08-19T01:10:00Z",
  sourceBranch: "feature/review",
  targetBranch: "main",
  headSha: "head-2",
  author: { id: "9", username: "reviewer", name: "Review User", webUrl: null, avatarUrl: null },
  assignees: [],
  reviewers: [],
  milestone: null,
  labels: ["frontend"],
  pipeline,
  changes: [{ oldPath: null, newPath: "src/workbench.ts", diff: "@@", changeType: "added" }],
  notes: [],
  pipelines: [pipeline],
};

function rulesStore() {
  const profile = { name: "default", displayName: "默认 profile", isDefault: true, rules: [] };
  return {
    async list() { return [profile]; },
    async readForProject() { return profile; },
    async createProfile() { return profile; },
    async deleteProfile() {},
    async createRule() { return profile; },
    async updateRule() { return profile; },
    async deleteRule() { return profile; },
    async reorderRules() { return profile; },
  };
}

describe("GitLab workbench API", () => {
  it("serves overview, MR detail, project config, pipeline actions, comments, and review actions", async () => {
    const listQueries: GitLabMergeRequestListQuery[] = [];
    let createdInput: GitLabCreateMergeRequestInput | null = null;
    let mergeInput: GitLabMergeMergeRequestInput | null = null;
    const gitlab = {
      async getMergeRequest() { return { diff_refs: { head_sha: detail.headSha }, target_branch: detail.targetBranch }; },
      async getReviewSnapshot() { return { mergeRequest: { diff_refs: { head_sha: detail.headSha } }, changes: [] }; },
      async findNoteByMarker() { return null; },
      async createNote(_projectId: string, _iid: string, body: string) { return { id: 11, body }; },
      async updateNote() { return { id: 11 }; },
      async getCurrentUser() { return { id: 9, username: "reviewer", name: "Review User" }; },
      async getRecentPush() {
        return {
          project: { id: "7", name: "Project", path: "project", pathWithNamespace: "group/project", nameWithNamespace: "Group / Project", webUrl: null, defaultBranch: "main", visibility: "private", lastActivityAt: null, avatarUrl: null },
          sourceBranch: "feature/new-mr",
          commitSha: "head-3",
          commitTitle: "Add a new MR",
          createdAt: "2026-08-31T01:00:00Z",
        };
      },
      async getMergeRequestCreateOptions(): Promise<GitLabMergeRequestCreateOptions> {
        return {
          currentUser: { id: "9", username: "reviewer", name: "Review User", webUrl: null, avatarUrl: null },
          branches: [{ name: "feature/new-mr", isDefault: false, isProtected: false, commitSha: "head-3", commitTitle: "Add a new MR", commitMessage: "Add a new MR\n\nDescription from commit" }, { name: "main", isDefault: true, isProtected: true, commitSha: "main-1", commitTitle: "Main", commitMessage: "Main" }],
          members: [{ id: "9", username: "reviewer", name: "Review User", webUrl: null, avatarUrl: null }],
          milestones: [{ id: "4", title: "Q3", state: "active", dueDate: null }],
          labels: [{ id: "8", name: "frontend", color: "#42a5f5", description: null }],
        };
      },
      async createMergeRequest(input: GitLabCreateMergeRequestInput) { createdInput = input; return { ...detail, iid: "21", title: input.title }; },
      async updateMergeRequest(_projectId: string, _iid: string, input: GitLabUpdateMergeRequestInput) { return { ...detail, title: input.title ?? detail.title, description: input.description ?? detail.description, targetBranch: input.targetBranch ?? detail.targetBranch, labels: input.labels ?? detail.labels }; },
      async mergeMergeRequest(_projectId: string, _iid: string, input: GitLabMergeMergeRequestInput) { mergeInput = input; return { ...detail, state: "merged" }; },
      async listMergeRequests(query: GitLabMergeRequestListQuery) { listQueries.push(query); return [detail]; },
      async getMergeRequestDetails() { return detail; },
      async listPipelines() { return [pipeline]; },
      async listPipelineJobs() { return [{ id: "654", name: "test", stage: "test", status: "failed", webUrl: null, createdAt: null, startedAt: null, finishedAt: null, duration: null, allowFailure: false, failureReason: null }]; },
      async retryPipeline() { return { ...pipeline, status: "running" }; },
      async cancelPipeline() { return { ...pipeline, status: "canceled" }; },
      async listProjects() { return [{ id: "7", name: "Project", path: "project", pathWithNamespace: "group/project", nameWithNamespace: "Group / Project", webUrl: null, defaultBranch: "main", visibility: "private", lastActivityAt: null, avatarUrl: null }]; },
    };
    const app = await buildApp({ config, reviewService: service(), gitlab, reviewRulesStore: rulesStore() });
    const headers = { authorization: "Bearer trigger-token" };

    expect((await app.inject({ method: "GET", url: "/api/v1/gitlab/overview", headers })).statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/v1/gitlab/merge-requests?scope=assigned_to_me&state=opened", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().mergeRequests[0]).toMatchObject({ projectId: "7", iid: "2" });
    const reviewRequested = await app.inject({ method: "GET", url: "/api/v1/gitlab/merge-requests?scope=review_requested&state=opened", headers });
    expect(reviewRequested.statusCode).toBe(200);
    expect(listQueries[listQueries.length - 1]).toMatchObject({ scope: "review_requested", reviewerUsername: "reviewer" });
    const mr = await app.inject({ method: "GET", url: "/api/v1/gitlab/merge-requests/7/2", headers });
    expect(mr.statusCode).toBe(200);
    expect(mr.json()).toMatchObject({ title: detail.title, pipelines: [{ id: "321" }] });
    const projects = await app.inject({ method: "GET", url: "/api/v1/gitlab/projects", headers });
    expect(projects.statusCode).toBe(200);
    expect(projects.json().projects[0]).toMatchObject({ pathWithNamespace: "group/project", customReviewProfile: false });
    const createOptions = await app.inject({ method: "GET", url: "/api/v1/gitlab/projects/7/merge-request-options", headers });
    expect(createOptions.statusCode).toBe(200);
    expect(createOptions.json()).toMatchObject({ currentUser: { username: "reviewer" }, branches: [{ name: "feature/new-mr" }, { name: "main" }] });
    const recentPush = await app.inject({ method: "GET", url: "/api/v1/gitlab/recent-push", headers });
    expect(recentPush.statusCode).toBe(200);
    expect(recentPush.json()).toMatchObject({ recentPush: { project: { id: "7", defaultBranch: "main" }, sourceBranch: "feature/new-mr", commitTitle: "Add a new MR" } });
    const created = await app.inject({ method: "POST", url: "/api/v1/gitlab/merge-requests", headers, payload: {
      targetProjectId: "7",
      sourceProjectId: "7",
      sourceBranch: "feature/new-mr",
      targetBranch: "main",
      title: "Add a new MR",
      description: "Description",
      assigneeIds: ["9"],
      reviewerIds: [],
      milestoneId: "4",
      labels: ["frontend"],
      removeSourceBranch: true,
      squash: false,
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ iid: "21", title: "Add a new MR" });
    expect(createdInput).toMatchObject({ targetProjectId: "7", sourceBranch: "feature/new-mr", milestoneId: "4" });
    const updated = await app.inject({ method: "PUT", url: "/api/v1/gitlab/merge-requests/7/2", headers, payload: {
      targetBranch: "main",
      title: "Updated GitLab MR",
      description: "Updated description",
      assigneeIds: ["9"],
      reviewerIds: ["9"],
      milestoneId: null,
      labels: [],
    } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ title: "Updated GitLab MR", description: "Updated description" });
    const merged = await app.inject({ method: "PUT", url: "/api/v1/gitlab/merge-requests/7/2/merge", headers, payload: {
      sha: detail.headSha,
      mergeWhenPipelineSucceeds: false,
      shouldRemoveSourceBranch: true,
      squash: true,
    } });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({ state: "merged" });
    expect(mergeInput).toEqual({ sha: detail.headSha, mergeWhenPipelineSucceeds: false, shouldRemoveSourceBranch: true, squash: true });
    const invalidCreate = await app.inject({ method: "POST", url: "/api/v1/gitlab/merge-requests", headers, payload: {
      targetProjectId: "7",
      sourceProjectId: "7",
      sourceBranch: "feature/new-mr",
      targetBranch: "main",
      title: "",
    } });
    expect(invalidCreate.statusCode).toBe(400);
    const pipelines = await app.inject({ method: "GET", url: "/api/v1/gitlab/projects/7/pipelines", headers });
    expect(pipelines.statusCode).toBe(200);
    const jobs = await app.inject({ method: "GET", url: "/api/v1/gitlab/projects/7/pipelines/321/jobs", headers });
    expect(jobs.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/gitlab/projects/7/pipelines/321/retry", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/gitlab/projects/7/pipelines/321/cancel", headers })).statusCode).toBe(200);
    const note = await app.inject({ method: "POST", url: "/api/v1/gitlab/merge-requests/7/2/notes", headers, payload: { body: "Please take a look" } });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toMatchObject({ note: { id: "11", body: "Please take a look" } });
    const review = await app.inject({ method: "POST", url: "/api/v1/gitlab/merge-requests/7/2/review", headers });
    expect(review.statusCode).toBe(202);
    expect(review.json()).toMatchObject({ accepted: true, job: { source: "gitlab-workbench", projectId: "7", mrIid: "2" } });

    await app.close();
  });

  it("uses the OAuth user's GitLab client for a browser workbench session", async () => {
    let oauthCreatedInput: GitLabCreateMergeRequestInput | null = null;
    const userClient: GitLabClientPort = {
      async getMergeRequest() { return { diff_refs: { head_sha: detail.headSha }, target_branch: detail.targetBranch }; },
      async getReviewSnapshot() { return { mergeRequest: { diff_refs: { head_sha: detail.headSha } }, changes: [] }; },
      async findNoteByMarker() { return null; },
      async createNote() { return { id: 11, body: "" }; },
      async updateNote() { return { id: 11 }; },
      async getCurrentUser() { return { id: 31, username: "personal-user", name: "Personal User" }; },
      async getMergeRequestCreateOptions(): Promise<GitLabMergeRequestCreateOptions> {
        return {
          currentUser: { id: "31", username: "personal-user", name: "Personal User", webUrl: null, avatarUrl: null },
          branches: [{ name: "feature/personal", isDefault: false, isProtected: false, commitSha: "head-4", commitTitle: "Personal MR", commitMessage: "Personal MR\n\nPersonal description" }, { name: "main", isDefault: true, isProtected: true, commitSha: "main-1", commitTitle: "Main", commitMessage: "Main" }],
          members: [],
          milestones: [],
          labels: [],
        };
      },
      async createMergeRequest(input: GitLabCreateMergeRequestInput) {
        oauthCreatedInput = input;
        return { ...detail, iid: "22", title: input.title };
      },
      async listMergeRequests() { return []; },
    };
    const requestedSessionKeys: string[] = [];
    const oauth: GitLabOAuthServicePort = {
      status() { return { configured: true, connected: true, identity: { id: "31", username: "personal-user", name: "Personal User", webUrl: null, avatarUrl: null } }; },
      authorizationUrl() { return "https://gitblue.example/oauth/authorize"; },
      async complete() { return { id: "31", username: "personal-user", name: "Personal User", webUrl: null, avatarUrl: null }; },
      disconnect() {},
      async getClient(sessionKey) {
        requestedSessionKeys.push(sessionKey);
        return userClient;
      },
    };
    const app = await buildApp({ config, reviewService: service(), gitlabOAuthService: oauth });
    try {
      const session = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: config.webOrigin },
        payload: { username: config.loginUsername, password: config.loginPassword },
      });
      const setCookie = session.headers["set-cookie"];
      const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const overview = await app.inject({
        method: "GET",
        url: "/api/v1/gitlab/overview",
        headers: { cookie: cookie?.split(";", 1)[0] ?? "" },
      });

      expect(overview.statusCode).toBe(200);
      expect(overview.json().user).toMatchObject({ username: "personal-user", name: "Personal User" });
      const createOptions = await app.inject({
        method: "GET",
        url: "/api/v1/gitlab/projects/7/merge-request-options",
        headers: { cookie: cookie?.split(";", 1)[0] ?? "" },
      });
      expect(createOptions.statusCode).toBe(200);
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/gitlab/merge-requests",
        headers: { cookie: cookie?.split(";", 1)[0] ?? "" },
        payload: {
          targetProjectId: "7",
          sourceProjectId: "7",
          sourceBranch: "feature/personal",
          targetBranch: "main",
          title: "Personal MR",
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ iid: "22", title: "Personal MR" });
      expect(oauthCreatedInput).toMatchObject({ sourceBranch: "feature/personal", targetProjectId: "7" });
      expect(requestedSessionKeys).toHaveLength(3);
      expect(requestedSessionKeys.every((key) => key.startsWith("product:"))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
