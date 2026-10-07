import { asRecord, valueText } from "./agent-sdk-utils.js";
import type { ReviewProgressInput, ReviewProgressMeta } from "./contracts.js";

export const MAX_PROGRESS_DETAIL_LENGTH = 600;
export const MAX_TOOL_OUTPUT_LENGTH = 4_000;
export const ASSISTANT_TEXT_FLUSH_INTERVAL_MS = 120;
export const ASSISTANT_TEXT_FLUSH_LENGTH = 240;

export function truncate(value: string, limit = MAX_PROGRESS_DETAIL_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

export function limitText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…（输出过长，已截断）` : value;
}

export function formattedResult(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }
  return "";
}

export function toolInputDetail(toolName: string, input: unknown): string {
  const value = asRecord(input) ?? {};
  const filePath = String(value.file_path ?? value.path ?? "");
  if (toolName === "Read") {
    const range = [value.offset, value.limit].filter((item) => item !== undefined).join(", ");
    return filePath ? `读取 ${filePath}${range ? `（${range}）` : ""}` : "读取文件";
  }
  if (toolName === "Grep") {
    const pattern = String(value.pattern ?? "");
    return `${pattern ? `搜索 ${JSON.stringify(truncate(pattern, 180))}` : "搜索代码"}${filePath ? ` · ${filePath}` : ""}`;
  }
  if (toolName === "Glob") {
    const pattern = String(value.pattern ?? "");
    return pattern ? `匹配 ${pattern}${filePath ? ` · ${filePath}` : ""}` : "扫描文件";
  }
  return truncate(valueText(input));
}

export interface SdkProgressState {
  textStreamId: number;
  lastTextFlushAt: number;
  pendingAssistantText: string;
  assistantTextSeen: boolean;
  assistantTextClosed: boolean;
}

export function emitProgress(
  onProgress: ((event: ReviewProgressInput) => void) | undefined,
  event: ReviewProgressInput,
): void {
  try {
    onProgress?.(event);
  } catch {
    // Progress reporting must never interrupt the review itself.
  }
}

export function flushAssistantText(
  onProgress: ((event: ReviewProgressInput) => void) | undefined,
  state: SdkProgressState,
  force = false,
): void {
  if (!state.pendingAssistantText) return;
  const now = Date.now();
  const shouldFlush = force
    || now - state.lastTextFlushAt >= ASSISTANT_TEXT_FLUSH_INTERVAL_MS
    || state.pendingAssistantText.length >= ASSISTANT_TEXT_FLUSH_LENGTH
    || /\r?\n/.test(state.pendingAssistantText);
  if (!shouldFlush) return;

  emitProgress(onProgress, {
    kind: "assistant",
    message: "",
    detail: state.pendingAssistantText,
    meta: { stream: "assistant", phase: "chunk", streamId: state.textStreamId },
  });
  state.pendingAssistantText = "";
  state.lastTextFlushAt = now;
}

export function closeAssistantText(
  onProgress: ((event: ReviewProgressInput) => void) | undefined,
  state: SdkProgressState,
): void {
  flushAssistantText(onProgress, state, true);
  if (!state.assistantTextSeen || state.assistantTextClosed) return;
  emitProgress(onProgress, {
    kind: "assistant",
    message: "",
    detail: null,
    meta: { stream: "assistant", phase: "end", streamId: state.textStreamId },
  });
  state.assistantTextClosed = true;
}

export function startAssistantTextMessage(
  onProgress: ((event: ReviewProgressInput) => void) | undefined,
  state: SdkProgressState,
): void {
  closeAssistantText(onProgress, state);
  state.textStreamId += 1;
  state.lastTextFlushAt = 0;
  state.pendingAssistantText = "";
  state.assistantTextSeen = false;
  state.assistantTextClosed = false;
}

export type { ReviewProgressMeta };
