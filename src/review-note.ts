import type { ReviewJob, ReviewProgressEvent } from "./contracts.js";

export const REVIEW_NOTE_MARKER_PREFIX = "mr-review-service";

export function reviewProgressNoteMarker(projectId: string, mrIid: string): string {
  return `<!-- ${REVIEW_NOTE_MARKER_PREFIX}:progress:${projectId}:${mrIid} -->`;
}

export function reviewReportNoteMarker(projectId: string, mrIid: string, headSha: string | null): string {
  return `<!-- ${REVIEW_NOTE_MARKER_PREFIX}:report:${projectId}:${mrIid}:${headSha ?? "unknown"} -->`;
}

function statusLabel(status: ReviewJob["status"]): string {
  switch (status) {
    case "queued": return "🕒 排队中";
    case "running": return "🔍 审核中";
    case "completed": return "✅ 审核完成";
    case "failed": return "❌ 审核失败";
    case "superseded": return "⏹️ 已被新提交替代";
    case "canceled": return "⏹️ 已取消";
  }
}

function visibleProgress(event: ReviewProgressEvent): { stage: string; detail: string | null } {
  if (["thinking", "tool", "tool_result", "assistant"].includes(event.kind)) {
    return { stage: "正在执行 Claude 审查", detail: null };
  }
  return { stage: event.message, detail: event.detail ?? null };
}

function elapsed(createdAt: string, now: Date): string {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return "未知";
  const seconds = Math.max(0, Math.floor((now.getTime() - created) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function renderReviewProgressNote({
  job,
  event,
  jobUrl,
  now = new Date(),
}: {
  job: ReviewJob;
  event: ReviewProgressEvent;
  jobUrl?: string | null;
  now?: Date;
}): string {
  const progress = visibleProgress(event);
  const lines = [
    reviewProgressNoteMarker(job.projectId, job.mrIid),
    "## Frontend Pilot 审核",
    "",
    `- 状态：${statusLabel(job.status)}`,
    `- 提交：\`${String(job.headSha ?? "unknown").slice(0, 12)}\``,
    `- 阶段：${progress.stage}`,
    `- 已用时：${elapsed(job.createdAt, now)}`,
    `- 最后更新：${event.at}`,
  ];
  if (progress.detail) lines.push(`- 详情：${progress.detail}`);
  if (jobUrl) lines.push(`- CI Job：[查看审核任务](${jobUrl})`);
  if (job.status === "superseded") lines.push("", "该任务不会再写回旧审核结果，最新提交会创建新的审核任务。");
  if (job.status === "canceled") lines.push("", "该任务已停止，合并门禁不会使用本次结果。");
  return `${lines.join("\n")}\n`;
}
