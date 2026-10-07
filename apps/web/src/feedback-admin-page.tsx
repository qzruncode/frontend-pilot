import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedbackDetail, FeedbackListItem } from "@contracts";
import { ApiError, deleteFeedback, getFeedback, listFeedback } from "./api";
import { FeedbackList } from "./feedback-list";

type FeedbackAdminPageProps = {
  sessionReady: boolean;
  isAdmin: boolean;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
};

function feedbackErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "这条反馈已不存在。";
    if (typeof error.details === "string") return error.details;
    return error.status >= 500 ? fallback : error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function FeedbackAdminPage({ sessionReady, isAdmin, onNotice, onError }: FeedbackAdminPageProps) {
  const [items, setItems] = useState<FeedbackListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedbackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const requestId = useRef(0);
  const detailRequestId = useRef(0);

  const loadFeedback = useCallback(async () => {
    const currentRequestId = requestId.current + 1;
    requestId.current = currentRequestId;
    if (!sessionReady || !isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listFeedback();
      if (currentRequestId !== requestId.current) return;
      setItems(result.items);
      setTotal(result.total);
      onError(null);
    } catch (loadError) {
      if (currentRequestId !== requestId.current) return;
      const message = feedbackErrorMessage(loadError, "反馈列表暂时无法读取，请稍后重试。");
      setError(message);
      onError(message);
    } finally {
      if (currentRequestId === requestId.current) setLoading(false);
    }
  }, [isAdmin, onError, sessionReady]);

  const viewDetail = useCallback(async (id: string) => {
    const currentRequestId = detailRequestId.current + 1;
    detailRequestId.current = currentRequestId;
    setDetailId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const result = await getFeedback(id);
      if (currentRequestId !== detailRequestId.current) return;
      setDetail(result);
    } catch (detailLoadError) {
      if (currentRequestId !== detailRequestId.current) return;
      setDetailError(feedbackErrorMessage(detailLoadError, "反馈详情暂时无法读取，请稍后重试。"));
    } finally {
      if (currentRequestId === detailRequestId.current) setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    detailRequestId.current += 1;
    setDetailId(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  const removeFeedback = useCallback(async (id: string) => {
    setDeletingId(id);
    onError(null);
    try {
      await deleteFeedback(id);
      setItems((current) => current.filter((item) => item.id !== id));
      setTotal((current) => Math.max(0, current - 1));
      if (detailId === id) closeDetail();
      onNotice("反馈已删除。");
    } catch (deleteError) {
      onError(feedbackErrorMessage(deleteError, "反馈暂时无法删除，请稍后重试。"));
    } finally {
      setDeletingId(null);
    }
  }, [closeDetail, detailId, onError, onNotice]);

  useEffect(() => {
    void loadFeedback();
    return () => {
      requestId.current += 1;
      detailRequestId.current += 1;
    };
  }, [loadFeedback]);

  if (!isAdmin) {
    return <section className="feedback-admin-page" aria-labelledby="feedback-admin-title"><div className="feedback-admin-inner"><div className="feedback-list-state is-error" role="alert">只有管理员可以查看反馈管理内容。</div></div></section>;
  }

  return (
    <section className="feedback-admin-page" aria-labelledby="feedback-admin-title">
      <div className="feedback-admin-inner">
        <header className="feedback-admin-heading">
          <h3 id="feedback-admin-title">反馈管理</h3>
          <p>仅管理员可以查看、查看详情和处理已收集的意见。</p>
        </header>

        <FeedbackList
          items={items}
          total={total}
          loading={loading}
          error={error}
          detailId={detailId}
          detail={detail}
          detailLoading={detailLoading}
          detailError={detailError}
          deletingId={deletingId}
          onRefresh={() => void loadFeedback()}
          onViewDetail={(id) => void viewDetail(id)}
          onCloseDetail={closeDetail}
          onDeleteFeedback={(id) => void removeFeedback(id)}
        />
      </div>
    </section>
  );
}
