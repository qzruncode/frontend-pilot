import { Clock3, LoaderCircle, RefreshCw, Timer, Trash2, X } from "lucide-react";
import type { ReviewJob } from "@contracts";
import { Button } from "@/components/ui/button";
import {
  formatDateTime,
  formatReviewDuration,
  isActiveReviewStatus,
  isTerminalReviewStatus,
  projectLabel,
  ReviewStatusBadge,
  shortSha,
  statusMeta,
} from "./review-history-shared";
import { ReviewListRow } from "./review-list";

export type ReviewJobListProps = {
  jobs: ReviewJob[];
  selectedId?: string | null;
  onSelect: (job: ReviewJob) => void;
  onCancel?: (job: ReviewJob) => void | Promise<void>;
  onRetry?: (job: ReviewJob) => void | Promise<void>;
  onDelete?: (job: ReviewJob) => void | Promise<void>;
  cancelingId?: string | null;
  retryingId?: string | null;
  deletingId?: string | null;
  className?: string;
};

export function ReviewJobList({
  jobs,
  selectedId,
  onSelect,
  onCancel,
  onRetry,
  onDelete,
  cancelingId,
  retryingId,
  deletingId,
  className,
}: ReviewJobListProps) {
  const listClassName = ["review-history-list", className].filter(Boolean).join(" ");

  return (
    <div className={listClassName}>
      {jobs.map((job) => {
        const selected = job.id === selectedId;
        const canCancel = Boolean(onCancel) && isActiveReviewStatus(job.status);
        const canRetry = Boolean(onRetry) && job.status === "failed";
        const canDelete = Boolean(onDelete) && isTerminalReviewStatus(job.status);
        const actionsDisabled = Boolean(retryingId || deletingId);

        const actions = (canCancel || canRetry || canDelete) ? (
          <>
            {canCancel && (
              <Button
                variant="ghost"
                size="icon"
                className="review-history-row-action review-history-row-cancel"
                type="button"
                aria-label={`取消 !${job.mrIid} 的 Review 任务`}
                title="取消任务"
                onClick={() => void onCancel?.(job)}
                disabled={cancelingId === job.id}
              >
                {cancelingId === job.id ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <X aria-hidden="true" />}
              </Button>
            )}
            {canRetry && (
              <Button
                variant="ghost"
                size="icon"
                className="review-history-row-action review-history-row-retry"
                type="button"
                aria-label={`重试 !${job.mrIid} 的 Review 任务`}
                title="重试任务"
                onClick={() => void onRetry?.(job)}
                disabled={actionsDisabled}
              >
                <RefreshCw className={retryingId === job.id ? "is-spinning" : undefined} aria-hidden="true" />
              </Button>
            )}
            {canDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="review-history-row-action review-history-row-delete"
                type="button"
                aria-label={`删除 !${job.mrIid} 的 Review 记录`}
                title="删除记录"
                onClick={() => void onDelete?.(job)}
                disabled={actionsDisabled}
              >
                {deletingId === job.id ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
              </Button>
            )}
          </>
        ) : null;

        return (
          <ReviewListRow
            key={job.id}
            ariaLabel={`查看 ${projectLabel(job)} !${job.mrIid} 的审查会话`}
            onSelect={() => onSelect(job)}
            selected={selected}
            actions={actions}
            actionsLabel={`${projectLabel(job)} !${job.mrIid} 操作`}
            main={(
              <span className="review-history-row-main">
                <span className="review-history-row-topline">
                  <strong>{projectLabel(job)}</strong>
                  <ReviewStatusBadge status={job.status} />
                </span>
                <span className="review-history-row-title">
                  !{job.mrIid} <span>·</span> {job.result?.summary || statusMeta[job.status].detail}
                </span>
                <span className="review-history-row-meta">
                  <code>{shortSha(job.headSha)}</code>
                  <span><Clock3 aria-hidden="true" />{formatDateTime(job.createdAt)}</span>
                  <span><Timer aria-hidden="true" />{formatReviewDuration(job.startedAt, job.finishedAt)}</span>
                  <span>{job.result ? job.result.findingCount + job.result.ruleFindingCount + " 个问题" : "结果待生成"}</span>
                </span>
              </span>
            )}
          />
        );
      })}
    </div>
  );
}
