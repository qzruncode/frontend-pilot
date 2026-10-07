import { useIntegrationApi } from "./integration-api-context";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { GitLabMergeRequest, GitLabMergeRequestDetails, GitLabMrAiRepairTask, GitLabMrAiRepairTaskDetail, GitLabPipeline, GitLabPipelineJob, GitLabProjectConfig } from "@contracts";
import type { ReviewJob } from "@contracts";
import { CheckCircle2, ChevronRight, ExternalLink, FileCode2, FileSearch, GitBranch, GitMerge, LoaderCircle, MessageSquare, Pencil, Play, RefreshCw, RotateCcw, Sparkles, X, XCircle } from "lucide-react";
import { cancelReview, retryReview } from "./api";
import { errorMessage } from "./review-ui-utils";
import { assistantActivitiesFromRuns, AssistantActivityPanel } from "./assistant-activity";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./components/ui/alert-dialog";
import { GitLabMarkdown, GitLabMarkdownEditor, type GitLabMarkdownEditorMode } from "./gitlab-markdown";
import { ReviewSessionDrawer } from "./review-session-drawer";
import { GitLabEditMergeRequestDrawer } from "./gitlab-edit-merge-request-drawer";
import { GitLabMergeRequestMergeDrawer } from "./gitlab-merge-request-merge-drawer";

export function formatGitLabDate(value: string | null): string {
  if (!value) return "暂无时间";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function gitlabStateLabel(state: string | null): string {
  if (state === "opened") return "开放中";
  if (state === "merged") return "已合并";
  if (state === "closed") return "已关闭";
  return state || "未知状态";
}

export function pipelineStatusLabel(status: string | null): string {
  const labels: Record<string, string> = {
    success: "成功",
    failed: "失败",
    running: "运行中",
    pending: "等待中",
    canceled: "已取消",
    skipped: "已跳过",
    manual: "等待手动执行",
    created: "已创建",
  };
  return status ? labels[status] ?? status : "未知状态";
}

export function pipelineTone(status: string | null): string {
  if (status === "success") return "is-success";
  if (status === "failed") return "is-failed";
  if (status === "running") return "is-running";
  return "is-muted";
}

export function formatGitLabDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "暂无";
  const roundedSeconds = Math.max(0, Math.round(seconds));
  if (roundedSeconds < 60) return `${roundedSeconds} 秒`;
  const minutes = Math.floor(roundedSeconds / 60);
  const remainder = roundedSeconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
}

function pipelineSourceLabel(source: string | null): string {
  const labels: Record<string, string> = {
    merge_request_event: "Merge Request",
    push: "Push",
    web: "手动执行",
    schedule: "定时任务",
    api: "API",
    trigger: "触发器",
  };
  return source ? labels[source] ?? source : "未知来源";
}

function mrKey(item: Pick<GitLabMergeRequest, "projectId" | "iid">): string {
  return `${item.projectId}:${item.iid}`;
}

function reviewJobForMr(item: GitLabMergeRequest, jobs: ReviewJob[]): ReviewJob | null {
  return jobs.find((job) => job.projectId === item.projectId && job.mrIid === item.iid && (!item.headSha || !job.headSha || job.headSha === item.headSha)) ?? null;
}

const MR_AI_ACTIVE_STATUSES = new Set<GitLabMrAiRepairTask["status"]>(["queued", "preparing", "running", "publishing", "pipeline_pending", "review_pending", "review_fixing"]);

function mrAiStatusLabel(status: GitLabMrAiRepairTask["status"]): string {
  const labels: Record<GitLabMrAiRepairTask["status"], string> = {
    queued: "排队中",
    preparing: "准备工作区",
    running: "AI 分析中",
    publishing: "正在推送修复",
    pipeline_pending: "等待 Pipeline",
    review_pending: "等待 Pipeline Review",
    review_fixing: "根据 Review 修复中",
    mr_open: "验证通过，等待合并",
    merged: "MR 已合并",
    closed: "MR 已关闭",
    failed: "处理失败",
    canceled: "已停止",
  };
  return labels[status];
}

export function GitLabMetric({ label, value, note, tone, icon, onClick }: { label: string; value: number | string; note: string; tone: string; icon?: ReactNode; onClick?: () => void }) {
  const content = <><span className="gitlab-metric-label">{icon && <span className="gitlab-metric-icon">{icon}</span>}<span>{label}</span></span><ChevronRight className="gitlab-metric-arrow" aria-hidden="true" /><strong>{value}</strong><small>{note}</small></>;
  if (!onClick) return <div className={`gitlab-metric ${tone}`}>{content}</div>;
  return <button className={`gitlab-metric ${tone}`} type="button" aria-label={`${label}：${value}，${note}`} onClick={onClick}>{content}</button>;
}

