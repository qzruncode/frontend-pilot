import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Download, ExternalLink, LoaderCircle, MessageCircle, Paperclip, RefreshCw, Send, Sparkles, Tag } from "lucide-react";
import { JIRA_BOARD_STATUS_IDS, type JiraAttachment, type JiraComment, type JiraIssue, type JiraIssueDetails, type JiraIssueTransition, type OrdinaryJiraAiPrecheckSummary, type OrdinaryJiraAiTaskSummary } from "@contracts";
import { useIntegrationApi } from "./integration-api-context";
import { JiraImagePreviewModal } from "./jira-image-preview-modal";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { errorMessage } from "./review-ui-utils";
import { JiraAiPrecheckStatusBadge, JiraAiTaskStatusBadge } from "./jira-ai-task-status";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { LucideIcon } from "lucide-react";

function displayDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { hour12: false });
}

function identityLabel(value: { name: string; username: string } | null): string {
  return value?.name || value?.username || "未分配";
}

function initials(value: string): string {
  return Array.from(value.replace(/\s+/g, "").slice(0, 2)).join("").toUpperCase() || "?";
}

export function JiraMetric({ label, value, note, tone, icon: Icon, onClick }: {
  label: string;
  value: number | string;
  note: string;
  tone: string;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <button className={`jira-metric-card ${tone}`} type="button" onClick={onClick}>
      <span className="jira-metric-icon"><Icon aria-hidden="true" /></span>
      <span className="jira-metric-label">{label}</span>
      <strong>{typeof value === "number" ? value.toLocaleString("zh-CN") : value}</strong>
      <small>{note}</small>
    </button>
  );
}

function JiraIssueRow({ issue, selected, onSelect, aiTasks, aiPrechecks }: { issue: JiraIssue; selected: boolean; onSelect: () => void; aiTasks?: Readonly<Record<string, OrdinaryJiraAiTaskSummary>>; aiPrechecks?: Readonly<Record<string, OrdinaryJiraAiPrecheckSummary>> }) {
  const statusClass = issue.statusCategory.replace(/[^a-z0-9_-]/gi, "-");
  const aiTask = aiTasks?.[issue.key.trim().toLowerCase()];
  const aiPrecheck = aiPrechecks?.[issue.key.trim().toLowerCase()];
  return (
    <button className={`jira-issue-row ${selected ? "is-selected" : ""}`} type="button" role="option" aria-selected={selected} onClick={onSelect}>
      <span className={`jira-issue-status-bar status-${statusClass}`} aria-hidden="true" />
      <span className="jira-issue-row-main">
        <span className="jira-issue-row-topline"><span className="jira-issue-key">{issue.key}</span>{aiTask ? <JiraAiTaskStatusBadge task={aiTask} /> : aiPrecheck && <JiraAiPrecheckStatusBadge precheck={aiPrecheck} />}</span>
        <strong>{issue.summary}</strong>
        <span className="jira-issue-row-meta"><em>{issue.status}</em><em>{issue.issueType}</em>{issue.priority && <em>{issue.priority}</em>}{issue.labels.slice(0, 2).map((label) => <em key={label}>{label}</em>)}</span>
      </span>
      <span className="jira-issue-row-side"><small className="jira-issue-updated">{displayDate(issue.updatedAt)}</small><span className="jira-issue-assignee"><span className="jira-issue-avatar" aria-hidden="true">{initials(identityLabel(issue.assignee))}</span><span>{identityLabel(issue.assignee)}</span></span></span>
    </button>
  );
}

export function JiraIssueList({ items, selectedKey, onSelect, loading = false, aiTasks, aiPrechecks }: { items: JiraIssue[]; selectedKey: string | null; onSelect: (issue: JiraIssue) => void; loading?: boolean; aiTasks?: Readonly<Record<string, OrdinaryJiraAiTaskSummary>>; aiPrechecks?: Readonly<Record<string, OrdinaryJiraAiPrecheckSummary>> }) {
  if (items.length === 0) {
    return loading ? <div className="jira-empty-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" /><strong>正在读取 Jira 问题</strong><span>正在同步当前筛选条件下的问题。</span></div> : <div className="jira-empty-state"><MessageCircle aria-hidden="true" /><strong>没有找到符合条件的问题</strong><span>可以切换范围、状态或缩短关键词后重试。</span></div>;
  }
  return <div className="jira-issue-list" role="listbox" aria-label="Jira 问题列表" aria-busy={loading}>{items.map((issue) => <JiraIssueRow key={issue.id} issue={issue} selected={selectedKey === issue.key} onSelect={() => onSelect(issue)} aiTasks={aiTasks} aiPrechecks={aiPrechecks} />)}</div>;
}

