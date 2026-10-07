import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import { AssistantEditService } from "../src/assistant-edit-service.js";
import { AssistantEditStore } from "../src/assistant-edit-store.js";
import { GitAssistantEditWorkspaceProvider } from "../src/assistant-edit-workspace.js";
import { AssistantExecutionManager } from "../src/assistant-execution.js";
import { AssistantStore } from "../src/assistant-store.js";
import type { AssistantRunner } from "../src/assistant-runner.js";
import { InspectionAiService } from "../src/inspection-ai-service.js";
import { InspectionAiStore } from "../src/inspection-ai-store.js";
import type { InspectionRun, PreSubmitReviewInput, ReviewProfile, ReviewProgressInput } from "../src/contracts.js";
import type { GitLabReviewDecisionRunner } from "../src/gitlab-review-decision.js";
import type { InspectionExecutionIdentity } from "../src/inspection-service.js";
import type { GitLabClientPort } from "../src/gitlab-client.js";
import type { GitLabMergeRequestDetails, GitLabMergeRequestNote, GitLabPipelineJob } from "../src/gitlab-workbench.js";
import type { JiraClientPort } from "../src/jira-client.js";

const exec = promisify(execFile);
export const aiIdentity = { maintainerId: "alice", operatorId: "admin" };
export const bobIdentity = { maintainerId: "bob", operatorId: "admin" };
export const aiRun: InspectionRun = { id: "inspection-run", ...aiIdentity, projectId: "42", projectPath: "group/demo", projectName: "巡检示例项目", branch: "main",
  source: "manual", status: "completed", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, headSha: "abc", error: null, progress: [],
  result: { format: "structured", summary: "发现问题", findingCount: 1, ruleFindingCount: 1, headSha: "abc", ruleResults: [], findings: [{
    id: "finding", fingerprint: "finding", severity: "high", category: "正确性", path: "demo.ts", line: 1, issue: "默认值错误", suggestion: "修复默认值",
    author: null, jira: { status: "created", key: "TEST-42", url: "https://jira.example/browse/TEST-42", assignee: null, error: null },
  }] } };
export const aiIssue = { id: "42", key: "TEST-42", summary: "修复默认值", description: "默认值应为 new。\n保留现有行为和类型。", status: "待办", statusId: "1", statusCategory: "new", issueType: "缺陷", priority: "High", projectKey: "TEST", projectName: "巡检", webUrl: "https://jira.example/browse/TEST-42", createdAt: null, updatedAt: null, resolution: null, labels: [], assignee: null, reporter: null, comments: [], attachments: [] };

