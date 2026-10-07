import { CheckCircle2, CircleAlert, GitMerge, LoaderCircle, Sparkles, XCircle } from "lucide-react";
import type { OrdinaryJiraAiPrecheckSummary, OrdinaryJiraAiTaskSummary } from "@contracts";

const processingStatuses: ReadonlySet<OrdinaryJiraAiTaskSummary["status"]> = new Set([
  "queued",
  "preparing",
  "running",
  "publishing",
  "pipeline_pending",
  "review_pending",
  "review_fixing",
]);

export function isOrdinaryJiraAiTaskProcessing(status: OrdinaryJiraAiTaskSummary["status"] | null | undefined): boolean {
  return status ? processingStatuses.has(status) : false;
}

function statusMeta(task: OrdinaryJiraAiTaskSummary): { label: string; tone: string; icon: typeof LoaderCircle } {
  if (task.status === "merged") return { label: "已合并", tone: "is-success", icon: CheckCircle2 };
  if (task.status === "mr_open") return { label: "MR待合并", tone: "is-success", icon: GitMerge };
  if (task.status === "closed") return { label: "MR已关闭", tone: "is-muted", icon: XCircle };
  if (task.status === "failed") return { label: task.hasMr ? "验收失败" : "处理失败", tone: "is-failed", icon: CircleAlert };
  if (task.status === "canceled") return { label: "已停止", tone: "is-muted", icon: XCircle };
  if (task.status === "queued") return { label: "排队中", tone: "is-processing", icon: LoaderCircle };
  if (task.status === "preparing") return { label: "准备工作区", tone: "is-processing", icon: LoaderCircle };
  if (task.status === "publishing") return { label: "创建MR中", tone: "is-processing", icon: LoaderCircle };
  if (task.status === "pipeline_pending") return { label: "Pipeline验收中", tone: "is-processing", icon: LoaderCircle };
  if (task.status === "review_pending") return { label: "Review验收中", tone: "is-processing", icon: LoaderCircle };
  if (task.status === "review_fixing") return { label: "修复后复验", tone: "is-processing", icon: LoaderCircle };
  return { label: "AI处理中", tone: "is-processing", icon: Sparkles };
}

export function JiraAiTaskStatusBadge({ task }: { task: OrdinaryJiraAiTaskSummary }) {
  const meta = statusMeta(task);
  const phase = task.phase.trim();
  const label = phase && phase !== meta.label ? `AI处理状态：${meta.label}，${phase}` : `AI处理状态：${meta.label}`;
  return <span className={`jira-ai-task-status ${meta.tone}`} title={phase || meta.label} aria-label={label}><meta.icon className={isOrdinaryJiraAiTaskProcessing(task.status) ? "is-spinning" : undefined} aria-hidden="true" /><span>{meta.label}</span></span>;
}

export function JiraAiPrecheckStatusBadge({ precheck }: { precheck: OrdinaryJiraAiPrecheckSummary }) {
  const isProcessing = precheck.status === "processing";
  const label = isProcessing ? "正在检查 Jira" : precheck.precheckStatus === "needs_input" ? "待补充信息" : precheck.precheckStatus === "failed" ? "检查失败" : "待确认";
  const tone = isProcessing ? "is-processing" : precheck.precheckStatus === "needs_input" || precheck.precheckStatus === "failed" ? "is-failed" : "is-muted";
  const Icon = isProcessing ? LoaderCircle : precheck.precheckStatus === "failed" || precheck.precheckStatus === "needs_input" ? CircleAlert : Sparkles;
  return <span className={`jira-ai-task-status ${tone}`} title={label} aria-label={`AI处理状态：${label}`}><Icon className={isProcessing ? "is-spinning" : undefined} aria-hidden="true" /><span>{label}</span></span>;
}
