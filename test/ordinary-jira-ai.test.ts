import { describe, expect, it, vi } from "vitest";
import type { JiraIssueDetails } from "../src/api-contracts.js";
import { OrdinaryJiraAiTaskDetailSchema, OrdinaryJiraAiTaskSchema, OrdinaryJiraAiTaskSummarySchema } from "../src/api-contracts.js";
import {
  buildJiraAiPrecheckPrompt,
  buildJiraAiPrecheckSupplementPrompt,
  jiraAiContentHash,
  normalizeJiraAiPrecheckOutput,
  normalizeJiraAiPrecheckSupplementOutput,
  ORDINARY_JIRA_AI_CHECKS,
  type JiraAiPrecheckResult,
  type JiraAiPrecheckSupplementInput,
  type JiraAiPrecheckSupplementResult,
} from "../src/jira-ai-precheck.js";
import { OrdinaryJiraAiStore, publicOrdinaryJiraAiTask, publicOrdinaryJiraAiTaskSummary, type StoredOrdinaryJiraAiTask } from "../src/ordinary-jira-ai-store.js";
import { OrdinaryJiraAiService } from "../src/ordinary-jira-ai-service.js";
import { AssistantExecutionManager } from "../src/assistant-execution.js";
import { AssistantStore } from "../src/assistant-store.js";
import type { AssistantRunner } from "../src/assistant-runner.js";
import type { AssistantEditService } from "../src/assistant-edit-service.js";
import type { JiraClientPort } from "../src/jira-client.js";
import type { GitLabClientPort } from "../src/gitlab-client.js";
import type { GitLabMergeRequestDetails, GitLabPipelineJob, GitLabPipelineSummary } from "../src/gitlab-workbench.js";
import type { PreSubmitReviewInput, ReviewProfile, ReviewProgressInput } from "../src/contracts.js";

function issue(overrides: Partial<JiraIssueDetails> = {}): JiraIssueDetails {
  return {
    id: "100",
    key: "AIP-42",
    summary: "修复普通 Jira 问题",
    description: "问题现象：保存后数据丢失。\n期望结果：保存后数据保持不变。",
    status: "待处理",
    statusId: "1",
    statusCategory: "new",
    issueType: "故障",
    priority: "重要",
    projectKey: "AIP",
    projectName: "AIP",
    webUrl: "https://jira.invalid/browse/AIP-42",
    createdAt: "2026-09-12T01:00:00.000Z",
    updatedAt: "2026-09-12T02:00:00.000Z",
    resolution: null,
    labels: [],
    assignee: null,
    reporter: null,
    comments: [{ id: "comment-1", body: "验收标准：刷新页面后数据仍然存在。", author: null, createdAt: "2026-09-12T02:00:00.000Z", updatedAt: null }],
    attachments: [],
    ...overrides,
  };
}

function task(): StoredOrdinaryJiraAiTask {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "user-1",
    jiraKey: "AIP-42",
    title: "修复普通 Jira 问题",
    jiraUrl: "https://jira.invalid/browse/AIP-42",
    projectId: "10",
    projectPath: "aip/frontend",
    targetBranch: "dev",
    sourceBranch: "ai/jira-aip-42-111111111111",
    status: "queued",
    phase: "已进入队列",
    createdAt: "2026-09-12T02:00:00.000Z",
    updatedAt: "2026-09-12T02:00:00.000Z",
    editSessionId: null,
    assistantRunId: null,
    commitSha: null,
    mr: null,
    precheck: {
      id: "22222222-2222-4222-8222-222222222222",
      jiraKey: "AIP-42",
      jiraUpdatedAt: "2026-09-12T02:00:00.000Z",
      contentHash: "a".repeat(64),
      checkedAt: "2026-09-12T02:00:00.000Z",
      status: "passed",
      checks: ORDINARY_JIRA_AI_CHECKS.map(({ id, label }) => ({ id, label, status: "present" as const, evidence: "Jira 原文", detail: "" })),
      summary: "检查通过",
      implementationBrief: { problem: "问题", expected: "期望", scope: "范围", reproduction: "复现", acceptance: "验收", constraints: "约束" },
      projectPath: "aip/frontend",
      targetBranch: "dev",
      error: null,
    },
    preReview: null,
    verification: null,
    error: null,
    syncedAt: null,
    syncError: null,
    identity: { userId: "user-1", username: "alice" },
    jiraDescription: "private description",
    jiraContext: "private context",
    gitlabUserId: "71",
    gitlabApiBaseUrl: "https://gitlab.example.com/api/v4",
    conversationId: "33333333-3333-4333-8333-333333333333",
    editCompleted: false,
  };
}

