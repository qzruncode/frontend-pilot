import { describe, expect, it, vi } from "vitest";
import type { AssistantEditService } from "../src/assistant-edit-service.js";
import type { AssistantExecutionManager } from "../src/assistant-execution.js";
import type { AssistantStore } from "../src/assistant-store.js";
import type { GitLabClientPort } from "../src/gitlab-client.js";
import type { GitLabMergeRequestDetails } from "../src/gitlab-workbench.js";
import { GitLabMrAiRepairService } from "../src/gitlab-mr-ai-service.js";
import { GitLabMrAiRepairStore, publicGitLabMrAiRepairTask, type StoredGitLabMrAiRepairTask } from "../src/gitlab-mr-ai-store.js";

const identity = { userId: "user-1", username: "alice" };
const connection = { baseUrl: "https://gitlab.invalid", apiBaseUrl: "https://gitlab.invalid/api/v4", token: "token" };

type FakeState = {
  headSha: string;
  mode: "passed" | "review-findings" | "pipeline-failure";
  title?: string;
  pipelineStatus?: string;
  pollIntervalMs?: number;
  updateTitles?: string[];
  detailCalls?: number;
  driftAfterCall?: number;
  createSessionGate?: Promise<void>;
  repairRoundsBeforePass?: number;
  published?: number;
  verificationTimeoutMs?: number;
};

function passedReport(): string {
  return "## Claude 代码审查报告\n### 规则审查\n通过\n### 高价值问题\n无问题\n✅ 全部通过\n\n补充说明（验证完整性）：\n\n- 本环境未执行额外测试。";
}

function findingsReport(): string {
  return "## Claude 代码审查报告\n### 规则审查\n通过\n### 高价值问题\n| 问题 | 建议 |\n| --- | --- |\n| 示例问题 | 修复示例问题 |";
}

function fakeDetail(state: FakeState, headSha = state.headSha): GitLabMergeRequestDetails {
  const pipelineFailed = state.mode === "pipeline-failure";
  const pipelineStatus = state.pipelineStatus ?? (pipelineFailed ? "failed" : "success");
  const reviewReport = state.mode === "review-findings" ? findingsReport() : passedReport();
  const pipelineId = `pipeline-${headSha}`;
  const reviewJobId = `review-${headSha}`;
  return {
    id: "mr-1",
    iid: "42",
    projectId: "10",
    projectPath: "group/demo",
    title: state.title ?? "修复 MR 自动验证问题",
    description: null,
    state: "opened",
    draft: false,
    webUrl: "https://gitlab.invalid/group/demo/-/merge_requests/42",
    createdAt: "2026-09-14T01:00:00.000Z",
    updatedAt: "2026-09-14T01:00:00.000Z",
    sourceBranch: "feature/fix",
    targetBranch: "dev",
    headSha,
    mergeCommitSha: null,
    squashCommitSha: null,
    mergeBaseSha: null,
    mergedAt: null,
    mergeError: null,
    author: null,
    assignees: [],
    reviewers: [],
    milestone: null,
    labels: [],
    pipeline: {
      id: pipelineId,
      status: pipelineStatus,
      ref: "feature/fix",
      sha: headSha,
      webUrl: `https://gitlab.invalid/group/demo/-/pipelines/${pipelineId}`,
      source: "merge_request_event",
      createdAt: "2026-09-14T01:01:00.000Z",
      updatedAt: "2026-09-14T01:02:00.000Z",
      duration: null,
      coverage: null,
    },
    changes: [],
    notes: pipelineFailed ? [] : [{
      id: `note-${headSha}`,
      body: reviewReport,
      author: null,
      createdAt: "2026-09-14T01:03:00.000Z",
      updatedAt: null,
      system: false,
      resolvable: false,
    }],
    pipelines: [],
  };
}

