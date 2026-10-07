import { ArrowRight, CheckCircle2, CircleAlert, CircleStop, GitPullRequest, LoaderCircle } from "lucide-react";
import type { AssistantReviewTaskReference } from "@contracts";
import { Button } from "@/components/ui/button";
import { ReviewStatusBadge, statusMeta } from "./review-history-shared";

export function AssistantReviewTaskCard({ task, onOpen }: { task: AssistantReviewTaskReference; onOpen: (reviewId: string) => void }) {
  const canceled = task.action === "canceled";
  const failed = task.status === "failed";
  const project = task.projectPath || task.projectId;
  const failureReason = failed ? task.error : null;
  const title = canceled ? "Review 任务已取消" : task.status === "failed" ? "Review 任务未完成" : task.status === "completed" ? "Review 任务已完成" : "Review 任务已启动";
  const message = canceled
    ? "任务已取消，运行记录仍保留在 Review 记录中。"
    : task.status === "failed"
      ? failureReason ? "任务未完成，失败原因如下。" : "任务未完成，打开运行记录查看失败原因。"
    : task.deduplicated
      ? "已复用同一 MR commit 的已有任务。"
      : task.status === "queued"
        ? "任务已进入队列，记录会持续更新。"
        : "任务已启动，记录会持续更新。";
  return (
    <article className={`assistant-review-task-card ${canceled ? "is-canceled" : failed ? "is-failed" : ""}`}>
      <div className="assistant-review-task-card-main">
        <span className="assistant-review-task-card-icon" aria-hidden="true">
          {canceled ? <CircleStop /> : task.status === "queued" || task.status === "running" ? <LoaderCircle className="is-spinning" /> : failed ? <CircleAlert /> : <CheckCircle2 />}
        </span>
        <div className="assistant-review-task-card-copy">
          <div className="assistant-review-task-card-heading">
            <strong>{title}</strong>
            <ReviewStatusBadge status={task.status} />
          </div>
          <span className="assistant-review-task-card-target"><GitPullRequest aria-hidden="true" />{project} !{task.mrIid}</span>
          <small>{message}</small>
          {failureReason && <span className="assistant-review-task-card-error"><CircleAlert aria-hidden="true" />{failureReason}</span>}
        </div>
      </div>
      <div className="assistant-review-task-card-footer">
        <span>{statusMeta[task.status].detail}</span>
        <Button variant="ghost" size="sm" type="button" onClick={() => onOpen(task.id)}><span>查看运行记录</span><ArrowRight aria-hidden="true" /></Button>
      </div>
    </article>
  );
}
