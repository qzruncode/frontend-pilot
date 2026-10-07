import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { CheckCircle2, CircleAlert, Code2, ExternalLink, GitMerge, LoaderCircle, RotateCcw, Sparkles, Square } from "lucide-react";
import { InspectionAiTaskSchema, InspectionAiTaskDetailSchema, InspectionAiReprocessResponseSchema, type InspectionAiTask, type InspectionAiTaskDetail } from "@contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { createIntegrationApi } from "./api";
import { IntegrationApiContext, useIntegrationApi } from "./integration-api-context";
import { assistantActivitiesFromRuns, assistantErrorMessage, AssistantActivityPanel, ReviewProgressPanel } from "./assistant-activity";
import { AssistantEditOperationCard, AssistantWorkspaceDiffCard } from "./assistant-edit-operation-card";
import { AssistantMarkdown } from "./assistant-markdown";
import { ReviewDrawerShell } from "./review-drawer-shell";

export interface InspectionAiSource { runId: string; findingId: string }
const base = "/api/v1/ai-tasks";
const responseSchema = z.object({ task: InspectionAiTaskSchema.nullable() });
const inspectionAiSourceResponseSchema = z.object({
  source: z.object({ runId: z.string(), findingId: z.string() }).nullable(),
  maintainerId: z.string().nullable(),
});
const isProcessing = (task: InspectionAiTask | null) => Boolean(task && ["queued", "preparing", "running", "publishing", "pipeline_pending", "review_pending", "review_fixing"].includes(task.status));

type InspectionJiraAiContext = {
  source: InspectionAiSource;
  api: ReturnType<typeof createIntegrationApi>;
};

