import {
  ArrowLeft,
  CircleAlert,
  ChevronRight,
  FileSearch,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
  Timer,
  X,
} from "lucide-react";
import type { ReviewJob } from "@contracts";
import { Button } from "@/components/ui/button";
import { ReviewAssistantThread } from "./review-thread";
import {
  formatDateTime,
  formatReviewDuration,
  projectLabel,
  ReviewStatusBadge,
  reviewProfileContext,
} from "./review-history-shared";

export function ReviewHistoryDetailPane({
  job,
  canceling,
  retrying,
  onCancel,
  onRetry,
  onBack,
  showMobileBack = true,
  deferEvents = false,
}: {
  job: ReviewJob | null;
  canceling: boolean;
  retrying: boolean;
  onCancel: () => void;
  onRetry?: () => void;
  onBack: () => void;
  showMobileBack?: boolean;
  deferEvents?: boolean;
}) {
  const profileContext = job ? reviewProfileContext(job) : null;
  const failureEventRecorded = job !== null && job.error !== null
    && job.progress.some((event) => event.kind === "error" && event.detail === job.error);

  return (
    <section className="review-history-detail-pane" aria-labelledby="review-history-detail-title">
      {job ? (
        <>
          {showMobileBack && <Button variant="ghost" size="sm" className="review-history-mobile-back" type="button" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />返回记录列表
          </Button>}
          <div className="review-history-detail-heading">
            <div className="review-history-detail-title-row">
              <div className="review-history-detail-title-copy">
                <h4 id="review-history-detail-title">{projectLabel(job)} !{job.mrIid}</h4>
                <ReviewStatusBadge status={job.status} />
                <p>创建于 {formatDateTime(job.createdAt)} · 来源 {job.source}</p>
              </div>
              <div className="review-history-detail-actions">
                {onRetry && job.status === "failed" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="review-history-row-action review-history-row-retry"
                    type="button"
                    aria-label={`重试 !${job.mrIid} 的 Review 任务`}
                    title="重试任务"
                    onClick={onRetry}
                    disabled={retrying}
                  >
                    {retrying
                      ? <LoaderCircle className="is-spinning" aria-hidden="true" />
                      : <RefreshCw aria-hidden="true" />}
                  </Button>
                )}
                {(job.status === "queued" || job.status === "running") && (
                  <Button variant="outline" size="sm" type="button" onClick={onCancel} disabled={canceling}>
                    <X aria-hidden="true" />{canceling ? "取消中…" : "取消任务"}
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="review-history-finding-grid" aria-label="问题统计">
            <div><strong>{job.result?.findingCount ?? "—"}</strong><span>高价值问题</span></div>
            <div><strong>{job.result?.ruleFindingCount ?? "—"}</strong><span>规范问题</span></div>
            <div><strong>{job.progress.length}</strong><span>执行事件</span></div>
          </div>

          <dl className="review-history-metadata">
            <div><dt><GitCommitHorizontal aria-hidden="true" />提交</dt><dd><code>{job.headSha || "未提供"}</code></dd></div>
            <div><dt><GitBranch aria-hidden="true" />目标分支</dt><dd>{job.targetBranch || "未指定"}</dd></div>
            <div><dt><Timer aria-hidden="true" />总耗时</dt><dd>{formatReviewDuration(job.startedAt, job.finishedAt)}</dd></div>
            <div><dt><RefreshCw aria-hidden="true" />来源</dt><dd>{job.source}</dd></div>
          </dl>

          {job.error && !failureEventRecorded && (
            <div className="review-history-error-card" role="alert">
              <CircleAlert aria-hidden="true" />
              <div><strong>失败原因</strong><p>{job.error}</p></div>
            </div>
          )}
          {(job.status === "queued" || job.status === "running") && (
            <div className="review-history-running-card" role="status">
              <LoaderCircle className="is-spinning" aria-hidden="true" />
              <div>
                <strong>{job.status === "queued" ? "任务正在排队" : "Review 正在进行"}</strong>
                <p>{profileContext
                  ? `当前采用：${profileContext.displayName} · ${profileContext.ruleCount === null ? "规则数量读取中" : `${profileContext.ruleCount} 条启用规则`}`
                  : "当前采用：正在按 MR 所属仓库匹配审查规则"}</p>
              </div>
            </div>
          )}

          <details className="review-history-events" open={job.progress.length > 0}>
            <summary>
              <span><FileSearch aria-hidden="true" /><strong>执行事件</strong><small>{job.progress.length} 条</small></span>
              <ChevronRight aria-hidden="true" />
            </summary>
            {job.progress.length > 0 && deferEvents ? (
              <div className="review-history-events-loading" role="status" aria-live="polite">
                <LoaderCircle className="is-spinning" aria-hidden="true" />
                <span>正在展开审查会话…</span>
              </div>
            ) : job.progress.length > 0 ? (
              <ReviewAssistantThread
                events={job.progress}
                live={job.status === "queued" || job.status === "running"}
                status={job.status}
                context={job}
              />
            ) : (
              <p className="review-history-events-empty">任务开始后，阶段、工具和结果事件会显示在这里。</p>
            )}
          </details>
        </>
      ) : (
        <div className="review-history-detail-empty">
          <div className="review-history-detail-empty-icon" aria-hidden="true"><FileSearch /></div>
          <span className="review-history-section-kicker">SELECT A RUN</span>
          <strong>选择一条记录查看详情</strong>
          <p>从左侧历史任务中选择 Review，可查看摘要、问题统计和完整执行事件。</p>
        </div>
      )}
    </section>
  );
}
