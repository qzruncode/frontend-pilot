import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewJob } from "@contracts";
import { ReviewHistoryDetailPane } from "./review-history-detail";
import { ReviewDrawerShell } from "./review-drawer-shell";

const DRAWER_EXIT_DURATION_MS = 220;
const DRAWER_EVENTS_DELAY_MS = 300;

export function ReviewSessionDrawer({
  job,
  canceling,
  retrying = false,
  onCancel,
  onRetry,
  onClose,
}: {
  job: ReviewJob | null;
  canceling: boolean;
  retrying?: boolean;
  onCancel: () => void;
  onRetry?: () => void;
  onClose: () => void;
}) {
  const [renderedJob, setRenderedJob] = useState<ReviewJob | null>(job);
  const [isClosing, setIsClosing] = useState(false);
  const [eventsReady, setEventsReady] = useState(false);
  const previousJobIdRef = useRef<string | null>(job?.id ?? null);

  useEffect(() => {
    const previousJobId = previousJobIdRef.current;
    previousJobIdRef.current = job?.id ?? null;
    if (!job) return;
    if (job.id !== previousJobId) setIsClosing(false);
    setRenderedJob(job);
  }, [job]);

  useEffect(() => {
    if (job || !renderedJob) return;
    setIsClosing(true);
  }, [job, renderedJob]);

  useEffect(() => {
    if (!renderedJob) return;
    setEventsReady(false);
    const timer = window.setTimeout(() => setEventsReady(true), DRAWER_EVENTS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isClosing, renderedJob?.id]);

  useEffect(() => {
    if (!isClosing) return;
    const timer = window.setTimeout(() => {
      setRenderedJob(null);
      onClose();
    }, DRAWER_EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [isClosing, onClose]);

  const requestClose = useCallback(() => setIsClosing(true), []);

  if (!renderedJob) return null;
  return (
    <ReviewDrawerShell
      eyebrow="任务记录"
      title="审查会话详情"
      titleId="review-session-drawer-title"
      closeLabel="关闭审查会话详情"
      isClosing={isClosing}
      onRequestClose={requestClose}
    >
      <ReviewHistoryDetailPane job={renderedJob} canceling={canceling} retrying={retrying} onCancel={onCancel} onRetry={onRetry} onBack={requestClose} showMobileBack={false} deferEvents={!eventsReady} />
    </ReviewDrawerShell>
  );
}
