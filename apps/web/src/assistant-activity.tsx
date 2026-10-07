import { useEffect, useState } from "react";
import { Activity, CheckCircle2, ChevronDown, CircleAlert, LoaderCircle, Sparkles, Square, Wrench } from "lucide-react";
import { ApiError, type AssistantStreamEvent } from "./api";
import { createId, type AgentActivity, type AssistantActivityPhase } from "./assistant-types";
import { formatTime } from "./review-ui-utils";
import { AssistantStreamEventSchema } from "@contracts";
import type { AssistantReviewTaskReference, AssistantRunResponse, ReviewProgressEvent } from "@contracts";

function formatActivityInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function activityToolLabel(toolName?: string): string {
  if (toolName === "Glob") return "查找文件";
  if (toolName === "Grep") return "搜索代码";
  if (toolName === "Read") return "读取文件";
  if (toolName === "Edit" || toolName === "Write") return "修改代码";
  if (toolName === "apply_file_patch" || toolName?.endsWith("__apply_file_patch")) return "修改代码";
  return toolName ? `使用 ${toolName}` : "执行工具";
}

function activityDisplayTitle(activity: AgentActivity): string {
  if (activity.kind === "thinking") return activity.phase === "error" ? "思考遇到问题" : activity.phase === "complete" ? "思路已整理" : "正在整理思路";
  if (activity.kind === "tool") {
    const label = activityToolLabel(activity.toolName);
    if (activity.phase === "error") return `${label}失败`;
    if (activity.phase === "start") return activity.toolName === "Edit" || activity.toolName === "Write" ? "正在修改代码" : label === "修改代码" ? "正在生成代码补丁" : `正在准备${label}`;
    return activity.phase === "complete" ? `${label}完成` : `正在${label}`;
  }
  if (activity.kind === "warning") return "需要注意";
  if (/思考摘要|思考|形成判断|整理上下文/.test(activity.title)) return activity.phase === "complete" ? "思路已整理" : "正在整理思路";
  if (/重新连接模型|模型连接/.test(activity.title)) return activity.phase === "complete" ? "模型连接已恢复" : activity.phase === "error" ? "模型连接未恢复" : "正在重新连接模型";
  if (/连接|启动/.test(activity.title)) return "助手已连接";
  if (/完成|返回审查结果|请求结束/.test(activity.title)) return "处理完成";
  if (activity.phase === "error" || /失败|拒绝|错误/.test(activity.title)) return "处理遇到问题";
  return activity.phase === "complete" ? "状态已更新" : "正在处理";
}

function activityStatusLabel(phase: AssistantActivityPhase): string {
  if (phase === "start" || phase === "running") return "进行中";
  if (phase === "error") return "未完成";
  return "已完成";
}

function legacyReviewTask(payload: AssistantStreamEvent): AssistantReviewTaskReference | undefined {
  const toolName = payload.toolName ?? "";
  const isCancel = toolName === "cancel_review" || toolName.endsWith("__cancel_review");
  const isStart = toolName === "start_review" || toolName.endsWith("__start_review") || toolName === "start_review_from_url" || toolName.endsWith("__start_review_from_url");
  if ((!isCancel && !isStart) || payload.meta?.isError === true || !payload.detail) return undefined;
  try {
    const data = JSON.parse(payload.detail) as { accepted?: boolean; canceled?: boolean; deduplicated?: boolean; review?: Record<string, unknown> };
    const review = data.review;
    if (!review || typeof review.id !== "string" || typeof review.projectId !== "string" || typeof review.mrIid !== "string") return undefined;
    if (typeof review.status !== "string" || !["queued", "running", "completed", "failed", "superseded", "canceled"].includes(review.status)) return undefined;
    const action = isCancel ? data.canceled === true ? "canceled" : undefined : data.accepted === true ? "started" : undefined;
    if (!action) return undefined;
    return {
      id: review.id,
      projectId: review.projectId,
      projectPath: typeof review.projectPath === "string" ? review.projectPath : null,
      mrIid: review.mrIid,
      headSha: typeof review.headSha === "string" ? review.headSha : null,
      targetBranch: typeof review.targetBranch === "string" ? review.targetBranch : null,
      status: review.status as AssistantReviewTaskReference["status"],
      error: typeof review.error === "string" ? review.error : null,
      action,
      deduplicated: data.deduplicated === true,
    };
  } catch {
    return undefined;
  }
}

function ActivityIcon({ activity, stopped, failed }: { activity: AgentActivity; stopped: boolean; failed: boolean }) {
  if (stopped) return <Square aria-hidden="true" />;
  if (failed || activity.phase === "error") return <CircleAlert aria-hidden="true" />;
  if (activity.phase === "start" || activity.phase === "running") return <LoaderCircle className="is-spinning" aria-hidden="true" />;
  if (activity.kind === "thinking") return <Sparkles aria-hidden="true" />;
  if (activity.kind === "tool") return <Wrench aria-hidden="true" />;
  return <CheckCircle2 aria-hidden="true" />;
}