async function createOrdinaryFlowFixture(options: {
  preSubmitReview?: (input: PreSubmitReviewInput, runtime?: { onProgress?: (event: ReviewProgressInput) => void }) => string;
  precheckResult?: JiraAiPrecheckResult | ((input: JiraIssueDetails) => JiraAiPrecheckResult);
  supplement?: (input: JiraAiPrecheckSupplementInput) => JiraAiPrecheckSupplementResult | Promise<JiraAiPrecheckSupplementResult>;
} = {}) {
  const store = new OrdinaryJiraAiStore(":memory:");
  const assistant = new AssistantStore(":memory:");
  const identity = { userId: "user-1", username: "alice" };
  const project = { id: "10", name: "Frontend", path: "frontend", pathWithNamespace: "aip/frontend", nameWithNamespace: "AIP / Frontend", webUrl: null, defaultBranch: "dev", visibility: "private", lastActivityAt: null, avatarUrl: null };
  const sessionView = { id: "edit-session-1", projectId: "10", projectPath: "aip/frontend", baseRef: "dev", baseSha: "base-sha", status: "active" as const, retentionMode: "pinned" as const, createdAt: "2026-09-15T02:00:00.000Z", updatedAt: "2026-09-15T02:00:00.000Z", expiresAt: "2026-09-16T02:00:00.000Z", changedFiles: 1, pendingOperationCount: 0, operations: [] };
  const editContext = { id: sessionView.id, ownerKey: "jira-ai:user-1", projectPath: "aip/frontend", baseRef: "dev", baseSha: "base-sha", workspacePath: "/tmp/ordinary-jira-ai-test", pendingOperationCount: 0 };
  const edits = {
    createSession: async () => sessionView,
    getRunnerContext: async () => editContext,
    getDiff: async () => ({ session: sessionView, diff: "diff --git a/demo.ts b/demo.ts\n+old\n+new\n", changedFiles: 1 }),
    getSession: async () => sessionView,
    setRetentionMode: async () => sessionView,
    publish: async (_id: string, _owner: string, input: { onCommitted?: (sha: string) => void }) => { input.onCommitted?.("commit-sha"); return "commit-sha"; },
  } as unknown as AssistantEditService;
  const runner: AssistantRunner = { run: async (_input, runtime) => { runtime?.onProgress?.({ kind: "tool", activityId: "ordinary-edit", toolName: "apply_file_patch", message: "已修改代码", phase: "complete" }); return "已完成代码修改。"; } };
  const execution = new AssistantExecutionManager(runner, assistant);
  let reviewCalls = 0;
  let mr: GitLabMergeRequestDetails | null = null;
  const createdTitles: string[] = [];
  const updatedTitles: string[] = [];
  const report = "## Claude 代码审查报告\n\n### 规则审查\n✅ 未发现规则违规\n\n### 高价值问题\n✅ 未发现高价值问题\n\n✅ 全部通过";
  const reviewJob: GitLabPipelineJob = { id: "review-job-1", name: "claude-mr-agent", stage: "review", status: "success", webUrl: "https://gitlab.example/jobs/1", createdAt: "2026-09-15T02:01:00.000Z", startedAt: "2026-09-15T02:01:00.000Z", finishedAt: "2026-09-15T02:02:00.000Z", duration: 60, allowFailure: false, failureReason: null };
  const pipeline: GitLabPipelineSummary = { id: "pipeline-1", status: "success", ref: "ai/jira-aip-42-example", sha: "commit-sha", webUrl: "https://gitlab.example/pipelines/1", source: "merge_request_event", createdAt: "2026-09-15T02:01:00.000Z", updatedAt: "2026-09-15T02:02:00.000Z", duration: 60, coverage: null };
  const gitlab: GitLabClientPort = {
    getCurrentUser: async () => ({ id: "71", username: "alice", name: "Alice", email: "alice@example.com", commit_email: "alice@example.com", webUrl: null, avatarUrl: null }),
    getProject: async () => project,
    getMergeRequestCreateOptions: async () => ({ currentUser: { id: "71", username: "alice", name: "Alice", webUrl: null, avatarUrl: null }, branches: [{ name: "dev", isDefault: true, isProtected: true, commitSha: "base-sha", commitTitle: "", commitMessage: "" }], members: [], milestones: [], labels: [] }),
    listMergeRequests: async () => mr ? [mr] : [],
    getMergeRequestDetails: async () => {
      if (!mr) throw new Error("MR not found");
      return { ...mr, headSha: "commit-sha", pipeline, pipelines: [pipeline], notes: [{ id: "note-1", body: report, author: null, createdAt: reviewJob.finishedAt, updatedAt: reviewJob.finishedAt, system: false, resolvable: false }] };
    },
    listPipelines: async () => [pipeline],
    listPipelineJobs: async () => [reviewJob],
    getPipelineJobTrace: async () => `===== Claude Review 输出 =====\n${report}\n发送评论到 MR...`,
    createMergeRequest: async (input) => {
      createdTitles.push(input.title);
      mr = { id: "mr-1", iid: "1", projectId: input.targetProjectId, projectPath: "aip/frontend", title: input.title, description: input.description, state: "opened", draft: input.title.startsWith("Draft: "), webUrl: "https://gitlab.example/aip/frontend/-/merge_requests/1", createdAt: "2026-09-15T02:01:00.000Z", updatedAt: "2026-09-15T02:01:00.000Z", sourceBranch: input.sourceBranch, targetBranch: input.targetBranch, headSha: "commit-sha", author: null, assignees: [], reviewers: [], milestone: null, labels: input.labels, pipeline, changes: [{ oldPath: "demo.ts", newPath: "demo.ts", diff: "", changeType: "modified" }], notes: [], pipelines: [pipeline] };
      return mr;
    },
    updateMergeRequest: async (_projectId, _iid, input) => {
      if (!mr || !input.title) throw new Error("MR not found");
      updatedTitles.push(input.title);
      mr = { ...mr, title: input.title, draft: false };
      return mr;
    },
  };
  let currentIssue = issue();
  const jira = {
    getIssue: async () => currentIssue,
    addComment: async (_key: string, body: string) => {
      const comment = { id: `ai-comment-${currentIssue.comments.length + 1}`, body, author: null, createdAt: "2026-09-15T03:00:00.000Z", updatedAt: null };
      currentIssue = { ...currentIssue, comments: [...currentIssue.comments, comment], updatedAt: "2026-09-15T03:00:00.000Z" };
      return comment;
    },
  } as unknown as JiraClientPort;
  const modelResult = normalizeJiraAiPrecheckOutput({ checks: ORDINARY_JIRA_AI_CHECKS.map(({ id, label }) => ({ id, label, status: "present", evidence: "Jira 原文", detail: "" })), summary: "检查通过", implementationBrief: { problem: "问题", expected: "期望", scope: "范围", reproduction: "复现", acceptance: "验收", constraints: "约束" } });
  const precheckResult = options.precheckResult ?? modelResult;
  const reviewProfile: ReviewProfile = { name: "default", displayName: "默认", rules: [] };
  const service = new OrdinaryJiraAiService({ store, edits, assistant, execution, dependencies: async () => ({ gitlab, jira, connection: { baseUrl: "https://gitlab.example", apiBaseUrl: "https://gitlab.example/api/v4", token: "token" } }), precheckRunner: { runJiraAiPrecheck: async (input) => typeof precheckResult === "function" ? precheckResult(input.issue) : precheckResult, ...(options.supplement ? { runJiraAiPrecheckSupplement: options.supplement } : {}) }, preSubmitReview: { runPreSubmitReview: async (input, runtime) => { reviewCalls++; runtime?.onProgress?.({ kind: "stage", message: "正在检查候选代码" }); return options.preSubmitReview?.(input, runtime) ?? JSON.stringify({ summary: "通过", requirementChecks: [{ requirement: "问题已修复", status: "satisfied", evidence: "demo.ts:1" }], ruleResults: [], findings: [] }); } }, reviewProfile: async () => reviewProfile, reviewDecisionRunner: { judgeGitLabReview: async () => ({ needsRepair: false, reason: "测试通过" }) }, verificationPollIntervalMs: 0, verificationTimeoutMs: 2_000, maxPreSubmitRepairAttempts: 2 });
  return { service, store, assistant, execution, identity, createdTitles, updatedTitles, get mr() { return mr; }, get jiraComments() { return currentIssue.comments; }, get reviewCalls() { return reviewCalls; }, close: async () => { await service.close(); await execution.close(); assistant.close(); store.close(); } };
}