export function useInspectionJiraAiSource(jiraKey: string | null): { context: InspectionJiraAiContext | null; loading: boolean; unavailable: boolean } {
  const { request } = useIntegrationApi();
  const [context, setContext] = useState<InspectionJiraAiContext | null>(null);
  const [loading, setLoading] = useState(Boolean(jiraKey));
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!jiraKey) {
      setContext(null);
      setLoading(false);
      setUnavailable(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setUnavailable(false);
    const load = async () => {
      try {
        const response = await request(`/api/v1/jira/issues/${encodeURIComponent(jiraKey)}/inspection-ai-source`, inspectionAiSourceResponseSchema, { cache: "no-store", signal: controller.signal });
        if (!active) return;
        setContext(response.source && response.maintainerId
          ? { source: response.source, api: createIntegrationApi("/api/v1/inspections", response.maintainerId) }
          : null);
      } catch {
        if (active) {
          setContext(null);
          setUnavailable(true);
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    setContext(null);
    void load();
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [jiraKey, request]);
  return { context, loading, unavailable };
}

export function InspectionAiAction({ source, jiraKey, onError, onNotice, onResolved }: { source: InspectionAiSource; jiraKey: string; onError: (message: string) => void; onNotice?: (message: string) => void; onResolved?: () => void | Promise<void> }) {
  const { request } = useIntegrationApi();
  const navigate = useNavigate();
  const [task, setTask] = useState<InspectionAiTask | null>(null);
  const [detail, setDetail] = useState<InspectionAiTaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<"start" | "retry" | "cancel" | "reprocess" | null>(null);
  const submitting = pendingAction !== null;
  const mutationPending = useRef(false);
  const requestVersion = useRef(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolvedNotified = useRef<string | null>(null);
  const processing = isProcessing(task);
  const actionStarting = pendingAction === "start" || pendingAction === "retry";
  const actionDisabled = submitting || (!task && loading);
  const taskId = task?.id;
  useEffect(() => {
    if (submitting) return;
    let active = true;
    const version = requestVersion.current;
    const controller = new AbortController();
    const isCurrent = () => active && !mutationPending.current && version === requestVersion.current;
    const notifyResolutionChange = (nextTask: InspectionAiTask | null) => {
      const signature = nextTask?.status === "merged" && nextTask.resolution?.status && nextTask.resolution.status !== "unknown"
        ? `${nextTask.status}:${nextTask.resolution.status}:${nextTask.resolution.targetHeadSha ?? ""}`
        : null;
      if (signature === resolvedNotified.current) return;
      resolvedNotified.current = signature;
      if (signature) void Promise.resolve(onResolved?.()).catch(() => undefined);
    };
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        if (taskId) {
          const next = await request(`${base}/${encodeURIComponent(taskId)}`, InspectionAiTaskDetailSchema, { cache: "no-store", signal: controller.signal });
          if (isCurrent()) {
            setTask(next.task); setDetail(next);
            notifyResolutionChange(next.task);
          }
        } else {
          const next = await request(`${base}?${new URLSearchParams({ runId: source.runId, findingId: source.findingId })}`, responseSchema, { cache: "no-store", signal: controller.signal });
          if (isCurrent()) {
            setTask(next.task);
            notifyResolutionChange(next.task);
          }
        }
        if (isCurrent()) setError(null);
      } catch (error) { if (isCurrent()) setError(assistantErrorMessage(error)); }
      finally { inFlight = false; if (isCurrent()) setLoading(false); }
    };
    void load();
    const refresh = () => { void load(); };
    const timer = window.setInterval(refresh, processing ? 3_000 : 30_000);
    window.addEventListener("focus", refresh);
    return () => { active = false; controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [source.runId, source.findingId, taskId, onResolved, processing, submitting, request]);
  const act = async (action: "start" | "retry" | "cancel") => {
    if (mutationPending.current) return;
    mutationPending.current = true;
    requestVersion.current += 1;
    setOpen(true);
    setLoading(false);
    setPendingAction(action);
    setError(null);
    try {
      const next = await request(action === "start" ? base : `${base}/${task!.id}/${action}`, responseSchema,
        { method: "POST", ...(action === "start" ? { body: JSON.stringify(source) } : {}) });
      setTask(next.task); setError(null); setOpen(true);
    } catch (error) { const message = assistantErrorMessage(error); setError(message); onError(message); setOpen(true); }
    finally { mutationPending.current = false; setPendingAction(null); }
  };
  const reprocess = async () => {
    if (mutationPending.current || !task?.mr || task.status !== "merged") return;
    mutationPending.current = true;
    requestVersion.current += 1;
    setOpen(true);
    setLoading(false);
    setPendingAction("reprocess");
    setError(null);
    try {
      const result = await request(`${base}/${encodeURIComponent(task.id)}/reprocess`, InspectionAiReprocessResponseSchema, { method: "POST" });
      setTask(result.task);
      setError(null);
      setOpen(true);
      void Promise.resolve(onResolved?.()).catch(() => undefined);
      if (result.action === "restarted") onNotice?.("AI 已确认代码被回滚，已重新进入处理队列。");
      else if (result.resolutionStatus === "active") onNotice?.("AI 检查完成，合并代码仍然存在，无需重新处理。");
      else onNotice?.(result.task.resolution?.error ? `AI 检查完成，本次不重新处理：${result.task.resolution.error}` : "AI 检查完成，未确认代码已回滚，本次不重新处理。");
    } catch (error) {
      const message = assistantErrorMessage(error);
      setError(message);
      onError(message);
      setOpen(true);
    } finally {
      mutationPending.current = false;
      setPendingAction(null);
    }
  };
  const openMr = () => {
    if (!task?.mr) return;
    navigate(`/gitlab-workbench?${new URLSearchParams({ inspection: "1", maintainerId: task.maintainerId,
      projectId: task.mr.projectId, mrIid: task.mr.iid })}`);
  };
  const execution = pendingAction !== "retry" && pendingAction !== "reprocess" && detail?.execution?.id === task?.assistantRunId ? detail?.execution : null;
  const executions = useMemo(() => {
    const history = detail?.executions ?? [];
    if (!execution) return history;
    return history.some((run) => run.id === execution.id)
      ? history.map((run) => run.id === execution.id ? execution : run)
      : [...history, execution];
  }, [detail?.executions, execution]);
  const activities = useMemo(() => assistantActivitiesFromRuns(executions), [executions]);
  const latestExecution = execution ?? [...executions].sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id)).at(-1) ?? null;
  const answer = [...(latestExecution?.events ?? [])].reverse().find((event) => event.event === "done")?.payload.message;
  const label = loading ? "读取 AI 状态…" : pendingAction === "reprocess" ? "正在检查…" : pendingAction === "retry" ? "正在继续…" : pendingAction === "cancel" ? "正在停止…" : pendingAction === "start" ? "正在启动…" : task?.status === "queued" ? "排队中" : processing ? "处理中" : task?.status === "merged" ? "已合并"
    : task?.status === "closed" ? "MR 已关闭" : task?.status === "failed" ? "处理失败" : task?.mr ? "MR详情" : task?.status === "canceled" ? "已停止" : "AI处理";
  const stopped = task?.status === "canceled";
  const title = task?.title?.endsWith(` #${jiraKey}`) ? task.title.slice(0, -jiraKey.length - 2) : task?.title || jiraKey;
  const StatusIcon = submitting || processing ? LoaderCircle : stopped ? Square : task?.status === "failed" ? CircleAlert : task?.status === "merged" ? CheckCircle2 : task?.mr ? GitMerge : Sparkles;
  const statusNote = pendingAction === "retry" ? "正在启动新一轮处理，已有代码改动会保留。" : stopped ? "已有改动和执行记录已保留，可以继续处理。"
    : task?.status === "failed" && task.mr ? "同一个 MR 的 Pipeline 或机器人评论未通过，已有改动和反馈已保留，可以继续处理。"
    : task?.status === "failed" ? "已有改动和执行记录已保留，排除问题后可继续处理。"
    : task?.status === "merged" ? "代码已合并，可前往 GitLab 工作台查看详情。"
    : task?.status === "closed" ? "MR 已关闭，本次改动和执行记录仍可查看。"
    : task?.status === "pipeline_pending" ? "正在等待当前提交的 Pipeline；只有最新提交验证通过才会结束。"
    : task?.status === "review_pending" ? "正在等待当前提交的 Pipeline Review 报告和机器人评论确认；历史评论不会参与本轮判断。"
    : task?.status === "review_fixing" ? "机器人发现了问题，正在同一个分支和 MR 上修复后重新验证。"
    : task?.mr ? "Pipeline 与 Pipeline Review 均已通过，等待维护人员审阅和合并。"
    : task?.status === "queued" ? "当前任务正在排队，前面的 AI 任务完成后会自动开始。"
    : task?.status === "preparing" ? task.editSessionId ? "正在恢复工作区并启动新一轮处理，已有代码改动会保留。" : "正在读取 Jira 并准备项目工作区。"
    : task?.status === "publishing" ? "正在提交代码改动，并为此 Jira 创建 MR。"
    : "根据 Jira 描述分析项目代码，完成修改后自动创建 MR。";
  const taskError = error || (!submitting && !stopped && task?.error) || task?.syncError;
  const operations = detail?.editSession?.operations ?? [];
  const changedFiles = detail?.editSession?.changedFiles ?? 0;
  const editSessionId = detail?.editSession?.id ?? task?.editSessionId ?? null;
  return <>
    <Button variant={task ? "outline" : "default"} size="sm" type="button" disabled={actionDisabled} onClick={() => {
      if (task?.mr) openMr(); else if (task) setOpen(true); else void act("start");
    }}>{loading || processing || submitting ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : task?.status === "failed" ? <CircleAlert aria-hidden="true" /> : task?.status === "merged" ? <CheckCircle2 aria-hidden="true" /> : task?.mr ? <GitMerge aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{label}</Button>
    {task?.status === "merged" && task.mr && <Button size="sm" variant="ghost" type="button" disabled={submitting} onClick={() => void reprocess()}><RotateCcw aria-hidden="true" />{pendingAction === "reprocess" ? "正在检查…" : "AI重新处理"}</Button>}
    {task?.mr && <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>处理过程</Button>}
    {open && <ReviewDrawerShell eyebrow={`巡检工作台 · ${jiraKey}`} title="AI 处理" titleId="inspection-ai-title" closeLabel="关闭 AI 处理过程" isClosing={false} onRequestClose={() => setOpen(false)} contentClassName="jira-detail-drawer-content inspection-ai-drawer-content">
      <div className="inspection-ai-process">
        <section className="inspection-ai-overview" aria-label="处理任务">
          <h3>{title}</h3>
          <div className="inspection-ai-status" data-status={pendingAction === "retry" || pendingAction === "start" || pendingAction === "reprocess" ? "preparing" : task?.status}>
            <div className="inspection-ai-status-copy">
              <Badge variant="secondary" className="inspection-ai-status-badge" role="status"><StatusIcon className={processing || submitting ? "is-spinning" : undefined} aria-hidden="true" />{pendingAction === "reprocess" ? "正在检查合并代码…" : pendingAction === "retry" ? "正在继续处理…" : pendingAction === "cancel" ? "正在停止…" : task?.phase || (error ? "暂时无法开始" : "读取处理记录")}</Badge>
              <p>{statusNote}</p>
            </div>
            <div className="inspection-ai-actions">
              {processing && <Button variant="outline" size="sm" disabled={submitting} onClick={() => void act("cancel")}><Square aria-hidden="true" />{pendingAction === "cancel" ? "正在停止…" : "停止处理"}</Button>}
              {task?.mr && <Button size="sm" onClick={openMr}><GitMerge aria-hidden="true" />{task.status === "merged" ? "查看已合并 MR" : "MR详情"}</Button>}
              {task && ["failed", "canceled"].includes(task.status) && <Button size="sm" disabled={submitting} onClick={() => void act("retry")}><RotateCcw aria-hidden="true" />{submitting ? "正在继续…" : "继续处理"}</Button>}
              {!task && error && <Button size="sm" disabled={submitting} onClick={() => void act("start")}><RotateCcw aria-hidden="true" />重试 AI 处理</Button>}
            </div>
          </div>
          {taskError && <p className="inspection-ai-error" role="alert"><CircleAlert aria-hidden="true" />{taskError}</p>}
          {task && <dl className="inspection-ai-context">
            <div><dt>项目</dt><dd>{task.projectPath}</dd></div>
            <div><dt>合并目标</dt><dd><code>{task.targetBranch}</code></dd></div>
            <div className="inspection-ai-source-branch"><dt>开发分支</dt><dd><code>{task.sourceBranch}</code></dd></div>
          </dl>}
        </section>
        {task?.preReview && <section className="inspection-ai-section" aria-label="提交前 Review">
          <h4>提交前 Review{task.preReview.attempt > 0 && <span>已检查 {task.preReview.attempt} 轮</span>}</h4>
          <dl className="inspection-ai-verification">
            <div><dt>状态</dt><dd>{task.preReview.status === "passed" ? "已通过" : task.preReview.status === "findings" ? "发现问题" : task.preReview.status === "failed" ? "执行失败" : "检查中"}</dd></div>
            <div><dt>未满足 Jira 要求</dt><dd>{task.preReview.missingRequirementCount}</dd></div>
            <div><dt>待 Pipeline 验证</dt><dd>{task.preReview.unclearRequirementCount}</dd></div>
            <div><dt>阻断代码问题</dt><dd>{task.preReview.blockingFindingCount}</dd></div>
          </dl>
          <ReviewProgressPanel events={task.preReview.progress} live={task.preReview.status === "pending" && processing} />
          {task.preReview.report && <div className="inspection-ai-verification-report"><AssistantMarkdown text={task.preReview.report} /></div>}
        </section>}
        {task?.verification && <section className="inspection-ai-section" aria-label="Pipeline 验收">
          <h4>Pipeline 验收{task.verification.repairAttempts > 0 && <span>已自动修复 {task.verification.repairAttempts} 轮</span>}</h4>
          <dl className="inspection-ai-verification">
            <div><dt>当前提交</dt><dd><code>{task.verification.headSha ?? "等待提交"}</code></dd></div>
            <div><dt>Pipeline</dt><dd>{task.verification.pipelineWebUrl ? <a href={task.verification.pipelineWebUrl} target="_blank" rel="noreferrer">#{task.verification.pipelineId} · {task.verification.pipelineStatus ?? "等待中"}<ExternalLink aria-hidden="true" /></a> : task.verification.pipelineStatus ?? "等待中"}</dd></div>
            <div><dt>Pipeline Review</dt><dd>{task.verification.reviewJobWebUrl ? <a href={task.verification.reviewJobWebUrl} target="_blank" rel="noreferrer">{task.verification.reviewJobName} · {task.verification.reviewStatus === "passed" ? "已通过" : task.verification.reviewJobStatus ?? "等待中"}<ExternalLink aria-hidden="true" /></a> : task.verification.reviewJobName ?? "等待执行"}</dd></div>
          </dl>
          {task.verification.report && <div className="inspection-ai-verification-report"><AssistantMarkdown text={task.verification.report} /></div>}
        </section>}
        {activities.length > 0 && <section className="inspection-ai-section" aria-label="执行过程">
          <h4>执行过程{executions.length > 1 && <span>{executions.length} 轮</span>}</h4>
          <AssistantActivityPanel activities={activities} streaming={execution?.status === "running" && processing} hasError={execution?.status === "failed"} stopped={stopped} defaultOpen showCompleted />
        </section>}
        {(processing || actionStarting) && !execution && <p className="inspection-ai-empty" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" />{actionStarting ? "正在创建 AI 处理任务…" : "正在准备项目和 Jira 上下文…"}</p>}
        {detail && <section className="inspection-ai-section" aria-label="代码改动">
          <h4>代码改动{changedFiles > 0 ? <span>{changedFiles} 个文件</span> : operations.length > 0 ? <span>{operations.length} 处修改</span> : null}</h4>
          {operations.map((operation) => <AssistantEditOperationCard key={operation.id} operation={operation} published={Boolean(task?.mr)} />)}
          {changedFiles > 0 && editSessionId ? <AssistantWorkspaceDiffCard sessionId={editSessionId} changedFiles={changedFiles} live={processing} published={Boolean(task?.mr)} /> : operations.length === 0 ? <p className="inspection-ai-empty"><Code2 aria-hidden="true" />{processing ? "完成代码修改后，改动会显示在这里。" : "本次尚未产生代码改动。"}</p> : null}
        </section>}
        {typeof answer === "string" && <section className="inspection-ai-section" aria-label="处理结果"><h4>处理结果</h4><AssistantMarkdown text={answer} /></section>}
      </div>
    </ReviewDrawerShell>}
  </>;
}
