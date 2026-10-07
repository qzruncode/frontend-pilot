import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { planAssistantTask } from "../src/assistant-intent.js";
import { InspectionAiTaskDetailSchema } from "../src/api-contracts.js";
import { aiIdentity, aiIssue, bobIdentity, createInspectionAiFixture } from "./inspection-ai-fixtures.js";

const TASK_WAIT_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: 60_000 });

describe("inspection AI resolution", () => {
  it("reuses assistant edits, commits and pushes once, assigns the MR, persists progress and tracks merge after restart", async () => {
    const f = await createInspectionAiFixture({ syncIntervalMs: 20 });
    try {
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      expect(f.service.start("inspection-run", "finding", aiIdentity).id).toBe(task.id);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(f.reviewDecisionCalls).toBe(1);
      const detail = InspectionAiTaskDetailSchema.parse(await f.service.detail(task.id, aiIdentity));
      expect(detail.execution?.status).toBe("completed");
      expect(detail.editSession?.operations[0]?.status).toBe("applied");
      expect(detail.execution?.events.some(event => event.payload.editOperation)).toBe(true);
      expect(detail.task).not.toHaveProperty("identity");
      expect(f.createdTitles).toEqual(["Draft: 修复默认值 (#TEST-42)"]);
      expect(f.updatedTitles).toEqual(["修复默认值 (#TEST-42)"]);
      expect(f.mr).toMatchObject({ title: "修复默认值 (#TEST-42)", assignees: [{ id: "71" }], labels: ["ai-created"] });
      expect(f.mr?.description).toContain("## Background");
      expect(f.mr?.description).toContain("## 关联");
      expect(await f.git(["show", `${task.sourceBranch}:demo.ts`], f.remote)).toBe("new");
      const commitMessage = await f.git(["show", "-s", "--format=%B", task.sourceBranch], f.remote);
      expect(commitMessage).toContain("修复默认值 (#TEST-42)");
      expect(commitMessage).toContain("## Background");
      expect(await f.git(["show", "-s", "--format=%ae", task.sourceBranch], f.remote)).toBe("maintainer@example.com");
      expect(await f.git(["ls-tree", "--name-only", task.sourceBranch], f.remote)).toBe("demo.ts");
      expect(f.service.start("inspection-run", "finding", aiIdentity).id).toBe(task.id);
      expect(f.runs).toBe(1); expect(f.creates).toBe(1);
      await expect(f.service.detail(task.id, { ...aiIdentity, maintainerId: "bob" })).rejects.toThrow("不属于");
      await f.restart();
      f.mr!.state = "merged";
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("merged"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect((await f.service.detail(task.id, aiIdentity)).task.status).toBe("merged");
      expect(f.store.list()[0]?.status).toBe("merged");
      expect(f.markAiResolutionCalls).toHaveBeenCalledWith(expect.objectContaining({ maintainerId: "alice" }), "TEST-42", "merged");
    } finally { await f.close(); }
  });
  it("detects a rollback after the AI MR was merged and allows a fresh run", async () => {
    const f = await createInspectionAiFixture({ syncIntervalMs: 20 });
    try {
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      f.mr!.state = "merged";
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("merged"), { timeout: TASK_WAIT_TIMEOUT_MS });
      const unchanged = await f.service.reprocess(task.id, aiIdentity);
      expect(unchanged).toMatchObject({ action: "skipped", resolutionStatus: "active", task: { status: "merged" } });
      f.rollback();
      const previousSourceBranch = f.store.list()[0]!.sourceBranch;
      const reprocessed = await f.service.reprocess(task.id, aiIdentity);
      expect(reprocessed).toMatchObject({ action: "restarted", resolutionStatus: "reverted" });
      expect(f.markAiResolutionCalls).toHaveBeenLastCalledWith(expect.objectContaining({ maintainerId: "alice" }), "TEST-42", "reverted");
      expect(reprocessed.task.status).toBe("preparing");
      expect(reprocessed.task.sourceBranch).not.toBe(previousSourceBranch);
      expect(reprocessed.task.mr).toBeNull();
      expect(reprocessed.task.resolution).toBeNull();
    } finally { await f.close(); }
  });
  it("does not start another AI run when the merged files have a later change", async () => {
    const f = await createInspectionAiFixture({ syncIntervalMs: 20 });
    try {
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      f.mr!.state = "merged";
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("merged"), { timeout: TASK_WAIT_TIMEOUT_MS });
      f.changeTarget();
      const result = await f.service.reprocess(task.id, aiIdentity);
      expect(result).toMatchObject({ action: "skipped", resolutionStatus: "unknown", task: { status: "merged" } });
      expect(f.runs).toBe(1);
    } finally { await f.close(); }
  });
  it("requires Jira consistency review before creating the MR and repairs the same edit session", async () => {
    let f!: Awaited<ReturnType<typeof createInspectionAiFixture>>;
    let editAttempts = 0;
    let reviewAttempts = 0;
    f = await createInspectionAiFixture({
      run: async (input) => {
        editAttempts += 1;
        await f.edits.applyFilePatch(input.editSession!.id, input.editSession!.ownerKey, {
          path: "demo.ts", summary: editAttempts === 1 ? "首次修改" : "修复提交前 Review 反馈",
          patch: editAttempts === 1
            ? "diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-old\n+new\n"
            : "diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-new\n+fixed\n",
        });
        return "已完成代码修改。";
      },
      preSubmitReview: async (input) => {
        reviewAttempts += 1;
        expect(input.jiraKey).toBe("TEST-42");
        expect(input.jiraDescription).toContain("默认值应为 new");
        expect(input.diff).toContain("demo.ts");
        if (reviewAttempts === 1) {
          expect(f.creates).toBe(0);
          return JSON.stringify({
            summary: "发现实现没有满足 Jira 需求。",
            requirementChecks: [{ requirement: "默认值应为 new", status: "satisfied", evidence: "demo.ts:1" }],
            ruleResults: [],
            findings: [{ severity: "high", category: "正确性", path: "demo.ts", line: 1, issue: "当前实现仍未满足实际行为要求", suggestion: "修复候选代码" }],
          });
        }
        return JSON.stringify({
          summary: "Jira 需求与候选代码一致。",
          requirementChecks: [{ requirement: "默认值应为 new", status: "satisfied", evidence: "demo.ts:1" }],
          ruleResults: [],
          findings: [],
        });
      },
    });
    try {
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(reviewAttempts).toBe(2);
      expect(editAttempts).toBe(2);
      expect(f.creates).toBe(1);
      expect(await f.git(["show", `${task.sourceBranch}:demo.ts`], f.remote)).toBe("fixed");
      expect(f.store.list()[0]?.preReview).toMatchObject({ status: "passed", attempt: 2, blockingFindingCount: 0, unmetRequirementCount: 0 });
      expect(await f.git(["rev-list", "--count", task.sourceBranch], f.remote)).toBe("2");
    } finally { await f.close(); }
  });
  it("creates the MR after two pre-submit repair rounds and leaves remaining findings to Pipeline", async () => {
    let f!: Awaited<ReturnType<typeof createInspectionAiFixture>>;
    let editAttempts = 0;
    let reviewAttempts = 0;
    f = await createInspectionAiFixture({
      syncIntervalMs: 20,
      run: async (input) => {
        editAttempts += 1;
        await f.edits.applyFilePatch(input.editSession!.id, input.editSession!.ownerKey, {
          path: "demo.ts",
          summary: `第 ${editAttempts} 次修改`,
          patch: editAttempts === 1
            ? "diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-old\n+new\n"
            : editAttempts === 2
              ? "diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-new\n+fixed\n"
              : "diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-fixed\n+fixed-final\n",
        });
        return "已完成代码修改。";
      },
      preSubmitReview: async () => {
        reviewAttempts += 1;
        return JSON.stringify({
          summary: "仍有需要 Pipeline 验证的问题。",
          requirementChecks: [{ requirement: "问题已修复", status: "unclear", evidence: "仍需运行时验证" }],
          ruleResults: [],
          findings: [{ severity: "high", category: "正确性", path: "demo.ts", line: 1, issue: "仍有问题", suggestion: "交由 Pipeline 验证" }],
        });
      },
    });
    try {
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(reviewAttempts).toBe(3);
      expect(editAttempts).toBe(3);
      expect(f.creates).toBe(1);
      expect(f.createdTitles).toEqual(["Draft: 修复默认值 (#TEST-42)"]);
      expect(f.mr).toMatchObject({ draft: false });
      expect(f.store.list()[0]?.preReview).toMatchObject({ status: "findings", attempt: 3, blockingFindingCount: 1 });
      expect(await f.git(["show", `${task.sourceBranch}:demo.ts`], f.remote)).toBe("fixed-final");
    } finally { await f.close(); }
  });
  it("passes static-only uncertainty to Pipeline without consuming pre-submit repair rounds", async () => {
    let reviewAttempts = 0;
    const f = await createInspectionAiFixture({
      preSubmitReview: async () => {
        reviewAttempts += 1;
        return JSON.stringify({
          summary: "代码行为已覆盖，运行时结果交给 Pipeline 验证。",
          requirementChecks: [{ requirement: "问题已修复", status: "unclear", evidence: "静态代码已覆盖，无法从 Review 证明运行时结果" }],
          ruleResults: [],
          findings: [],
        });
      },
    });
    try {
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      const detail = InspectionAiTaskDetailSchema.parse(await f.service.detail(task.id, aiIdentity));
      expect(reviewAttempts).toBe(1);
      expect(detail.task.preReview).toMatchObject({ status: "passed", missingRequirementCount: 0, unclearRequirementCount: 1 });
      expect(f.createdTitles).toEqual(["Draft: 修复默认值 (#TEST-42)"]);
    } finally { await f.close(); }
  });
  it("fails closed without creating an MR when the pre-submit review cannot run", async () => {
    const f = await createInspectionAiFixture({ preSubmitReview: async () => { throw new Error("review service unavailable"); } });
    try {
      f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(f.creates).toBe(0);
      expect(f.store.list()[0]?.preReview).toMatchObject({ status: "failed" });
      expect(f.store.list()[0]?.error).toContain("提交前 Review 失败");
    } finally { await f.close(); }
  });
  it("persists pre-submit Review progress so reopening the task keeps the running history", async () => {
    const f = await createInspectionAiFixture({
      preSubmitReviewProgress: [
        { kind: "stage", message: "正在读取提交前 Review 配置" },
        { kind: "tool", message: "正在检查候选代码", detail: "demo.ts" },
        { kind: "result", message: "提交前 Review 已返回结果" },
      ],
    });
    try {
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      const detail = InspectionAiTaskDetailSchema.parse(await f.service.detail(task.id, aiIdentity));
      expect(detail.task.preReview?.progress.map((event) => event.message)).toEqual([
        "正在读取提交前 Review 配置",
        "正在检查候选代码",
        "提交前 Review 已返回结果",
      ]);
    } finally { await f.close(); }
  });
  it("resolves only Jira issues linked to the current inspection maintainer", async () => {
    const f = await createInspectionAiFixture();
    try {
      expect(f.service.findJiraSource("test-42", aiIdentity)).toEqual({ runId: "inspection-run", findingId: "finding" });
      expect(f.service.findJiraSource("OTHER-1", aiIdentity)).toBeNull();
      expect(f.service.findJiraSource("TEST-42", { ...aiIdentity, maintainerId: "bob" })).toBeNull();
    } finally { await f.close(); }
  });
  it("allows only one maintainer to process a Jira at a time", async () => {
    const f = await createInspectionAiFixture({ includeBob: true });
    try {
      f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(() => f.service.start("inspection-run", "finding", bobIdentity)).toThrow("该 Jira 已有 AI 处理任务");
      expect(f.store.list()).toHaveLength(1);
    } finally { await f.close(); }
  });
  it("shortens a legacy long Jira summary before creating the MR", async () => {
    const f = await createInspectionAiFixture({ issueSummary: "[巡检][medium] getGatewayUrl (src/utils/getGatewayUrl.ts:7) 用 window.location.origin 硬拼 /gateway/isgw/ 前缀，忽略了 getGatewayPrefix() (src/utils/getGatewayPrefix.ts) 中的 base path；而其他调用方仍使用旧逻辑" });
    try {
      f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(f.mr?.title).not.toContain("src/utils/getGatewayUrl.ts");
      expect(f.mr?.title.length).toBeLessThan(130);
    } finally { await f.close(); }
  });
  it("keeps the same MR and repairs findings from the target Pipeline Review", async () => {
    let f!: Awaited<ReturnType<typeof createInspectionAiFixture>>;
    let attempts = 0;
    const passedReport = "## Claude 代码审查报告\n\n### 规则审查\n✅ 未发现规则违规\n\n### 高价值问题\n✅ 未发现高价值问题\n\n✅ 全部通过";
    const findingsReport = "## Claude 代码审查报告\n\n### 规则审查\n✅ 未发现规则违规\n\n### 高价值问题\n| 类型 | 位置 | 问题 | 建议 |\n| --- | --- | --- | --- |\n| 缺陷 | demo.ts:1 | 还需要校验新值 | 补充修复 |";
    f = await createInspectionAiFixture({
      verificationPlans: [
        { report: findingsReport, trace: `提示词模板：## Claude 代码审查报告\n===== Claude Review 输出 =====\n+ cat review.md\n${findingsReport}\n+ echo 发送评论到 MR...\n发送评论到 MR...\n${JSON.stringify({ body: findingsReport.replace(/\n/g, "\\n") })}\n评论已发送到 MR` },
        { report: passedReport, trace: "Review Job completed; comment was posted" },
      ],
      run: async (input) => {
        attempts++;
        await f.edits.applyFilePatch(input.editSession!.id, input.editSession!.ownerKey, {
          path: "demo.ts", summary: "修复 Pipeline Review 反馈",
          patch: attempts === 1
            ? "diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-old\n+new\n"
            : "diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-new\n+fixed\n",
        });
        return "已根据 Pipeline Review 反馈完成修复。";
      },
    });
    try {
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      const stored = f.store.list()[0]!;
      expect(attempts).toBe(2);
      expect(f.creates).toBe(1);
      expect(await f.git(["rev-list", "--count", task.sourceBranch], f.remote)).toBe("3");
      expect(await f.git(["show", `${task.sourceBranch}:demo.ts`], f.remote)).toBe("fixed");
      expect(stored.verification).toMatchObject({ reviewStatus: "passed", reviewNoteId: "note-2", repairAttempts: 1, report: passedReport });
      expect(stored.verification?.headSha).toBe(stored.commitSha);
      expect(f.preSubmitReviewCalls).toBe(2);
    } finally { await f.close(); }
  });
  it("repairs a code failure reported by Pipeline before waiting for Review", async () => {
    let f!: Awaited<ReturnType<typeof createInspectionAiFixture>>;
    let attempts = 0;
    f = await createInspectionAiFixture({
      verificationPlans: [
        { pipelineStatus: "failed", reviewJobStatus: "skipped", report: "error: demo.ts:1 expected fixed value" },
        {},
      ],
      run: async (input) => {
        attempts++;
        await f.edits.applyFilePatch(input.editSession!.id, input.editSession!.ownerKey, {
          path: "demo.ts", summary: "修复 Pipeline 失败",
          patch: attempts === 1
            ? "diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-old\n+new\n"
            : "diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-new\n+fixed\n",
        });
        return "已根据 Pipeline 失败日志完成修复。";
      },
    });
    try {
      f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(attempts).toBe(2);
      expect(f.store.list()[0]?.verification).toMatchObject({ reviewStatus: "passed", repairAttempts: 1 });
    } finally { await f.close(); }
  });
  it("fails closed when the target Pipeline Review job is skipped", async () => {
    const f = await createInspectionAiFixture({ verificationPlans: [{ pipelineStatus: "success", reviewJobStatus: "skipped" }] });
    try {
      f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(f.store.list()[0]?.error).toContain("没有产生可确认的机器人评论");
      expect(f.store.list()[0]?.verification).toMatchObject({ reviewStatus: "skipped", pipelineStatus: "success" });
    } finally { await f.close(); }
  });
  it("does not edit unrelated code when the target branch baseline has the same Pipeline failure", async () => {
    const f = await createInspectionAiFixture({
      baselinePipelineFailure: true,
      verificationPlans: [{ pipelineStatus: "failed", reviewJobStatus: "skipped", report: "Identifier `useChatMessage` has already been declared at line 12" }],
    });
    try {
      f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(f.store.list()[0]?.error).toContain("属于基线问题");
      expect(f.runs).toBe(1);
    } finally { await f.close(); }
  });
  it("limits concurrent AI tasks, queues the rest, and starts them in order", async () => {
    let attempts = 0;
    let releaseFirst!: () => void;
    const f = await createInspectionAiFixture({ concurrency: 1, findingKeys: ["TEST-42", "TEST-43"], run: async (_input, runtime) => {
      if (++attempts === 1) return new Promise<string>((resolve, reject) => {
        releaseFirst = () => resolve("首个任务已结束");
        runtime?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return "没有发现需要修改的代码";
    } });
    try {
      const first = f.service.start("inspection-run", "finding-0", aiIdentity);
      await vi.waitFor(() => expect(attempts).toBe(1), { timeout: TASK_WAIT_TIMEOUT_MS });
      const second = f.service.start("inspection-run", "finding-1", aiIdentity);
      expect(first.status).toBe("preparing");
      expect(second.status).toBe("queued");
      releaseFirst();
      await vi.waitFor(() => expect(f.store.list().every((task) => task.status === "failed")).toBe(true), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(attempts).toBe(2);
    } finally { releaseFirst?.(); await f.close(); }
  });
  it("resumes a persisted queued task after the service restarts", async () => {
    let attempts = 0;
    let releaseFirst!: () => void;
    const f = await createInspectionAiFixture({ concurrency: 1, findingKeys: ["TEST-42", "TEST-43"], run: async (_input, runtime) => {
      if (++attempts === 1) return new Promise<string>((resolve, reject) => {
        releaseFirst = () => resolve("首个任务已结束");
        runtime?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return "没有发现需要修改的代码";
    } });
    try {
      f.service.start("inspection-run", "finding-0", aiIdentity);
      await vi.waitFor(() => expect(attempts).toBe(1), { timeout: TASK_WAIT_TIMEOUT_MS });
      const second = f.service.start("inspection-run", "finding-1", aiIdentity);
      expect(second.status).toBe("queued");
      await f.restart();
      await vi.waitFor(() => expect(f.store.list().find((task) => task.id === second.id)?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(attempts).toBe(2);
      expect(f.store.list().find((task) => task.jiraKey === "TEST-42")?.status).toBe("canceled");
    } finally { releaseFirst?.(); await f.close(); }
  });
  it("can cancel an AI task while it is waiting in the queue", async () => {
    let releaseFirst!: () => void;
    const f = await createInspectionAiFixture({ concurrency: 1, findingKeys: ["TEST-42", "TEST-43"], run: async (_input, runtime) => new Promise<string>((resolve, reject) => {
      releaseFirst = () => resolve("首个任务已结束");
      runtime?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) });
    try {
      f.service.start("inspection-run", "finding-0", aiIdentity);
      await vi.waitFor(() => expect(f.runs).toBe(1), { timeout: TASK_WAIT_TIMEOUT_MS });
      const second = f.service.start("inspection-run", "finding-1", aiIdentity);
      expect(second.status).toBe("queued");
      expect(f.service.cancel(second.id, aiIdentity).status).toBe("canceled");
      releaseFirst();
      await vi.waitFor(() => expect(f.store.list().find((task) => task.jiraKey === "TEST-42")?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(f.runs).toBe(1);
      expect(f.store.list().find((task) => task.jiraKey === "TEST-43")?.status).toBe("canceled");
    } finally { releaseFirst?.(); await f.close(); }
  });
  it.each(["before", "after"] as const)("recovers a %s-response publication failure without re-editing or duplicating the MR", async (when) => {
    const f = await createInspectionAiFixture();
    try {
      f.setCreateFailure(when);
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      const sha = f.store.list()[0]?.commitSha;
      expect(sha).toBeTruthy();
      await f.restart(); f.setCreateFailure("none");
      f.service.retry(task.id, aiIdentity);
      f.service.retry(task.id, aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(f.runs).toBe(1); expect(f.creates).toBe(when === "after" ? 1 : 2);
      expect(f.store.list()[0]?.commitSha).toBe(sha);
      expect(await f.git(["rev-list", "--count", task.sourceBranch], f.remote)).toBe("2");
    } finally { await f.close(); }
  });
  it("does not publish without changes, and does not follow Jira action intents in edit mode", async () => {
    const f = await createInspectionAiFixture({ run: async () => "没有发现需要修改的代码" });
    try {
      f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(f.store.list()[0]?.error).toContain("没有产生代码改动");
      expect(f.creates).toBe(0);
      f.service.retry(f.store.list()[0]!.id, aiIdentity);
      await vi.waitFor(() => expect(f.runs).toBe(2), { timeout: TASK_WAIT_TIMEOUT_MS });
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(planAssistantTask([{ role: "user", content: "帮我创建 Jira 并合并 MR" }], undefined, true)).toMatchObject({ intent: "code_edit", maxTurns: 40 });
    } finally { await f.close(); }
  });
  it("starts a fresh execution on retry without showing the previous failure during preparation", async () => {
    let attempts = 0;
    let release!: () => void;
    const prepareGate = new Promise<void>(resolve => { release = resolve; });
    const f = await createInspectionAiFixture({ run: async (_input, options) => {
      if (++attempts === 1) throw new Error("model upstream 502");
      return new Promise((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    } });
    try {
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      const previousRunId = f.store.list()[0]!.assistantRunId!;
      const currentUser = f.client.getCurrentUser!.bind(f.client);
      f.client.getCurrentUser = vi.fn(currentUser).mockImplementationOnce(async () => {
        await prepareGate;
        return currentUser();
      });
      const retried = f.service.retry(task.id, aiIdentity);
      f.service.retry(task.id, aiIdentity);
      expect(retried.status).toBe("preparing");
      expect(retried.assistantRunId).toBeNull();
      expect((await f.service.detail(task.id, aiIdentity)).execution).toBeNull();
      expect(f.assistant.getRun(previousRunId)?.status).toBe("failed");
      await vi.waitFor(() => expect(f.client.getCurrentUser).toHaveBeenCalled(), { timeout: TASK_WAIT_TIMEOUT_MS });
      release();
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("running"), { timeout: TASK_WAIT_TIMEOUT_MS });
      const detail = await f.service.detail(task.id, aiIdentity);
      expect(detail.execution?.id).not.toBe(previousRunId);
      expect(detail.execution?.status).toBe("running");
      expect(f.runs).toBe(2);
      expect(f.creates).toBe(0);
    } finally { release(); await f.close(); }
  });
  it("cancels the shared assistant execution, keeps the process record and creates no MR", async () => {
    const f = await createInspectionAiFixture({ run: async (_input, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) });
    try {
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("running"), { timeout: TASK_WAIT_TIMEOUT_MS });
      f.service.cancel(task.id, aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("canceled"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect((await f.service.detail(task.id, aiIdentity)).execution?.status).toBe("canceled");
      expect(f.creates).toBe(0);
    } finally { await f.close(); }
  });
  it("stops publishing when the connected GitLab identity has changed", async () => {
    const f = await createInspectionAiFixture();
    try {
      f.setCreateFailure("before");
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      f.changeUser(); f.service.retry(task.id, aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(f.store.list()[0]?.error).toContain("连接已更换");
      expect(f.creates).toBe(1);
      f.revoke(); expect(() => f.service.retry(task.id, aiIdentity)).toThrow("权限已撤销");
    } finally { await f.close(); }
  });
  it("does not overwrite an occupied branch or execute repository hooks when publishing", async () => {
    const f = await createInspectionAiFixture();
    try {
      f.setCreateFailure("before");
      const task = f.service.start("inspection-run", "finding", aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      const session = await f.edits.getRunnerContext(f.store.list()[0]!.editSessionId!, "inspection:alice");
      const baseSha = session!.baseSha;
      await f.git(["update-ref", `refs/heads/${task.sourceBranch}`, baseSha], f.remote);
      f.service.retry(task.id, aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("failed"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(f.store.list()[0]?.error).toContain("未覆盖远端修改");
      expect(await f.git(["rev-parse", task.sourceBranch], f.remote)).toBe(baseSha);
      const hook = path.join(session!.workspacePath, ".git/hooks/pre-push");
      await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      await f.git(["update-ref", "-d", `refs/heads/${task.sourceBranch}`], f.remote);
      f.setCreateFailure("none"); f.service.retry(task.id, aiIdentity);
      await vi.waitFor(() => expect(f.store.list()[0]?.status).toBe("mr_open"), { timeout: TASK_WAIT_TIMEOUT_MS });
      expect(await readFile(path.join(session!.workspacePath, "demo.ts"), "utf8")).toBe("new\n");
    } finally { await f.close(); }
  });
});