export async function createInspectionAiFixture(options: {
  run?: AssistantRunner["run"];
  syncIntervalMs?: number;
  verificationPollIntervalMs?: number;
  verificationTimeoutMs?: number;
  verificationPlans?: Array<{ pipelineStatus?: string; reviewJobStatus?: string; report?: string; trace?: string }>;
  baselinePipelineFailure?: boolean;
  includeBob?: boolean;
  concurrency?: number;
  findingKeys?: string[];
  issueSummary?: string;
  preSubmitReview?: (input: PreSubmitReviewInput) => Promise<string> | string;
  preSubmitReviewProgress?: ReviewProgressInput[];
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pilot-ai-test-"));
  const seed = path.join(root, "seed"); const remote = path.join(root, "remote.git");
  await mkdir(seed);
  const git = async (args: string[], cwd = seed) => (await exec("git", args, { cwd })).stdout.trim();
  await git(["init", "--quiet", "-b", "main"]);
  await writeFile(path.join(seed, "demo.ts"), "old\n");
  await git(["add", "demo.ts"]);
  await git(["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "--quiet", "-m", "base"]);
  const baseSha = await git(["rev-parse", "HEAD"]);
  await git(["clone", "--quiet", "--bare", seed, remote]);
  const provider = new GitAssistantEditWorkspaceProvider({ rootDir: path.join(root, "edits"), runCommand: async (file, args, commandOptions) => {
    const rewritten = args[0] === "remote" && args[1] === "add" ? [...args.slice(0, 3), remote] : args;
    const result = await exec(file, rewritten, { ...commandOptions, encoding: "utf8" });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } });
  const editsStore = new AssistantEditStore(path.join(root, "state.sqlite"));
  const edits = new AssistantEditService(editsStore, provider);
  const assistant = new AssistantStore(path.join(root, "state.sqlite"));
  const store = new InspectionAiStore(path.join(root, "state.sqlite"));
  let runs = 0; let creates = 0; let preSubmitReviewCalls = 0; let reviewDecisionCalls = 0; let allowed = true; let gitlabUserId = 71;
  const createdTitles: string[] = [];
  const updatedTitles: string[] = [];
  let mr: GitLabMergeRequestDetails | null = null;
  let rolledBack = false;
  let targetChanged = false;
  let failCreate: "none" | "before" | "after" = "none";
  let verificationPlanIndex = 0;
  const verificationBaseTime = Date.now();
  const reviewNotes: GitLabMergeRequestNote[] = [];
  let verificationState: { sha: string; pipelineId: string; pipelineStatus: string; reviewJob: GitLabPipelineJob; report: string; trace: string } | null = null;
  const passedReport = "## Claude 代码审查报告\n\n### 规则审查\n✅ 未发现规则违规\n\n### 高价值问题\n✅ 未发现高价值问题\n\n✅ 全部通过";
  const defaultPreSubmitReview = JSON.stringify({
    summary: "Jira 需求与候选代码一致。",
    requirementChecks: [{ requirement: "Jira 问题已修复", status: "satisfied", evidence: "demo.ts:1" }],
    ruleResults: [],
    findings: [],
  });
  const reviewDecisionRunner: GitLabReviewDecisionRunner = {
    judgeGitLabReview: async ({ report }) => {
      reviewDecisionCalls++;
      return {
        needsRepair: report.includes("| ---"),
        reason: report.includes("| ---") ? "测试报告包含待修复条目。" : "测试报告没有需要修复的代码问题。",
      };
    },
  };
  const inspectionRun: InspectionRun = options.findingKeys?.length ? {
    ...aiRun,
    result: {
      ...aiRun.result!,
      findingCount: options.findingKeys.length,
      ruleFindingCount: options.findingKeys.length,
      findings: options.findingKeys.map((key, index) => ({
        ...aiRun.result!.findings[0]!,
        id: `finding-${index}`,
        fingerprint: `finding-${index}`,
        jira: { ...aiRun.result!.findings[0]!.jira!, key, url: `https://jira.example/browse/${key}` },
      })),
    },
  } : structuredClone(aiRun);
  const markFindingAiResolution = vi.fn((identity: InspectionExecutionIdentity, jiraKey: string, status: "merged" | "reverted" | "unknown") => {
    if (identity.maintainerId !== inspectionRun.maintainerId) throw new Error("巡检问题不属于当前维护人员");
    const finding = inspectionRun.result?.findings.find((item) => item.jira.key?.toLowerCase() === jiraKey.toLowerCase());
    if (finding) finding.jira.aiResolutionStatus = status;
  });
  const runner: AssistantRunner = { run: async (input, runtime) => {
    runs++;
    if (options.run) return options.run(input, runtime);
    input.runtimeContext?.validateWrite?.();
    runtime?.onProgress?.({ kind: "tool", activityId: "read", toolName: "Read", message: "读取 demo.ts", phase: "start" });
    await readFile(path.join(input.editSession!.workspacePath, "demo.ts"));
    runtime?.onProgress?.({ kind: "tool_result", activityId: "read", toolName: "Read", message: "已读取 demo.ts", phase: "complete" });
    const operation = await edits.applyFilePatch(input.editSession!.id, input.editSession!.ownerKey, {
      path: "demo.ts", summary: "修复默认值", patch: "diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-old\n+new\n",
    });
    runtime?.onProgress?.({ kind: "tool_result", toolName: "apply_file_patch", message: "已修复默认值", editOperation: operation, phase: "complete" });
    return "已修复默认值。未运行项目测试。";
  } };
  const execution = new AssistantExecutionManager(runner, assistant);
  const configureVerification = async (sha: string) => {
    if (verificationState?.sha === sha) return verificationState;
    const plan = options.verificationPlans?.[verificationPlanIndex++] ?? {};
    const pipelineStatus = plan.pipelineStatus ?? "success";
    const reviewJobStatus = plan.reviewJobStatus ?? "success";
    const sequence = verificationPlanIndex;
    const timestamp = new Date(verificationBaseTime + sequence * 1_000).toISOString();
    const report = plan.report ?? passedReport;
    verificationState = {
      sha,
      pipelineId: String(500 + sequence),
      pipelineStatus,
      reviewJob: { id: String(700 + sequence), name: "claude-mr-agent", stage: "pr_agent", status: reviewJobStatus,
        webUrl: `https://gitlab.example/group/demo/-/jobs/${700 + sequence}`, createdAt: timestamp, startedAt: timestamp,
        finishedAt: timestamp, duration: null, allowFailure: false, failureReason: null },
      report,
      trace: plan.trace ?? report,
    };
    reviewNotes.push({ id: `note-${sequence}`, body: report, author: null, createdAt: timestamp, updatedAt: timestamp, system: false, resolvable: false });
    return verificationState;
  };
  const client = {
    getCurrentUser: async () => ({ id: gitlabUserId, username: "maintainer-gitlab", name: "维护人员", email: "maintainer@example.com" }),
    listMergeRequests: async () => mr ? [mr] : [],
    getMergeRequestDetails: async () => {
      if (!mr) throw new Error("not found");
      const sha = await git(["rev-parse", mr.sourceBranch!], remote);
      const state = await configureVerification(sha);
      const pipeline = { id: state.pipelineId, status: state.pipelineStatus, ref: mr.sourceBranch, sha,
        webUrl: `https://gitlab.example/group/demo/-/pipelines/${state.pipelineId}`, source: "merge_request_event",
        createdAt: state.reviewJob.createdAt, updatedAt: state.reviewJob.finishedAt, duration: null, coverage: null };
      mr = { ...mr, headSha: sha, pipeline, pipelines: [pipeline], notes: [...reviewNotes],
        mergeCommitSha: mr.state === "merged" ? "merge-sha" : mr.mergeCommitSha ?? null,
        mergeBaseSha: baseSha,
        mergedAt: mr.state === "merged" ? new Date(verificationBaseTime).toISOString() : mr.mergedAt ?? null,
        changes: mr.changes.length > 0 ? mr.changes : [{ oldPath: "demo.ts", newPath: "demo.ts", diff: "", changeType: "modified" }],
      };
      return mr;
    },
    listPipelines: async (_projectId: string, query: { ref?: string }) => {
      if (mr && query.ref === mr.targetBranch && options.baselinePipelineFailure) {
        return [{ id: "400", status: "failed", ref: mr.targetBranch, sha: baseSha, webUrl: "https://gitlab.example/group/demo/-/pipelines/400", source: "push", createdAt: null, updatedAt: null, duration: null, coverage: null }];
      }
      if (!mr || query.ref !== mr.sourceBranch || !verificationState) return [];
      return [{ id: verificationState.pipelineId, status: verificationState.pipelineStatus, ref: mr.sourceBranch, sha: verificationState.sha,
        webUrl: `https://gitlab.example/group/demo/-/pipelines/${verificationState.pipelineId}`, source: "merge_request_event",
        createdAt: verificationState.reviewJob.createdAt, updatedAt: verificationState.reviewJob.finishedAt, duration: null, coverage: null }];
    },
    listPipelineJobs: async (_projectId: string, pipelineId: string) => {
      if (pipelineId === "400") return [{ id: "baseline-test-build", name: "test-build", stage: "build", status: "failed", webUrl: null, createdAt: null, startedAt: null, finishedAt: null, duration: null, allowFailure: false, failureReason: "script_failure" }];
      if (!verificationState || verificationState.pipelineId !== pipelineId) return [];
      const failed = verificationState.pipelineStatus !== "success";
      const buildJobs: GitLabPipelineJob[] = failed ? ["test-build", "unit-test"].map((name, index) => ({ id: String(800 + verificationPlanIndex + index), name,
        stage: "build", status: "failed", webUrl: null, createdAt: null, startedAt: null, finishedAt: null, duration: null,
        allowFailure: false, failureReason: "script_failure" })) : [];
      return [...buildJobs, verificationState.reviewJob];
    },
    getPipelineJobTrace: async () => verificationState?.trace ?? "",
    listRepositoryCommits: async (_projectId: string, query: { ref?: string }) => query.ref === "main" ? [{
      id: targetChanged ? "changed-sha" : rolledBack ? "revert-sha" : "merge-sha", shortId: targetChanged ? "changed-sha" : rolledBack ? "revert-sha" : "merge-sha", title: targetChanged ? "Follow-up change" : rolledBack ? "Revert AI MR" : "Merge AI MR",
      message: "", authorName: "Maintainer", authorEmail: "maintainer@example.com", authoredAt: null, committedAt: null, webUrl: null,
    }] : [],
    getRepositoryFile: async (_projectId: string, filePath: string, ref: string) => {
      const blobId = ref === baseSha || ref === "main" && rolledBack ? "old-blob"
        : ref === "main" && targetChanged ? "changed-blob"
        : ref === "merge-sha" || ref === "main" ? "new-blob" : null;
      return { path: filePath, blobId, commitId: ref };
    },
    createMergeRequest: async (input: Parameters<NonNullable<GitLabClientPort["createMergeRequest"]>>[0]) => {
      creates++;
      createdTitles.push(input.title);
      if (failCreate === "before") throw new Error("GitLab 暂时不可用");
      mr = { id: "100", iid: "9", projectId: input.targetProjectId, projectPath: "group/demo", title: input.title,
        description: input.description, sourceBranch: input.sourceBranch, targetBranch: input.targetBranch, state: "opened", draft: input.title.startsWith("Draft: "),
        webUrl: "https://gitlab.example/group/demo/-/merge_requests/9", createdAt: null, updatedAt: null, headSha: null,
        author: null, assignees: input.assigneeIds.map(id => ({ id, name: "维护人员", username: "maintainer-gitlab", avatarUrl: null, webUrl: null })),
        reviewers: [], milestone: null, labels: input.labels, pipeline: null, changes: [], notes: [], pipelines: [] };
      if (failCreate === "after") throw new Error("响应丢失");
      return mr;
    },
    updateMergeRequest: async (_projectId: string, _iid: string, input: { title?: string }) => {
      if (!mr || !input.title) throw new Error("MR 不存在或缺少标题");
      updatedTitles.push(input.title);
      mr = { ...mr, title: input.title, draft: false };
      return mr;
    },
  } as unknown as GitLabClientPort;
  const reviewProfile: ReviewProfile = { name: "default", displayName: "默认 profile", rules: [] };
  const createService = () => new InspectionAiService({ store, edits, assistant, execution, syncIntervalMs: options.syncIntervalMs, concurrency: options.concurrency,
    verificationPollIntervalMs: options.verificationPollIntervalMs ?? 0,
    verificationTimeoutMs: options.verificationTimeoutMs ?? 2_000,
    maxPreSubmitRepairAttempts: 2,
    preSubmitReview: {
      runPreSubmitReview: async (input, runtime) => {
        preSubmitReviewCalls++;
        for (const event of options.preSubmitReviewProgress ?? []) runtime?.onProgress?.(event);
        return await options.preSubmitReview?.(input) ?? defaultPreSubmitReview;
      },
    },
    reviewProfile: async () => reviewProfile,
    reviewDecisionRunner,
    inspection: {
      getRun: (_runId, identity?: InspectionExecutionIdentity) => options.includeBob && identity?.maintainerId === bobIdentity.maintainerId ? { ...inspectionRun, ...bobIdentity } : inspectionRun,
      findJiraSource: (jiraKey, identity) => inspectionRun.result?.findings.find((finding) => jiraKey.toLowerCase() === finding.jira.key?.toLowerCase())
        && (identity.maintainerId === aiIdentity.maintainerId || options.includeBob && identity.maintainerId === bobIdentity.maintainerId) ? { runId: inspectionRun.id, findingId: inspectionRun.result.findings.find((finding) => jiraKey.toLowerCase() === finding.jira.key?.toLowerCase())!.id } : null,
      markFindingAiResolution,
    }, validateIdentity: (identity) => { if (!allowed || !identity.maintainerId) throw new Error("权限已撤销"); },
    dependencies: async () => ({ gitlab: client, jira: { getIssue: async (key: string) => ({ ...aiIssue, summary: options.issueSummary ?? aiIssue.summary, key, id: key, webUrl: `https://jira.example/browse/${key}` }) } as unknown as JiraClientPort,
      connection: { baseUrl: "https://gitlab.example", apiBaseUrl: "https://gitlab.example/api/v4", token: "fixture-token" } }),
  });
  let service = createService();
  return { root, remote, git, provider, edits, assistant, execution, store, client,
    get service() { return service; }, get mr() { return mr; }, get runs() { return runs; }, get creates() { return creates; },
    get createdTitles() { return createdTitles; }, get updatedTitles() { return updatedTitles; },
    get preSubmitReviewCalls() { return preSubmitReviewCalls; },
    get reviewDecisionCalls() { return reviewDecisionCalls; },
    get markAiResolutionCalls() { return markFindingAiResolution; },
    setCreateFailure: (value: typeof failCreate) => { failCreate = value; },
    revoke: () => { allowed = false; }, changeUser: () => { gitlabUserId++; },
    rollback: () => { rolledBack = true; }, changeTarget: () => { targetChanged = true; },
    restart: async () => { await service.close(); service = createService(); },
    close: async () => { await service.close(); await execution.close(); store.close(); assistant.close(); editsStore.close(); await rm(root, { recursive: true, force: true }); },
  };
}
