import { type GitLabClientPort, type GitLabNote } from "./gitlab-client.js";
import { parseReviewOutput, renderReviewComment, reviewGateSummary } from "./review-prompt.js";
import type { ReviewWorkspace, ReviewWorkspaceProvider } from "./review-workspace.js";
import type {
  CreateReviewInput,
  ReviewProgressInput,
  ReviewProfile,
  ReviewRunner,
  ReviewStatus,
} from "./contracts.js";
import type { AppConfig } from "./config.js";
import { safeErrorMessage } from "./errors.js";
import type { InternalJob } from "./review-service-types.js";

export interface ReviewExecutionDependencies {
  gitlab: GitLabClientPort;
  runner: ReviewRunner;
  workspaceProvider: ReviewWorkspaceProvider | undefined;
  config: Pick<AppConfig, "rulesDir" | "profileConfigPath">;
  profileLoader: (projectPath: string, config: Pick<AppConfig, "rulesDir" | "profileConfigPath">) => Promise<ReviewProfile>;
  now: () => Date;
  isClosing: () => boolean;
  appendProgress: (job: InternalJob, input: ReviewProgressInput) => void;
  enqueueReplacement: (job: InternalJob, headSha: string | null, source: string) => Promise<void>;
  registerReviewWorkspace: (job: InternalJob) => void;
  upsertNote: (job: InternalJob, body: string) => Promise<GitLabNote | null>;
  shouldSendComments: () => boolean;
  getReviewSession: (job: InternalJob) => string | null;
  saveReviewSession: (job: InternalJob, sessionId: string) => void;
}

