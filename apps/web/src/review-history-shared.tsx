import type { ReviewJob, ReviewStats } from "@contracts";
import { Badge } from "@/components/ui/badge";

export type ReviewTimeRange = "all" | "today" | "7d" | "30d";
export type ReviewStatusFilter = ReviewJob["status"] | "active" | "all";

export const statusMeta: Record<ReviewJob["status"], { label: string; detail: string }> = {
  queued: { label: "排队中", detail: "等待执行" },
  running: { label: "审查中", detail: "正在输出" },
  completed: { label: "已完成", detail: "结果可查看" },
  failed: { label: "失败", detail: "需要关注" },
  superseded: { label: "已被替代", detail: "由新提交接替" },
  canceled: { label: "已取消", detail: "任务已停止" },
};

export function formatDateTime(value: string | null): string {
  if (!value) return "未结束";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatReviewDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return "未开始";
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "时间未知";
  const finished = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(finished)) return "时间未知";
  const totalSeconds = Math.max(0, Math.floor((finished - started) / 1_000));
  if (totalSeconds < 1) return "不足 1 秒";
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
}

export function shortSha(value: string | null): string {
  if (!value) return "未提供 SHA";
  return value.length > 10 ? value.slice(0, 8) + "…" : value;
}

export function projectLabel(job: ReviewJob): string {
  return job.projectPath ?? "未命名项目";
}

export function matchesQuery(job: ReviewJob, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = [
    projectLabel(job),
    job.projectId,
    job.mrIid,
    job.headSha ?? "",
    job.targetBranch ?? "",
    job.source,
    job.result?.summary ?? "",
  ].join(" ").toLocaleLowerCase();
  return haystack.includes(query.trim().toLocaleLowerCase());
}

export function isWithinRange(value: string, range: ReviewTimeRange): boolean {
  if (range === "all") return true;
  const createdAt = new Date(value).getTime();
  if (!Number.isFinite(createdAt)) return false;
  const duration = range === "today"
    ? 24 * 60 * 60 * 1_000
    : Number(range.slice(0, -1)) * 24 * 60 * 60 * 1_000;
  return Date.now() - createdAt <= duration;
}

export function countStatus(jobs: ReviewJob[], stats: ReviewStats | null, status: keyof ReviewStats): number {
  return stats?.[status] ?? jobs.filter((job) => job.status === status).length;
}

export function isActiveReviewStatus(status: ReviewJob["status"]): boolean {
  return status === "queued" || status === "running";
}

export function matchesStatusFilter(job: ReviewJob, filter: ReviewStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return isActiveReviewStatus(job.status);
  return job.status === filter;
}

export interface ReviewProfileContext {
  name: string;
  displayName: string;
  ruleCount: number | null;
}

export function reviewProfileContext(job: ReviewJob): ReviewProfileContext | null {
  const event = [...job.progress].reverse().find((item) => item.message === "审查 profile 已匹配" && typeof item.meta?.profile === "string");
  if (!event) return null;
  const name = String(event.meta?.profile);
  const displayName = typeof event.meta?.profileDisplayName === "string"
    ? event.meta.profileDisplayName
    : event.detail?.split(" · ", 1)[0] || name;
  const ruleCount = typeof event.meta?.ruleCount === "number" ? event.meta.ruleCount : null;
  return { name, displayName, ruleCount };
}

export function isTerminalReviewStatus(status: ReviewJob["status"]): boolean {
  return status !== "queued" && status !== "running";
}

export function ReviewStatusBadge({ status }: { status: ReviewJob["status"] }) {
  const meta = statusMeta[status];
  return (
    <Badge variant="outline" className={"review-history-status status-" + status} aria-label={"状态：" + meta.label}>
      <span aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}
