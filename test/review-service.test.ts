import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewRunner } from "../src/contracts.js";
import { ReviewDeleteError, ReviewService, ReviewTerminalError } from "../src/review-service.js";
import { ReviewStore } from "../src/review-store.js";

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
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

function makeDependencies({ runnerResult = JSON.stringify({ summary: "ok", findings: [] }) } = {}) {
  const notes: Array<{ id: number; body: string }> = [];
  let nextNoteId = 1;
  const gitlab = {
    async getReviewSnapshot() {
      return {
        mergeRequest: { target_branch: "master", diff_refs: { head_sha: "head-1" } },
        changes: [{ new_path: "src/example.ts", diff: "+const value = 1;" }],
      };
    },
    async getMergeRequest() {
      return { diff_refs: { head_sha: "head-1" } };
    },
    async findNoteByMarker(_projectId: string, _mrIid: string, marker: string) {
      return notes.find((note) => note.body.includes(marker)) ?? null;
    },
    async createNote(projectId: string, mrIid: string, body: string) {
      const note = { id: nextNoteId++, projectId, mrIid, body };
      notes.push(note);
      return note;
    },
    async updateNote(projectId: string, mrIid: string, noteId: number, body: string) {
      const note = { id: noteId, projectId, mrIid, body };
      const index = notes.findIndex((existing) => existing.id === noteId);
      if (index >= 0) notes[index] = note;
      else notes.push(note);
      return note;
    },
  };
  const runner: ReviewRunner = { async run() { return runnerResult; } };
  const profileLoader = async () => ({
    name: "demo/project",
    displayName: "demo/project",
    rules: [{ id: "high-value", name: "高价值问题审查", description: "", enabled: true, order: 0, file: "audit.md", sharedBy: ["demo/project"], content: "audit" }],
  });
  return { gitlab, runner, profileLoader, notes };
}

const config = { reviewConcurrency: 1, maxDiffBytes: 10_000, rulesDir: "config/skills", profileConfigPath: "config/review-profiles.json" };

