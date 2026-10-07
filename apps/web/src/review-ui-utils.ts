import { ApiError } from "./api";
import type { ReviewJob, ReviewProgressEvent } from "@contracts";

export function formatTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

export function shortId(value: string | null): string {
  return value ? value.slice(0, 12) : "latest";
}

export function statusClass(status: ReviewJob["status"]): string {
  return `status status-${status}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录已过期，请重新登录。";
    if (error.status === 403) return "当前页面来源未被服务端允许。";
    if (error.status === 503) return "服务端尚未配置 REVIEW_SERVICE_TOKEN。";
    if (typeof error.details === "string") return error.details;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function mergeProgressEvents(...groups: ReviewProgressEvent[][]): ReviewProgressEvent[] {
  const events = new Map<string, ReviewProgressEvent>();
  for (const group of groups) for (const event of group) events.set(event.id, event);
  return [...events.values()].slice(-1_000);
}
