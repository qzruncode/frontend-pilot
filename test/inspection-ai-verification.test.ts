import { describe, expect, it } from "vitest";
import {
  extractClaudeReviewReport,
  failureTracesMatch,
  findLatestClaudeReviewNote,
  findClaudeReviewNote,
  inspectAiVerification,
  isTransientGitLabReadError,
  reviewJobFor,
} from "../src/inspection-ai-verification.js";
import { ensureGitLabDraftTitle, gitLabTitleWithoutDraftPrefix } from "../src/gitlab-mr-title.js";
import type { InspectionAiVerification } from "../src/api-contracts.js";
import type { GitLabMergeRequestDetails, GitLabPipelineJob } from "../src/gitlab-workbench.js";

const passedReport = `## Claude 代码审查报告

### 规则审查
✅ 未发现规则违规

### 高价值问题
✅ 未发现高价值问题

  ✅ 全部通过`;

describe("inspection AI Pipeline Review verification", () => {
  it("extracts the report from a traced CI job", () => {
    const trace = `+ cat review.md\n${passedReport}\n+ echo 发送评论到 MR...\n评论已发送到 MR`;
    expect(extractClaudeReviewReport(trace)).toBe(passedReport);
  });

  it("does not parse the report echoed in the GitLab note API response", () => {
    const findingsReport = `## Claude 代码审查报告

### 规则审查
✅ 未发现规则违规

### 高价值问题
| 类型 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 缺陷 | src/hooks/useNotifications.ts:118 | 缺少 return | 补充 return |
`;
    const trace = [
      "提示词模板：## Claude 代码审查报告",
      "===== Claude Review 输出 =====",
      "+ cat review.md",
      findingsReport,
      "+ echo 发送评论到 MR...",
      "发送评论到 MR...",
      "+ curl -X POST /notes",
      JSON.stringify({ body: findingsReport.replace(/\n/g, "\\n") }),
      "评论已发送到 MR",
    ].join("\n");
    expect(extractClaudeReviewReport(trace)).toBe(findingsReport.trim());
  });

  it("extracts a report with verification notes after the pass marker", () => {
    const report = `${passedReport}\n\n补充说明（验证完整性）：\n\n- 本环境未执行额外测试。`;
    expect(extractClaudeReviewReport(report)).toBe(report);
  });

  it("requires the robot note to belong to the current review job window", () => {
    const note = {
      id: "1", body: passedReport, author: null, createdAt: "2026-09-11T10:00:02.000Z", updatedAt: null,
      system: false, resolvable: false,
    };
    expect(findClaudeReviewNote([note], passedReport, "2026-09-11T10:00:00.000Z")).toEqual(note);
    expect(findClaudeReviewNote([note], passedReport, "2026-09-11T10:01:00.000Z")).toBeNull();
    const matchingNote = { ...note, body: `${passedReport}\n额外内容` };
    expect(findClaudeReviewNote([matchingNote], passedReport, "2026-09-11T10:00:00.000Z", "2026-09-11T10:00:01.000Z")).toEqual(matchingNote);
    const differentReport = passedReport.replace("✅ 未发现高价值问题", "发现高价值问题");
    expect(findClaudeReviewNote([{ ...note, body: differentReport }], passedReport, "2026-09-11T10:00:00.000Z")).toBeNull();
    expect(findClaudeReviewNote([note], passedReport, "2026-09-11T10:00:03.000Z", "2026-09-11T09:59:00.000Z")).toBeNull();
    const delayedNote = { ...note, createdAt: "2026-09-11T10:05:00.000Z" };
    expect(findClaudeReviewNote([delayedNote], passedReport, "2026-09-11T10:00:00.000Z", "2026-09-11T10:00:01.000Z")).toEqual(delayedNote);

    const olderNote = { ...note, id: "older", createdAt: "2026-09-11T09:59:59.000Z" };
    const latestNote = { ...note, id: "latest", body: `${passedReport}\n本轮评论`, createdAt: "2026-09-11T10:00:05.000Z" };
    expect(findLatestClaudeReviewNote([olderNote, latestNote], "2026-09-11T10:00:00.000Z")).toEqual(latestNote);
  });

  it("selects the newest retry of a named review job", () => {
    const job = (id: string, createdAt: string): GitLabPipelineJob => ({
      id, name: "claude-mr-agent", stage: "review", status: "success", webUrl: null,
      createdAt, startedAt: createdAt, finishedAt: createdAt, duration: null, allowFailure: false, failureReason: null,
    });
    const older = job("10", "2026-09-11T10:00:00.000Z");
    const latest = job("11", "2026-09-11T10:01:00.000Z");
    expect(reviewJobFor([older, latest], ["claude-mr-agent"])).toBe(latest);
  });

  it("recognizes GitLab Draft title prefixes without changing ordinary titles", () => {
    expect(gitLabTitleWithoutDraftPrefix("Draft: 修复问题")).toBe("修复问题");
    expect(gitLabTitleWithoutDraftPrefix("[draft] 修复问题")).toBe("修复问题");
    expect(gitLabTitleWithoutDraftPrefix("(DRAFT) 修复问题")).toBe("修复问题");
    expect(gitLabTitleWithoutDraftPrefix("Draft 设计方案")).toBeNull();
    expect(gitLabTitleWithoutDraftPrefix("修复 Draft 相关逻辑")).toBeNull();
  });

  it("marks Jira MR titles as Draft without dropping the Jira key suffix", () => {
    expect(ensureGitLabDraftTitle("修复问题 (#AIP-42)")).toBe("Draft: 修复问题 (#AIP-42)");
    expect(ensureGitLabDraftTitle("Draft: 修复问题 (#AIP-42)")).toBe("Draft: 修复问题 (#AIP-42)");
    const title = ensureGitLabDraftTitle(`${"修复问题".repeat(100)} (#AIP-42)`);
    expect(title.startsWith("Draft: ")).toBe(true);
    expect(title.endsWith(" (#AIP-42)")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(255);
  });

  it("clears a Draft MR after Pipeline and Review both pass", async () => {
    const pipeline = { id: "321", status: "success", ref: "ai/aip-42", sha: "head-sha", source: "merge_request_event" };
    const job: GitLabPipelineJob = {
      id: "654", name: "claude-mr-agent", stage: "review", status: "success", webUrl: null,
      createdAt: "2026-09-14T10:00:00.000Z", startedAt: "2026-09-14T10:00:00.000Z", finishedAt: "2026-09-14T10:01:00.000Z",
      duration: null, allowFailure: false, failureReason: null,
    };
    const detail = {
      projectId: "7", projectPath: "group/project", iid: "42", title: "Draft: 修复问题 (#AIP-42)", draft: true,
      state: "opened", webUrl: "https://gitlab.invalid/group/project/-/merge_requests/42", headSha: "head-sha",
      pipeline, pipelines: [pipeline], notes: [{
        id: "note-1", body: passedReport, author: null, createdAt: "2026-09-14T10:01:01.000Z", updatedAt: null, system: false, resolvable: false,
      }],
    } as unknown as GitLabMergeRequestDetails;
    let updateCalls = 0;
    const outcome = await inspectAiVerification({
      task: { mr: { projectId: "7", iid: "42" }, commitSha: "head-sha", verification: null },
      gitlab: {
        getMergeRequestDetails: async () => detail,
        listPipelineJobs: async () => [job],
        getPipelineJobTrace: async () => passedReport,
        updateMergeRequest: async () => { updateCalls += 1; return { ...detail, title: "修复问题 (#AIP-42)", draft: false }; },
      },
      reviewJobNames: ["claude-mr-agent"],
      signal: new AbortController().signal,
      reviewDecisionRunner: { async judgeGitLabReview() { return { needsRepair: false, reason: "测试通过" }; } },
      validate: () => undefined,
      setVerification: (patch) => patch as InspectionAiVerification,
      refreshMr: () => undefined,
      applyMr: async () => undefined,
    });

    expect(outcome.kind).toBe("passed");
    expect(updateCalls).toBe(1);
    expect(detail.title).toBe("修复问题 (#AIP-42)");
  });

  it("re-reads a just-published MR head while GitLab propagates the commit", async () => {
    const pipeline = { id: "321", status: "running", ref: "ai/aip-42", sha: "head-sha", source: "merge_request_event" };
    const base = {
      projectId: "7", projectPath: "group/project", iid: "42", title: "Draft: 修复问题 (#AIP-42)", draft: true,
      state: "opened", webUrl: "https://gitlab.invalid/group/project/-/merge_requests/42", pipeline, pipelines: [pipeline], notes: [],
    };
    let detailCalls = 0;
    const phases: string[] = [];
    const outcome = await inspectAiVerification({
      task: { mr: { projectId: "7", iid: "42" }, commitSha: "head-sha", verification: null },
      gitlab: {
        getMergeRequestDetails: async () => {
          detailCalls += 1;
          return { ...base, headSha: detailCalls === 1 ? "old-sha" : "head-sha" } as unknown as GitLabMergeRequestDetails;
        },
        listPipelineJobs: async () => [],
      },
      reviewJobNames: ["claude-mr-agent"],
      signal: new AbortController().signal,
      reviewDecisionRunner: { async judgeGitLabReview() { return { needsRepair: false, reason: "测试通过" }; } },
      validate: () => undefined,
      setVerification: (patch, _status, phase) => { phases.push(phase); return patch as InspectionAiVerification; },
      refreshMr: () => undefined,
      applyMr: async () => undefined,
    });

    expect(outcome.kind).toBe("pending");
    expect(detailCalls).toBe(2);
    expect(phases.at(-1)).toBe("正在等待 Pipeline 完成（#321）");
  });

  it("retries a transient GitLab read without turning verification into a failure", async () => {
    const pipeline = { id: "321", status: "running", ref: "ai/aip-42", sha: "head-sha", source: "merge_request_event" };
    const detail = {
      projectId: "7", projectPath: "group/project", iid: "42", title: "Draft: 修复问题 (#AIP-42)", draft: true,
      state: "opened", webUrl: "https://gitlab.invalid/group/project/-/merge_requests/42", headSha: "head-sha", pipeline, pipelines: [pipeline], notes: [],
    } as unknown as GitLabMergeRequestDetails;
    let jobCalls = 0;
    const outcome = await inspectAiVerification({
      task: { mr: { projectId: "7", iid: "42" }, commitSha: "head-sha", verification: null },
      gitlab: {
        getMergeRequestDetails: async () => detail,
        listPipelineJobs: async () => {
          jobCalls += 1;
          if (jobCalls === 1) throw new TypeError("fetch failed");
          return [];
        },
      },
      reviewJobNames: ["claude-mr-agent"],
      signal: new AbortController().signal,
      reviewDecisionRunner: { async judgeGitLabReview() { return { needsRepair: false, reason: "测试通过" }; } },
      validate: () => undefined,
      setVerification: (patch) => patch as InspectionAiVerification,
      refreshMr: () => undefined,
      applyMr: async () => undefined,
    });

    expect(isTransientGitLabReadError(new TypeError("fetch failed"))).toBe(true);
    expect(outcome.kind).toBe("pending");
    expect(jobCalls).toBe(2);
  });

  it("matches the same concrete failure across baseline and MR logs despite line numbers", () => {
    expect(failureTracesMatch(
      "Identifier `useChatMessage` has already been declared at line 12",
      "Identifier `useChatMessage` has already been declared at line 9",
    )).toBe(true);
    expect(failureTracesMatch("expected fixed value", "network timeout while pulling image")).toBe(false);
  });
});
