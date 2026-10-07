import { useCallback, useMemo } from "react";
import type { ReactElement } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  LoaderCircle,
  Sparkles,
  UserRound,
  Wrench,
} from "lucide-react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { ThreadMessageLike, ToolCallMessagePartProps } from "@assistant-ui/react";
import type { ReviewJob, ReviewProgressEvent } from "@contracts";
import { buildReviewThreadMessages, type ReviewContext } from "./review-thread-messages";

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolLabel(toolName: string): string {
  const labels: Record<string, string> = { Bash: "运行命令", Edit: "修改文件", Glob: "查找文件", Grep: "搜索代码", Read: "读取文件", Write: "写入文件" };
  return labels[toolName] ?? toolName;
}

function formatMessageTime(value: Date | undefined): string {
  if (!value || Number.isNaN(value.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(value);
}

function agentStatus(status: ReviewJob["status"], live: boolean): { label: string; tone: string } {
  if (live) return { label: "正在审查", tone: "is-live" };
  const statuses: Record<ReviewJob["status"], { label: string; tone: string }> = {
    queued: { label: "排队中", tone: "is-queued" }, running: { label: "正在审查", tone: "is-live" }, completed: { label: "审查完成", tone: "is-complete" },
    failed: { label: "审查失败", tone: "is-error" }, superseded: { label: "已被替代", tone: "is-muted" }, canceled: { label: "已取消", tone: "is-muted" },
  };
  return statuses[status];
}

function ReviewToolCall({ toolName, argsText, result, isError, status }: ToolCallMessagePartProps): ReactElement {
  const isRunning = status.type === "running" || result === undefined;
  const statusLabel = isRunning ? "执行中" : isError ? "执行失败" : "已完成";
  return (
    <details className={`assistant-tool-call ${isError ? "assistant-tool-call-error" : ""}`} open={result === undefined}>
      <summary className="assistant-tool-heading">
        <span className="assistant-tool-glyph" aria-hidden="true"><Wrench /></span>
        <span className="assistant-tool-copy"><strong>{toolLabel(toolName)}</strong><small>{toolName}</small></span>
        <span className={`assistant-tool-status ${isRunning ? "is-running" : isError ? "is-error" : "is-complete"}`}>
          {isRunning ? <LoaderCircle className="assistant-tool-status-icon is-spinning" /> : isError ? <CircleAlert className="assistant-tool-status-icon" /> : <Check className="assistant-tool-status-icon" />}
          {statusLabel}
        </span>
        <ChevronRight className="assistant-tool-chevron" aria-hidden="true" />
      </summary>
      <div className="assistant-tool-body">
        {argsText && <div className="assistant-tool-section"><span>输入</span><pre className="assistant-tool-input">{argsText}</pre></div>}
        {result !== undefined && <div className="assistant-tool-section"><span>输出</span><pre className="assistant-tool-result">{resultText(result)}</pre></div>}
      </div>
    </details>
  );
}

const reviewPartComponents = { tools: { Fallback: ReviewToolCall } };

function ReviewThreadView({ live }: { live: boolean }) {
  return (
    <ThreadPrimitive.Root className={`assistant-thread ${live ? "assistant-thread-live" : ""}`}>
      <ThreadPrimitive.Viewport className="assistant-thread-viewport" autoScroll>
        <ThreadPrimitive.Messages>
          {({ message }) => {
            const isResult = message.id.startsWith("review-result-");
            const isRunning = message.status?.type === "running";
            const isSystem = message.role === "system";
            const label = message.role === "user" ? "Review 请求" : isResult ? "审查结果" : isSystem ? "任务状态" : "Frontend Pilot";
            const detail = message.role === "user" ? "审查范围" : isResult ? "最终结论" : isSystem ? "阶段更新" : isRunning ? "正在输出" : "分析记录";
            const avatar = message.role === "user" ? <UserRound /> : isResult ? <CircleCheck /> : isSystem ? <Clock3 /> : <Bot />;
            return (
              <MessagePrimitive.Root className={`assistant-message assistant-message-${message.role} ${isResult ? "assistant-message-result" : ""} ${isRunning ? "assistant-message-running" : ""}`}>
                <div className="assistant-message-header">
                  <span className="assistant-message-avatar" aria-hidden="true">{avatar}</span>
                  <span className="assistant-message-author"><strong>{label}</strong><small>{detail}</small></span>
                  {message.createdAt && <time>{formatMessageTime(message.createdAt)}</time>}
                </div>
                <div className="assistant-message-body">
                  <MessagePrimitive.Parts components={reviewPartComponents} />
                  {isRunning && <div className="assistant-thinking-indicator"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>正在分析代码变更</span><i /><i /><i /></div>}
                </div>
              </MessagePrimitive.Root>
            );
          }}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ScrollToBottom className="assistant-thread-scroll-button"><ChevronDown aria-hidden="true" /><span>回到底部</span></ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.Root>
  );
}

export function ReviewAssistantThread({ events, live, status, context }: { events: ReviewProgressEvent[]; live: boolean; status: ReviewJob["status"]; context: ReviewContext }) {
  const messages = useMemo(() => buildReviewThreadMessages(events, live, context), [context, events, live]);
  const convertMessage = useCallback((message: ThreadMessageLike) => message, []);
  const onNew = useCallback(async () => undefined, []);
  const runtime = useExternalStoreRuntime({ messages, convertMessage, onNew, isRunning: live, isDisabled: true });
  const currentStatus = agentStatus(status, live);
  return (
    <div className={`job-console ${live ? "job-console-live" : ""}`}>
      <div className="job-console-heading"><div className="job-console-agent"><span className="job-console-agent-avatar"><Sparkles aria-hidden="true" /></span><span className="job-console-agent-copy"><strong>Frontend Pilot</strong><small>Claude · 代码审查</small></span></div><span className={`job-console-state ${currentStatus.tone}`}><i className={live ? "console-pulse" : ""} />{currentStatus.label}</span></div>
      <div className="job-console-meta"><span><Bot aria-hidden="true" />审查会话</span><span><Clock3 aria-hidden="true" />{events.length} 个事件</span></div>
      <AssistantRuntimeProvider runtime={runtime}><ReviewThreadView live={live} /></AssistantRuntimeProvider>
    </div>
  );
}