function fakeGitLab(state: FakeState): GitLabClientPort {
  return {
    async getCurrentUser() {
      return { id: "71", username: "alice", name: "Alice", email: "alice@example.com", commit_email: "alice@example.com", webUrl: null, avatarUrl: null };
    },
    async getProject() {
      return {
        id: "10",
        name: "Demo",
        path: "demo",
        pathWithNamespace: "group/demo",
        nameWithNamespace: "Group / Demo",
        webUrl: null,
        defaultBranch: "dev",
        visibility: "private",
        lastActivityAt: null,
        avatarUrl: null,
      };
    },
    async getMergeRequestDetails() {
      state.detailCalls = (state.detailCalls ?? 0) + 1;
      const drifted = state.driftAfterCall !== undefined && state.detailCalls >= state.driftAfterCall;
      return fakeDetail(state, drifted ? "other-head" : state.headSha);
    },
    async updateMergeRequest(_projectId, _iid, input) {
      if (input.title !== undefined) {
        state.title = input.title;
        state.updateTitles?.push(input.title);
      }
      return fakeDetail(state);
    },
    async listPipelines() { return []; },
    async listPipelineJobs(_projectId, pipelineId) {
      const headSha = pipelineId.replace("pipeline-", "");
      if (state.mode === "pipeline-failure") return [{
        id: `build-${headSha}`,
        name: "build",
        stage: "test",
        status: "failed",
        webUrl: null,
        createdAt: "2026-09-14T01:01:00.000Z",
        startedAt: "2026-09-14T01:01:00.000Z",
        finishedAt: "2026-09-14T01:02:00.000Z",
        duration: null,
        allowFailure: false,
        failureReason: "script_failure",
      }, {
        id: `review-${headSha}`,
        name: "claude-mr-agent",
        stage: "review",
        status: "success",
        webUrl: null,
        createdAt: "2026-09-14T01:01:00.000Z",
        startedAt: "2026-09-14T01:01:00.000Z",
        finishedAt: "2026-09-14T01:02:00.000Z",
        duration: null,
        allowFailure: false,
        failureReason: null,
      }];
      return [{
        id: `review-${headSha}`,
        name: "claude-mr-agent",
        stage: "review",
        status: "success",
        webUrl: null,
        createdAt: "2026-09-14T01:01:00.000Z",
        startedAt: "2026-09-14T01:01:00.000Z",
        finishedAt: "2026-09-14T01:02:00.000Z",
        duration: null,
        allowFailure: false,
        failureReason: null,
      }];
    },
    async getPipelineJobTrace(_projectId, jobId) {
      return jobId.startsWith("build-") ? "Error: assertion failed while testing the changed code" : state.mode === "review-findings" ? findingsReport() : passedReport();
    },
  };
}

function fakeEditAndExecution(state: FakeState) {
  const session = {
    id: "edit-session",
    ownerKey: "gitlab-mr-ai:user-1",
    projectId: "10",
    projectPath: "group/demo",
    baseRef: "feature/fix",
    baseSha: "head-1",
    workspacePath: "/tmp/gitlab-mr-ai-test",
    pendingOperationCount: 0,
  };
  const publish = vi.fn(async (_id: string, _owner: string, input: { expectedRemoteSha?: string | null; onCommitted: (sha: string) => void }) => {
    expect(input.expectedRemoteSha).toBe(state.headSha);
    const next = `head-${(state.published ?? 0) + 2}`;
    input.onCommitted(next);
    state.headSha = next;
    state.published = (state.published ?? 0) + 1;
    state.mode = state.published >= (state.repairRoundsBeforePass ?? 1) ? "passed" : "review-findings";
    return next;
  });
  const edits = {
    createSession: vi.fn(async () => {
      if (state.createSessionGate) await state.createSessionGate;
      return { ...session, status: "active", retentionMode: "auto", createdAt: "2026-09-14T01:00:00.000Z", updatedAt: "2026-09-14T01:00:00.000Z", expiresAt: "2026-09-15T01:00:00.000Z", changedFiles: 0, pendingOperationCount: 0, operations: [] };
    }),
    getRunnerContext: vi.fn(async () => session),
    getDiff: vi.fn(async () => ({ session: { ...session, status: "active", retentionMode: "pinned", createdAt: "2026-09-14T01:00:00.000Z", updatedAt: "2026-09-14T01:00:00.000Z", expiresAt: "2026-09-15T01:00:00.000Z", changedFiles: 1, pendingOperationCount: 0, operations: [] }, diff: "diff", changedFiles: 1 })),
    publish,
    setRetentionMode: vi.fn(async () => ({ ...session, status: "active", retentionMode: "pinned", createdAt: "2026-09-14T01:00:00.000Z", updatedAt: "2026-09-14T01:00:00.000Z", expiresAt: "2026-09-15T01:00:00.000Z", changedFiles: 0, pendingOperationCount: 0, operations: [] })),
    getSession: vi.fn(async () => null),
    closeSession: vi.fn(async () => null),
  } as unknown as AssistantEditService;
  let runNumber = 0;
  const execution = {
    createRun: vi.fn(() => ({ run: { id: `run-${++runNumber}` } })),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(),
  } as unknown as AssistantExecutionManager;
  const assistant = {
    appendMessage: vi.fn(),
    getRun: vi.fn(() => ({ status: "completed", error: null })),
    listRuns: vi.fn(() => []),
  } as unknown as AssistantStore;
  return { edits, execution, assistant, publish };
}