describe("ordinary Jira AI precheck", () => {
  it("uses Jira description and comments as the only precheck material", () => {
    const prompt = buildJiraAiPrecheckPrompt({ issue: issue(), projectPath: "aip/frontend", targetBranch: "dev" });

    expect(prompt).toContain("问题现象：保存后数据丢失");
    expect(prompt).toContain("验收标准：刷新页面后数据仍然存在");
    expect(prompt).toContain("不要用常识补齐 Jira 没有提供的要求");
    expect(prompt).toContain("附件文件名（仅供线索，未读取附件内容）");
  });

  it("normalizes the checklist to the six fixed items and blocks missing context", () => {
    const result = normalizeJiraAiPrecheckOutput({
      checks: [
        ...ORDINARY_JIRA_AI_CHECKS.slice(0, 5).reverse().map(({ id, label }) => ({ id, label, status: "present", evidence: `${label} 原文`, detail: "" })),
        { id: "constraints", label: "兼容性 / 约束", status: "missing", evidence: "", detail: "没有写明兼容性约束" },
      ],
      summary: "缺少约束",
      implementationBrief: { problem: "问题", expected: "期望", scope: "范围", reproduction: "复现", acceptance: "验收", constraints: "" },
    });

    expect(result.status).toBe("needs_input");
    expect(result.checks.map((check) => check.id)).toEqual(ORDINARY_JIRA_AI_CHECKS.map(({ id }) => id));
    expect(result.checks.find((check) => check.id === "constraints")).toMatchObject({ status: "missing", detail: "没有写明兼容性约束" });
  });

  it("changes the content fingerprint when a Jira comment changes", () => {
    const original = jiraAiContentHash({ issue: issue(), projectPath: "aip/frontend", targetBranch: "dev" });
    const updated = jiraAiContentHash({ issue: issue({ comments: [{ id: "comment-1", body: "补充：兼容旧版浏览器。", author: null, createdAt: "2026-09-12T02:00:00.000Z", updatedAt: null }] }), projectPath: "aip/frontend", targetBranch: "dev" });

    expect(updated).not.toBe(original);
  });

  it("only accepts an AI supplement when it includes a concrete suggestion and Jira evidence", () => {
    const prompt = buildJiraAiPrecheckSupplementPrompt({
      issue: issue(),
      projectPath: "aip/frontend",
      targetBranch: "dev",
      check: { id: "constraints", label: "兼容性 / 约束", instruction: "说明不能违反的约束", detail: "没有找到约束" },
    });
    expect(prompt).toContain("不要读取代码");
    expect(prompt).toContain("只有 Jira 原文明确给出");

    expect(normalizeJiraAiPrecheckSupplementOutput({ status: "resolvable", suggestion: "兼容 Chrome 120 及以上。", evidence: "Jira 评论写明支持 Chrome 120。", reason: "" })).toEqual({
      status: "resolvable",
      suggestion: "兼容 Chrome 120 及以上。",
      evidence: "Jira 评论写明支持 Chrome 120。",
      reason: "已从 Jira 原文整理出可核对的补充内容。",
    });
    expect(normalizeJiraAiPrecheckSupplementOutput({ status: "resolvable", suggestion: "", evidence: "", reason: "Jira 没有写明兼容范围" })).toEqual({
      status: "needs_user",
      suggestion: "",
      evidence: "",
      reason: "Jira 没有写明兼容范围",
    });
  });

  it("writes a confirmed AI supplement as a Jira comment and rechecks the updated issue", async () => {
    const missing = normalizeJiraAiPrecheckOutput({
      checks: ORDINARY_JIRA_AI_CHECKS.map(({ id, label }) => ({ id, label, status: id === "constraints" ? "missing" : "present", evidence: id === "constraints" ? "" : "Jira 原文", detail: id === "constraints" ? "没有找到兼容性约束" : "" })),
      summary: "缺少约束",
      implementationBrief: { problem: "问题", expected: "期望", scope: "范围", reproduction: "复现", acceptance: "验收", constraints: "" },
    });
    const passed = normalizeJiraAiPrecheckOutput({
      checks: ORDINARY_JIRA_AI_CHECKS.map(({ id, label }) => ({ id, label, status: "present", evidence: "Jira 原文", detail: "" })),
      summary: "检查通过",
      implementationBrief: { problem: "问题", expected: "期望", scope: "范围", reproduction: "复现", acceptance: "验收", constraints: "兼容 Chrome 120 及以上" },
    });
    const f = await createOrdinaryFlowFixture({
      precheckResult: (nextIssue) => nextIssue.comments.some((comment) => comment.body.includes("AI 补充")) ? passed : missing,
      supplement: async function (this: { runJiraAiPrecheck?: unknown }) {
        expect(this.runJiraAiPrecheck).toBeTypeOf("function");
        return { status: "resolvable", suggestion: "兼容 Chrome 120 及以上。", evidence: "Jira 评论明确写明支持 Chrome 120。", reason: "" };
      },
    });
    try {
      const input = { projectId: "10", projectPath: "aip/frontend", targetBranch: "dev" };
      const precheck = await f.service.precheck("AIP-42", input, f.identity);
      expect(precheck.status).toBe("needs_input");
      expect(f.jiraComments).toHaveLength(1);

      const suggestion = await f.service.suggestPrecheckSupplement("AIP-42", { ...input, precheckId: precheck.id, checkId: "constraints" }, f.identity);
      expect(suggestion).toMatchObject({ checkId: "constraints", status: "resolvable", suggestion: "兼容 Chrome 120 及以上。" });
      expect(f.jiraComments).toHaveLength(1);

      const refreshed = await f.service.confirmPrecheckSupplement("AIP-42", { ...input, precheckId: precheck.id, checkId: "constraints", supplement: suggestion.suggestion }, f.identity);
      expect(refreshed.status).toBe("passed");
      expect(refreshed.id).not.toBe(precheck.id);
      expect(f.jiraComments.at(-1)?.body).toContain("AI 补充（兼容性 / 约束）");
      expect(f.jiraComments.at(-1)?.body).toContain("兼容 Chrome 120 及以上。");
    } finally { await f.close(); }
  });

  it("validates the selected project by its stable GitLab id instead of searching the full namespace path", async () => {
    const store = new OrdinaryJiraAiStore(":memory:");
    const project = {
      id: "10",
      name: "Frontend",
      path: "frontend",
      pathWithNamespace: "aip/frontend",
      nameWithNamespace: "AIP / Frontend",
      webUrl: null,
      defaultBranch: "dev",
      visibility: "private",
      lastActivityAt: null,
      avatarUrl: null,
    };
    const gitlab = {
      async getProject(projectId: string) {
        expect(projectId).toBe("10");
        return project;
      },
      async listProjects() {
        throw new Error("project search should not be used when getProject is available");
      },
      async getMergeRequestCreateOptions() {
        return {
          currentUser: { id: "1", username: "alice", name: "Alice", webUrl: null, avatarUrl: null },
          branches: [{ name: "dev", isDefault: true, isProtected: true, commitSha: "sha", commitTitle: "", commitMessage: "" }],
          members: [],
          milestones: [],
          labels: [],
        };
      },
    } as unknown as GitLabClientPort;
    const jira = { async getIssue() { return issue(); } } as unknown as JiraClientPort;
    const modelResult = normalizeJiraAiPrecheckOutput({
      checks: ORDINARY_JIRA_AI_CHECKS.map(({ id, label }) => ({ id, label, status: "present", evidence: "Jira 原文", detail: "" })),
      summary: "检查通过",
      implementationBrief: Object.fromEntries(ORDINARY_JIRA_AI_CHECKS.map(({ id }) => [id, "已确认"])),
    });
    let resolveModelResult!: (result: typeof modelResult) => void;
    const modelResultPromise = new Promise<typeof modelResult>((resolve) => { resolveModelResult = resolve; });
    const service = new OrdinaryJiraAiService({
      store,
      edits: {} as AssistantEditService,
      assistant: { listRuns: () => [] } as never,
      execution: {} as AssistantExecutionManager,
      dependencies: async () => ({ gitlab, jira, connection: { baseUrl: "https://gitlab.example.com", apiBaseUrl: "https://gitlab.example.com/api/v4", token: "token" } }),
      precheckRunner: {
        async runJiraAiPrecheck() { return modelResultPromise; },
      },
      reviewDecisionRunner: { async judgeGitLabReview() { return { needsRepair: false, reason: "测试通过" }; } },
    });
    try {
      const precheckPromise = service.precheck("AIP-42", { projectId: "10", projectPath: "aip/frontend", targetBranch: "dev" }, { userId: "user-1", username: "alice" });
      expect(service.findPrecheck("AIP-42", { userId: "user-1", username: "alice" })).toEqual({ status: "processing", precheck: null, projectId: "10" });
      resolveModelResult(modelResult);
      const precheck = await precheckPromise;
      expect(precheck).toMatchObject({ status: "passed", projectPath: "aip/frontend", targetBranch: "dev" });
      expect(service.findPrecheck("AIP-42", { userId: "user-1", username: "alice" })).toMatchObject({ status: "ready", projectId: "10", precheck: { id: precheck.id } });
    } finally {
      await service.close();
      store.close();
    }
  });
});

