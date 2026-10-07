import { describe, expect, it, vi } from "vitest";
import { GitLabApiError, GitLabClient, InvalidMergeRequestUrlError, parseMergeRequestUrl } from "../src/gitlab-client.js";

it("looks up an existing AI MR by project and exact source branch, including closed and merged requests", async () => {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/api/v4/projects/42/merge_requests");
    expect(url.searchParams.get("source_branch")).toBe("ai/inspection-test-42");
    expect(url.searchParams.get("state")).toBe("all");
    return new Response("[]", { status: 200 });
  });
  const client = new GitLabClient({ baseUrl: "https://gitlab.example/api/v4", token: "fixture", fetchImpl });
  await expect(client.listMergeRequests({ projectId: "42", sourceBranch: "ai/inspection-test-42", state: "all", scope: "all", page: 1, perPage: 100 })).resolves.toEqual([]);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

describe("GitLab MR URL resolution", () => {
  it("parses nested GitLab project paths", () => {
    expect(parseMergeRequestUrl("https://gitlab.example.com/aip/ui/so-chart/-/merge_requests/17"))
      .toEqual({ projectPath: "aip/ui/so-chart", mrIid: "17" });
  });

  it("rejects URLs without an MR path", () => {
    expect(() => parseMergeRequestUrl("https://gitlab.example.com/aip/ui/so-chart"))
      .toThrow(InvalidMergeRequestUrlError);
  });

  it("looks up the project ID and current MR metadata", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input));
      expect(new Headers(init?.headers).get("private-token")).toBe("gitlab-token");
      if (String(input).endsWith("/projects/aip%2Fui%2Fso-chart")) {
        return new Response(JSON.stringify({ id: 16534, path_with_namespace: "aip/ui/so-chart" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        target_branch: "dev",
        sha: "head-18",
        diff_refs: { head_sha: "head-17" },
      }), { status: 200 });
    });
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com/api/v4",
      token: "gitlab-token",
      fetchImpl,
    });

    await expect(client.resolveMergeRequestUrl("https://gitlab.example.com/aip/ui/so-chart/-/merge_requests/17"))
      .resolves.toEqual({
        projectId: "16534",
        projectPath: "aip/ui/so-chart",
        mrIid: "17",
        headSha: "head-18",
        targetBranch: "dev",
      });
    expect(requests).toEqual([
      "https://gitlab.example.com/api/v4/projects/aip%2Fui%2Fso-chart",
      "https://gitlab.example.com/api/v4/projects/16534/merge_requests/17",
    ]);
  });

  it("checks the current GitLab identity", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://gitlab.example.com/api/v4/user");
      expect(new Headers(init?.headers).get("private-token")).toBe("gitlab-token");
      return new Response(JSON.stringify({ id: 9, username: "review-bot", name: "Review Bot", email: "review@example.com", commit_email: "review@users.noreply.gitlab.com" }), { status: 200 });
    });
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com/api/v4",
      token: "gitlab-token",
      fetchImpl,
    });

    await expect(client.getCurrentUser()).resolves.toEqual({ id: 9, username: "review-bot", name: "Review Bot", email: "review@example.com", commit_email: "review@users.noreply.gitlab.com" });
  });

  it("retrieves a file blame range with the author commit", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify([{
        commit: { author_name: "Line Owner", author_email: "line@example.com" },
        lines: ["const value = 1;"],
      }]), { status: 200 });
    });
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com/api/v4",
      token: "gitlab-token",
      fetchImpl,
    });

    await expect(client.getRepositoryFileBlame("7", "src/app.ts", "head-2", 42)).resolves.toEqual([{
      authorName: "Line Owner",
      authorEmail: "line@example.com",
      lines: ["const value = 1;"],
    }]);
    expect(requests[0]).toContain("range%5Bstart%5D=42");
    expect(requests[0]).toContain("range%5Bend%5D=42");
  });

  it("retrieves file metadata at an exact ref", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ file_path: "src/app.ts", blob_id: "blob-17", commit_id: "merge-17" }), { status: 200 });
    });
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com/api/v4",
      token: "gitlab-token",
      fetchImpl,
    });

    await expect(client.getRepositoryFile("7", "src/app.ts", "merge-17")).resolves.toEqual({
      path: "src/app.ts", blobId: "blob-17", commitId: "merge-17",
    });
    expect(requests[0]).toContain("/projects/7/repository/files/src%2Fapp.ts");
    expect(requests[0]).toContain("ref=merge-17");
  });

  it("finds the latest eligible recent push for merge request creation", async () => {
    const now = Date.now();
    const latestPush = new Date(now - 2 * 60 * 1_000).toISOString();
    const activeMergeRequestPush = new Date(now - 5 * 60 * 1_000).toISOString();
    const eligiblePush = new Date(now - 8 * 60 * 1_000).toISOString();
    const project = (id: number, name: string, path: string, defaultBranch: string) => ({
      id,
      name,
      path,
      path_with_namespace: `group/${path}`,
      name_with_namespace: `Group / ${name}`,
      default_branch: defaultBranch,
      web_url: `https://gitlab.example.com/group/${path}`,
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("private-token")).toBe("gitlab-token");
      if (url.pathname === "/api/v4/events") {
        return new Response(JSON.stringify([
          { action_name: "pushed to", project_id: 7, created_at: latestPush, push_data: { ref_type: "branch", ref: "main", commit_to: "main-sha", commit_title: "Update main" } },
          { action_name: "pushed to", project_id: 7, created_at: activeMergeRequestPush, push_data: { ref_type: "branch", ref: "feature-active", commit_to: "active-sha", commit_title: "Already in review" } },
          { action_name: "pushed new", project_id: 8, created_at: eligiblePush, push_data: { ref_type: "branch", ref: "feature-eligible", commit_to: "eligible-sha", commit_title: "Ready for review" } },
        ]), { status: 200 });
      }
      if (url.pathname === "/api/v4/projects/7") return new Response(JSON.stringify(project(7, "Project", "project", "main")), { status: 200 });
      if (url.pathname === "/api/v4/projects/8") return new Response(JSON.stringify(project(8, "Eligible Project", "eligible-project", "dev")), { status: 200 });
      if (url.pathname === "/api/v4/projects/7/repository/branches/feature-active") return new Response(JSON.stringify({ name: "feature-active", commit: { id: "active-sha", title: "Already in review" } }), { status: 200 });
      if (url.pathname === "/api/v4/projects/8/repository/branches/feature-eligible") return new Response(JSON.stringify({ name: "feature-eligible", commit: { id: "eligible-sha", title: "Ready for review" } }), { status: 200 });
      if (url.pathname === "/api/v4/projects/7/merge_requests") return new Response(JSON.stringify([{ id: 101, iid: 1 }]), { status: 200 });
      if (url.pathname === "/api/v4/projects/8/merge_requests") return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected GitLab request: ${url}`);
    });
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com/api/v4",
      token: "gitlab-token",
      fetchImpl,
    });

    await expect(client.getRecentPush()).resolves.toEqual({
      project: {
        id: "8",
        name: "Eligible Project",
        path: "eligible-project",
        pathWithNamespace: "group/eligible-project",
        nameWithNamespace: "Group / Eligible Project",
        webUrl: "https://gitlab.example.com/group/eligible-project",
        defaultBranch: "dev",
        visibility: null,
        lastActivityAt: null,
        avatarUrl: null,
      },
      sourceBranch: "feature-eligible",
      commitSha: "eligible-sha",
      commitTitle: "Ready for review",
      createdAt: eligiblePush,
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://gitlab.example.com/api/v4/events?action=pushed&sort=desc&per_page=100", expect.anything());
  });

  it("retrieves the current CI job with JOB-TOKEN instead of the service token", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://gitlab.example.com/api/v4/job");
      const headers = new Headers(init?.headers);
      expect(headers.get("job-token")).toBe("ci-token");
      expect(headers.get("private-token")).toBeNull();
      return new Response(JSON.stringify({
        id: 321,
        commit: { id: "head-1" },
        pipeline: { id: 654, project_id: 16534, source: "merge_request_event" },
      }), { status: 200 });
    });
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com/api/v4",
      token: "service-token",
      fetchImpl,
    });

    await expect(client.getJobByToken("ci-token")).resolves.toMatchObject({
      id: 321,
      commit: { id: "head-1" },
      pipeline: { id: 654, project_id: 16534, source: "merge_request_event" },
    });
  });

  it("rejects malformed successful GitLab responses", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ username: 42 }), { status: 200 }));
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com/api/v4",
      token: "gitlab-token",
      fetchImpl,
    });

    await expect(client.getCurrentUser()).rejects.toMatchObject({
      name: "GitLabApiError",
      status: 200,
      message: "GitLab API returned an invalid response",
    } satisfies Partial<GitLabApiError>);
  });

  it("preserves GitLab merge failure details for the workbench", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/merge_requests/26") && init?.method === "PUT") {
        return new Response(JSON.stringify({ id: 26, iid: 26, state: "opened" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        message: { base: ["Squashing failed: Squash the commits locally, resolve any conflicts, then push the branch. Try again."] },
      }), { status: 405 });
    });
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com/api/v4",
      token: "gitlab-token",
      fetchImpl,
    });

    await expect(client.mergeMergeRequest("7", "26", {
      mergeWhenPipelineSucceeds: false,
      shouldRemoveSourceBranch: true,
      squash: true,
    })).rejects.toMatchObject({
      name: "GitLabApiError",
      status: 405,
      message: "GitLab API request failed with 405: Squashing failed: Squash the commits locally, resolve any conflicts, then push the branch. Try again.",
    } satisfies Partial<GitLabApiError>);
  });

  it("loads and normalizes workbench merge request, pipeline, job, and project data", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const pipeline = {
      id: 321,
      status: "failed",
      ref: "feature/review",
      sha: "head-2",
      web_url: "https://gitlab.example.com/pipelines/321",
      source: "merge_request_event",
      created_at: "2026-08-19T01:00:00Z",
      updated_at: "2026-08-19T01:10:00Z",
      duration: 42,
      coverage: 88.5,
    };
    const mergeRequest = {
      id: 1002,
      iid: 2,
      project_id: 7,
      title: "Add GitLab workbench",
      description: "description",
      state: "opened",
      draft: false,
      web_url: "https://gitlab.example.com/group/project/-/merge_requests/2",
      created_at: "2026-08-18T01:00:00Z",
      updated_at: "2026-08-19T01:10:00Z",
      source_branch: "feature/review",
      target_branch: "main",
      sha: "head-2",
      diff_refs: { head_sha: "head-2", base_sha: "base-2", start_sha: "target-before-2" },
      merge_commit_sha: "merge-2",
      squash_commit_sha: null,
      merged_at: null,
      merge_error: "Squashing failed: resolve locally",
      author: { id: 9, username: "reviewer", name: "Review User", web_url: "https://gitlab.example.com/reviewer" },
      assignees: [],
      reviewers: [],
      labels: ["frontend"],
      source_project: { path_with_namespace: "group/project" },
      pipeline,
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url: `${url.pathname}${url.search}`, method: init?.method ?? "GET" });
      if (url.pathname.endsWith("/merge_requests/2/changes")) {
        return new Response(JSON.stringify({ changes: [{ old_path: "old.ts", new_path: "new.ts", diff: "@@", renamed_file: true }] }), { status: 200 });
      }
      if (url.pathname.endsWith("/merge_requests/2/notes")) {
        return new Response(JSON.stringify([{ id: 11, body: "Looks good", author: { username: "reviewer", name: "Review User" }, created_at: "2026-08-19T01:20:00Z", system: false }]), { status: 200 });
      }
      if (url.pathname.endsWith("/jobs/654/trace")) return new Response("review trace\n", { status: 200 });
      if (url.pathname.endsWith("/merge_requests/2/pipelines")) return new Response(JSON.stringify([pipeline]), { status: 200 });
      if (url.pathname.endsWith("/merge_requests/2")) return new Response(JSON.stringify(mergeRequest), { status: 200 });
      if (url.pathname.endsWith("/merge_requests")) return new Response(JSON.stringify([mergeRequest]), { status: 200 });
      if (url.pathname.endsWith("/pipelines/321/jobs")) return new Response(JSON.stringify([{ id: 654, name: "test", stage: "test", status: "failed", web_url: "https://gitlab.example.com/jobs/654" }]), { status: 200 });
      if (url.pathname.endsWith("/pipelines/321/retry")) return new Response(JSON.stringify({ ...pipeline, status: "running" }), { status: 200 });
      if (url.pathname.endsWith("/pipelines/321/cancel")) return new Response(JSON.stringify({ ...pipeline, status: "canceled" }), { status: 200 });
      if (url.pathname.endsWith("/pipelines")) return new Response(JSON.stringify([pipeline]), { status: 200 });
      if (url.pathname.endsWith("/repository/commits")) return new Response(JSON.stringify([{ id: "commit-1", short_id: "commit-1", title: "Add workbench context", message: "Add workbench context\n", author_name: "Review User", author_email: "review@example.com", authored_date: "2026-08-19T01:00:00Z", committed_date: "2026-08-19T01:01:00Z", web_url: "https://gitlab.example.com/group/project/-/commit/commit-1" }]), { status: 200 });
      if (url.pathname.endsWith("/contributed_projects")) return new Response(JSON.stringify([{ id: 7, name: "Project", path: "project", path_with_namespace: "group/project", name_with_namespace: "Group / Project", default_branch: "main", web_url: "https://gitlab.example.com/group/project" }]), { status: 200 });
      if (url.pathname.endsWith("/projects")) return new Response(JSON.stringify([{ id: 7, name: "Project", path: "project", path_with_namespace: "group/project", name_with_namespace: "Group / Project", default_branch: "main", web_url: "https://gitlab.example.com/group/project" }]), { status: 200 });
      throw new Error(`unexpected GitLab request: ${url}`);
    });
    const client = new GitLabClient({ baseUrl: "https://gitlab.example.com/api/v4", token: "gitlab-token", fetchImpl });

    await expect(client.listMergeRequests({ scope: "assigned_to_me", state: "opened", page: 1, perPage: 25 })).resolves.toMatchObject([{ projectId: "7", iid: "2", projectPath: "group/project", headSha: "head-2", mergeCommitSha: "merge-2", mergeBaseSha: "base-2" }]);
    await expect(client.listMergeRequests({ scope: "review_requested", reviewerUsername: "review-bot", state: "opened", page: 1, perPage: 25 })).resolves.toMatchObject([{ projectId: "7", iid: "2" }]);
    await expect(client.getMergeRequestDetails("7", "2")).resolves.toMatchObject({ projectId: "7", mergeError: "Squashing failed: resolve locally", changes: [{ changeType: "renamed" }], notes: [{ id: "11" }], pipelines: [{ id: "321" }] });
    await expect(client.listPipelines("7", { page: 1, perPage: 20, ref: "feature/review", status: "failed" })).resolves.toMatchObject([{ id: "321", status: "failed" }]);
    await expect(client.listPipelineJobs("7", "321")).resolves.toMatchObject([{ id: "654", name: "test", stage: "test" }]);
    await expect(client.getPipelineJobTrace("7", "654")).resolves.toBe("review trace\n");
    await expect(client.retryPipeline("7", "321")).resolves.toMatchObject({ id: "321", status: "running" });
    await expect(client.cancelPipeline("7", "321")).resolves.toMatchObject({ id: "321", status: "canceled" });
    await expect(client.listProjects({ page: 1, perPage: 30 })).resolves.toMatchObject([{ id: "7", pathWithNamespace: "group/project", defaultBranch: "main" }]);
    await expect(client.listContributedProjects("review-bot")).resolves.toMatchObject([{ id: "7", pathWithNamespace: "group/project" }]);
    await expect(client.listRepositoryCommits("7", { ref: "head-2", path: "src/app.ts", since: "2026-08-18T00:00:00Z", until: "2026-08-20T00:00:00Z", author: "Review User", all: true, page: 1, perPage: 20 })).resolves.toMatchObject([{ id: "commit-1", title: "Add workbench context", authorName: "Review User" }]);
    expect(requests.some((request) => request.url.includes("review_requests"))).toBe(false);
    expect(requests.some((request) => request.url.includes("scope=all") && request.url.includes("reviewer_username=review-bot"))).toBe(true);
    expect(requests.some((request) => request.url.includes("/users/review-bot/contributed_projects") && request.url.includes("order_by=last_activity_at"))).toBe(true);
    expect(requests.some((request) => request.url.includes("/merge_requests/2/notes") && request.url.includes("sort=desc") && request.url.includes("order_by=created_at"))).toBe(true);
    expect(requests.some((request) => request.url.includes("/repository/commits") && request.url.includes("all=true") && request.url.includes("ref_name=head-2") && request.url.includes("path=src%2Fapp.ts"))).toBe(true);
    expect(requests.every((request) => request.method === "GET" || request.url.includes("/retry") || request.url.includes("/cancel"))).toBe(true);
  });

  it("loads create options and creates a merge request with GitLab API fields", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url: `${url.pathname}${url.search}`, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
      if (url.pathname.endsWith("/user")) return new Response(JSON.stringify({ id: 9, username: "reviewer", name: "Review User" }), { status: 200 });
      if (url.pathname === "/api/v4/projects/7") return new Response(JSON.stringify({ id: 7, name: "Project", path: "project", path_with_namespace: "group/project", name_with_namespace: "Group / Project", default_branch: "dev", web_url: "https://gitlab.example.com/group/project" }), { status: 200 });
      if (url.pathname.endsWith("/repository/branches")) return new Response(JSON.stringify([
        { name: "feature/new-mr", default: false, protected: false, commit: { id: "feature-sha", title: "Add a new MR", message: "Add a new MR\n\nDescription from commit" } },
      ]), { status: 200 });
      if (url.pathname.endsWith("/repository/branches/dev")) return new Response(JSON.stringify({ name: "dev", default: false, protected: true, commit: { id: "dev-sha", title: "Latest dev", message: "Latest dev" } }), { status: 200 });
      if (url.pathname.endsWith("/members/all")) return new Response(JSON.stringify([{ id: 9, username: "reviewer", name: "Review User" }, { id: 10, username: "another", name: "Another User" }]), { status: 200 });
      if (url.pathname.endsWith("/milestones")) return new Response(JSON.stringify([{ id: 4, title: "Q3", state: "active", due_date: "2026-09-30" }]), { status: 200 });
      if (url.pathname.endsWith("/labels")) return new Response(JSON.stringify([{ id: 8, name: "frontend", color: "#42a5f5", description: "Frontend work" }]), { status: 200 });
      if (url.pathname.endsWith("/merge_requests/21/merge") && init?.method === "PUT") return new Response(JSON.stringify({
        id: 2001,
        iid: 21,
        project_id: 7,
        title: "Updated MR",
        description: "Updated description",
        state: "merged",
        web_url: "https://gitlab.example.com/group/project/-/merge_requests/21",
        source_branch: "feature/new-mr",
        target_branch: "main",
        sha: "feature-sha",
        author: { id: 9, username: "reviewer", name: "Review User" },
        assignees: [{ id: 9, username: "reviewer", name: "Review User" }],
        reviewers: [{ id: 9, username: "reviewer", name: "Review User" }],
        labels: [],
        milestone: null,
      }), { status: 200 });
      if (url.pathname.endsWith("/merge_requests/21") && init?.method === "PUT") return new Response(JSON.stringify({
        id: 2001,
        iid: 21,
        project_id: 7,
        title: "Updated MR",
        description: "Updated description",
        state: "opened",
        web_url: "https://gitlab.example.com/group/project/-/merge_requests/21",
        source_branch: "feature/new-mr",
        target_branch: "main",
        sha: "feature-sha",
        author: { id: 9, username: "reviewer", name: "Review User" },
        assignees: [{ id: 9, username: "reviewer", name: "Review User" }],
        reviewers: [{ id: 9, username: "reviewer", name: "Review User" }],
        labels: [],
        milestone: null,
      }), { status: 200 });
      if (url.pathname.endsWith("/merge_requests") && init?.method === "POST") return new Response(JSON.stringify({
        id: 2001,
        iid: 21,
        project_id: 7,
        title: "Add a new MR",
        description: "Description",
        state: "opened",
        web_url: "https://gitlab.example.com/group/project/-/merge_requests/21",
        source_branch: "feature/new-mr",
        target_branch: "dev",
        sha: "feature-sha",
        author: { id: 9, username: "reviewer", name: "Review User" },
        assignees: [{ id: 9, username: "reviewer", name: "Review User" }],
        reviewers: [{ id: 10, username: "another", name: "Another User" }],
        labels: ["frontend"],
      }), { status: 201 });
      throw new Error(`unexpected GitLab request: ${url}`);
    });
    const client = new GitLabClient({ baseUrl: "https://gitlab.example.com/api/v4", token: "gitlab-token", fetchImpl });

    await expect(client.getProject("7")).resolves.toMatchObject({ id: "7", pathWithNamespace: "group/project" });
    await expect(client.getMergeRequestCreateOptions("7")).resolves.toMatchObject({
      currentUser: { id: "9", username: "reviewer" },
      branches: [{ name: "dev", isDefault: true, commitMessage: "Latest dev" }, { name: "feature/new-mr", commitTitle: "Add a new MR", commitMessage: "Add a new MR\n\nDescription from commit" }],
      members: [{ id: "9" }, { id: "10" }],
      milestones: [{ id: "4", title: "Q3" }],
      labels: [{ id: "8", name: "frontend" }],
    });
    await expect(client.searchProjectMembers("7", "another")).resolves.toMatchObject([{ id: "9", username: "reviewer" }, { id: "10", username: "another" }]);
    expect(requests.some((request) => request.url.includes("/members/all") && request.url.includes("query=another"))).toBe(true);
    await expect(client.createMergeRequest({
      targetProjectId: "7",
      sourceProjectId: "7",
      sourceBranch: "feature/new-mr",
      targetBranch: "dev",
      title: "Add a new MR",
      description: "Description",
      assigneeIds: ["9"],
      reviewerIds: ["10", "9"],
      milestoneId: "4",
      labels: ["frontend"],
      removeSourceBranch: true,
      squash: false,
    })).resolves.toMatchObject({ iid: "21", projectId: "7", sourceBranch: "feature/new-mr" });

    const createRequest = requests.find((request) => request.method === "POST");
    expect(createRequest?.url).toBe("/api/v4/projects/7/merge_requests");
    expect(JSON.parse(createRequest?.body ?? "{}")).toEqual({
      source_branch: "feature/new-mr",
      target_branch: "dev",
      title: "Add a new MR",
      description: "Description",
      remove_source_branch: true,
      squash: false,
      assignee_ids: [9],
      reviewer_ids: [10, 9],
      milestone_id: 4,
      labels: "frontend",
    });

    await expect(client.updateMergeRequest("7", "21", {
      targetBranch: "main",
      title: "Updated MR",
      description: "Updated description",
      assigneeIds: ["9"],
      reviewerIds: ["9"],
      milestoneId: null,
      labels: [],
    })).resolves.toMatchObject({ iid: "21", title: "Updated MR", milestone: null });
    const updateRequest = requests.find((request) => request.method === "PUT");
    expect(updateRequest?.url).toBe("/api/v4/projects/7/merge_requests/21");
    expect(JSON.parse(updateRequest?.body ?? "{}")).toEqual({
      target_branch: "main",
      title: "Updated MR",
      description: "Updated description",
      assignee_ids: [9],
      reviewer_ids: [9],
      milestone_id: null,
      labels: "",
    });

    await expect(client.mergeMergeRequest("7", "21", {
      sha: "feature-sha",
      mergeWhenPipelineSucceeds: false,
      shouldRemoveSourceBranch: true,
      squash: true,
    })).resolves.toMatchObject({ iid: "21", state: "merged" });
    const mergeRequestCall = requests.find((request) => request.url === "/api/v4/projects/7/merge_requests/21/merge");
    expect(mergeRequestCall?.method).toBe("PUT");
    expect(JSON.parse(mergeRequestCall?.body ?? "{}")).toEqual({
      sha: "feature-sha",
      merge_when_pipeline_succeeds: false,
      should_remove_source_branch: true,
      squash: true,
    });
    const squashUpdateRequests = requests.filter((request) => request.url === "/api/v4/projects/7/merge_requests/21" && request.method === "PUT");
    expect(JSON.parse(squashUpdateRequests.at(-1)?.body ?? "{}")).toEqual({ squash: true });
  });

  it("does not treat an open MR with merge_error as a successful merge", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url: `${url.pathname}${url.search}`, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
      if (url.pathname.endsWith("/merge_requests/26") && init?.method === "PUT") {
        return new Response(JSON.stringify({ id: 26, iid: 26, state: "opened" }), { status: 200 });
      }
      if (url.pathname.endsWith("/merge_requests/26/merge") && init?.method === "PUT") {
        return new Response(JSON.stringify({
          id: 26,
          iid: 26,
          state: "opened",
          merge_error: "Squashing failed: resolve locally",
        }), { status: 200 });
      }
      throw new Error(`unexpected GitLab request: ${url}`);
    });
    const client = new GitLabClient({ baseUrl: "https://gitlab.example.com/api/v4", token: "gitlab-token", fetchImpl });

    await expect(client.mergeMergeRequest("7", "26", {
      mergeWhenPipelineSucceeds: false,
      shouldRemoveSourceBranch: true,
      squash: false,
    })).rejects.toMatchObject({
      name: "GitLabApiError",
      message: "GitLab 合并失败：Squashing failed: resolve locally",
    } satisfies Partial<GitLabApiError>);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ squash: false });
    expect(requests.map((request) => request.url)).toEqual([
      "/api/v4/projects/7/merge_requests/26",
      "/api/v4/projects/7/merge_requests/26/merge",
    ]);
  });
});