function CommentItem({ comment }: { comment: JiraComment }) {
  const author = identityLabel(comment.author);
  return <article className="jira-comment-item"><span className="jira-comment-avatar" aria-hidden="true">{initials(author)}</span><div><header><strong>{author}</strong><time>{displayDate(comment.createdAt)}</time></header><p>{comment.body || "（空评论）"}</p></div></article>;
}

function IssueMetadata({ detail }: { detail: JiraIssueDetails }) {
  return <dl className="jira-detail-meta"><div><dt>经办人</dt><dd>{identityLabel(detail.assignee)}</dd></div><div><dt>报告人</dt><dd>{identityLabel(detail.reporter)}</dd></div><div><dt>创建时间</dt><dd>{displayDate(detail.createdAt)}</dd></div><div><dt>更新时间</dt><dd>{displayDate(detail.updatedAt)}</dd></div></dl>;
}

function IssueComments({ comments }: { comments: JiraComment[] }) {
  return <section className="jira-detail-section"><div className="jira-comments-heading"><h4>活动与评论</h4><span>{comments.length} 条评论</span></div>{comments.length ? <div className="jira-comments-list">{comments.map((comment) => <CommentItem key={comment.id} comment={comment} />)}</div> : <p className="jira-detail-muted">还没有评论，添加第一条补充信息。</p>}</section>;
}