export async function executeReviewJob(
  dependencies: ReviewExecutionDependencies,
  job: InternalJob,
): Promise<void> {
  const {
    appendProgress,
    config,
    enqueueReplacement,
    gitlab,
    isClosing,
    now,
    profileLoader,
    registerReviewWorkspace,
    runner,
    shouldSendComments,
    upsertNote,
    workspaceProvider,
  } = dependencies;
  job.status = "running";
  job.startedAt = now().toISOString();
  job.controller = new AbortController();
  appendProgress(job, { kind: "stage", message: "审查执行器已启动" });
  let workspace: ReviewWorkspace | null = null;

  try {
    appendProgress(job, { kind: "stage", message: "读取 GitLab MR 元数据" });
    const mergeRequest = await gitlab.getMergeRequest(job.projectId, job.mrIid);
    const actualHeadSha = currentHead(mergeRequest) ?? job.headSha;
    if (!job.headSha && actualHeadSha) job.headSha = actualHeadSha;
    const targetBranch = currentTargetBranch(mergeRequest);
    if (targetBranch) job.targetBranch = targetBranch;
    appendProgress(job, {
      kind: "stage",
      message: "GitLab MR 元数据已读取",
      detail: `head ${actualHeadSha?.slice(0, 12) ?? "unknown"}`,
      meta: { headSha: actualHeadSha },
    });
    if (job.headSha && actualHeadSha && job.headSha !== actualHeadSha) {
      if (job.status === "running") {
        job.status = "superseded";
        job.finishedAt = now().toISOString();
        appendProgress(job, { kind: "stage", message: "检测到 MR 已产生新提交", detail: "任务转交给最新 head SHA" });
        await enqueueReplacement(job, actualHeadSha, "superseded");
      }
      return;
    }
    if (job.status !== "running") return;

    const projectPath = job.projectPath
      ?? mergeRequest.target_project?.path_with_namespace
      ?? mergeRequest.source_project?.path_with_namespace
      ?? job.projectId;
    const targetProjectPath = mergeRequest.target_project?.path_with_namespace ?? projectPath;
    const sourceProjectPath = mergeRequest.source_project?.path_with_namespace ?? targetProjectPath;
    appendProgress(job, { kind: "stage", message: "加载项目审查规则", detail: projectPath });
    const profile = await profileLoader(projectPath, config);
    appendProgress(job, {
      kind: "stage",
      message: "审查 profile 已匹配",
      detail: `${profile.displayName} · ${profile.rules.filter((rule) => rule.enabled).length} 条启用规则`,
      meta: {
        profile: profile.name,
        profileDisplayName: profile.displayName,
        ruleCount: profile.rules.filter((rule) => rule.enabled).length,
      },
    });
    if (workspaceProvider) {
      appendProgress(job, { kind: "stage", message: "准备 MR 持久审查工作区", detail: "首次初始化或更新同一 MR 仓库" });
      // Keep the MR-level marker when materialization fails. The provider may
      // have left a partially-created workspace that needs terminal cleanup.
      registerReviewWorkspace(job);
      workspace = await workspaceProvider.create({
        jobId: job.id,
        projectId: job.projectId,
        projectPath,
        sourceProjectPath,
        targetProjectPath,
        mrIid: job.mrIid,
        targetBranch: targetBranch ?? job.targetBranch ?? null,
        headSha: actualHeadSha,
      }, { signal: job.controller.signal });
      appendProgress(job, {
        kind: "stage",
        message: "审查工作区已就绪",
        detail: "模型将自主检查 Git 历史和代码变更",
        meta: { workspacePath: workspace.path },
      });
    }
    if (job.status !== "running") return;
    appendProgress(job, { kind: "stage", message: "启动 Claude Code Review 会话", detail: "Claude Code 工具：Read · Grep · Glob · Bash · Task · Agent" });
    const raw = await runner.run({
      projectPath,
      mrIid: job.mrIid,
      workspacePath: workspace?.path ?? null,
      profile,
    }, {
      signal: job.controller.signal,
      gitEnvironment: workspace?.gitEnvironment,
      onProgress: (event) => appendProgress(job, event),
      resumeSessionId: dependencies.getReviewSession(job),
      onSessionId: (sessionId) => dependencies.saveReviewSession(job, sessionId),
    });
    if (job.status !== "running") return;

    appendProgress(job, { kind: "stage", message: "解析 Claude 审查结果" });
    const result = parseReviewOutput(raw, profile.rules);
    const latestMergeRequest = await gitlab.getMergeRequest(job.projectId, job.mrIid);
    const latestHeadSha = currentHead(latestMergeRequest) ?? actualHeadSha;
    if (job.status !== "running") return;
    if (actualHeadSha && latestHeadSha && actualHeadSha !== latestHeadSha) {
      job.status = "superseded";
      job.finishedAt = now().toISOString();
      appendProgress(job, { kind: "stage", message: "结果生成后发现 MR 已更新", detail: "丢弃旧结果并重新排队最新提交" });
      await enqueueReplacement(job, latestHeadSha, "stale-result");
      return;
    }

    const commentsEnabled = shouldSendComments();
    let note: GitLabNote | null = null;
    if (commentsEnabled) {
      const body = renderReviewComment({ projectId: job.projectId, mrIid: job.mrIid, headSha: actualHeadSha, result });
      appendProgress(job, { kind: "stage", message: "正在写回 GitLab MR 评论" });
      // Once the final report is being written, late Claude progress callbacks
      // must not enqueue another update that could replace the report again.
      job.suppressProgressNotes = true;
      try {
        note = await upsertNote(job, body);
      } catch (error) {
        if (job.status === "running") job.suppressProgressNotes = false;
        throw error;
      }
      if (job.status !== "running") return;
      if (!note && shouldSendComments()) return;
      if (note) job.noteId = note.id;
    } else {
      appendProgress(job, { kind: "stage", message: "已跳过 GitLab MR 评论", detail: "自动发送评论已关闭" });
    }
    const gate = reviewGateSummary(result);
    job.result = {
      format: result.format,
      summary: result.summary,
      ruleFindingCount: result.ruleFindingCount,
      findingCount: result.findings.length,
      headSha: actualHeadSha,
      ...gate,
    };
    job.status = "completed";
    job.finishedAt = now().toISOString();
    appendProgress(job, {
      kind: "result",
      message: commentsEnabled && note ? "审查完成，MR 评论已更新" : "审查完成，未发送 GitLab 评论",
      detail: `${gate.gate === "passed" ? "门禁通过" : "门禁阻断"} · ${gate.blockingFindingCount} 个阻断问题`,
      meta: {
        findingCount: result.findings.length,
        ruleFindingCount: result.ruleFindingCount,
        blockingFindingCount: gate.blockingFindingCount,
        ...(note ? { noteId: note.id } : {}),
      },
    });
  } catch (error) {
    if (job.status === "superseded" || (job.status as ReviewStatus) === "canceled" || (isClosing() && job.error === "服务正在关闭，任务未完成。")) return;
    job.status = "failed";
    job.error = safeErrorMessage(error, "审查执行失败，请稍后重试。");
    job.finishedAt = now().toISOString();
    appendProgress(job, { kind: "error", message: "审查失败", detail: job.error });
  } finally {
    appendProgress(job, { kind: "stage", message: "任务执行资源已释放，MR 工作区保留复用" });
  }
}

function currentHead(mergeRequest: { diff_refs?: { head_sha?: string | null } | null; sha?: string | null }): string | null {
  return mergeRequest.sha?.trim() || mergeRequest.diff_refs?.head_sha?.trim() || null;
}

function currentTargetBranch(mergeRequest: { target_branch?: string | null }): string | null {
  const targetBranch = mergeRequest.target_branch?.trim();
  return targetBranch || null;
}