describe("ReviewService", () => {
  it("deduplicates the same MR head and writes one note", async () => {
    const dependencies = makeDependencies();
    const service = new ReviewService({ ...dependencies, config });
    const first = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    const second = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    await waitFor(() => service.getJob(first.job.id)?.status === "completed");
    expect(second.deduplicated).toBe(true);
    expect(dependencies.notes).toHaveLength(1);
    expect(dependencies.notes[0].body).toContain("Frontend Pilot 代码审查报告");
    expect(service.getJob(first.job.id)?.result).toMatchObject({ gate: "passed", blockingFindingCount: 0 });
    const progress = service.getJob(first.job.id)?.progress ?? [];
    expect(progress.map((event) => event.message)).toEqual(expect.arrayContaining([
      "任务已进入队列",
      "审查执行器已启动",
      "审查完成，MR 评论已更新",
      "任务执行资源已释放，MR 工作区保留复用",
    ]));
    expect(progress.find((event) => event.message === "审查 profile 已匹配")?.meta).toMatchObject({
      profile: "demo/project",
      profileDisplayName: "demo/project",
      ruleCount: 1,
    });
  });

  it("resolves the current head before deduplicating a headless review", async () => {
    let currentHead = "head-1";
    const dependencies = makeDependencies();
    dependencies.gitlab.getMergeRequest = async () => ({ diff_refs: { head_sha: currentHead }, target_branch: "main" });
    const service = new ReviewService({ ...dependencies, config });

    const first = await service.enqueue({ projectId: 1, mrIid: 2 });
    await waitFor(() => service.getJob(first.job.id)?.status === "completed");

    currentHead = "head-2";
    const second = await service.enqueue({ projectId: 1, mrIid: 2 });

    expect(first.job.headSha).toBe("head-1");
    expect(second.deduplicated).toBe(false);
    expect(second.job.headSha).toBe("head-2");
    await waitFor(() => service.getJob(second.job.id)?.status === "completed");
  });

  it("does not enqueue a review for a merged MR", async () => {
    const dependencies = makeDependencies();
    dependencies.gitlab.getMergeRequest = async () => ({ state: "merged", diff_refs: { head_sha: "head-1" } });
    const service = new ReviewService({ ...dependencies, config });

    await expect(service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" })).rejects.toBeInstanceOf(ReviewTerminalError);
    expect(service.stats()).toMatchObject({ queued: 0, running: 0 });
    await service.close();
  });

  it("uses the live MR target branch instead of a stale queued value", async () => {
    const dependencies = makeDependencies();
    dependencies.gitlab.getMergeRequest = async () => ({
      diff_refs: { head_sha: "head-1" },
      target_branch: "dev",
    });
    const workspaceInputs: Array<{ targetBranch: string | null }> = [];
    const service = new ReviewService({
      ...dependencies,
      config,
      workspaceProvider: {
        async create(input: { targetBranch: string | null }) {
          workspaceInputs.push({ targetBranch: input.targetBranch });
          return { path: "/tmp/review-workspace", async dispose() {} };
        },
      },
    });

    const created = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1", targetBranch: "main" });
    await waitFor(() => service.getJob(created.job.id)?.status === "completed");

    expect(workspaceInputs).toEqual([{ targetBranch: "dev" }]);
    expect(service.getJob(created.job.id)?.targetBranch).toBe("dev");
  });

  it("completes the review but marks the CI gate failed for blocking findings", async () => {
    const dependencies = makeDependencies({ runnerResult: JSON.stringify({
      summary: "需要修复",
      ruleResults: [{
        ruleId: "high-value",
        ruleName: "高价值问题审查",
        conclusion: "发现高风险问题",
        findings: [{ severity: "high", path: "src/example.ts", issue: "会阻断合并" }],
      }],
      findings: [],
    }) });
    const service = new ReviewService({ ...dependencies, config });
    const created = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" }, {
      ciBinding: { jobId: "101", pipelineId: "201", jobUrl: "https://gitlab.example/jobs/101", tokenHash: "ci-hash" },
    });
    await waitFor(() => service.getJob(created.job.id)?.status === "completed");
    expect(service.getJob(created.job.id)?.result).toMatchObject({
      gate: "failed",
      blockingFindingCount: 1,
      blockingSeverities: ["high"],
    });
    expect(dependencies.notes.find((note) => note.body.includes("mr-review-service:report:1:2:head-1"))?.body)
      .toContain("合并门禁：❌ 阻断");
  });

  it("converts each CI progress note into a report and preserves reports for earlier heads", async () => {
    let currentHead = "head-1";
    const dependencies = makeDependencies();
    dependencies.gitlab.getReviewSnapshot = async () => ({
      mergeRequest: { target_branch: "master", diff_refs: { head_sha: currentHead } },
      changes: [{ new_path: "src/example.ts", diff: "+const value = " + currentHead + ";" }],
    });
    dependencies.gitlab.getMergeRequest = async () => ({ diff_refs: { head_sha: currentHead } });

    let runCount = 0;
    let resolveSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => { resolveSecondStarted = resolve; });
    let releaseSecondRun!: () => void;
    const secondRunGate = new Promise<void>((resolve) => { releaseSecondRun = resolve; });
    dependencies.runner.run = async () => {
      runCount += 1;
      if (runCount === 2) {
        resolveSecondStarted();
        await secondRunGate;
      }
      return JSON.stringify({ summary: "ok", findings: [] });
    };

    const service = new ReviewService({ ...dependencies, config });
    const ciBinding = { jobId: "101", pipelineId: "201", jobUrl: "https://gitlab.example/jobs/101", tokenHash: "ci-hash" };
    try {
      const first = await service.enqueue({ projectId: 1, mrIid: 2, headSha: currentHead }, { ciBinding });
      await waitFor(() => service.getJob(first.job.id)?.status === "completed");
      const firstReport = () => dependencies.notes.find((note) =>
        note.body.includes("mr-review-service:report:1:2:head-1"));
      await waitFor(() => firstReport() !== undefined);
      expect(firstReport()?.body).toContain("Frontend Pilot 代码审查报告");
      expect(dependencies.notes.some((note) => note.body.includes("mr-review-service:progress:1:2"))).toBe(false);

      currentHead = "head-2";
      const second = await service.enqueue({ projectId: 1, mrIid: 2, headSha: currentHead }, { ciBinding });
      await secondStarted;
      await waitFor(() => dependencies.notes.some((note) =>
        note.body.includes("mr-review-service:progress:1:2") && note.body.includes("head-2")));

      const secondProgressNote = () => dependencies.notes.find((note) =>
        note.body.includes("mr-review-service:progress:1:2"));
      const secondProgressNoteId = secondProgressNote()?.id;
      expect(secondProgressNoteId).toBeDefined();
      expect(firstReport()?.body).toContain("Frontend Pilot 代码审查报告");
      expect(dependencies.notes.some((note) => note.body.includes("mr-review-service:report:1:2:head-1"))).toBe(true);
      expect(dependencies.notes.some((note) => note.body.includes("mr-review-service:report:1:2:head-2"))).toBe(false);

      releaseSecondRun();
      await waitFor(() => service.getJob(second.job.id)?.status === "completed");
      await waitFor(() => dependencies.notes.some((note) =>
        note.body.includes("mr-review-service:report:1:2:head-2")));
      expect(dependencies.notes.find((note) => note.body.includes("mr-review-service:report:1:2:head-2"))?.id)
        .toBe(secondProgressNoteId);
      expect(dependencies.notes.some((note) => note.body.includes("mr-review-service:progress:1:2"))).toBe(false);
      expect(dependencies.notes.filter((note) => note.body.includes("mr-review-service:report:1:2:"))).toHaveLength(2);
      expect(dependencies.notes).toHaveLength(2);
    } finally {
      releaseSecondRun();
      await service.close();
    }
  });

  it("restores completed jobs and their progress after reopening SQLite", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-store-"));
    const databasePath = path.join(tempDir, "reviews.sqlite");
    try {
      const dependencies = makeDependencies();
      const service = new ReviewService({
        ...dependencies,
        config,
        store: new ReviewStore(databasePath),
      });
      const created = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" }, {
        ciBinding: { jobId: "101", pipelineId: "201", jobUrl: "https://gitlab.example/jobs/101", tokenHash: "ci-hash" },
      });
      await waitFor(() => service.getJob(created.job.id)?.status === "completed");
      const beforeRestart = service.getJob(created.job.id);
      await service.close();

      const restored = new ReviewService({
        ...dependencies,
        config,
        store: new ReviewStore(databasePath),
      });
      const afterRestart = restored.getJob(created.job.id);
      expect(afterRestart?.status).toBe("completed");
      expect(afterRestart?.result).toEqual(beforeRestart?.result);
      expect(restored.getCiJob(created.job.id, "ci-hash")?.id).toBe(created.job.id);
      expect(afterRestart?.progress.map((event) => event.message)).toEqual(
        expect.arrayContaining(["任务已进入队列", "审查完成，MR 评论已更新"]),
      );
      expect(restored.listJobs()).toHaveLength(1);
      await restored.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reuses the persisted Claude Code session when the same MR receives a new head", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-review-session-"));
    const databasePath = path.join(tempDir, "reviews.sqlite");
    let currentHead = "head-1";
    const firstDependencies = makeDependencies();
    firstDependencies.gitlab.getReviewSnapshot = async () => ({
      mergeRequest: { target_branch: "master", diff_refs: { head_sha: currentHead } },
      changes: [{ new_path: "src/example.ts", diff: `+const value = ${currentHead};` }],
    });
    firstDependencies.gitlab.getMergeRequest = async () => ({ diff_refs: { head_sha: currentHead } });
    const firstRunOptions: Array<{ resumeSessionId?: string | null }> = [];
    firstDependencies.runner.run = async (_input, options) => {
      firstRunOptions.push(options ?? {});
      options?.onSessionId?.("session-for-mr-2");
      return JSON.stringify({ summary: "ok", findings: [] });
    };

    try {
      const first = new ReviewService({ ...firstDependencies, config, store: new ReviewStore(databasePath) });
      const firstJob = await first.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
      await waitFor(() => first.getJob(firstJob.job.id)?.status === "completed");
      await first.close();

      currentHead = "head-2";
      const secondDependencies = makeDependencies();
      secondDependencies.gitlab.getReviewSnapshot = firstDependencies.gitlab.getReviewSnapshot;
      secondDependencies.gitlab.getMergeRequest = firstDependencies.gitlab.getMergeRequest;
      secondDependencies.runner.run = async (_input, options) => {
        firstRunOptions.push(options ?? {});
        options?.onSessionId?.("session-for-mr-2");
        return JSON.stringify({ summary: "ok", findings: [] });
      };
      const second = new ReviewService({ ...secondDependencies, config, store: new ReviewStore(databasePath) });
      const secondJob = await second.enqueue({ projectId: 1, mrIid: 2, headSha: "head-2" });
      await waitFor(() => second.getJob(secondJob.job.id)?.status === "completed");

      expect(firstRunOptions.map((options) => options.resumeSessionId)).toEqual([null, "session-for-mr-2"]);
      await second.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a session created by a superseded run for the next MR head", async () => {
    const dependencies = makeDependencies();
    let currentHead = "head-1";
    dependencies.gitlab.getMergeRequest = async () => ({ diff_refs: { head_sha: currentHead } });
    let releaseFirstRun!: () => void;
    const firstRunGate = new Promise<void>((resolve) => { releaseFirstRun = resolve; });
    const resumeSessionIds: Array<string | null | undefined> = [];
    let runCount = 0;
    dependencies.runner.run = async (_input, options) => {
      resumeSessionIds.push(options?.resumeSessionId);
      runCount += 1;
      if (runCount === 1) {
        await firstRunGate;
        options?.onSessionId?.("session-for-mr-2");
      }
      return JSON.stringify({ summary: "ok", findings: [] });
    };

    const service = new ReviewService({ ...dependencies, config });
    const first = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    await waitFor(() => service.getJob(first.job.id)?.status === "running");

    currentHead = "head-2";
    const second = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-2" });
    releaseFirstRun();
    await waitFor(() => service.getJob(second.job.id)?.status === "completed");

    expect(resumeSessionIds).toEqual([null, "session-for-mr-2"]);
    await service.close();
  });

  it("stops a terminal MR, removes its Claude session, and keeps the audit job", async () => {
    const dependencies = makeDependencies();
    let mergeRequestState = "opened";
    dependencies.gitlab.getMergeRequest = async () => ({ state: mergeRequestState, diff_refs: { head_sha: "head-1" } });
    dependencies.runner.run = async (_input, options) => new Promise<string>((resolve) => {
      if (options?.signal?.aborted) {
        resolve(JSON.stringify({ summary: "aborted", findings: [] }));
        return;
      }
      options?.signal?.addEventListener("abort", () => {
        resolve(JSON.stringify({ summary: "aborted", findings: [] }));
      }, { once: true });
    });
    const deletedSessions: string[] = [];
    const store = new ReviewStore(":memory:");
    store.saveReviewSession("1", "2", "session-for-mr-2");
    const service = new ReviewService({
      ...dependencies,
      config,
      store,
      cleanupIntervalMs: 0,
      deleteReviewSession: async (sessionId) => { deletedSessions.push(sessionId); },
    });

    const created = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    await waitFor(() => service.getJob(created.job.id)?.status === "running");
    mergeRequestState = "merged";
    await service.cleanupMergeRequest("1", "2", "merge");

    expect(service.getJob(created.job.id)?.status).toBe("canceled");
    expect(service.getJob(created.job.id)?.error).toContain("MR 已合并");
    expect(deletedSessions).toEqual(["session-for-mr-2"]);
    expect(store.getReviewSession("1", "2")).toBeNull();
    expect(store.loadJobs()).toHaveLength(1);
    expect(dependencies.notes).toHaveLength(0);
    await service.close();
  });

  it("sweeps persisted sessions when the terminal webhook was missed", async () => {
    const dependencies = makeDependencies();
    dependencies.gitlab.getMergeRequest = async () => ({ state: "closed", diff_refs: { head_sha: "head-1" } });
    const deletedSessions: string[] = [];
    const store = new ReviewStore(":memory:");
    store.saveReviewSession("1", "2", "session-for-mr-2");
    const service = new ReviewService({
      ...dependencies,
      config,
      store,
      cleanupIntervalMs: 5,
      deleteReviewSession: async (sessionId) => { deletedSessions.push(sessionId); },
    });

    await waitFor(() => deletedSessions.length === 1);
    expect(store.getReviewSession("1", "2")).toBeNull();
    await service.close();
  });

  it("sweeps a persisted MR workspace even when no Claude session was created", async () => {
    const dependencies = makeDependencies();
    dependencies.gitlab.getMergeRequest = async () => ({ state: "closed", diff_refs: { head_sha: "head-1" } });
    const disposed: Array<{ projectId: string; mrIid: string }> = [];
    const store = new ReviewStore(":memory:");
    store.saveReviewWorkspace("1", "2");
    const service = new ReviewService({
      ...dependencies,
      config,
      store,
      cleanupIntervalMs: 5,
      workspaceProvider: {
        async create() {
          return { path: "/tmp/review-workspace", async dispose() {} };
        },
        async disposeReview(input: { projectId: string; mrIid: string }) {
          disposed.push(input);
        },
      },
    });

    await waitFor(() => disposed.length === 1);
    expect(disposed).toEqual([{ projectId: "1", mrIid: "2" }]);
    expect(store.listReviewWorkspaces()).toEqual([]);
    await service.close();
  });

  it("retains the workspace lifecycle record when cleanup fails and retries it", async () => {
    const dependencies = makeDependencies();
    const store = new ReviewStore(":memory:");
    store.saveReviewWorkspace("1", "2");
    let attempts = 0;
    const service = new ReviewService({
      ...dependencies,
      config,
      store,
      cleanupIntervalMs: 0,
      workspaceProvider: {
        async create() {
          return { path: "/tmp/review-workspace", async dispose() {} };
        },
        async disposeReview() {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary cleanup failure");
        },
      },
    });

    await service.cleanupMergeRequest("1", "2", "merge");
    expect(store.listReviewWorkspaces()).toHaveLength(1);
    await service.cleanupMergeRequest("1", "2", "merge");
    expect(attempts).toBe(2);
    expect(store.listReviewWorkspaces()).toEqual([]);
    await service.close();
  });

  it("waits for a canceled execution before disposing its MR workspace", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = makeDependencies();
    dependencies.runner.run = async () => {
      await gate;
      return JSON.stringify({ summary: "ok", findings: [] });
    };
    const disposed: Array<{ projectId: string; mrIid: string }> = [];
    const service = new ReviewService({
      ...dependencies,
      config,
      cleanupIntervalMs: 0,
      workspaceProvider: {
        async create() {
          return { path: "/tmp/review-workspace", async dispose() {} };
        },
        async disposeReview(input: { projectId: string; mrIid: string }) {
          disposed.push(input);
        },
      },
    });

    const created = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    await waitFor(() => service.getJob(created.job.id)?.status === "running");
    await service.cancel(created.job.id);
    const cleanup = service.cleanupMergeRequest("1", "2", "merge");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toEqual([]);

    release();
    await cleanup;
    expect(disposed).toEqual([{ projectId: "1", mrIid: "2" }]);
    await service.close();
  });

  it("keeps the workspace lifecycle record when materialization fails", async () => {
    const dependencies = makeDependencies();
    const store = new ReviewStore(":memory:");
    const service = new ReviewService({
      ...dependencies,
      config,
      store,
      cleanupIntervalMs: 0,
      workspaceProvider: {
        async create() {
          throw new Error("workspace materialization failed");
        },
      },
    });

    const created = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    await waitFor(() => service.getJob(created.job.id)?.status === "failed");
    expect(store.listReviewWorkspaces()).toEqual([{ projectId: "1", mrIid: "2" }]);
    await service.close();
  });

  it("rejects a new review while terminal MR cleanup is still running", async () => {
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
    const dependencies = makeDependencies();
    const store = new ReviewStore(":memory:");
    store.saveReviewWorkspace("1", "2");
    const service = new ReviewService({
      ...dependencies,
      config,
      store,
      cleanupIntervalMs: 0,
      workspaceProvider: {
        async disposeReview() {
          await disposeGate;
        },
      },
    });

    const cleanup = service.cleanupMergeRequest("1", "2", "merge");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" })).rejects.toBeInstanceOf(ReviewTerminalError);
    releaseDispose();
    await cleanup;
    await service.close();
  });

  it("joins concurrent terminal cleanup calls before disposing the MR workspace", async () => {
    let releaseAliasLookup!: () => void;
    const aliasLookupGate = new Promise<void>((resolve) => { releaseAliasLookup = resolve; });
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
    let aliasLookupStarted = false;
    let disposeStarted = false;
    const dependencies = makeDependencies();
    const store = new ReviewStore(":memory:");
    store.saveReviewWorkspace("group/project", "2");
    const service = new ReviewService({
      ...dependencies,
      config,
      store,
      cleanupIntervalMs: 0,
      gitlab: {
        ...dependencies.gitlab,
        async getProject(projectId: string) {
          if (projectId === "group/project") {
            aliasLookupStarted = true;
            await aliasLookupGate;
          }
          return {
            id: "1",
            name: "project",
            path: "project",
            pathWithNamespace: "group/project",
            nameWithNamespace: "group / project",
            webUrl: null,
            defaultBranch: "dev",
            visibility: null,
            lastActivityAt: null,
            avatarUrl: null,
          };
        },
      },
      workspaceProvider: {
        async disposeReview() {
          disposeStarted = true;
          await disposeGate;
        },
      },
    });

    const first = service.cleanupMergeRequest("1", "2", "merge");
    await waitFor(() => aliasLookupStarted);
    let secondFinished = false;
    const second = service.cleanupMergeRequest("1", "2", "merge").then(() => { secondFinished = true; });
    releaseAliasLookup();
    await waitFor(() => disposeStarted);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondFinished).toBe(false);
    releaseDispose();
    await Promise.all([first, second]);
    expect(secondFinished).toBe(true);
    await service.close();
  });

  it("cleans a legacy project-path workspace when a terminal event uses the canonical project id", async () => {
    const dependencies = makeDependencies();
    const store = new ReviewStore(":memory:");
    store.saveReviewWorkspace("group/project", "2");
    const disposed: Array<{ projectId: string; mrIid: string }> = [];
    const service = new ReviewService({
      ...dependencies,
      config,
      store,
      cleanupIntervalMs: 0,
      gitlab: {
        ...dependencies.gitlab,
        async getProject(projectId: string) {
          if (projectId !== "group/project") throw new Error("unexpected project lookup");
          return {
            id: "1",
            name: "project",
            path: "project",
            pathWithNamespace: "group/project",
            nameWithNamespace: "group / project",
            webUrl: null,
            defaultBranch: "dev",
            visibility: null,
            lastActivityAt: null,
            avatarUrl: null,
          };
        },
      },
      workspaceProvider: {
        async disposeReview(input: { projectId: string; mrIid: string }) {
          disposed.push(input);
        },
      },
    });

    await service.cleanupMergeRequest("1", "2", "merge");

    expect(disposed).toEqual([
      { projectId: "1", mrIid: "2" },
      { projectId: "group/project", mrIid: "2" },
    ]);
    expect(store.listReviewWorkspaces()).toEqual([]);
    await service.close();
  });

  it("canonicalizes a project path before creating the MR job and workspace", async () => {
    const dependencies = makeDependencies();
    const projectInputs: string[] = [];
    const workspaceInputs: string[] = [];
    const gitlab = {
      ...dependencies.gitlab,
      async getProject(projectId: string) {
        projectInputs.push(projectId);
        return {
          id: "42",
          name: "project",
          path: "project",
          pathWithNamespace: "group/project",
          nameWithNamespace: "group / project",
          webUrl: null,
          defaultBranch: "dev",
          visibility: null,
          lastActivityAt: null,
          avatarUrl: null,
        };
      },
    };
    const service = new ReviewService({
      ...dependencies,
      gitlab,
      config,
      workspaceProvider: {
        async create(input: { projectId: string }) {
          workspaceInputs.push(input.projectId);
          return { path: "/tmp/review-workspace", async dispose() {} };
        },
      },
    });

    const created = await service.enqueue({ projectId: "group/project", mrIid: 2, headSha: "head-1" });
    await waitFor(() => service.getJob(created.job.id)?.status === "completed");
    const sameHead = await service.enqueue({ projectId: "42", mrIid: 2, headSha: "head-1" });

    expect(projectInputs).toEqual(["group/project"]);
    expect(workspaceInputs).toEqual(["42"]);
    expect(created.job.projectId).toBe("42");
    expect(sameHead.deduplicated).toBe(true);
    await service.close();
  });

  it("uses an isolated workspace for each concurrent review and disposes both", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = makeDependencies();
    const workspacePaths: string[] = [];
    const disposedPaths: string[] = [];
    const runnerInputs: Array<{ workspacePath?: string | null }> = [];
    dependencies.runner.run = async (input) => {
      runnerInputs.push(input);
      await gate;
      return JSON.stringify({ summary: "ok", findings: [] });
    };
    const workspaceProvider = {
      async create(input: { jobId: string }) {
        const workspacePath = `/tmp/review-workspaces/${input.jobId}`;
        workspacePaths.push(workspacePath);
        return {
          path: workspacePath,
          async dispose() { disposedPaths.push(workspacePath); },
        };
      },
      async disposeReview(input: { projectId: string; mrIid: string }) {
        disposedPaths.push(`/tmp/review-workspaces/${input.projectId}/${input.mrIid}`);
      },
    };
    const service = new ReviewService({
      ...dependencies,
      workspaceProvider,
      config: { ...config, reviewConcurrency: 2 },
    });

    const first = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    const second = await service.enqueue({ projectId: 1, mrIid: 3, headSha: "head-1" });
    await waitFor(() => service.stats().running === 2 && runnerInputs.length === 2);

    expect(first.job.id).not.toBe(second.job.id);
    expect(new Set(workspacePaths).size).toBe(2);
    expect(new Set(runnerInputs.map((input) => input.workspacePath)).size).toBe(2);
    expect(runnerInputs.every((input) => !Object.prototype.hasOwnProperty.call(input, "diff"))).toBe(true);
    expect(disposedPaths).toHaveLength(0);

    release();
    await waitFor(() => service.stats().completed === 2);
    await service.cleanupMergeRequest("1", "2", "merge");
    await service.cleanupMergeRequest("1", "3", "merge");
    expect(disposedPaths).toEqual([
      "/tmp/review-workspaces/1/2",
      "/tmp/review-workspaces/1/3",
    ]);
  });

  it("reuses one MR workspace across heads and disposes it with the MR session", async () => {
    const dependencies = makeDependencies();
    let currentHead = "head-1";
    dependencies.gitlab.getMergeRequest = async () => ({ diff_refs: { head_sha: currentHead } });
    const workspacePaths: string[] = [];
    const disposed: Array<{ projectId: string; mrIid: string }> = [];
    const service = new ReviewService({
      ...dependencies,
      config,
      workspaceProvider: {
        async create(input: { projectId: string; mrIid: string; headSha: string | null }) {
          workspacePaths.push(`${input.projectId}/${input.mrIid}:${input.headSha}`);
          return { path: `/tmp/review-workspaces/${input.projectId}/${input.mrIid}`, async dispose() {} };
        },
        async disposeReview(input: { projectId: string; mrIid: string }) {
          disposed.push(input);
        },
      },
    });

    const first = await service.enqueue({ projectId: "1", mrIid: "2", headSha: "head-1" });
    await waitFor(() => service.getJob(first.job.id)?.status === "completed");
    currentHead = "head-2";
    const second = await service.enqueue({ projectId: "1", mrIid: "2", headSha: "head-2" });
    await waitFor(() => service.getJob(second.job.id)?.status === "completed");

    expect(workspacePaths).toEqual(["1/2:head-1", "1/2:head-2"]);
    expect(disposed).toEqual([]);
    await service.cleanupMergeRequest("1", "2", "merge");
    expect(disposed).toEqual([{ projectId: "1", mrIid: "2" }]);
  });

  it("round-robins queued reviews by project", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = makeDependencies();
    const startedProjects: string[] = [];
    dependencies.runner.run = async (input) => {
      startedProjects.push(input.projectPath);
      if (startedProjects.length === 1) await gate;
      return JSON.stringify({ summary: "ok", findings: [] });
    };
    const service = new ReviewService({ ...dependencies, config });

    await service.enqueue({ projectId: "project-a", projectPath: "group/project-a", mrIid: 1, headSha: "head-1" });
    await waitFor(() => service.stats().running === 1);
    await service.enqueue({ projectId: "project-a", projectPath: "group/project-a", mrIid: 2, headSha: "head-1" });
    await service.enqueue({ projectId: "project-b", projectPath: "group/project-b", mrIid: 1, headSha: "head-1" });

    release();
    await waitFor(() => service.stats().completed === 3);
    expect(startedProjects).toEqual(["group/project-a", "group/project-b", "group/project-a"]);
  });

  it("persists and applies a changed review concurrency", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-settings-"));
    const databasePath = path.join(tempDir, "reviews.sqlite");
    try {
      const first = new ReviewService({ ...makeDependencies(), config, store: new ReviewStore(databasePath) });
      expect(first.getSettings()).toMatchObject({ reviewConcurrency: 1, autoSendComments: true, minReviewConcurrency: 1, maxReviewConcurrency: 16 });
      expect(first.updateSettings(2, false).reviewConcurrency).toBe(2);
      await first.close();

      const restored = new ReviewService({ ...makeDependencies(), config, store: new ReviewStore(databasePath) });
      expect(restored.getSettings().reviewConcurrency).toBe(2);
      expect(restored.getSettings().autoSendComments).toBe(false);
      await restored.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("starts waiting jobs immediately when concurrency increases", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = makeDependencies();
    dependencies.runner.run = async () => {
      await gate;
      return JSON.stringify({ summary: "ok", findings: [] });
    };
    const service = new ReviewService({ ...dependencies, config });

    await service.enqueue({ projectId: "project-a", mrIid: 1, headSha: "head-1" });
    await service.enqueue({ projectId: "project-b", mrIid: 1, headSha: "head-1" });
    await waitFor(() => service.stats().running === 1 && service.stats().queued === 1);

    service.updateSettings(2);
    await waitFor(() => service.stats().running === 2 && service.stats().queued === 0);
    release();
    await waitFor(() => service.stats().completed === 2);
  });

  it("completes without GitLab comments when automatic comment sending is disabled", async () => {
    const dependencies = makeDependencies();
    const service = new ReviewService({ ...dependencies, config });
    service.updateSettings(1, false);

    const created = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" }, {
      ciBinding: { jobId: "101", pipelineId: "201", jobUrl: "https://gitlab.example/jobs/101", tokenHash: "ci-hash" },
    });
    await waitFor(() => service.getJob(created.job.id)?.status === "completed");

    expect(dependencies.notes).toHaveLength(0);
    expect(service.getJob(created.job.id)?.result).toMatchObject({ gate: "passed", blockingFindingCount: 0 });
    expect(service.getJob(created.job.id)?.progress.map((event) => event.message)).toEqual(expect.arrayContaining([
      "已跳过 GitLab MR 评论",
      "审查完成，未发送 GitLab 评论",
    ]));
  });

  it("supersedes a running older commit when a newer commit arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = makeDependencies();
    dependencies.runner.run = async () => { await gate; return JSON.stringify({ summary: "ok", findings: [] }); };
    const service = new ReviewService({ ...dependencies, config });
    const first = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    const second = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-2" });
    expect(service.getJob(first.job.id)?.status).toBe("superseded");
    expect(service.getJob(second.job.id)?.status).toBe("queued");
    release();
    await waitFor(() => service.getJob(second.job.id)?.status === "superseded");
  });

  it("aborts an old CI review and converts the latest progress note into its report", async () => {
    let currentHead = "head-1";
    let oldReviewAborted = false;
    let reviewCalls = 0;
    const dependencies = makeDependencies();
    dependencies.gitlab.getReviewSnapshot = async () => ({
      mergeRequest: { target_branch: "master", diff_refs: { head_sha: currentHead } },
      changes: [],
    });
    dependencies.gitlab.getMergeRequest = async () => ({ diff_refs: { head_sha: currentHead } });
    dependencies.runner.run = async (_input, options) => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            oldReviewAborted = true;
            resolve();
            return;
          }
          options?.signal?.addEventListener("abort", () => {
            oldReviewAborted = true;
            resolve();
          }, { once: true });
        });
      }
      return JSON.stringify({ summary: "latest", findings: [] });
    };
    const service = new ReviewService({ ...dependencies, config });
    const first = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" }, {
      ciBinding: { jobId: "101", pipelineId: "201", jobUrl: "https://gitlab.example/jobs/101", tokenHash: "hash-1" },
    });
    await waitFor(() => service.getJob(first.job.id)?.status === "running");
    await waitFor(() => dependencies.notes.some((note) => note.body.includes("mr-review-service:progress:1:2")));
    const progressNote = () => dependencies.notes.find((note) => note.body.includes("mr-review-service:progress:1:2"));
    expect(progressNote()?.body).toContain("CI Job");
    const progressNoteId = progressNote()?.id;

    currentHead = "head-2";
    const second = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-2" }, {
      ciBinding: { jobId: "102", pipelineId: "202", jobUrl: "https://gitlab.example/jobs/102", tokenHash: "hash-2" },
    });

    expect(service.getJob(first.job.id)?.status).toBe("superseded");
    await waitFor(() => service.getJob(second.job.id)?.status === "completed");
    await waitFor(() => dependencies.notes.some((note) => note.body.includes("mr-review-service:report:1:2:head-2")));
    expect(oldReviewAborted).toBe(true);
    const latestReport = dependencies.notes.find((note) => note.body.includes("mr-review-service:report:1:2:head-2"));
    expect(latestReport?.id).toBe(progressNoteId);
    expect(latestReport?.body)
      .toContain("合并门禁：✅ 通过");
    expect(progressNote()).toBeUndefined();
    expect(dependencies.notes).toHaveLength(1);
    expect(dependencies.notes.some((note) => note.body.includes("mr-review-service:report:1:2:head-1"))).toBe(false);
  });

  it("cancels a running job without publishing a note", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = makeDependencies();
    dependencies.runner.run = async () => { await gate; return JSON.stringify({ summary: "ok", findings: [] }); };
    const service = new ReviewService({ ...dependencies, config });
    const created = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    const canceled = await service.cancel(created.job.id);
    expect(canceled?.status).toBe("canceled");
    release();
    await waitFor(() => service.stats().running === 0);
    expect(dependencies.notes).toHaveLength(0);
  });

  it("retries a failed job as a new review record", async () => {
    let attempts = 0;
    const dependencies = makeDependencies();
    dependencies.runner.run = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("model unavailable");
      return JSON.stringify({ summary: "retry ok", findings: [] });
    };
    const service = new ReviewService({ ...dependencies, config });
    const failed = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    await waitFor(() => service.getJob(failed.job.id)?.status === "failed");

    const retried = await service.retry(failed.job.id);
    expect(retried?.deduplicated).toBe(false);
    expect(retried?.job.id).not.toBe(failed.job.id);
    expect(retried?.job.source).toBe("retry");
    await waitFor(() => retried ? service.getJob(retried.job.id)?.status === "completed" : false);
    expect(attempts).toBe(2);
    expect(service.getJob(failed.job.id)?.error).toBe("model unavailable");
  });

  it("deletes finished jobs and clears their persisted record", async () => {
    const dependencies = makeDependencies();
    const store = new ReviewStore(":memory:");
    const service = new ReviewService({ ...dependencies, config, store });
    const created = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    await waitFor(() => service.getJob(created.job.id)?.status === "completed");

    await expect(service.delete(created.job.id)).resolves.toBe(true);
    expect(service.getJob(created.job.id)).toBeNull();
    expect(service.listJobs()).toHaveLength(0);
    expect(store.loadJobs()).toHaveLength(0);

    const rerun = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    expect(rerun.deduplicated).toBe(false);
    await waitFor(() => service.getJob(rerun.job.id)?.status === "completed");
    await service.close();
  });

  it("does not delete a queued or running job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = makeDependencies();
    dependencies.runner.run = async () => {
      await gate;
      return JSON.stringify({ summary: "ok", findings: [] });
    };
    const service = new ReviewService({ ...dependencies, config });
    const created = await service.enqueue({ projectId: 1, mrIid: 2, headSha: "head-1" });
    await waitFor(() => service.getJob(created.job.id)?.status === "running");

    await expect(service.delete(created.job.id)).rejects.toBeInstanceOf(ReviewDeleteError);
    release();
    await waitFor(() => service.getJob(created.job.id)?.status === "completed");
  });
});