export function AssistantActivityPanel({ activities, streaming, hasError, showCompleted = false, defaultOpen = false, stopped = false }: { showCompleted?: boolean; defaultOpen?: boolean; stopped?: boolean; activities: AgentActivity[]; streaming: boolean; hasError: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (!streaming && !defaultOpen) setOpen(false);
  }, [streaming, defaultOpen]);
  if (activities.length === 0) return null;
  const runningCount = activities.filter((activity) => activity.phase === "start" || activity.phase === "running").length;
  const errorCount = activities.filter((activity) => activity.phase === "error").length;
  const hasIssue = hasError || errorCount > 0;
  if (!streaming && !hasIssue && !showCompleted) return null;
  const currentActivity = [...activities].reverse().find((activity) => activity.phase === "start" || activity.phase === "running");
  const summaryTitle = stopped ? "执行记录" : hasError ? "处理遇到问题" : streaming && currentActivity ? activityDisplayTitle(currentActivity) : streaming ? "正在生成回复" : "查看处理过程";
  const summaryMeta = stopped ? `${activities.length} 项记录 · 任务已停止` : streaming ? runningCount > 0 ? `${runningCount} 项进行中` : "正在生成最终回复" : hasError ? errorCount > 0 ? `${errorCount} 项未完成` : "回复未完成" : errorCount > 0 ? `${activities.length} 项记录 · ${errorCount} 项曾失败` : `${activities.length} 项已完成`;
  return (
    <details className="assistant-activity-panel" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="assistant-activity-summary-icon"><Activity aria-hidden="true" /></span>
        <span className="assistant-activity-summary-copy"><strong>{summaryTitle}</strong><small>{summaryMeta}</small></span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="assistant-activity-list">
        {activities.map((activity) => {
          const input = formatActivityInput(activity.toolInput);
          const interrupted = (stopped || hasError) && (activity.phase === "start" || activity.phase === "running");
          return (
            <div className={`assistant-activity-row kind-${activity.kind} phase-${interrupted ? stopped ? "stopped" : "error" : activity.phase}`} key={activity.id}>
              <div className="assistant-activity-marker"><ActivityIcon activity={activity} stopped={interrupted && stopped} failed={interrupted && hasError} /></div>
              <div className="assistant-activity-body">
                <div className="assistant-activity-title"><strong>{interrupted ? activity.kind === "tool" ? activityToolLabel(activity.toolName) : stopped ? "执行已停止" : "执行未完成" : activityDisplayTitle(activity)}</strong><span>{interrupted ? stopped ? "已停止" : "未完成" : activityStatusLabel(activity.phase)}</span></div>
                {!interrupted && activity.phase === "start" && activity.kind === "tool" && activity.detail && <p className="assistant-activity-progress" role="status">{activity.detail}</p>}
                {(activity.detail || activity.progressDetail) && (
                  <details className="assistant-activity-detail"><summary>查看详情</summary>{activity.detail && <p>{activity.detail}</p>}{activity.progressDetail && <span className="assistant-activity-progress">{activity.progressDetail}</span>}</details>
                )}
                {input && <details className="assistant-activity-code"><summary>查看参数</summary><pre>{input}</pre></details>}
                {activity.result && <details className="assistant-activity-code is-result" open={activity.phase === "error"}><summary>{activity.resultError ? "错误输出" : "查看返回"}</summary><pre>{activity.result}</pre></details>}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

export function mergeAssistantActivity(activities: AgentActivity[], event: string, payload: AssistantStreamEvent): AgentActivity[] {
  if (!["thinking", "tool", "tool_result", "system", "warning"].includes(event)) return activities;
  const activityId = payload.activityId || createId("activity");
  const existing = activities.find((activity) => activity.id === activityId);
  const phase: AssistantActivityPhase = payload.phase ?? (event === "warning" ? "error" : event === "tool_result" ? "complete" : "complete");
  const incomingDetail = payload.detail ?? "";
  const isThinkingTokenProgress = event === "thinking" && payload.meta?.stream === "thinking_tokens";
  const title = existing?.title || (event === "thinking" ? "思考摘要" : payload.message || "Agent 过程");
  if (event === "tool_result") {
    const reviewTask = payload.reviewTask ?? legacyReviewTask(payload);
    const next: AgentActivity = existing
      ? { ...existing, title, phase, result: incomingDetail || existing.result || "工具执行完成", resultError: payload.meta?.isError === true || phase === "error", reviewTask: reviewTask ?? existing.reviewTask }
      : { id: activityId, kind: "tool", title, detail: "", phase, toolName: payload.toolName ?? undefined, result: incomingDetail || "工具执行完成", resultError: payload.meta?.isError === true || phase === "error", reviewTask };
    return (existing ? activities.map((activity) => activity.id === activityId ? next : activity) : [...activities, next]).slice(-500);
  }
  const next: AgentActivity = existing
    ? {
        ...existing,
        title,
        phase,
        detail: isThinkingTokenProgress ? existing.detail : event === "thinking" && phase === "running" ? `${existing.detail}${incomingDetail}` : incomingDetail || existing.detail,
        progressDetail: isThinkingTokenProgress ? incomingDetail || existing.progressDetail : existing.progressDetail,
        toolName: payload.toolName ?? existing.toolName,
        toolInput: payload.toolInput !== undefined ? payload.toolInput : existing.toolInput,
        reviewTask: payload.reviewTask ?? existing.reviewTask,
      }
    : { id: activityId, kind: event as AgentActivity["kind"], title, detail: isThinkingTokenProgress ? "" : incomingDetail, progressDetail: isThinkingTokenProgress ? incomingDetail : undefined, phase, toolName: payload.toolName ?? undefined, toolInput: payload.toolInput, reviewTask: payload.reviewTask };
  return (existing ? activities.map((activity) => activity.id === activityId ? next : activity) : [...activities, next]).slice(-500);
}

export function assistantActivitiesFromRuns(runs: AssistantRunResponse[]): AgentActivity[] {
  return [...runs]
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
    .reduce<AgentActivity[]>((activities, run) => run.events.reduce<AgentActivity[]>((items, event) => {
      const parsed = AssistantStreamEventSchema.safeParse(event.payload);
      if (!parsed.success) return items;
      const activityId = `${run.id}:${parsed.data.activityId ?? event.sequence}`;
      return mergeAssistantActivity(items, event.event, { ...parsed.data, activityId });
    }, activities), []);
}

export function ReviewProgressPanel({ events, live }: { events: ReviewProgressEvent[]; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);
  if (events.length === 0) return null;
  return (
    <details className="inspection-progress-collapsible" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="inspection-progress-heading">
        <strong>Review 执行记录</strong>
        <span>{live ? "检查中" : `${events.length} 项记录`}</span>
        <ChevronDown className="inspection-progress-toggle-icon" aria-hidden="true" />
      </summary>
      <div className="inspection-progress-content">
        <div className="inspection-progress-list">
          {events.slice(-12).map((event) => {
            const detail = event.detail?.trim() && event.detail.trim() !== event.message ? event.detail.trim() : null;
            return <div className={`inspection-progress-item inspection-progress-${event.kind}`} key={event.id}>
              <i aria-hidden="true" />
              <div>
                <strong>{event.message}</strong>
                {detail && <span>{detail}</span>}
                <small>{formatTime(event.at)}</small>
              </div>
            </div>;
          })}
        </div>
      </div>
    </details>
  );
}

export function userFacingStatus(status: string): string {
  if (/正在请求模型|正在形成判断|正在思考|准备上下文|整理上下文|思考摘要/.test(status) || /已开启.*思考摘要/.test(status)) return "正在整理思路";
  if (/CLI 已连接|CLI 已启动|已连接助手流程/.test(status)) return "助手已连接";
  if (/已完成回复|已返回审查结果|请求结束/.test(status)) return "回复已完成";
  if (/模型请求失败|请求失败/.test(status)) return "请求失败，正在重试";
  if (/被拒绝/.test(status)) return "工具未获允许";
  const tool = /(?:调用工具|执行中|返回结果)\s*([A-Za-z]+)/.exec(status)?.[1];
  if (tool) {
    const label = activityToolLabel(tool);
    return /返回结果/.test(status) ? `${label}完成` : `正在${label}`;
  }
  return status.replaceAll("Claude CLI", "助手").replaceAll("Claude", "助手");
}

export function userFacingError(message: string): string {
  if (/超时/.test(message)) return "回复请求超时，请稍后重试。";
  if (/取消|停止/.test(message)) return "已停止生成。";
  if (/配置|未配置/.test(message)) return "助手未配置，请检查服务端配置。";
  if (/空消息/.test(message)) return "助手没有返回内容，请稍后重试。";
  if (/请求失败/.test(message)) return "回复请求失败，请稍后重试。";
  return message.replaceAll("Claude Agent SDK", "助手服务").replaceAll("Claude CLI", "助手").replaceAll("Claude", "助手");
}

export function assistantErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "页面会话已失效，请刷新页面后重试。";
    if (error.status === 503) return "助手当前不可用，请检查服务端配置。";
    return userFacingError(typeof error.details === "string" ? error.details : error.message);
  }
  return error instanceof Error ? userFacingError(error.message) : "助手回复失败，请稍后重试。";
}
