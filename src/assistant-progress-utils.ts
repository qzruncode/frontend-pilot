import { asRecord, valueText } from "./agent-sdk-utils.js";
import {
  ASSISTANT_ACTION_TOOL_NAMES,
} from "./assistant-tools.js";
import { AssistantCardSchema, ReviewStatusSchema, type AssistantCard, type AssistantReviewTaskReference } from "./contracts.js";
import { AssistantEditOperationSchema, type AssistantEditOperation } from "./contracts.js";
import type { AssistantProgressEvent } from "./assistant-runner.js";

export const MAX_PROGRESS_DETAIL_LENGTH = 1_200;
export const MAX_TOOL_OUTPUT_LENGTH = 5_000;

export function compact(value: string, limit = MAX_PROGRESS_DETAIL_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

export function limitText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…（输出过长，已截断）` : value;
}

export function thinkingText(value: Record<string, unknown>): string {
  return valueText(value.thinking ?? value.reasoning ?? value.reasoning_content ?? value.text);
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
    return `${pattern ? `搜索 ${JSON.stringify(compact(pattern, 180))}` : "搜索代码"}${filePath ? ` · ${filePath}` : ""}`;
  }
  if (toolName === "Glob") {
    const pattern = String(value.pattern ?? "");
    return pattern ? `匹配 ${pattern}${filePath ? ` · ${filePath}` : ""}` : "扫描文件";
  }
  if (toolName === "Edit") {
    const oldLength = typeof value.old_string === "string" ? value.old_string.length : 0;
    const newLength = typeof value.new_string === "string" ? value.new_string.length : 0;
    return `修改 ${filePath || "文件"}（${oldLength} → ${newLength} 字符）`;
  }
  if (toolName === "Write") {
    const contentLength = typeof value.content === "string" ? value.content.length : 0;
    return `写入 ${filePath || "文件"}（${contentLength} 字符）`;
  }
  return compact(valueText(input));
}

export function toolInputForProgress(toolName: string, input: unknown): unknown {
  const value = asRecord(input);
  if (!value || (toolName !== "Edit" && toolName !== "Write")) return input;
  if (toolName === "Edit") {
    return {
      file_path: value.file_path,
      ...(typeof value.replace_all === "boolean" ? { replace_all: value.replace_all } : {}),
      old_string_length: typeof value.old_string === "string" ? value.old_string.length : 0,
      new_string_length: typeof value.new_string === "string" ? value.new_string.length : 0,
    };
  }
  return {
    file_path: value.file_path,
    content_length: typeof value.content === "string" ? value.content.length : 0,
  };
}

function parseToolResultRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parseToolResultRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const block = asRecord(item);
      if (block?.type !== "text") continue;
      const parsed = parseToolResultRecord(block.text);
      if (parsed) return parsed;
    }
    return null;
  }
  return asRecord(value);
}

export function reviewTaskFromToolResult(
  toolName: string,
  content: unknown,
  isError: boolean,
): AssistantReviewTaskReference | undefined {
  if (isError || !ASSISTANT_ACTION_TOOL_NAMES.some((name) => name === toolName)) return undefined;
  const data = parseToolResultRecord(content);
  const review = asRecord(data?.review);
  if (!data || !review || typeof review.id !== "string" || typeof review.projectId !== "string" || typeof review.mrIid !== "string") return undefined;
  const action = toolName.endsWith("__cancel_review")
    ? data.canceled === true ? "canceled" : undefined
    : data.accepted === true ? "started" : undefined;
  const status = ReviewStatusSchema.safeParse(review.status);
  if (!action || !status.success) return undefined;
  return {
    id: review.id,
    projectId: review.projectId,
    projectPath: typeof review.projectPath === "string" ? review.projectPath : null,
    mrIid: review.mrIid,
    headSha: typeof review.headSha === "string" ? review.headSha : null,
    targetBranch: typeof review.targetBranch === "string" ? review.targetBranch : null,
    status: status.data,
    error: typeof review.error === "string" ? review.error : null,
    action,
    deduplicated: data.deduplicated === true,
  };
}

export function assistantCardFromToolResult(content: unknown, isError: boolean): AssistantCard | undefined {
  if (isError) return undefined;
  const data = parseToolResultRecord(content);
  const parsed = AssistantCardSchema.safeParse(data?.authRequired);
  return parsed.success ? parsed.data : undefined;
}

export function editOperationFromToolResult(
  toolName: string,
  content: unknown,
  isError: boolean,
): AssistantEditOperation | undefined {
  if (isError || !(toolName.endsWith("__apply_file_patch") || toolName.endsWith("__propose_file_patch"))) return undefined;
  const data = parseToolResultRecord(content);
  const parsed = AssistantEditOperationSchema.safeParse(data?.editOperation);
  return parsed.success ? parsed.data : undefined;
}

export function emitProgress(
  onProgress: ((event: AssistantProgressEvent) => void) | undefined,
  event: AssistantProgressEvent,
): void {
  try {
    onProgress?.(event);
  } catch {
    // Progress reporting must never interrupt the Claude request.
  }
}