describe("ordinary Jira AI workflow", () => {
  it("runs the user flow through Draft MR creation and removes Draft only after verification passes", async () => {
    const f = await createOrdinaryFlowFixture();
    try {
      const precheck = await f.service.precheck("AIP-42", { projectId: "10", projectPath: "aip/frontend", targetBranch: "dev" }, f.identity);
      const started = await f.service.start("AIP-42", { projectId: "10", projectPath: "aip/frontend", targetBranch: "dev", precheckId: precheck.id, confirmed: true }, f.identity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: 10_000 });
      const detail = OrdinaryJiraAiTaskDetailSchema.parse(await f.service.detail(started.id, f.identity));
      expect(detail.task.mr).toMatchObject({ state: "opened" });
      expect(detail.execution?.status).toBe("completed");
      expect(detail.executions).toHaveLength(1);
      expect(f.createdTitles).toEqual(["Draft: 修复普通 Jira 问题 (#AIP-42)"]);
      expect(f.updatedTitles).toEqual(["修复普通 Jira 问题 (#AIP-42)"]);
      expect(f.mr).toMatchObject({ title: "修复普通 Jira 问题 (#AIP-42)", draft: false });

      const reopened = OrdinaryJiraAiTaskDetailSchema.parse(await f.service.detail(started.id, f.identity));
      expect(reopened.execution?.id).toBe(detail.execution?.id);
      expect(reopened.executions.map((run) => run.id)).toEqual(detail.executions.map((run) => run.id));
    } finally { await f.close(); }
  });

  it("creates the MR after two pre-submit repair rounds and leaves remaining findings to Pipeline", async () => {
    const f = await createOrdinaryFlowFixture({
      preSubmitReview: (_input, runtime) => {
        runtime?.onProgress?.({ kind: "tool", message: "Review 正在读取差异", detail: "demo.ts" });
        if (f.reviewCalls <= 3) return JSON.stringify({ summary: "需要修复", requirementChecks: [{ requirement: "问题已修复", status: "unclear", evidence: "仍需修复" }], ruleResults: [], findings: [{ severity: "high", category: "正确性", path: "demo.ts", line: 1, issue: "仍有问题", suggestion: "继续修复" }] });
        return JSON.stringify({ summary: "通过", requirementChecks: [{ requirement: "问题已修复", status: "satisfied", evidence: "demo.ts:1" }], ruleResults: [], findings: [] });
      },
    });
    try {
      const precheck = await f.service.precheck("AIP-42", { projectId: "10", projectPath: "aip/frontend", targetBranch: "dev" }, f.identity);
      const started = await f.service.start("AIP-42", { projectId: "10", projectPath: "aip/frontend", targetBranch: "dev", precheckId: precheck.id, confirmed: true }, f.identity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: 10_000 });
      const completed = OrdinaryJiraAiTaskDetailSchema.parse(await f.service.detail(started.id, f.identity));
      expect(completed.task.editSessionId).toBeTruthy();
      expect(completed.executions).toHaveLength(3);
      expect(f.reviewCalls).toBe(3);
      expect(completed.task.preReview).toMatchObject({ status: "findings", attempt: 3, blockingFindingCount: 1 });
      expect(f.createdTitles).toEqual(["Draft: 修复普通 Jira 问题 (#AIP-42)"]);
      expect(f.mr).toMatchObject({ title: "修复普通 Jira 问题 (#AIP-42)", draft: false });
    } finally { await f.close(); }
  });

  it("does not spend repair rounds on a static-only uncertainty", async () => {
    const f = await createOrdinaryFlowFixture({
      preSubmitReview: () => JSON.stringify({
        summary: "代码行为已覆盖，运行时结果交给 Pipeline 验证。",
        requirementChecks: [{ requirement: "问题已修复", status: "unclear", evidence: "静态代码已覆盖，无法从 Review 证明运行时结果" }],
        ruleResults: [],
        findings: [],
      }),
    });
    try {
      const precheck = await f.service.precheck("AIP-42", { projectId: "10", projectPath: "aip/frontend", targetBranch: "dev" }, f.identity);
      const started = await f.service.start("AIP-42", { projectId: "10", projectPath: "aip/frontend", targetBranch: "dev", precheckId: precheck.id, confirmed: true }, f.identity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: 10_000 });
      const detail = OrdinaryJiraAiTaskDetailSchema.parse(await f.service.detail(started.id, f.identity));
      expect(f.reviewCalls).toBe(1);
      expect(detail.task.preReview).toMatchObject({ status: "passed", missingRequirementCount: 0, unclearRequirementCount: 1 });
      expect(f.createdTitles).toEqual(["Draft: 修复普通 Jira 问题 (#AIP-42)"]);
    } finally { await f.close(); }
  });
});

