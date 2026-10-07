import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { asRecord, contentBlocks, valueText } from "./agent-sdk-utils.js";
import type {
  AssistantProgressEvent,
  AssistantProgressPhase,
} from "./assistant-runner.js";
import {
  compact,
  emitProgress,
  limitText,
  MAX_PROGRESS_DETAIL_LENGTH,
  MAX_TOOL_OUTPUT_LENGTH,
  assistantCardFromToolResult,
  editOperationFromToolResult,
  reviewTaskFromToolResult,
  thinkingText,
  toolInputForProgress,
  toolInputDetail,
} from "./assistant-progress-utils.js";
export interface AssistantSdkProgressState {
  turnId: number;
  streamTextSeen: boolean;
  assistantTextEmitted: boolean;
  thinkingBlockSeen: boolean;
  thinkingOutputSeen: boolean;
  thinkingActivityIds: Map<number, string>;
  thinkingDeltaSeen: Set<string>;
  toolInputProgress: Map<number, { id: string; characters: number; reportedAt: number }>;
  retryActivityId?: string;
}
function thinkingActivityId(state: AssistantSdkProgressState, blockIndex: number): string {
  const existing = state.thinkingActivityIds.get(blockIndex);
  if (existing) return existing;
  const id = `thinking-${state.turnId}-${blockIndex}`;
  state.thinkingActivityIds.set(blockIndex, id);
  return id;
}
export function emitAssistantSdkProgress(
  message: SDKMessage,
  onProgress: ((event: AssistantProgressEvent) => void) | undefined,
  state: AssistantSdkProgressState,
  toolNames: Map<string, string>,
): string {
  const record = asRecord(message) ?? {};
  if (record.type === "stream_event") {
    const event = asRecord(record.event);
    if (!event) return "";
    if (event.type === "message_start") {
      state.turnId += 1;
      state.thinkingActivityIds.clear();
      state.toolInputProgress.clear();
      if (state.retryActivityId) {
        emitProgress(onProgress, { kind: "system", activityId: state.retryActivityId,
          message: "模型连接已恢复", phase: "complete" });
        state.retryActivityId = undefined;
      }
      return "";
    }
    if (event.type === "content_block_start") {
      const block = asRecord(event.content_block);
      const blockIndex = typeof event.index === "number" ? event.index : 0;
      if (block?.type === "thinking" || block?.type === "reasoning" || block?.type === "redacted_thinking") {
        state.thinkingBlockSeen = true;
        const activityId = thinkingActivityId(state, blockIndex);
        emitProgress(onProgress, {
          kind: "thinking",
          message: "Claude 正在形成判断",
          detail: null,
          activityId,
          phase: "start",
        });
      } else if (block?.type === "tool_use") {
        const toolName = String(block.name ?? "未知工具");
        const toolUseId = String(block.id ?? `tool-${state.turnId}-${blockIndex}`);
        toolNames.set(toolUseId, toolName);
        state.toolInputProgress.set(blockIndex, { id: toolUseId, characters: 0, reportedAt: 0 });
        emitProgress(onProgress, {
          kind: "tool",
          message: `调用工具 ${toolName}`,
          detail: toolInputDetail(toolName, block.input),
          activityId: toolUseId,
          toolName,
          toolInput: toolInputForProgress(toolName, block.input),
          phase: "start",
        });
      }
      return "";
    }
    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      const blockIndex = typeof event.index === "number" ? event.index : 0;
      if (delta?.type === "text_delta") {
        const text = valueText(delta.text);
        if (text) {
          state.streamTextSeen = true;
          state.assistantTextEmitted = true;
          emitProgress(onProgress, {
            kind: "assistant",
            message: text,
            meta: { stream: "assistant", phase: "chunk" },
          });
        }
        return text;
      }
      if (delta?.type === "input_json_delta") {
        const progress = state.toolInputProgress.get(blockIndex);
        if (progress) {
          progress.characters += valueText(delta.partial_json).length;
          const now = Date.now();
          if (!progress.reportedAt || now - progress.reportedAt >= 2_000) {
            progress.reportedAt = now;
            emitProgress(onProgress, { kind: "tool", activityId: progress.id,
              toolName: toolNames.get(progress.id), message: "正在准备工具输入", phase: "start",
              detail: `已生成 ${progress.characters} 个字符，生成完成后执行`,
              meta: { stream: "tool_input", inputCharacters: progress.characters } });
          }
        }
        return "";
      }
      const deltaType = String(delta?.type ?? "");
      const detail = delta ? thinkingText(delta) : "";
      if (deltaType === "thinking_delta" || deltaType === "reasoning_delta" || deltaType === "reasoning_content_delta" || detail) {
        state.thinkingBlockSeen = true;
        const activityId = thinkingActivityId(state, blockIndex);
        if (detail) {
          state.thinkingOutputSeen = true;
          state.thinkingDeltaSeen.add(activityId);
        }
        emitProgress(onProgress, {
          kind: "thinking",
          message: "思考摘要",
          detail: detail ? limitText(detail, MAX_PROGRESS_DETAIL_LENGTH) : null,
          activityId,
          phase: "running",
          meta: { stream: "thinking" },
        });
      }
      return "";
    }
    return "";
  }
  if (record.type === "system") {
    const subtype = String(record.subtype ?? "");
    if (subtype === "init") {
      const tools = Array.isArray(record.tools)
        ? record.tools.filter((item): item is string => typeof item === "string")
        : [];
      emitProgress(onProgress, {
        kind: "system",
        message: "Claude CLI 已连接",
        detail: `${String(record.model ?? "未知模型")} · 工具 ${tools.join(", ") || "无"}`,
        activityId: `system-init-${String(record.uuid ?? Date.now())}`,
        phase: "complete",
        meta: {
          model: typeof record.model === "string" ? record.model : null,
          claudeVersion: typeof record.claude_code_version === "string" ? record.claude_code_version : null,
          cwd: typeof record.cwd === "string" ? record.cwd : null,
        },
      });
      return "";
    }
    if (subtype === "status") {
      if (record.status === "compacting") emitProgress(onProgress, { kind: "status", message: "Claude 正在整理上下文" });
      if (record.status === "requesting") emitProgress(onProgress, { kind: "status", message: "Claude 正在请求模型" });
      return "";
    }
    if (subtype === "thinking_tokens") {
      state.thinkingBlockSeen = true;
      const activityId = thinkingActivityId(state, 0);
      const estimatedTokens = Number(record.estimated_tokens ?? 0);
      emitProgress(onProgress, {
        kind: "thinking",
        message: "模型正在思考",
        detail: estimatedTokens > 0 ? `已生成约 ${estimatedTokens} 个思考 token` : "正在生成思考摘要",
        activityId,
        phase: "running",
        meta: { stream: "thinking_tokens", estimatedTokens },
      });
      return "";
    }
    if (subtype === "api_retry") {
      state.retryActivityId ??= `model-retry-${state.turnId}`;
      emitProgress(onProgress, {
        kind: "system",
        message: "正在重新连接模型",
        detail: `第 ${String(record.attempt ?? "?")} 次重试，等待 ${Math.ceil(Number(record.retry_delay_ms ?? 0) / 1000)} 秒 · ${String(record.error ?? "未知错误")}`,
        activityId: state.retryActivityId,
        phase: "running",
      });
      return "";
    }
    if (subtype === "permission_denied") {
      const toolName = String(record.tool_name ?? "未知工具");
      emitProgress(onProgress, {
        kind: "warning",
        message: `工具 ${toolName} 被拒绝`,
        detail: compact(String(record.decision_reason ?? record.message ?? "当前助手只允许只读工具")),
        activityId: String(record.tool_use_id ?? `warning-permission-${Date.now()}`),
        toolName,
        phase: "error",
      });
      return "";
    }
    if (subtype === "task_started" || subtype === "task_progress" || subtype === "task_notification") {
      const taskId = String(record.tool_use_id ?? record.task_id ?? `task-${Date.now()}`);
      const taskName = String(record.subagent_type ?? "Task");
      const status = String(record.status ?? "running");
      const phase: AssistantProgressPhase = status === "failed" || status === "stopped"
        ? "error"
        : status === "completed"
          ? "complete"
          : subtype === "task_started" ? "start" : "running";
      emitProgress(onProgress, {
        kind: "tool",
        message: subtype === "task_notification" ? `${taskName} 已${status === "completed" ? "完成" : "停止"}` : `${taskName} 正在工作`,
        detail: compact(String(record.description ?? record.summary ?? record.last_tool_name ?? "正在处理子任务")),
        activityId: taskId,
        toolName: taskName,
        phase,
      });
      return "";
    }
    if (subtype === "notification" || subtype === "local_command_output" || subtype === "informational") {
      const detail = String(record.text ?? record.content ?? "");
      if (detail) {
        emitProgress(onProgress, {
          kind: "system",
          message: "Claude CLI 消息",
          detail: limitText(detail, MAX_PROGRESS_DETAIL_LENGTH),
          activityId: `system-${String(record.uuid ?? Date.now())}`,
          phase: "complete",
        });
      }
    }
    return "";
  }
  if (record.type === "tool_progress") {
    const toolUseId = String(record.tool_use_id ?? `tool-progress-${Date.now()}`);
    const toolName = toolNames.get(toolUseId) ?? String(record.tool_name ?? "工具");
    toolNames.set(toolUseId, toolName);
    emitProgress(onProgress, {
      kind: "tool",
      message: `${toolName} 执行中`,
      detail: `已耗时 ${String(record.elapsed_time_seconds ?? 0)} 秒`,
      activityId: toolUseId,
      toolName,
      phase: "running",
    });
    return "";
  }
  if (record.type === "tool_use_summary") {
    emitProgress(onProgress, {
      kind: "system",
      message: "工具调用阶段完成",
      detail: compact(String(record.summary ?? "")),
      activityId: `tool-summary-${String(record.uuid ?? Date.now())}`,
      phase: "complete",
    });
    return "";
  }
  if (record.type === "assistant") {
    contentBlocks(record.message).forEach((block, blockIndex) => {
      const blockType = String(block.type ?? "");
      if (blockType === "text") {
        const text = valueText(block.text);
        if (text && !state.streamTextSeen) {
          state.assistantTextEmitted = true;
          emitProgress(onProgress, {
            kind: "assistant",
            message: text,
            meta: { stream: "assistant", phase: "complete" },
          });
        }
      } else if (blockType === "thinking" || blockType === "reasoning" || blockType === "redacted_thinking") {
        state.thinkingBlockSeen = true;
        const activityId = thinkingActivityId(state, blockIndex);
        const detail = thinkingText(block);
        if (detail) state.thinkingOutputSeen = true;
        if (!state.thinkingDeltaSeen.has(activityId) && detail) {
          emitProgress(onProgress, {
            kind: "thinking",
            message: "思考摘要",
            detail: limitText(detail, MAX_PROGRESS_DETAIL_LENGTH),
            activityId,
            phase: "complete",
          });
        } else {
          emitProgress(onProgress, { kind: "thinking", message: "思考摘要已完成", activityId, phase: "complete" });
        }
      } else if (blockType === "tool_use") {
        const toolName = String(block.name ?? "未知工具");
        const toolUseId = String(block.id ?? `tool-${state.turnId}-${blockIndex}`);
        toolNames.set(toolUseId, toolName);
        emitProgress(onProgress, {
          kind: "tool",
          message: `调用工具 ${toolName}`,
          detail: toolInputDetail(toolName, block.input),
          activityId: toolUseId,
          toolName,
          toolInput: toolInputForProgress(toolName, block.input),
          phase: "running",
        });
      }
    });
    return "";
  }
  if (record.type === "user") {
    contentBlocks(record.message).forEach((block) => {
      if (String(block.type ?? "") !== "tool_result") return;
      const toolUseId = String(block.tool_use_id ?? `tool-result-${Date.now()}`);
      const toolName = toolNames.get(toolUseId) ?? "工具";
      const detail = limitText(valueText(block.content), MAX_TOOL_OUTPUT_LENGTH) || "工具执行完成";
      const isError = block.is_error === true;
      const reviewTask = reviewTaskFromToolResult(toolName, block.content, isError);
      const card = assistantCardFromToolResult(block.content, isError);
      const editOperation = editOperationFromToolResult(toolName, block.content, isError);
      emitProgress(onProgress, {
        kind: "tool_result",
        message: `${toolName} ${isError ? "执行失败" : "返回结果"}`,
        detail,
        activityId: toolUseId,
        toolName,
        phase: isError ? "error" : "complete",
        meta: { isError },
        ...(reviewTask ? { reviewTask } : {}),
        ...(card ? { card } : {}),
        ...(editOperation ? { editOperation } : {}),
      });
    });
  }
  return "";
}