async function waitForTerminal(service: GitLabMrAiRepairService, id: string): Promise<StoredGitLabMrAiRepairTask["status"]> {
  for (let attempt = 0; attempt < 4_000; attempt += 1) {
    const task = await service.detail(id, identity);
    if (["mr_open", "merged", "closed", "failed", "canceled"].includes(task.task.status)) return task.task.status;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("AI MR task did not reach a terminal state");
}

function createService(state: FakeState) {
  const store = new GitLabMrAiRepairStore(":memory:");
  const fake = fakeEditAndExecution(state);
  const reviewDecisionRunner = {
    judgeGitLabReview: vi.fn(async ({ report }: { report: string }) => ({
      needsRepair: report.includes("| ---"),
      reason: report.includes("| ---") ? "测试报告包含待修复条目。" : "测试报告没有需要修复的代码问题。",
    })),
  };
  const service = new GitLabMrAiRepairService({
    store,
    edits: fake.edits,
    assistant: fake.assistant,
    execution: fake.execution,
    dependencies: async () => ({ gitlab: fakeGitLab(state), connection }),
    concurrency: 1,
    verificationPollIntervalMs: state.pollIntervalMs ?? 0,
    verificationTimeoutMs: state.verificationTimeoutMs ?? 2_000,
    reviewDecisionRunner,
  });
  return { service, store, fake, reviewDecisionRunner };
}

describe("GitLab MR AI repair persistence", () => {
  it("keeps a single claim for one MR and hides private connection fields", () => {
    const store = new GitLabMrAiRepairStore(":memory:");
    const task = {
      id: "11111111-1111-4111-8111-111111111111",
      userId: "user-1",
      projectId: "10",
      projectPath: "group/demo",
      sourceProjectId: "10",
      sourceProjectPath: "group/demo",
      mrIid: "42",
      title: "MR",
      mrUrl: null,
      sourceBranch: "feature/fix",
      targetBranch: "dev",
      status: "queued" as const,
      phase: "排队中",
      createdAt: "2026-09-14T01:00:00.000Z",
      updatedAt: "2026-09-14T01:00:00.000Z",
      editSessionId: null,
      assistantRunId: null,
      commitSha: "head-1",
      verification: null,
      error: null,
      syncedAt: null,
      syncError: null,
      identity,
      gitlabUserId: "71",
      gitlabApiBaseUrl: connection.apiBaseUrl,
      conversationId: "22222222-2222-4222-8222-222222222222",
      editCompleted: false,
    } satisfies StoredGitLabMrAiRepairTask;
    try {
      expect(store.claimMr("10", "42", task.id, "user-1")).toBe(true);
      expect(store.claimMr("10", "42", "another-task", "user-2")).toBe(false);
      store.save(task);
      const publicTask = publicGitLabMrAiRepairTask(store.get(task.id, "user-1")!);
      expect(publicTask).not.toHaveProperty("identity");
      expect(publicTask).not.toHaveProperty("gitlabApiBaseUrl");
    } finally {
      store.close();
    }
  });
});

describe("GitLab MR AI repair loop", () => {
  it("marks a passing current MR without creating a repair commit", async () => {
    const { service, store, fake, reviewDecisionRunner } = createService({ headSha: "head-1", mode: "passed" });
    try {
      const started = await service.start("10", "42", { confirmed: true }, identity);
      const status = await waitForTerminal(service, started.id);
      expect(status).toBe("mr_open");
      expect(fake.execution.start).not.toHaveBeenCalled();
      expect(fake.publish).not.toHaveBeenCalled();
      expect(reviewDecisionRunner.judgeGitLabReview).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
      store.close();
    }
  });

  it("does not let polling replace the active task state", async () => {
    let releaseSession!: () => void;
    const createSessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const { service, store, fake } = createService({ headSha: "head-1", mode: "passed", createSessionGate });

    try {
      const started = await service.start("10", "42", { confirmed: true }, identity);
      await vi.waitFor(() => expect(fake.edits.createSession).toHaveBeenCalledTimes(1));
      expect((await service.find("10", "42", identity))?.status).toBe("preparing");

      releaseSession();
      expect(await waitForTerminal(service, started.id)).toBe("mr_open");
      expect((await service.detail(started.id, identity)).task).toMatchObject({
        status: "mr_open",
        editSessionId: "edit-session",
        verification: { headSha: "head-1", reviewStatus: "passed" },
      });
      expect(store.get(started.id, identity.userId)).toMatchObject({ status: "mr_open", editSessionId: "edit-session" });
    } finally {
      releaseSession();
      await service.close();
      store.close();
    }
  });

  it("continues Pipeline Review repair beyond three rounds until it passes", async () => {
    const { service, store, fake } = createService({ headSha: "head-1", mode: "review-findings", repairRoundsBeforePass: 4, verificationTimeoutMs: 10_000 });

    try {
      const started = await service.start("10", "42", { confirmed: true }, identity);
      expect(await waitForTerminal(service, started.id)).toBe("mr_open");
      expect(fake.execution.start).toHaveBeenCalledTimes(4);
      expect(fake.publish).toHaveBeenCalledTimes(4);
      expect((await service.detail(started.id, identity)).task).toMatchObject({
        status: "mr_open",
        commitSha: "head-5",
        verification: { reviewStatus: "passed", repairAttempts: 4 },
      });
    } finally {
      await service.close();
      store.close();
    }
  });

  it("does not time out while the current Pipeline is still running", async () => {
    const state: FakeState = { headSha: "head-1", mode: "passed", pipelineStatus: "running", pollIntervalMs: 10, verificationTimeoutMs: 1_000 };
    const { service, store } = createService(state);

    try {
      const started = await service.start("10", "42", { confirmed: true }, identity);
      await vi.waitFor(() => expect(store.get(started.id, identity.userId)).toMatchObject({
        status: "pipeline_pending",
        verification: { pipelineStatus: "running" },
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
      expect(store.get(started.id, identity.userId)).toMatchObject({ status: "pipeline_pending", error: null });

      state.pipelineStatus = "success";
      expect(await waitForTerminal(service, started.id)).toBe("mr_open");
    } finally {
      await service.close();
      store.close();
    }
  });

  it("removes the Draft prefix after the current MR passes verification", async () => {
    const state: FakeState = { headSha: "head-1", mode: "passed", title: "Draft: 修复 MR 自动验证问题", updateTitles: [] };
    const { service, store } = createService(state);
    try {
      const started = await service.start("10", "42", { confirmed: true }, identity);
      expect(await waitForTerminal(service, started.id)).toBe("mr_open");
      expect(state.updateTitles).toEqual(["修复 MR 自动验证问题"]);
      expect((await service.detail(started.id, identity)).task.title).toBe("修复 MR 自动验证问题");
    } finally {
      await service.close();
      store.close();
    }
  });

  it("repairs review findings, publishes to the same source branch, and verifies the new head", async () => {
    const { service, store, fake } = createService({ headSha: "head-1", mode: "review-findings" });
    try {
      const started = await service.start("10", "42", { confirmed: true }, identity);
      const status = await waitForTerminal(service, started.id);
      expect(status).toBe("mr_open");
      expect(fake.execution.start).toHaveBeenCalledTimes(1);
      expect(fake.publish).toHaveBeenCalledWith("edit-session", "gitlab-mr-ai:user-1", expect.objectContaining({ branch: "feature/fix", expectedRemoteSha: "head-1" }));
      expect((await service.detail(started.id, identity)).task).toMatchObject({ commitSha: "head-2", verification: { headSha: "head-2", reviewStatus: "passed", repairAttempts: 1 } });
    } finally {
      await service.close();
      store.close();
    }
  });

  it("uses a failed Pipeline Job trace as repair feedback before rechecking Review", async () => {
    const { service, store, fake } = createService({ headSha: "head-1", mode: "pipeline-failure" });
    try {
      const started = await service.start("10", "42", { confirmed: true }, identity);
      expect(await waitForTerminal(service, started.id)).toBe("mr_open");
      expect(fake.execution.start).toHaveBeenCalledTimes(1);
      expect(fake.publish).toHaveBeenCalledWith("edit-session", "gitlab-mr-ai:user-1", expect.objectContaining({ expectedRemoteSha: "head-1" }));
    } finally {
      await service.close();
      store.close();
    }
  });

  it("stops before AI and publish when the MR head drifts", async () => {
    const { service, store, fake } = createService({ headSha: "head-1", mode: "review-findings", driftAfterCall: 3 });
    try {
      const started = await service.start("10", "42", { confirmed: true }, identity);
      expect(await waitForTerminal(service, started.id)).toBe("failed");
      expect(fake.execution.start).not.toHaveBeenCalled();
      expect(fake.publish).not.toHaveBeenCalled();
      expect((await service.detail(started.id, identity)).task.error).toContain("其他提交");
    } finally {
      await service.close();
      store.close();
    }
  });
});