describe("ordinary Jira AI persistence", () => {
  it("does not expose private task context in the public task contract", () => {
    const stored = task();
    const publicTask = publicOrdinaryJiraAiTask(stored);
    const summary = publicOrdinaryJiraAiTaskSummary(stored);

    expect(OrdinaryJiraAiTaskSchema.parse(publicTask)).toEqual(publicTask);
    expect(OrdinaryJiraAiTaskSummarySchema.parse(summary)).toEqual({
      id: stored.id,
      jiraKey: stored.jiraKey,
      status: stored.status,
      phase: stored.phase,
      updatedAt: stored.updatedAt,
      hasMr: false,
    });
    expect(publicTask).not.toHaveProperty("identity");
    expect(publicTask).not.toHaveProperty("jiraContext");
    expect(publicTask).not.toHaveProperty("gitlabUserId");
  });

  it("returns the latest card summary for requested Jira keys and the current user only", async () => {
    const f = await createOrdinaryFlowFixture();
    try {
      const older = task();
      const latest = { ...task(), id: "44444444-4444-4444-8444-444444444444", projectId: "11", updatedAt: "2026-09-12T03:00:00.000Z", status: "running" as const, phase: "正在处理代码" };
      const otherUser = { ...task(), id: "55555555-5555-4555-8555-555555555555", userId: "user-2", updatedAt: "2026-09-12T04:00:00.000Z" };
      f.store.save(older);
      f.store.save(latest);
      f.store.save(otherUser);

      expect(f.service.findSummaries(["aip-42", "AIP-404"], f.identity)).toEqual([{
        id: latest.id,
        jiraKey: latest.jiraKey,
        status: latest.status,
        phase: latest.phase,
        updatedAt: latest.updatedAt,
        hasMr: false,
      }]);
    } finally {
      await f.close();
    }
  });

  it("keeps a Jira claim exclusive across users", () => {
    const store = new OrdinaryJiraAiStore(":memory:");
    try {
      expect(store.claimJira("AIP-42", "10", "dev", "task-1", "user-1")).toBe(true);
      expect(store.claimJira("AIP-42", "10", "dev", "task-2", "user-2")).toBe(false);
      expect(store.claimJira("AIP-42", "10", "dev", "task-1", "user-1")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("recovers and keeps a passed verification when refreshing an open MR", async () => {
    const store = new OrdinaryJiraAiStore(":memory:");
    const stored = task();
    stored.status = "failed";
    stored.phase = "处理失败";
    stored.commitSha = "commit-sha";
    stored.mr = {
      projectId: "10",
      iid: "2041",
      webUrl: "https://gitlab.invalid/aip/frontend/-/merge_requests/2041",
      state: "opened",
      changedPaths: [],
    };
    stored.verification = {
      headSha: "commit-sha",
      pipelineId: "1348431",
      pipelineStatus: "success",
      pipelineWebUrl: "https://gitlab.invalid/aip/frontend/-/pipelines/1348431",
      reviewJobId: "review-job-1",
      reviewJobName: "claude-mr-agent",
      reviewJobStatus: "success",
      reviewJobWebUrl: "https://gitlab.invalid/aip/frontend/-/jobs/1",
      reviewNoteId: "review-note-1",
      reviewStatus: "passed",
      report: "Review 通过",
      feedback: null,
      repairAttempts: 0,
    };
    store.save(stored);
    const service = new OrdinaryJiraAiService({
      store,
      edits: {} as AssistantEditService,
      assistant: { listRuns: () => [] } as never,
      execution: {} as AssistantExecutionManager,
      dependencies: async () => ({
        gitlab: {
          async getMergeRequestDetails() {
            return {
              id: "mr-1",
              iid: "2041",
              projectId: "10",
              projectPath: "aip/frontend",
              title: "修复普通 Jira 问题 AIP-42",
              description: null,
              state: "opened",
              draft: false,
              webUrl: "https://gitlab.invalid/aip/frontend/-/merge_requests/2041",
              createdAt: "2026-09-12T02:00:00.000Z",
              updatedAt: "2026-09-12T02:10:00.000Z",
              sourceBranch: stored.sourceBranch,
              targetBranch: stored.targetBranch,
              headSha: "commit-sha",
              mergeCommitSha: null,
              squashCommitSha: null,
              mergeBaseSha: null,
              mergedAt: null,
              mergeError: null,
              author: null,
              assignees: [],
              reviewers: [],
              milestone: null,
              labels: ["ai-created"],
              pipeline: null,
              changes: [],
              notes: [],
              pipelines: [],
            };
          },
        } as unknown as GitLabClientPort,
        jira: {} as JiraClientPort,
        connection: { baseUrl: "https://gitlab.invalid", apiBaseUrl: "https://gitlab.invalid/api/v4", token: "token" },
      }),
      precheckRunner: {} as never,
      reviewDecisionRunner: { async judgeGitLabReview() { return { needsRepair: false, reason: "测试通过" }; } },
    });
    try {
      const result = await service.detail(stored.id, { userId: "user-1", username: "alice" });
      expect(result.task).toMatchObject({
        status: "mr_open",
        phase: "Pipeline 与 Pipeline Review 均已通过，等待维护人员审阅",
        verification: { pipelineStatus: "success", reviewStatus: "passed" },
      });
      await expect(service.detail(stored.id, { userId: "user-1", username: "alice" })).resolves.toMatchObject({
        task: { status: "mr_open", phase: "Pipeline 与 Pipeline Review 均已通过，等待维护人员审阅" },
      });
    } finally {
      await service.close();
      store.close();
    }
  });
});
