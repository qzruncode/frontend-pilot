import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { asRecord, contentBlocks, valueText } from "./agent-sdk-utils.js";
import type { ReviewProgressInput, ReviewProgressMeta } from "./contracts.js";
import {
  closeAssistantText,
  emitProgress,
  flushAssistantText,
  formattedResult,
  limitText,
  MAX_TOOL_OUTPUT_LENGTH,
  startAssistantTextMessage,
  type SdkProgressState,
  toolInputDetail,
  truncate,
} from "./review-progress-utils.js";

export function emitSdkProgress(
  message: SDKMessage,
  onProgress: ((event: ReviewProgressInput) => void) | undefined,
  toolNames: Map<string, string>,
  state: SdkProgressState,
  taskLabel = "审查",
): void {
  const record = asRecord(message) ?? {};
  if (message.type === "system") {
    const subtype = String(record.subtype ?? "");
    if (subtype === "init") {
      const tools = Array.isArray(record.tools) ? record.tools.filter((item): item is string => typeof item === "string") : [];
      const mcpServers = Array.isArray(record.mcp_servers) ? record.mcp_servers.length : 0;
      emitProgress(onProgress, {
        kind: "system",
        message: "Claude CLI 已启动",
        detail: `${String(record.model ?? "未知模型")} · 工作目录 ${String(record.cwd ?? "未知")} · 工具 ${tools.join(", ") || "无"}`,
        meta: {
          model: typeof record.model === "string" ? record.model : null,
          cwd: typeof record.cwd === "string" ? record.cwd : null,
          claudeVersion: typeof record.claude_code_version === "string" ? record.claude_code_version : null,
          mcpServers,
        },
      });
      return;
    }
    if (subtype === "status") return;
    if (subtype === "api_retry") {
      emitProgress(onProgress, {
        kind: "warning",
        message: `模型请求失败，准备第 ${String(record.attempt ?? "?")} 次重试`,
        detail: `等待 ${String(record.retry_delay_ms ?? "?")}ms · ${String(record.error ?? "未知错误")}`,
        meta: {
          attempt: typeof record.attempt === "number" ? record.attempt : null,
          maxRetries: typeof record.max_retries === "number" ? record.max_retries : null,
        },
      });
      return;
    }
    if (subtype === "thinking_tokens") return;
    if (subtype === "permission_denied") {
      emitProgress(onProgress, {
        kind: "warning",
        message: `工具 ${String(record.tool_name ?? "未知工具")} 被拒绝`,
        detail: typeof record.message === "string" ? truncate(record.message) : null,
      });
      return;
    }
    if (subtype === "notification" || subtype === "local_command_output") {
      const text = String(record.text ?? record.content ?? "");
      if (text) emitProgress(onProgress, { kind: "system", message: "Claude CLI 消息", detail: truncate(text) });
    }
    return;
  }

  if (message.type === "assistant") {
    for (const block of contentBlocks(record.message)) {
      const blockType = String(block.type ?? "");
      if (blockType === "tool_use") {
        const toolName = String(block.name ?? "未知工具");
        const toolUseId = String(block.id ?? "");
        if (toolUseId) toolNames.set(toolUseId, toolName);
        emitProgress(onProgress, {
          kind: "tool",
          message: `调用工具 ${toolName}`,
          detail: toolInputDetail(toolName, block.input),
          meta: { tool: toolName, toolUseId: toolUseId || null },
        });
      } else if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text && !state.assistantTextSeen) {
          state.assistantTextSeen = true;
          emitProgress(onProgress, {
            kind: "assistant",
            message: "",
            detail: text,
            meta: { stream: "assistant", phase: "complete", streamId: state.textStreamId },
          });
          state.assistantTextClosed = true;
        }
      }
    }
    return;
  }

  if (message.type === "user") {
    for (const block of contentBlocks(record.message)) {
      if (String(block.type ?? "") !== "tool_result") continue;
      const toolUseId = String(block.tool_use_id ?? "");
      const toolName = toolNames.get(toolUseId) ?? "工具";
      const detail = limitText(valueText(block.content), MAX_TOOL_OUTPUT_LENGTH) || "工具执行完成";
      emitProgress(onProgress, {
        kind: "tool_result",
        message: `${toolName} 返回结果`,
        detail,
        meta: {
          tool: toolName,
          toolUseId: toolUseId || null,
          isError: block.is_error === true,
        },
      });
    }
    return;
  }

  if (message.type === "stream_event") {
    const event = asRecord(record.event);
    const eventType = String(event?.type ?? "");
    if (eventType === "message_start") {
      startAssistantTextMessage(onProgress, state);
    } else if (eventType === "message_stop") {
      closeAssistantText(onProgress, state);
    } else if (eventType === "content_block_delta") {
      const delta = asRecord(event?.delta);
      if (String(delta?.type ?? "") === "text_delta" && typeof delta?.text === "string") {
        if (state.textStreamId === 0) state.textStreamId = 1;
        state.assistantTextSeen = true;
        state.assistantTextClosed = false;
        state.pendingAssistantText += delta.text;
        flushAssistantText(onProgress, state);
      }
    }
    return;
  }

  if (message.type === "tool_progress" || message.type === "tool_use_summary") return;

  if (message.type === "result") {
    const subtype = String(record.subtype ?? "");
    if (subtype === "success") {
      const meta: ReviewProgressMeta = {
        turns: typeof record.num_turns === "number" ? record.num_turns : null,
        durationMs: typeof record.duration_ms === "number" ? record.duration_ms : null,
        apiDurationMs: typeof record.duration_api_ms === "number" ? record.duration_api_ms : null,
        costUsd: typeof record.total_cost_usd === "number" ? record.total_cost_usd : null,
        stopReason: typeof record.stop_reason === "string" ? record.stop_reason : null,
      };
      const output = formattedResult(record.result) || formattedResult(record.structured_output);
      emitProgress(onProgress, {
        kind: "result",
        message: `Claude 已返回${taskLabel}结果`,
        detail: output || `${meta.turns ?? "?"} 个回合 · ${meta.durationMs ?? "?"}ms · stop=${meta.stopReason ?? "unknown"}`,
        meta: { ...meta, output: Boolean(output) },
      });
    } else {
      const errors = Array.isArray(record.errors) ? record.errors.filter((item): item is string => typeof item === "string") : [];
      emitProgress(onProgress, {
        kind: "error",
        message: `Claude 请求结束：${subtype || "未知错误"}`,
        detail: errors.join("; ") || null,
        meta: { subtype, turns: typeof record.num_turns === "number" ? record.num_turns : null },
      });
    }
  }
}
