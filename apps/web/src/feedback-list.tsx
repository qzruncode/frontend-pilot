import { useCallback, useEffect, useState } from "react";
import { Eye, Inbox, LoaderCircle, RefreshCw, Star, Trash2 } from "lucide-react";
import type { FeedbackAttachment, FeedbackCategory, FeedbackDetail, FeedbackListItem } from "@contracts";
import { Button } from "@/components/ui/button";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { getFeedbackAttachmentUrl } from "./api";

type FeedbackListProps = {
  items: FeedbackListItem[];
  total: number;
  loading: boolean;
  error: string | null;
  detailId: string | null;
  detail: FeedbackDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  deletingId: string | null;
  onRefresh: () => void;
  onViewDetail: (id: string) => void;
  onCloseDetail: () => void;
  onDeleteFeedback: (id: string) => void;
};

const categoryLabels: Record<FeedbackCategory, string> = {
  experience: "使用体验",
  bug: "遇到问题",
  feature: "功能建议",
  other: "其他想法",
};

function formatFeedbackDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatAttachmentSize(size: number): string {
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

function FeedbackRating({ rating }: { rating: number }) {
  return (
    <span className="feedback-list-rating" aria-label={`${rating} 分`}>
      {Array.from({ length: 5 }, (_, index) => (
        <Star key={index} aria-hidden="true" className={index < rating ? "is-filled" : undefined} />
      ))}
    </span>
  );
}

function FeedbackAttachmentCard({ feedbackId, attachment }: { feedbackId: string; attachment: FeedbackAttachment }) {
  return (
    <a
      className="feedback-detail-attachment"
      href={getFeedbackAttachmentUrl(feedbackId, attachment.id)}
      target="_blank"
      rel="noreferrer"
    >
      <img src={getFeedbackAttachmentUrl(feedbackId, attachment.id)} alt={`反馈截图：${attachment.filename}`} loading="lazy" />
      <span title={attachment.filename}>{attachment.filename} · {formatAttachmentSize(attachment.size)}</span>
    </a>
  );
}

function FeedbackDetailContent({ detail }: { detail: FeedbackDetail }) {
  return (
    <div className="feedback-detail-panel">
      <div className="feedback-detail-grid">
        <div className="feedback-detail-field"><span>反馈类型</span><strong>{categoryLabels[detail.category]}</strong></div>
        <div className="feedback-detail-field"><span>满意度</span><strong>{detail.rating} / 5</strong></div>
        <div className="feedback-detail-field"><span>提交时间</span><strong>{formatFeedbackDate(detail.createdAt)}</strong></div>
        <div className="feedback-detail-field"><span>联系方式</span><strong>{detail.contact || "未留下联系方式"}</strong></div>
        <div className="feedback-detail-field is-wide"><span>具体意见</span><p>{detail.message}</p></div>
        {(detail.attachments?.length ?? 0) > 0 && (
          <div className="feedback-detail-field is-wide">
            <span>图片附件</span>
            <div className="feedback-detail-attachments">
              {detail.attachments?.map((attachment) => <FeedbackAttachmentCard key={attachment.id} feedbackId={detail.id} attachment={attachment} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FeedbackDetailDrawer({
  detailId,
  detail,
  loading,
  error,
  onRetry,
  onClose,
}: {
  detailId: string;
  detail: FeedbackDetail | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (!isClosing) return;
    const timer = window.setTimeout(onClose, 220);
    return () => window.clearTimeout(timer);
  }, [isClosing, onClose]);

  const requestClose = useCallback(() => setIsClosing(true), []);

  return (
    <ReviewDrawerShell
      eyebrow="反馈记录"
      title="反馈详情"
      titleId={`feedback-detail-title-${detailId}`}
      closeLabel="关闭反馈详情"
      isClosing={isClosing}
      onRequestClose={requestClose}
      contentClassName="feedback-detail-drawer-content"
    >
      {loading && <div className="feedback-detail-drawer-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取反馈详情…</div>}
      {error && (
        <div className="feedback-detail-drawer-state is-error" role="alert">
          <span>{error}</span>
          <Button variant="ghost" size="sm" type="button" onClick={onRetry}>重新读取</Button>
        </div>
      )}
      {detail && detail.id === detailId && <FeedbackDetailContent detail={detail} />}
    </ReviewDrawerShell>
  );
}

function FeedbackDeleteConfirmation({ deleting, onCancel, onConfirm }: { deleting: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="feedback-delete-confirmation" role="alertdialog" aria-label="确认删除反馈">
      <p>删除后无法恢复，确认删除这条意见吗？</p>
      <div className="feedback-delete-confirmation-actions">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel} disabled={deleting}>取消</Button>
        <Button className="feedback-delete-confirm-button" size="sm" type="button" onClick={onConfirm} disabled={deleting}>
          {deleting ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
          {deleting ? "删除中…" : "确认删除"}
        </Button>
      </div>
    </div>
  );
}

export function FeedbackList({
  items,
  total,
  loading,
  error,
  detailId,
  detail,
  detailLoading,
  detailError,
  deletingId,
  onRefresh,
  onViewDetail,
  onCloseDetail,
  onDeleteFeedback,
}: FeedbackListProps) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  return (
    <>
      <section className="feedback-list-panel" aria-labelledby="feedback-list-title">
      <header className="feedback-list-heading">
        <div>
          <h4 id="feedback-list-title">最近收到的意见</h4>
          <p>这里展示最近收集到的反馈，联系方式不会出现在列表中。</p>
        </div>
        <div className="feedback-list-actions">
          <span className="feedback-list-count"><strong>{total}</strong> 条</span>
          <Button className="feedback-list-refresh" variant="outline" size="sm" type="button" onClick={onRefresh} disabled={loading}>
            {loading ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            刷新
          </Button>
        </div>
      </header>

      {loading && items.length === 0 ? (
        <div className="feedback-list-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取反馈…</div>
      ) : error ? (
        <div className="feedback-list-state is-error" role="alert"><span>{error}</span><Button variant="ghost" size="sm" type="button" onClick={onRefresh}>重新读取</Button></div>
      ) : items.length === 0 ? (
        <div className="feedback-list-state"><Inbox aria-hidden="true" /><span>暂时还没有反馈，提交第一条意见吧。</span></div>
      ) : (
        <div className="feedback-list-items">
          {items.map((item) => (
            <article className="feedback-list-item" key={item.id}>
              <time dateTime={item.createdAt}>{formatFeedbackDate(item.createdAt)}</time>
              <div className="feedback-list-item-header">
                <span className={`feedback-category-tag ${item.category}`}>{categoryLabels[item.category]}</span>
                <FeedbackRating rating={item.rating} />
                <div className="feedback-list-item-actions">
                  <Button variant="ghost" size="sm" className="feedback-list-action" type="button" onClick={() => { setPendingDeleteId(null); onViewDetail(item.id); }} disabled={deletingId !== null}>
                    <Eye aria-hidden="true" />查看详情
                  </Button>
                  <Button variant="ghost" size="sm" className="feedback-list-action feedback-list-delete-action" type="button" onClick={() => setPendingDeleteId((current) => current === item.id ? null : item.id)} disabled={deletingId !== null}>
                    <Trash2 aria-hidden="true" />删除
                  </Button>
                </div>
              </div>
              <p>{item.message}</p>
              {pendingDeleteId === item.id && (
                <FeedbackDeleteConfirmation
                  deleting={deletingId === item.id}
                  onCancel={() => setPendingDeleteId(null)}
                  onConfirm={() => { setPendingDeleteId(null); onDeleteFeedback(item.id); }}
                />
              )}
            </article>
          ))}
        </div>
      )}

      </section>
      {detailId && (
        <FeedbackDetailDrawer
          key={detailId}
          detailId={detailId}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onRetry={() => onViewDetail(detailId)}
          onClose={onCloseDetail}
        />
      )}
    </>
  );
}
