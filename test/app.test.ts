import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createBrowserSession } from "../src/auth.js";
import type { FeedbackStorePort, FeedbackSubmission } from "../src/feedback-store.js";
import { config, gitlabConnectionStore, service } from "./app-fixtures.js";

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(check, 5);
    };
    check();
  });
}

function multipartPayload(fields: Record<string, string>, files: Array<{ fieldName: string; filename: string; contentType: string; content: Buffer }>): { body: Buffer; contentType: string } {
  const boundary = "----frontend-pilot-feedback-test";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    chunks.push(file.content);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe("HTTP API", () => {
  it("protects review APIs and accepts a valid GitLab webhook", async () => {
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    const invalid = await app.inject({
      method: "POST",
      url: "/webhooks/gitlab",
      headers: { "x-gitlab-token": "wrong" },
      payload: { object_kind: "merge_request", project: { id: 7 }, object_attributes: { iid: 3, action: "update" } },
    });
    expect(invalid.statusCode).toBe(401);

    const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/reviews" });
    expect(unauthenticated.statusCode).toBe(401);

    const valid = await app.inject({
      method: "POST",
      url: "/webhooks/gitlab",
      headers: { "x-gitlab-token": "webhook-secret" },
      payload: {
        object_kind: "merge_request",
        project: { id: 7, path_with_namespace: "demo/project" },
        object_attributes: { iid: 3, action: "update", last_commit_id: "head-1" },
      },
    });
    expect(valid.statusCode).toBe(202);
    expect(valid.json().accepted).toBe(true);

    const terminal = await app.inject({
      method: "POST",
      url: "/webhooks/gitlab",
      headers: { "x-gitlab-token": "webhook-secret" },
      payload: {
        object_kind: "merge_request",
        project: { id: 7 },
        object_attributes: { iid: 3, action: "merge" },
      },
    });
    expect(terminal.statusCode).toBe(202);
    expect(terminal.json()).toMatchObject({ accepted: true, cleaned: true, action: "merge" });
    await app.close();
  });

  it("submits a review and lists it through the typed API", async () => {
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/reviews",
      headers: { authorization: "Bearer trigger-token" },
      payload: { projectId: 7, projectPath: "demo/project", mrIid: 3, headSha: "head-1", targetBranch: "main" },
    });
    expect(created.statusCode).toBe(202);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/reviews",
      headers: { authorization: "Bearer trigger-token" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().jobs).toHaveLength(1);
    await app.close();
  });

  it("reads and updates the authenticated review capacity", async () => {
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    const headers = { authorization: "Bearer trigger-token" };
    const initial = await app.inject({ method: "GET", url: "/api/v1/review-settings", headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().settings).toMatchObject({ reviewConcurrency: 1, autoSendComments: true, minReviewConcurrency: 1, maxReviewConcurrency: 16 });

    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/review-settings",
      headers,
      payload: { reviewConcurrency: 2, autoSendComments: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings.reviewConcurrency).toBe(2);
    expect(updated.json().settings.autoSendComments).toBe(false);

    const invalid = await app.inject({ method: "PUT", url: "/api/v1/review-settings", headers, payload: { reviewConcurrency: 0 } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("authenticates a CI review with the GitLab job token and allows scoped polling", async () => {
    const reviewService = service();
    const gitlab = {
      async getJobByToken(token: string) {
        expect(token).toBe("ci-job-token");
        return {
          id: 321,
          commit: { id: "head-1" },
          pipeline: { id: 654, project_id: 7, source: "merge_request_event" },
          web_url: "https://gitlab.example.com/aip/ui/so-chart/-/jobs/321",
        };
      },
      async getMergeRequest() { return { diff_refs: { head_sha: "head-1" } }; },
      async getReviewSnapshot() { return { mergeRequest: { diff_refs: { head_sha: "head-1" } }, changes: [] }; },
      async findNoteByMarker() { return null; },
      async createNote() { return { id: 1 }; },
      async updateNote() { return { id: 1 }; },
    };
    const app = await buildApp({ config, reviewService, gitlab });
    const payload = {
      projectId: 7,
      projectPath: "demo/project",
      mrIid: 3,
      headSha: "head-1",
      targetBranch: "main",
      pipelineId: 654,
      jobId: 321,
      jobUrl: "https://gitlab.example.com/aip/ui/so-chart/-/jobs/321",
    };

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/ci/reviews",
      headers: { "job-token": "ci-job-token" },
      payload,
    });
    expect(created.statusCode).toBe(202);
    const reviewId = created.json().job.id as string;

    const polled = await app.inject({
      method: "GET",
      url: `/api/v1/ci/reviews/${reviewId}`,
      headers: { "job-token": "ci-job-token" },
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().jobId).toBeUndefined();
    expect(polled.json().id).toBe(reviewId);

    const wrongToken = await app.inject({
      method: "GET",
      url: `/api/v1/ci/reviews/${reviewId}`,
      headers: { "job-token": "another-job-token" },
    });
    expect(wrongToken.statusCode).toBe(401);
    await app.close();
  });

  it("does not start a CI review for a stale MR head", async () => {
    const reviewService = service();
    const gitlab = {
      async getJobByToken() {
        return {
          id: 321,
          commit: { id: "old-head" },
          pipeline: { id: 654, project_id: 7, source: "merge_request_event" },
          web_url: "https://gitlab.example.com/jobs/321",
        };
      },
      async getMergeRequest() { return { diff_refs: { head_sha: "new-head" } }; },
    };
    const app = await buildApp({ config, reviewService, gitlab });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ci/reviews",
      headers: { "job-token": "ci-job-token" },
      payload: {
        projectId: 7,
        mrIid: 3,
        headSha: "old-head",
        pipelineId: 654,
        jobId: 321,
        jobUrl: "https://gitlab.example.com/jobs/321",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "review_head_is_stale", currentHeadSha: "new-head" });
    expect(reviewService.listJobs()).toHaveLength(0);
    await app.close();
  });

  it("returns not found for an authenticated progress stream without a job", async () => {
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reviews/missing/events",
      headers: { authorization: "Bearer trigger-token" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects blank resource IDs at the HTTP boundary", async () => {
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reviews/%20",
      headers: { authorization: "Bearer trigger-token" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
    await app.close();
  });

  it("retries a failed review through the authenticated API", async () => {
    let attempts = 0;
    const reviewService = service({
      runner: {
        async run() {
          attempts += 1;
          if (attempts === 1) throw new Error("model unavailable");
          return JSON.stringify({ summary: "retry ok", findings: [] });
        },
      },
    });
    const app = await buildApp({ config, reviewService, gitlabConnectionStore: gitlabConnectionStore() });
    const failed = await reviewService.enqueue({ projectId: 7, projectPath: "demo/project", mrIid: 3, headSha: "head-1", targetBranch: "main" });
    await waitFor(() => reviewService.getJob(failed.job.id)?.status === "failed");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reviews/${failed.job.id}/retry`,
      headers: { authorization: "Bearer trigger-token" },
    });

    expect(response.statusCode).toBe(202);
    const retried = response.json() as { job: { id: string; source: string } };
    expect(retried).toMatchObject({ accepted: true, deduplicated: false, job: { source: "retry" } });
    expect(retried.job.id).not.toBe(failed.job.id);
    await waitFor(() => reviewService.stats().completed === 1);
    expect(attempts).toBe(2);

    const retryCompleted = await app.inject({
      method: "POST",
      url: `/api/v1/reviews/${retried.job.id}/retry`,
      headers: { authorization: "Bearer trigger-token" },
    });
    expect(retryCompleted.statusCode).toBe(409);
    expect(retryCompleted.json()).toMatchObject({ error: "review_retry_not_allowed" });
    await app.close();
  });

  it("deletes a finished review through the authenticated API", async () => {
    const reviewService = service();
    const app = await buildApp({ config, reviewService, gitlabConnectionStore: gitlabConnectionStore() });
    const created = await reviewService.enqueue({ projectId: 7, projectPath: "demo/project", mrIid: 3, headSha: "head-1", targetBranch: "main" });
    await waitFor(() => reviewService.getJob(created.job.id)?.status === "completed");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/reviews/${created.job.id}`,
      headers: { authorization: "Bearer trigger-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: true });
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/reviews",
      headers: { authorization: "Bearer trigger-token" },
    });
    expect(list.json().jobs).toHaveLength(0);
    await app.close();
  });

  it("logs in with the product account without exposing the service token", async () => {
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    const status = await app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(status.json()).toEqual({ configured: true, authenticated: false, username: null, role: null, inspectionAccess: false });

    const invalidLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: config.webOrigin },
      payload: { username: config.loginUsername, password: "wrong-password" },
    });
    expect(invalidLogin.statusCode).toBe(401);

    const anonymousSession = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: { origin: config.webOrigin },
    });
    expect(anonymousSession.statusCode).toBe(401);

    const session = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: config.webOrigin },
      payload: { username: config.loginUsername, password: config.loginPassword },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ configured: true, authenticated: true, username: config.loginUsername, role: "user", inspectionAccess: false });

    const setCookie = session.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookie).toMatch(/^mr_review_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain(config.triggerToken);

    const reviews = await app.inject({
      method: "GET",
      url: "/api/v1/reviews",
      headers: { cookie: cookie?.split(";", 1)[0] ?? "" },
    });
    expect(reviews.statusCode).toBe(200);

    const legacyCookie = `mr_review_session=${encodeURIComponent(createBrowserSession(config.triggerToken, Date.now(), { username: config.loginUsername }))}`;
    const migrated = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: { origin: config.webOrigin, cookie: legacyCookie },
    });
    expect(migrated.statusCode).toBe(200);
    const migratedSetCookie = migrated.headers["set-cookie"];
    const migratedCookie = Array.isArray(migratedSetCookie) ? migratedSetCookie[0] : migratedSetCookie;
    expect(migratedCookie).toMatch(/^mr_review_session=/);
    expect(migratedCookie).not.toContain(legacyCookie.split("=", 2)[1]!);
    expect((await app.inject({ method: "GET", url: "/api/v1/reviews", headers: { cookie: migratedCookie?.split(";", 1)[0] ?? "" } })).statusCode).toBe(200);
    await app.close();
  });

  it("tests a model configuration without returning the API key", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer model-test-key");
      expect(headers.get("x-api-key")).toBeNull();
      expect(String(init?.body)).not.toContain("model-test-key");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/model-config/test",
        headers: { authorization: "Bearer trigger-token" },
        payload: {
          env: {
            ANTHROPIC_AUTH_TOKEN: "model-test-key",
            ANTHROPIC_BASE_URL: "https://api.anthropic.com",
            ANTHROPIC_MODEL: "claude-test",
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, model: "claude-test", message: "OK" });
      expect(fetchMock).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.any(Object));
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });

  it("reads and writes the project Claude model configuration through the authenticated API", async () => {
    let current = {
      env: {
        ANTHROPIC_AUTH_TOKEN: "project-key",
        ANTHROPIC_BASE_URL: "https://project.example.com",
        ANTHROPIC_MODEL: "project-model",
      },
    };
    const modelConfigStore = {
      async read() { return current; },
      async write(next: typeof current) {
        current = next;
        return current;
      },
    };
    const app = await buildApp({ config, reviewService: service(), modelConfigStore });
    try {
      const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/model-config" });
      expect(unauthenticated.statusCode).toBe(401);

      const read = await app.inject({
        method: "GET",
        url: "/api/v1/model-config",
        headers: { authorization: "Bearer trigger-token" },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({
        env: {
          ANTHROPIC_AUTH_TOKEN: "project-key",
          ANTHROPIC_BASE_URL: "https://project.example.com",
          ANTHROPIC_MODEL: "project-model",
        },
      });

      const write = await app.inject({
        method: "PUT",
        url: "/api/v1/model-config",
        headers: { authorization: "Bearer trigger-token" },
        payload: {
          env: {
            ANTHROPIC_AUTH_TOKEN: "updated-key",
            ANTHROPIC_BASE_URL: "https://updated.example.com",
            ANTHROPIC_MODEL: "updated-model",
          },
        },
      });
      expect(write.statusCode).toBe(200);
      expect(write.json().env.ANTHROPIC_AUTH_TOKEN).toBe("updated-key");
      expect(JSON.stringify(write.json())).toContain("updated-key");
      expect(current).toEqual({
        env: {
          ANTHROPIC_AUTH_TOKEN: "updated-key",
          ANTHROPIC_BASE_URL: "https://updated.example.com",
          ANTHROPIC_MODEL: "updated-model",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("reads the project GitLab configuration with the token and tests the current identity", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("private-token")).toBe("gitlab-token");
      return new Response(JSON.stringify({ username: "review-bot", name: "Review Bot" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    try {
      const read = await app.inject({
        method: "GET",
        url: "/api/v1/gitlab-connection",
        headers: { authorization: "Bearer trigger-token" },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ token: "gitlab-token", tokenConfigured: true });

      const test = await app.inject({
        method: "POST",
        url: "/api/v1/gitlab-connection/test",
        headers: { authorization: "Bearer trigger-token" },
        payload: {
          baseUrl: "https://gitlab.example.com",
          apiBaseUrl: "https://gitlab.example.com/api/v4",
          token: "gitlab-token",
        },
      });
      expect(test.statusCode).toBe(200);
      expect(test.json()).toMatchObject({ ok: true, userName: "Review Bot", username: "review-bot" });
      expect(test.json()).not.toHaveProperty("token");
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });

  it("resolves a GitLab MR URL into review fields", async () => {
    const gitlab = {
      async getReviewSnapshot() {
        return { mergeRequest: { diff_refs: { head_sha: "head-1" } }, changes: [] };
      },
      async getMergeRequest() { return { diff_refs: { head_sha: "head-1" } }; },
      async findNoteByMarker() { return null; },
      async createNote() { return { id: 1 }; },
      async updateNote() { return { id: 1 }; },
      async resolveMergeRequestUrl() {
        return {
          projectId: "16534",
          projectPath: "aip/ui/so-chart",
          mrIid: "17",
          headSha: "e2c1e0b62fafee23b5329ad7929ea63422c70d86",
          targetBranch: "dev",
        };
      },
    };
    const app = await buildApp({ config, reviewService: service(), gitlab });
    const resolved = await app.inject({
      method: "POST",
      url: "/api/v1/merge-requests/resolve",
      headers: { authorization: "Bearer trigger-token" },
      payload: { url: "https://gitlab.example.com/aip/ui/so-chart/-/merge_requests/17" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({
      projectId: "16534",
      projectPath: "aip/ui/so-chart",
      mrIid: "17",
      headSha: "e2c1e0b62fafee23b5329ad7929ea63422c70d86",
      targetBranch: "dev",
    });
    await app.close();
  });

  it("accepts authenticated product feedback and validates its fields", async () => {
    let received: FeedbackSubmission | null = null;
    const feedbackStore: FeedbackStorePort = {
      create(input) {
        received = input;
        return { id: "feedback-1", receivedAt: "2026-08-20T00:00:00.000Z" };
      },
      get(id) {
        return id === "00000000-0000-0000-0000-000000000001"
          ? { id, category: "bug", rating: 4, message: "页面有点难找", contact: "tester@example.com", createdAt: "2026-08-20T00:00:00.000Z" }
          : null;
      },
      list() {
        return {
          items: [{ id: "00000000-0000-0000-0000-000000000001", category: "bug", rating: 4, message: "页面有点难找", createdAt: "2026-08-20T00:00:00.000Z" }],
          total: 1,
        };
      },
      delete(id) {
        return id === "00000000-0000-0000-0000-000000000001";
      },
      close() {},
    };
    const app = await buildApp({ config, reviewService: service(), feedbackStore });
    try {
      const unauthenticated = await app.inject({
        method: "POST",
        url: "/api/v1/feedback",
        payload: { category: "bug", rating: 4, message: "页面有点难找" },
      });
      expect(unauthenticated.statusCode).toBe(401);

      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/feedback",
        headers: { authorization: "Bearer trigger-token" },
        payload: { category: "bug", rating: 6, message: "页面有点难找" },
      });
      expect(invalid.statusCode).toBe(400);

      const valid = await app.inject({
        method: "POST",
        url: "/api/v1/feedback",
        headers: { authorization: "Bearer trigger-token" },
        payload: { category: "bug", rating: 4, message: "  页面有点难找  ", contact: "  tester@example.com  " },
      });
      expect(valid.statusCode).toBe(201);
      expect(valid.json()).toEqual({ accepted: true, receivedAt: "2026-08-20T00:00:00.000Z" });
      expect(received).toEqual({ category: "bug", rating: 4, message: "页面有点难找", contact: "tester@example.com" });

      const uploaded = multipartPayload(
        { category: "experience", rating: "5", message: "上传截图后的反馈" },
        [{ fieldName: "images", filename: "screen.png", contentType: "image/png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]) }],
      );
      const multipart = await app.inject({
        method: "POST",
        url: "/api/v1/feedback",
        headers: { authorization: "Bearer trigger-token", "content-type": uploaded.contentType },
        payload: uploaded.body,
      });
      expect(multipart.statusCode).toBe(201);
      expect(received).toMatchObject({ category: "experience", rating: 5, message: "上传截图后的反馈" });
      expect(received?.attachments).toHaveLength(1);
      expect(received?.attachments?.[0]).toMatchObject({ filename: "screen.png", mimeType: "image/png" });
      expect(received?.attachments?.[0]?.data).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]));

      const largerUploaded = multipartPayload(
        { category: "bug", rating: "3", message: "稍大的截图" },
        [{ fieldName: "images", filename: "larger.png", contentType: "image/png", content: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1_100_000)]) }],
      );
      const largerMultipart = await app.inject({
        method: "POST",
        url: "/api/v1/feedback",
        headers: { authorization: "Bearer trigger-token", "content-type": largerUploaded.contentType },
        payload: largerUploaded.body,
      });
      expect(largerMultipart.statusCode).toBe(201);

      const invalidUpload = multipartPayload(
        { category: "bug", rating: "2", message: "无效图片" },
        [{ fieldName: "images", filename: "not-image.png", contentType: "image/png", content: Buffer.from("not an image") }],
      );
      const invalidMultipart = await app.inject({
        method: "POST",
        url: "/api/v1/feedback",
        headers: { authorization: "Bearer trigger-token", "content-type": invalidUpload.contentType },
        payload: invalidUpload.body,
      });
      expect(invalidMultipart.statusCode).toBe(400);
      expect(invalidMultipart.json().details).toBe("仅支持 JPG、PNG、GIF 或 WebP 图片。");

      const unauthenticatedList = await app.inject({ method: "GET", url: "/api/v1/feedback" });
      expect(unauthenticatedList.statusCode).toBe(401);
      const browserSessionList = await app.inject({
        method: "GET",
        url: "/api/v1/feedback",
        headers: { cookie: `mr_review_session=invalid-browser-session` },
      });
      expect(browserSessionList.statusCode).toBe(401);
      const validBrowserSessionList = await app.inject({
        method: "GET",
        url: "/api/v1/feedback",
        headers: { cookie: `mr_review_session=${encodeURIComponent(createBrowserSession(config.triggerToken))}` },
      });
      expect(validBrowserSessionList.statusCode).toBe(403);
      const adminBrowserSessionList = await app.inject({
        method: "GET",
        url: "/api/v1/feedback",
        headers: { cookie: `mr_review_session=${encodeURIComponent(createBrowserSession(config.triggerToken, Date.now(), { username: "pilot-admin" }))}` },
      });
      expect(adminBrowserSessionList.statusCode).toBe(200);
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/feedback?limit=10",
        headers: { authorization: "Bearer trigger-token" },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        items: [{ id: "00000000-0000-0000-0000-000000000001", category: "bug", rating: 4, message: "页面有点难找", createdAt: "2026-08-20T00:00:00.000Z" }],
        total: 1,
      });

      const unauthenticatedDetail = await app.inject({ method: "GET", url: "/api/v1/feedback/00000000-0000-0000-0000-000000000001" });
      expect(unauthenticatedDetail.statusCode).toBe(401);
      const detail = await app.inject({
        method: "GET",
        url: "/api/v1/feedback/00000000-0000-0000-0000-000000000001",
        headers: { authorization: "Bearer trigger-token" },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual({
        id: "00000000-0000-0000-0000-000000000001",
        category: "bug",
        rating: 4,
        message: "页面有点难找",
        contact: "tester@example.com",
        createdAt: "2026-08-20T00:00:00.000Z",
      });

      const deleted = await app.inject({
        method: "DELETE",
        url: "/api/v1/feedback/00000000-0000-0000-0000-000000000001",
        headers: { authorization: "Bearer trigger-token" },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ deleted: true });
      const missing = await app.inject({
        method: "DELETE",
        url: "/api/v1/feedback/00000000-0000-0000-0000-000000000002",
        headers: { authorization: "Bearer trigger-token" },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