export function GitLabMergeRequestList({ items, jobs, selectedKey, onSelect }: { items: GitLabMergeRequest[]; jobs: ReviewJob[]; selectedKey: string | null; onSelect: (item: GitLabMergeRequest) => void }) {
  if (items.length === 0) return <div className="gitlab-empty-state"><GitMerge aria-hidden="true" /><strong>没有匹配的 Merge Request</strong><span>调整筛选条件，或从 GitLab 工作台重新读取。</span></div>;
  return <div className="gitlab-mr-list" aria-label="Merge Request 列表">{items.map((item) => {
    const key = mrKey(item);
    const reviewJob = reviewJobForMr(item, jobs);
    return <article
      key={key}
      className={`gitlab-mr-item ${selectedKey === key ? "is-selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-expanded={selectedKey === key}
      onClick={() => onSelect(item)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(item);
        }
      }}
    >
      <div className="gitlab-mr-item-main">
        <div className="gitlab-mr-item-topline"><span className="gitlab-mr-iid">!{item.iid}</span><strong>{item.title}</strong>{item.draft && <span className="gitlab-soft-badge">Draft</span>}</div>
        <div className="gitlab-mr-item-meta"><span>{item.projectPath || `项目 ${item.projectId}`}</span><span>{item.sourceBranch ?? "未知分支"} → {item.targetBranch ?? "未知分支"}</span><span>更新于 {formatGitLabDate(item.updatedAt)}</span></div>
        <div className="gitlab-mr-item-bottom"><span className={`gitlab-state-badge ${item.state}`}>{gitlabStateLabel(item.state)}</span>{item.labels.slice(0, 3).map((label) => <span className="gitlab-label" key={label}>{label}</span>)}{reviewJob && <span className={`gitlab-review-badge ${reviewJob.status}`}>Review {reviewJob.status === "completed" ? "已完成" : reviewJob.status === "running" ? "审查中" : reviewJob.status === "failed" ? "失败" : "处理中"}</span>}</div>
      </div>
      <div className="gitlab-mr-item-actions"><span className="gitlab-mr-author">{item.author?.name || item.author?.username || "未知作者"}</span><ChevronRight aria-hidden="true" /></div>
    </article>;
  })}</div>;
}

export function GitLabPipelineList({ pipelines, selectedId, onSelect, onRetry, onCancel, busyId, expandedContent }: { pipelines: GitLabPipeline[]; selectedId?: string | null; onSelect?: (pipeline: GitLabPipeline) => void; onRetry?: (pipeline: GitLabPipeline) => void; onCancel?: (pipeline: GitLabPipeline) => void; busyId?: string | null; expandedContent?: (pipeline: GitLabPipeline) => ReactNode }) {
  if (pipelines.length === 0) return <div className="gitlab-inline-empty">暂无 Pipeline</div>;
  return <div className="gitlab-pipeline-list" aria-label="Pipeline 列表">{pipelines.map((pipeline) => {
    const busy = busyId === pipeline.id;
    return <Fragment key={pipeline.id}><article className={`gitlab-pipeline-item ${selectedId === pipeline.id ? "is-selected" : ""}`} role={onSelect ? "button" : undefined} aria-expanded={onSelect ? selectedId === pipeline.id : undefined} tabIndex={onSelect ? 0 : undefined} onClick={() => onSelect?.(pipeline)} onKeyDown={(event) => { if (onSelect && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect(pipeline); } }}>
      <div className={`gitlab-pipeline-status ${pipelineTone(pipeline.status)}`}><span aria-hidden="true" /></div>
      <div className="gitlab-pipeline-copy"><div><strong>Pipeline #{pipeline.id}</strong><span className={`gitlab-status-pill ${pipelineTone(pipeline.status)}`}>{pipelineStatusLabel(pipeline.status)}</span></div><small>{pipeline.ref || "未知 ref"} · {pipeline.sha?.slice(0, 8) || "无 SHA"} · {formatGitLabDate(pipeline.updatedAt ?? pipeline.createdAt)}</small></div>
      <div className="gitlab-pipeline-actions">{pipeline.webUrl && <a href={pipeline.webUrl} target="_blank" rel="noreferrer" aria-label={`在 GitLab 打开 Pipeline ${pipeline.id}`} onClick={(event) => event.stopPropagation()}><ExternalLink aria-hidden="true" /></a>}{onRetry && (pipeline.status === "failed" || pipeline.status === "canceled") && <Button variant="ghost" size="icon" type="button" title="重试 Pipeline" aria-label={`重试 Pipeline ${pipeline.id}`} disabled={busy} onClick={(event) => { event.stopPropagation(); onRetry(pipeline); }}>{busy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}</Button>}{onCancel && (pipeline.status === "running" || pipeline.status === "pending") && <Button variant="ghost" size="icon" type="button" title="取消 Pipeline" aria-label={`取消 Pipeline ${pipeline.id}`} disabled={busy} onClick={(event) => { event.stopPropagation(); onCancel(pipeline); }}><XCircle aria-hidden="true" /></Button>}</div>
    </article>{selectedId === pipeline.id && expandedContent?.(pipeline)}</Fragment>;
  })}</div>;
}

export function GitLabPipelineDetails({ pipeline, jobs, loadingJobs }: { pipeline: GitLabPipeline; jobs: GitLabPipelineJob[]; loadingJobs: boolean }) {
  return <section className="gitlab-pipeline-details" aria-label={`Pipeline #${pipeline.id} 详情`}>
    <div className="gitlab-pipeline-details-header"><div><span>PIPELINE DETAILS</span><strong>Pipeline #{pipeline.id}</strong></div><div className="gitlab-pipeline-detail-actions"><span className={`gitlab-status-pill ${pipelineTone(pipeline.status)}`}>{pipelineStatusLabel(pipeline.status)}</span>{pipeline.webUrl && <a className="gitlab-pipeline-open-link" href={pipeline.webUrl} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" />在 GitLab 打开</a>}</div></div>
    <div className="gitlab-pipeline-details-meta"><div><span>触发来源</span><strong>{pipelineSourceLabel(pipeline.source)}</strong></div><div><span>Ref</span><strong title={pipeline.ref ?? undefined}>{pipeline.ref || "—"}</strong></div><div><span>提交</span><strong title={pipeline.sha ?? undefined}>{pipeline.sha?.slice(0, 8) || "—"}</strong></div><div><span>耗时</span><strong>{formatGitLabDuration(pipeline.duration)}</strong></div><div><span>覆盖率</span><strong>{pipeline.coverage === null ? "—" : `${pipeline.coverage}%`}</strong></div><div><span>更新时间</span><strong>{formatGitLabDate(pipeline.updatedAt ?? pipeline.createdAt)}</strong></div></div>
    <div className="gitlab-pipeline-jobs-heading"><strong>Jobs</strong><span>{loadingJobs ? "读取中…" : `${jobs.length} 个`}</span></div>
    {loadingJobs ? <div className="gitlab-pipeline-details-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取 Job…</div> : jobs.length === 0 ? <div className="gitlab-pipeline-details-state">没有可展示的 Job</div> : <div className="gitlab-pipeline-job-list">{jobs.map((job) => <div className="gitlab-pipeline-job" key={job.id}><span className={`gitlab-job-dot ${pipelineTone(job.status)}`} /><div className="gitlab-pipeline-job-copy"><strong>{job.name}</strong><small>{job.stage} · {pipelineStatusLabel(job.status)}{job.allowFailure ? " · 允许失败" : ""}</small>{job.failureReason && <span>失败原因：{job.failureReason}</span>}</div><span className="gitlab-pipeline-job-duration">{formatGitLabDuration(job.duration)}</span>{job.webUrl && <a href={job.webUrl} target="_blank" rel="noreferrer" aria-label={`在 GitLab 打开 Job ${job.name}`}><ExternalLink aria-hidden="true" /></a>}</div>)}</div>}
  </section>;
}

export function GitLabMergeRequestDrawer({ allowReview = true, detail, loading, reviewJob, onClose, onRefresh, onListRefresh, onReviewChanged, onNotice, onError }: { allowReview?: boolean; detail: GitLabMergeRequestDetails | null; loading: boolean; reviewJob: ReviewJob | null; onClose: () => void; onRefresh: () => Promise<void>; onListRefresh: () => Promise<void>; onReviewChanged: () => void | Promise<void>; onNotice: (message: string) => void; onError: (message: string | null) => void }) {
  const { cancelGitLabPipeline, cancelGitLabMrAiTask, createGitLabNote, getGitLabMrAiTask, getGitLabMrAiTaskDetail, listGitLabPipelineJobs, retryGitLabPipeline, startGitLabMrAiTask, startGitLabReview } = useIntegrationApi();
  const navigate = useNavigate();
  const [noteDraft, setNoteDraft] = useState("");
  const [noteEditorMode, setNoteEditorMode] = useState<GitLabMarkdownEditorMode>("source");
  const [commenting, setCommenting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [pipelineJobs, setPipelineJobs] = useState<Record<string, GitLabPipelineJob[]>>({});
  const [loadingJobs, setLoadingJobs] = useState<string | null>(null);
  const [pipelineActionId, setPipelineActionId] = useState<string | null>(null);
  const [reviewSessionOpen, setReviewSessionOpen] = useState(false);
  const [reviewSessionCanceling, setReviewSessionCanceling] = useState(false);
  const [reviewSessionRetrying, setReviewSessionRetrying] = useState(false);
  const [closing, setClosing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [mrAiTask, setMrAiTask] = useState<GitLabMrAiRepairTask | null>(null);
  const [mrAiDetail, setMrAiDetail] = useState<GitLabMrAiRepairTaskDetail | null>(null);
  const [mrAiLoading, setMrAiLoading] = useState(false);
  const [mrAiAction, setMrAiAction] = useState<"start" | "cancel" | null>(null);
  const [mrAiConfirmOpen, setMrAiConfirmOpen] = useState(false);

  useEffect(() => {
    setClosing(false);
    setNoteDraft("");
    setNoteEditorMode("source");
    setSelectedPipelineId(null);
    setPipelineJobs({});
    setLoadingJobs(null);
    setPipelineActionId(null);
    setReviewSessionOpen(false);
    setReviewSessionCanceling(false);
    setReviewSessionRetrying(false);
    setEditOpen(false);
    setMrAiTask(null);
    setMrAiDetail(null);
    setMrAiLoading(false);
    setMrAiAction(null);
    setMrAiConfirmOpen(false);
  }, [detail?.projectId, detail?.iid]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    if (!allowReview || !detail) {
      setMrAiTask(null);
      setMrAiDetail(null);
      return () => { disposed = true; controller.abort(); };
    }
    setMrAiLoading(true);
    void getGitLabMrAiTask(detail.projectId, detail.iid, controller.signal)
      .then(async (response) => {
        if (disposed || !response.task) {
          if (!disposed) { setMrAiTask(null); setMrAiDetail(null); }
          return;
        }
        try {
          const next = await getGitLabMrAiTaskDetail(response.task.id, controller.signal);
          if (!disposed) { setMrAiTask(next.task); setMrAiDetail(next); }
        } catch {
          if (!disposed && !controller.signal.aborted) setMrAiTask(response.task);
        }
      })
      .catch((error) => {
        if (!disposed && !controller.signal.aborted) onError(errorMessage(error));
      })
      .finally(() => {
        if (!disposed) setMrAiLoading(false);
      });
    return () => { disposed = true; controller.abort(); };
  }, [allowReview, detail?.projectId, detail?.iid, getGitLabMrAiTask, getGitLabMrAiTaskDetail, onError]);

  useEffect(() => {
    if (!allowReview || !detail || !mrAiTask || !MR_AI_ACTIVE_STATUSES.has(mrAiTask.status)) return;
    let disposed = false;
    const controller = new AbortController();
    const poll = () => {
      void getGitLabMrAiTaskDetail(mrAiTask.id, controller.signal)
        .then((response) => {
          if (!disposed) { setMrAiTask(response.task); setMrAiDetail(response); }
        })
        .catch((error) => {
          if (!disposed && !controller.signal.aborted) onError(errorMessage(error));
        });
    };
    const timer = window.setInterval(poll, 5_000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [allowReview, detail?.projectId, detail?.iid, getGitLabMrAiTaskDetail, mrAiTask?.id, mrAiTask?.status, onError]);

  const loadPipelineJobs = async (pipeline: GitLabPipeline) => {
    if (selectedPipelineId === pipeline.id) {
      setSelectedPipelineId(null);
      return;
    }
    setSelectedPipelineId(pipeline.id);
    if (pipelineJobs[pipeline.id]) return;
    setLoadingJobs(pipeline.id);
    try {
      const response = await listGitLabPipelineJobs(detail?.projectId ?? "", pipeline.id);
      setPipelineJobs((current) => ({ ...current, [pipeline.id]: response.jobs }));
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoadingJobs(null);
    }
  };

  const submitNote = async () => {
    if (!detail || !noteDraft.trim()) return;
    setCommenting(true);
    try {
      await createGitLabNote(detail.projectId, detail.iid, noteDraft.trim());
      setNoteDraft("");
      onNotice("评论已发布到 GitLab MR");
      await onRefresh();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setCommenting(false);
    }
  };

  const startReview = async () => {
    if (!detail) return;
    setReviewing(true);
    try {
      const result = await startGitLabReview(detail.projectId, detail.iid);
      onNotice(result.deduplicated ? "这个 MR commit 已有 Review，已复用原任务。" : "Review 已进入队列。");
      await onReviewChanged();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setReviewing(false);
    }
  };

  const startMrAi = () => {
    if (!detail || detail.state !== "opened") return;
    setMrAiConfirmOpen(true);
  };

  const confirmMrAi = async () => {
    if (!detail || detail.state !== "opened") return;
    setMrAiConfirmOpen(false);
    setMrAiAction("start");
    try {
      const result = await startGitLabMrAiTask(detail.projectId, detail.iid);
      setMrAiTask(result.task);
      setMrAiDetail((current) => current?.task.id === result.task.id ? { ...current, task: result.task } : current);
      onNotice("AI 自动修复已进入队列，将持续跟进 Pipeline 和 Pipeline Review");
      await onRefresh();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setMrAiAction(null);
    }
  };

  const cancelMrAi = async () => {
    if (!mrAiTask) return;
    setMrAiAction("cancel");
    try {
      const result = await cancelGitLabMrAiTask(mrAiTask.id);
      setMrAiTask(result.task);
      setMrAiDetail((current) => current?.task.id === result.task.id ? { ...current, task: result.task } : current);
      onNotice("AI 自动修复已停止");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setMrAiAction(null);
    }
  };

  const cancelReviewSession = async () => {
    if (!reviewJob) return;
    setReviewSessionCanceling(true);
    try {
      await cancelReview(reviewJob.id);
      onNotice("Review 已取消。");
      await onReviewChanged();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setReviewSessionCanceling(false);
    }
  };

  const retryReviewSession = async () => {
    if (!reviewJob) return;
    setReviewSessionRetrying(true);
    try {
      await retryReview(reviewJob.id);
      onNotice("Review 已重新排队。");
      await onReviewChanged();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setReviewSessionRetrying(false);
    }
  };

  const reviewInProgress = reviewJob?.status === "queued" || reviewJob?.status === "running";
  const openReviewSessionOrStart = () => {
    if (reviewInProgress) {
      setReviewSessionOpen(true);
      return;
    }
    void startReview();
  };

  const askAssistant = () => {
    if (!detail) return;
    navigate("/", {
      state: {
        assistantLaunch: {
          focusContext: {
            provider: "gitlab",
            resourceType: "merge_request",
            resourceId: `${detail.projectId}:${detail.iid}`,
            projectId: detail.projectId,
            projectPath: detail.projectPath || undefined,
            title: detail.title,
          },
          prompt: "请分析这个 GitLab MR 的变更重点、潜在风险和建议的下一步。",
        },
      },
    });
  };

  const handleEdited = async (updated: GitLabMergeRequest) => {
    setEditOpen(false);
    onNotice(`!${updated.iid} 已更新`);
    await onRefresh();
  };

  const handleMerged = async (updated: GitLabMergeRequest) => {
    onNotice(updated.state === "merged" ? `!${updated.iid} 已合并` : `!${updated.iid} 已设置为流水线成功后自动合并`);
    await Promise.all([onRefresh(), onListRefresh()]);
  };

  const changePipeline = async (pipeline: GitLabPipeline, action: "retry" | "cancel") => {
    if (!detail) return;
    setPipelineActionId(pipeline.id);
    try {
      const updated = action === "retry" ? await retryGitLabPipeline(detail.projectId, pipeline.id) : await cancelGitLabPipeline(detail.projectId, pipeline.id);
      onNotice(action === "retry" ? `Pipeline #${updated.id} 已重新执行` : `Pipeline #${updated.id} 已取消`);
      await onRefresh();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setPipelineActionId(null);
    }
  };

  const mrAiActive = Boolean(mrAiTask && MR_AI_ACTIVE_STATUSES.has(mrAiTask.status));
  const mrAiHasNewHead = Boolean(mrAiTask?.commitSha && detail?.headSha && mrAiTask.commitSha !== detail.headSha);
  const mrAiCanStart = Boolean(detail?.state === "opened" && !mrAiActive && (!mrAiTask || mrAiHasNewHead || mrAiTask.status === "failed" || mrAiTask.status === "canceled"));
  const mrAiButtonLabel = mrAiActive ? "AI处理中…" : mrAiTask?.status === "failed" || mrAiTask?.status === "canceled" ? "重新 AI处理" : mrAiTask?.status === "mr_open" && !mrAiHasNewHead ? "AI已通过" : "AI处理";
  const mrAiExecution = mrAiDetail?.execution && mrAiDetail.execution.id === mrAiTask?.assistantRunId ? mrAiDetail.execution : null;
  const mrAiExecutions = useMemo(() => {
    const history = mrAiDetail?.executions ?? [];
    if (!mrAiExecution) return history;
    return history.some((run) => run.id === mrAiExecution.id)
      ? history.map((run) => run.id === mrAiExecution.id ? mrAiExecution : run)
      : [...history, mrAiExecution];
  }, [mrAiDetail?.executions, mrAiExecution]);
  const mrAiActivities = useMemo(() => assistantActivitiesFromRuns(mrAiExecutions), [mrAiExecutions]);

  const closeDrawer = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 210);
  };

  useEffect(() => {
    if (!detail && !loading) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closing && !reviewSessionOpen && !editOpen) {
        setClosing(true);
        window.setTimeout(onClose, 210);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closing, detail, editOpen, loading, onClose, reviewSessionOpen]);

  if (!detail && !loading) return null;

  return createPortal(<>
    <button className={`gitlab-mr-drawer-backdrop ${closing ? "is-closing" : ""}`} type="button" aria-label="关闭 Merge Request 详情" onClick={closeDrawer} />
    <aside className={`gitlab-mr-drawer ${closing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-busy={loading} aria-label="Merge Request 详情">
    <header className="gitlab-mr-drawer-header"><div className="gitlab-mr-drawer-title-copy"><span>GitLab MR详情</span><strong>{detail ? `!${detail.iid}` : "正在读取…"}</strong></div><div className="gitlab-mr-drawer-header-actions">{detail && <Button variant="ghost" size="icon" type="button" aria-label="刷新 MR 详情" title="刷新 MR 详情" onClick={() => void onRefresh()} disabled={loading}><RefreshCw aria-hidden="true" className={loading ? "is-spinning" : ""} /></Button>}<Button variant="ghost" size="icon" type="button" aria-label="关闭详情" title="关闭详情（Esc）" onClick={closeDrawer}><X aria-hidden="true" /></Button></div></header>
    {loading || !detail ? <div className="gitlab-drawer-loading"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>正在读取 GitLab MR 详情</span></div> : <div className="gitlab-mr-drawer-scroll">
      <div className="gitlab-mr-drawer-summary">
        <div className="gitlab-mr-drawer-intro"><div className="gitlab-mr-drawer-intro-copy"><p>{detail.title}</p></div><div className="gitlab-mr-drawer-intro-actions">{allowReview && <Button variant="ghost" size="sm" type="button" onClick={askAssistant}><Sparkles aria-hidden="true" />问答助手</Button>}{detail.webUrl && <a href={detail.webUrl} target="_blank" rel="noreferrer" aria-label="在 GitLab 中打开此 MR" title="在源 GitLab 中打开此 MR">在 GitLab 中打开<ExternalLink aria-hidden="true" /></a>}</div></div>
        <div className="gitlab-mr-drawer-meta"><span className={`gitlab-state-badge ${detail.state}`}>{gitlabStateLabel(detail.state)}</span><span>{detail.projectPath || `项目 ${detail.projectId}`}</span><span>{detail.sourceBranch} → {detail.targetBranch}</span><span>作者：{detail.author?.name || detail.author?.username || "未知"}</span><span>更新于 {formatGitLabDate(detail.updatedAt)}</span></div>
        <div className="gitlab-mr-summary-stats"><div><strong>{detail.changes.length}</strong><span>变更文件</span></div><div><strong>{detail.notes.filter((note) => !note.system).length}</strong><span>普通评论</span></div><div><strong>{detail.pipelines.length}</strong><span>Pipeline</span></div></div>
        <div className="gitlab-mr-drawer-actions"><Button size="sm" type="button" onClick={() => setEditOpen(true)}><Pencil aria-hidden="true" />编辑 MR</Button>{allowReview && <Button size="sm" type="button" onClick={openReviewSessionOrStart} disabled={reviewing} title={reviewInProgress ? "查看审查会话详情" : undefined}>{reviewing ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : reviewInProgress ? <FileSearch aria-hidden="true" /> : reviewJob?.status === "completed" ? <CheckCircle2 aria-hidden="true" /> : <Play aria-hidden="true" />}{reviewing ? "提交中…" : reviewInProgress ? "查看审查会话" : reviewJob?.status === "completed" ? "再次 Review" : "发起 Review"}</Button>}{allowReview && detail.state === "opened" && <Button variant="outline" size="sm" type="button" onClick={() => void startMrAi()} disabled={mrAiLoading || !mrAiCanStart || mrAiAction !== null} title="自动修复当前 MR，直到 Pipeline 和 Pipeline Review 通过"><Sparkles aria-hidden="true" />{mrAiAction === "start" ? "提交中…" : mrAiButtonLabel}</Button>}{allowReview && reviewJob && !reviewInProgress && <Button variant="outline" size="sm" type="button" onClick={() => setReviewSessionOpen(true)}><FileSearch aria-hidden="true" />查看审查会话</Button>}</div>
        {mrAiTask && <section className={`gitlab-mr-ai-task ${mrAiTask.status === "failed" ? "is-failed" : mrAiTask.status === "mr_open" || mrAiTask.status === "merged" ? "is-success" : ""}`} aria-live="polite"><div className="gitlab-mr-ai-task-header"><div><Sparkles aria-hidden="true" /><strong>AI 自动修复</strong></div><span>{mrAiStatusLabel(mrAiTask.status)}</span></div><p>{mrAiTask.phase}</p><div className="gitlab-mr-ai-task-meta"><span>当前提交：{mrAiTask.commitSha?.slice(0, 12) || "未知"}</span><span>修复轮次：{mrAiTask.verification?.repairAttempts ?? 0}</span>{mrAiTask.verification?.pipelineWebUrl && <a href={mrAiTask.verification.pipelineWebUrl} target="_blank" rel="noreferrer">Pipeline<ExternalLink aria-hidden="true" /></a>}{mrAiTask.verification?.reviewJobWebUrl && <a href={mrAiTask.verification.reviewJobWebUrl} target="_blank" rel="noreferrer">Review Job<ExternalLink aria-hidden="true" /></a>}</div>{mrAiTask.error && <div className="gitlab-mr-ai-task-error">{mrAiTask.error}</div>}{mrAiTask.verification?.feedback && <details className="gitlab-mr-ai-task-feedback"><summary>查看本轮反馈</summary><pre>{mrAiTask.verification.feedback}</pre></details>}{mrAiActivities.length > 0 && <div className="gitlab-mr-ai-task-activity"><strong>执行过程</strong><AssistantActivityPanel activities={mrAiActivities} streaming={mrAiExecution?.status === "running" && mrAiActive} hasError={mrAiExecution?.status === "failed" || mrAiTask.status === "failed"} stopped={mrAiTask.status === "canceled"} defaultOpen showCompleted /></div>}{mrAiActive && <Button variant="ghost" size="sm" type="button" onClick={() => void cancelMrAi()} disabled={mrAiAction !== null}><XCircle aria-hidden="true" />{mrAiAction === "cancel" ? "停止中…" : "停止 AI 自动修复"}</Button>}</section>}
        {detail.state === "opened" && <GitLabMergeRequestMergeDrawer detail={detail} onMerged={handleMerged} onError={onError} />}
      </div>
      <section className="gitlab-drawer-section"><div className="gitlab-section-heading"><div><GitMerge aria-hidden="true" /><strong>Pipeline</strong></div><span>{detail.pipelines.length} 条</span></div><GitLabPipelineList pipelines={detail.pipelines} selectedId={selectedPipelineId} onSelect={(pipeline) => void loadPipelineJobs(pipeline)} onRetry={(pipeline) => void changePipeline(pipeline, "retry")} onCancel={(pipeline) => void changePipeline(pipeline, "cancel")} busyId={pipelineActionId} />{selectedPipelineId && <div className="gitlab-pipeline-jobs">{loadingJobs === selectedPipelineId ? <span>正在读取 Job…</span> : (pipelineJobs[selectedPipelineId] ?? []).map((job) => <div key={job.id}><span className={`gitlab-job-dot ${pipelineTone(job.status)}`} /><strong>{job.name}</strong><small>{job.stage} · {pipelineStatusLabel(job.status)}</small>{job.webUrl && <a href={job.webUrl} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" /></a>}</div>)}</div>}</section>
      <section className="gitlab-drawer-section"><div className="gitlab-section-heading"><div><FileCode2 aria-hidden="true" /><strong>变更文件</strong></div><span>{detail.changes.length} 个</span></div><div className="gitlab-change-list">{detail.changes.length === 0 ? <div className="gitlab-inline-empty">没有可展示的文本变更</div> : detail.changes.slice(0, 12).map((change) => <details className="gitlab-change-item" key={`${change.oldPath}:${change.newPath}`}><summary><span className={`gitlab-change-type ${change.changeType}`}>{change.changeType}</span><strong>{change.newPath || change.oldPath || "未知文件"}</strong></summary><pre>{change.diff || "没有 diff 内容"}</pre></details>)}</div></section>
      <section className="gitlab-drawer-section"><div className="gitlab-section-heading"><div><MessageSquare aria-hidden="true" /><strong>评论</strong></div><span>{detail.notes.filter((note) => !note.system).length} 条</span></div><div className="gitlab-note-list">{detail.notes.filter((note) => !note.system).slice(-20).map((note) => <article key={note.id}><div className="gitlab-note-header"><strong>{note.author?.name || note.author?.username || "GitLab 用户"}</strong><time>{formatGitLabDate(note.createdAt)}</time></div><GitLabMarkdown source={note.body} /></article>)}{detail.notes.every((note) => note.system) && <div className="gitlab-inline-empty">还没有普通评论</div>}</div><div className="gitlab-note-editor"><span className="gitlab-note-editor-label">添加一条评论</span><GitLabMarkdownEditor value={noteDraft} mode={noteEditorMode} onChange={setNoteDraft} onModeChange={setNoteEditorMode} placeholder="写一条评论到 GitLab MR…" /><Button type="button" size="sm" onClick={() => void submitNote()} disabled={commenting || !noteDraft.trim()}>{commenting ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}发布评论</Button></div></section>
    </div>}
    </aside>
    {detail && <GitLabEditMergeRequestDrawer open={editOpen} detail={detail} onClose={() => setEditOpen(false)} onSaved={handleEdited} onError={onError} />}
    <ReviewSessionDrawer
      job={reviewSessionOpen ? reviewJob : null}
      canceling={reviewSessionCanceling}
      retrying={reviewSessionRetrying}
      onCancel={() => void cancelReviewSession()}
      onRetry={() => void retryReviewSession()}
      onClose={() => setReviewSessionOpen(false)}
    />
    <AlertDialog open={mrAiConfirmOpen} onOpenChange={(open) => { if (!open && mrAiAction !== "start") setMrAiConfirmOpen(false); }}>
      <AlertDialogContent className="gitlab-mr-ai-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>启动 AI 自动修复？</AlertDialogTitle>
          <AlertDialogDescription>AI 会持续检查当前 MR 的 Pipeline 和 Pipeline Review；只要它们仍在运行，就不会因等待时间结束。发现问题后，AI 会在源分支上修改并推送，直到当前提交通过、验证明确失败或你主动停止。</AlertDialogDescription>
        </AlertDialogHeader>
        {detail && <div className="gitlab-mr-ai-confirm-details"><div><span>MR</span><strong>!{detail.iid}</strong></div><div><span>源分支</span><strong>{detail.sourceBranch ?? "未知"}</strong></div><div><span>目标分支</span><strong>{detail.targetBranch ?? "未知"}</strong></div><div><span>当前提交</span><strong>{detail.headSha?.slice(0, 12) ?? "未知"}</strong></div><p>不会自动合并 MR，也不会修改目标分支。</p></div>}
        <AlertDialogFooter>
          <AlertDialogCancel asChild><Button variant="ghost" type="button" disabled={mrAiAction === "start"}>取消</Button></AlertDialogCancel>
          <Button type="button" onClick={() => void confirmMrAi()} disabled={mrAiAction === "start"}>{mrAiAction === "start" ? "提交中…" : "确认启动"}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>, document.body);
}

type GitLabProjectListProps = {
  projects: GitLabProjectConfig[];
  onOpenRules?: (project: GitLabProjectConfig) => void;
  onCreateProfile?: (project: GitLabProjectConfig) => void;
  creatingProfile?: string | null;
  selectedProjectId?: string | null;
  onSelect?: (project: GitLabProjectConfig) => void;
  selectionActionLabel?: { idle: string; selected: string };
};

export function GitLabProjectList({ projects, onOpenRules, onCreateProfile, creatingProfile, selectedProjectId, onSelect, selectionActionLabel = { idle: "配置巡检", selected: "正在配置" } }: GitLabProjectListProps) {
  if (projects.length === 0) return <div className="gitlab-empty-state"><GitBranch aria-hidden="true" /><strong>没有找到项目</strong><span>可以调整项目搜索条件。</span></div>;
  const hasSelectionAction = Boolean(onSelect);
  return <div className="gitlab-project-list">{projects.map((project) => <article className={`gitlab-project-item ${selectedProjectId === project.id ? "is-selected" : ""}`} key={project.id}>
    <a className="gitlab-project-link" href={project.webUrl ?? undefined} target={project.webUrl ? "_blank" : undefined} rel={project.webUrl ? "noreferrer" : undefined}>
      <div className="gitlab-project-icon"><GitBranch aria-hidden="true" /></div>
      <div className="gitlab-project-copy"><strong>{project.name}</strong><span>{project.pathWithNamespace}</span><small>默认分支：{project.defaultBranch || "未设置"} · {hasSelectionAction ? "独立巡检提示词" : `${project.reviewRuleCount} 条 Review 规则`}</small></div>
    </a>
    <div className="gitlab-project-actions">
      {!hasSelectionAction && <><span className={`gitlab-profile-state ${project.customReviewProfile ? "is-custom" : ""}`}>{project.customReviewProfile ? project.reviewProfileDisplayName : `正在使用 ${project.reviewProfileDisplayName}`}</span>{project.customReviewProfile ? <Button variant="outline" size="sm" type="button" onClick={() => onOpenRules?.(project)}>配置规则</Button> : <Button className="gitlab-project-create-profile-button" variant="outline" size="sm" type="button" disabled={creatingProfile === project.pathWithNamespace} onClick={() => onCreateProfile?.(project)}>{creatingProfile === project.pathWithNamespace ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}创建专属 profile</Button>}</>}
      {onSelect && <Button className={`gitlab-project-inspection-button ${selectedProjectId === project.id ? "is-active" : ""}`} variant="outline" size="sm" type="button" aria-pressed={selectedProjectId === project.id} onClick={() => onSelect(project)}>{selectedProjectId === project.id ? selectionActionLabel.selected : selectionActionLabel.idle}</Button>}
    </div>
  </article>)}</div>;
}