function fileSizeLabel(value: number | null): string {
  if (value === null) return "大小未知";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function attachmentPreviewKind(attachment: JiraAttachment): "image" | "video" | "audio" | "pdf" | "other" {
  const mimeType = attachment.mimeType?.toLowerCase() || "";
  const filename = attachment.filename.toLowerCase();
  if (mimeType.startsWith("image/") || /\.(avif|gif|jpeg|jpg|png|svg|webp)$/.test(filename)) return "image";
  if (mimeType.startsWith("video/") || /\.(mov|mp4|m4v|webm|ogg)$/.test(filename)) return "video";
  if (mimeType.startsWith("audio/") || /\.(aac|flac|m4a|mp3|wav)$/.test(filename)) return "audio";
  if (mimeType === "application/pdf" || filename.endsWith(".pdf")) return "pdf";
  return "other";
}

function AttachmentDownloadLink({ issueKey, attachment }: { issueKey: string; attachment: JiraAttachment }) {
  const { getJiraAttachmentPreviewUrl } = useIntegrationApi();
  const previewUrl = getJiraAttachmentPreviewUrl(issueKey, attachment.id);
  return <a className="jira-attachment-download" href={previewUrl} download={attachment.filename}><Download aria-hidden="true" />下载附件</a>;
}

function JiraImageFullscreenTrigger({ previewUrl, filename, onImageError }: { previewUrl: string; filename: string; onImageError: () => void }) {
  const [previewOpen, setPreviewOpen] = useState(false);

  return <><div className="jira-image-preview-stage"><img src={previewUrl} alt={`附件预览 ${filename}`} loading="lazy" onError={onImageError} /><Button variant="ghost" className="jira-image-preview-fullscreen-control" type="button" aria-label={`放大查看附件 ${filename}`} title="放大查看" onClick={() => setPreviewOpen(true)} /></div>{previewOpen && <JiraImagePreviewModal filename={filename} previewUrl={previewUrl} downloadUrl={previewUrl} onClose={() => setPreviewOpen(false)} />}</>;
}

function JiraAttachmentPreview({ issueKey, attachment }: { issueKey: string; attachment: JiraAttachment }) {
  const { getJiraAttachmentPreviewUrl } = useIntegrationApi();
  const [failed, setFailed] = useState(false);
  const kind = attachmentPreviewKind(attachment);
  if (!attachment.url) return <div className="jira-attachment-unsupported"><span>Jira 未提供可预览地址</span></div>;
  if (kind === "other") return <div className="jira-attachment-unsupported"><span>此文件类型暂不支持在线预览</span><AttachmentDownloadLink issueKey={issueKey} attachment={attachment} /></div>;
  if (failed) return <div className="jira-attachment-unsupported"><span>预览加载失败</span><AttachmentDownloadLink issueKey={issueKey} attachment={attachment} /></div>;

  const previewUrl = getJiraAttachmentPreviewUrl(issueKey, attachment.id);
  if (kind === "image") return <div className="jira-attachment-preview"><JiraImageFullscreenTrigger previewUrl={previewUrl} filename={attachment.filename} onImageError={() => setFailed(true)} /><AttachmentDownloadLink issueKey={issueKey} attachment={attachment} /></div>;
  if (kind === "video") return <div className="jira-attachment-preview"><video controls preload="metadata" src={previewUrl} onError={() => setFailed(true)} /><AttachmentDownloadLink issueKey={issueKey} attachment={attachment} /></div>;
  if (kind === "audio") return <div className="jira-attachment-preview jira-attachment-audio"><audio controls preload="metadata" src={previewUrl} onError={() => setFailed(true)} /><AttachmentDownloadLink issueKey={issueKey} attachment={attachment} /></div>;
  return <div className="jira-attachment-preview jira-attachment-pdf"><iframe src={previewUrl} title={`预览附件 ${attachment.filename}`} /></div>;
}

function IssueAttachments({ issueKey, attachments }: { issueKey: string; attachments: JiraAttachment[] }) {
  if (attachments.length === 0) return null;
  return <section className="jira-detail-section jira-attachments-section"><div className="jira-comments-heading"><h4>附件</h4><span>{attachments.length} 个文件</span></div><div className="jira-attachments-list">{attachments.map((attachment) => <article className="jira-attachment-item" key={attachment.id}><div className="jira-attachment-head"><span className="jira-attachment-icon"><Paperclip aria-hidden="true" /></span><span className="jira-attachment-copy"><strong title={attachment.filename}>{attachment.filename}</strong><small>{[attachment.mimeType, fileSizeLabel(attachment.size), attachment.createdAt ? displayDate(attachment.createdAt) : null].filter(Boolean).join(" · ")}</small></span></div><JiraAttachmentPreview issueKey={issueKey} attachment={attachment} /></article>)}</div></section>;
}

function jiraTransitionActionLabel(transition: JiraIssueTransition): string {
  const action = transition.name.trim();
  const target = transition.toStatus.trim();
  return action || target || "切换状态";
}

function primaryJiraTransition(transitions: JiraIssueTransition[]): JiraIssueTransition | null {
  return transitions.find((transition) => !transition.toStatusId || !JIRA_BOARD_STATUS_IDS.done.includes(transition.toStatusId)) ?? transitions[0] ?? null;
}

function IssueStatusEditor({ issueKey, status, transitions, transitionsLoading, transitionsError, onStatusChange, onRetry, onError }: { issueKey: string; status: string; transitions: JiraIssueTransition[]; transitionsLoading: boolean; transitionsError: string | null; onStatusChange: (transitionId: string) => Promise<void>; onRetry: () => Promise<void>; onError: (message: string) => void }) {
  const [savingTransitionId, setSavingTransitionId] = useState<string | null>(null);
  const nextTransition = primaryJiraTransition(transitions);
  const submit = async (transitionId: string) => {
    if (!transitionId || savingTransitionId) return;
    setSavingTransitionId(transitionId);
    try {
      await onStatusChange(transitionId);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSavingTransitionId(null);
    }
  };
  return <div className="jira-status-editor"><span className="jira-status-editor-label">状态</span><span className="jira-status-pill">{status}</span>{transitionsLoading ? <span className="jira-status-editor-loading"><LoaderCircle className="is-spinning" aria-hidden="true" />读取操作…</span> : transitionsError ? <><span className="jira-status-editor-error" role="alert" title={transitionsError}>状态操作读取失败</span><Button variant="ghost" className="jira-status-retry" size="sm" type="button" onClick={() => void onRetry()}>重试</Button></> : nextTransition ? <Button variant="outline" className="jira-status-action" size="sm" type="button" disabled={savingTransitionId !== null} title={nextTransition.toStatus ? `推进到${nextTransition.toStatus}` : undefined} onClick={() => void submit(nextTransition.id)}>{savingTransitionId === nextTransition.id ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}{jiraTransitionActionLabel(nextTransition)}</Button> : <span className="jira-status-editor-empty">当前没有可用状态操作</span>}</div>;
}

function CommentComposer({ issueKey, onRefresh, onNotice, onError }: { issueKey: string; onRefresh: () => Promise<void>; onNotice: (message: string) => void; onError: (message: string) => void }) {
  const { addJiraIssueComment } = useIntegrationApi();
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => setComment(""), [issueKey]);
  const submit = async () => {
    const body = comment.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await addJiraIssueComment(issueKey, body);
      setComment("");
      onNotice(`${issueKey} 评论已发布`);
      await onRefresh();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSending(false);
    }
  };
  return <section className="jira-comment-composer"><h4>添加评论</h4><Textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="写下对这个问题的补充…" maxLength={50_000} /><div><small>{comment.length.toLocaleString("zh-CN")}/50,000</small><Button type="button" onClick={() => void submit()} disabled={!comment.trim() || sending}>{sending ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Send aria-hidden="true" />}发布评论</Button></div></section>;
}

export function JiraIssueDetailPanel({ actions, issue, detail, transitions, transitionsLoading, transitionsError, loading, onClose, onRefresh, onStatusChange, onNotice, onError }: { actions?: ReactNode; issue: JiraIssue | null; detail: JiraIssueDetails | null; transitions: JiraIssueTransition[]; transitionsLoading: boolean; transitionsError: string | null; loading: boolean; onClose: () => void | Promise<void>; onRefresh: () => Promise<void>; onStatusChange: (transitionId: string) => Promise<void>; onNotice: (message: string) => void; onError: (message: string) => void }) {
  const navigate = useNavigate();
  if (!issue) return null;
  const askAssistant = () => {
    navigate("/", {
      state: {
        assistantLaunch: {
          focusContext: { provider: "jira", resourceType: "issue", resourceId: issue.key, title: issue.summary },
          prompt: `请结合 Jira 问题 ${issue.key} 的上下文，帮我梳理当前状态、风险和下一步。`,
        },
      },
    });
  };
  return (
    <ReviewDrawerShell
      eyebrow="Jira 问题详情"
      title={issue.key}
      titleId={`jira-issue-detail-title-${issue.key}`}
      closeLabel="关闭问题详情"
      isClosing={false}
      onRequestClose={() => { void onClose(); }}
      contentClassName="jira-detail-drawer-content"
    >
      <div className="jira-detail-drawer-inner">
        <div className="jira-detail-drawer-intro">
          <h3>{issue.summary}</h3>
          <div className="jira-detail-drawer-intro-actions">{actions ?? <Button variant="ghost" size="sm" type="button" onClick={askAssistant}><Sparkles aria-hidden="true" />问答助手</Button>}<a href={issue.webUrl} target="_blank" rel="noreferrer" aria-label={`在 Jira 中打开 ${issue.key}`} title="在 Jira 中打开">在 Jira 中打开<ExternalLink aria-hidden="true" /></a></div>
        </div>
        {loading && !detail && <div className="jira-detail-loading" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取问题详情…</div>}
        {!loading && !detail && <div className="jira-detail-loading"><MessageCircle aria-hidden="true" /><strong>详情暂不可用</strong><span>可以点击刷新重新读取。</span><Button variant="outline" size="sm" type="button" onClick={() => void onRefresh()}><RefreshCw aria-hidden="true" />重新读取</Button></div>}
        {detail && <div className="jira-detail-scroll jira-detail-drawer-scroll"><div className="jira-detail-status-row"><IssueStatusEditor issueKey={issue.key} status={detail.status} transitions={transitions} transitionsLoading={transitionsLoading} transitionsError={transitionsError} onStatusChange={onStatusChange} onRetry={onRefresh} onError={onError} /><span>{detail.issueType}</span><span>{detail.priority || "未设置优先级"}</span><Button variant="ghost" size="sm" type="button" onClick={() => void onRefresh()} disabled={loading}><RefreshCw aria-hidden="true" className={loading ? "is-spinning" : ""} />刷新</Button></div><IssueMetadata detail={detail} />{detail.labels.length > 0 && <div className="jira-detail-labels"><Tag aria-hidden="true" />{detail.labels.map((label) => <span key={label}>{label}</span>)}</div>}{detail.attachments.length > 0 && <IssueAttachments issueKey={issue.key} attachments={detail.attachments} />}<section className="jira-detail-section"><h4>描述</h4><p className="jira-detail-description">{detail.description || "暂无描述"}</p></section><IssueComments comments={detail.comments} /><CommentComposer issueKey={issue.key} onRefresh={onRefresh} onNotice={onNotice} onError={onError} /></div>}
      </div>
    </ReviewDrawerShell>
  );
}
