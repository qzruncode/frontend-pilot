import { useEffect, useState } from "react";
import { CircleHelp, LoaderCircle } from "lucide-react";
import { getReviewSettings, saveReviewSettings, type HealthResponse, type ReviewSettings } from "./api";
import { AdminPermissionTooltip } from "./admin-permission-tooltip";
import { errorMessage } from "./review-ui-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ReviewCapacityPageProps = {
  health: HealthResponse | null;
  sessionReady: boolean;
  sessionLoading: boolean;
  isAdmin: boolean;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};

export function ReviewCapacityPage({ health, sessionReady, sessionLoading, isAdmin, onRefresh, onNotice, onError }: ReviewCapacityPageProps) {
  const [reviewSettings, setReviewSettings] = useState<ReviewSettings | null>(null);
  const [reviewConcurrency, setReviewConcurrency] = useState("");
  const [autoSendComments, setAutoSendComments] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);

  useEffect(() => {
    if (!sessionReady) {
      setReviewSettings(null);
      setReviewConcurrency("");
      setAutoSendComments(true);
      return;
    }
    let disposed = false;
    setSettingsLoading(true);
    void getReviewSettings()
      .then((response) => {
        if (disposed) return;
        setReviewSettings(response.settings);
        setReviewConcurrency(String(response.settings.reviewConcurrency));
        setAutoSendComments(response.settings.autoSendComments);
      })
      .catch((error: unknown) => {
        if (!disposed) onError(errorMessage(error));
      })
      .finally(() => {
        if (!disposed) setSettingsLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [onError, sessionReady]);

  const saveCapacity = async () => {
    if (!isAdmin) {
      onError("只有管理员可以保存 Review 配置。");
      return;
    }
    const min = reviewSettings?.minReviewConcurrency ?? 1;
    const max = reviewSettings?.maxReviewConcurrency ?? 16;
    const next = Number(reviewConcurrency);
    if (!Number.isSafeInteger(next) || next < min || next > max) {
      onError(`并发数请输入 ${min} 到 ${max} 之间的整数。`);
      return;
    }
    setSettingsSaving(true);
    try {
      const response = await saveReviewSettings({ reviewConcurrency: next, autoSendComments });
      setReviewSettings(response.settings);
      setReviewConcurrency(String(response.settings.reviewConcurrency));
      setAutoSendComments(response.settings.autoSendComments);
      onNotice(`Review 配置已保存：${response.settings.autoSendComments ? "会自动发送 GitLab 评论" : "不会发送 GitLab 评论"}。`);
      await onRefresh();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSettingsSaving(false);
    }
  };

  if (!sessionReady) {
    return <div className="review-capacity-state" role={sessionLoading ? "status" : "alert"}><LoaderCircle className={sessionLoading ? "is-spinning" : undefined} aria-hidden="true" /><strong>{sessionLoading ? "正在连接服务" : "页面会话建立失败"}</strong><p>Review 配置需要先建立安全会话。</p></div>;
  }

  return (
    <section className="review-capacity-page" aria-labelledby="review-capacity-page-title">
      <div className="review-capacity-page-inner">
        <header className="review-capacity-page-heading">
          <div className="review-capacity-title-row">
            <h3 id="review-capacity-page-title">Review 配置</h3>
            <span className="review-capacity-tooltip-trigger" tabIndex={0} aria-describedby="review-capacity-page-tip">
              <CircleHelp aria-hidden="true" />
              <span id="review-capacity-page-tip" className="review-capacity-tooltip" role="tooltip">配置 Review 任务池，并控制是否自动将审查评论写回 GitLab。</span>
            </span>
          </div>
        </header>
        <section className="review-capacity-section" aria-label="Review 容量配置">
          <div className="review-capacity-heading">
            <div>
              <div className="review-capacity-heading-title-row">
                <strong>只读 Review 任务池</strong>
                <span className="review-capacity-tooltip-trigger" tabIndex={0} aria-describedby="review-capacity-pool-tip">
                  <CircleHelp aria-hidden="true" />
                  <span id="review-capacity-pool-tip" className="review-capacity-tooltip" role="tooltip">按项目公平轮转，避免单个项目占满队列。</span>
                </span>
              </div>
            </div>
            <Badge variant="outline" className="capacity-badge">{health?.running ?? 0} / {reviewSettings?.reviewConcurrency ?? "—"} 运行中</Badge>
          </div>
          <div className="review-capacity-control">
            <div className="review-capacity-control-label">
              <Label htmlFor="review-concurrency">最大并发</Label>
              <span className="review-capacity-tooltip-trigger" tabIndex={0} aria-describedby="review-capacity-queue-tip">
                <CircleHelp aria-hidden="true" />
                <span id="review-capacity-queue-tip" className="review-capacity-tooltip" role="tooltip">当前排队任务会在并发上限提高后自动拉起；降低上限不会中断已运行的审查。</span>
              </span>
            </div>
            <div className="review-capacity-input">
              <Input id="review-concurrency" type="number" min={reviewSettings?.minReviewConcurrency ?? 1} max={reviewSettings?.maxReviewConcurrency ?? 16} value={reviewConcurrency} onChange={(event) => setReviewConcurrency(event.target.value)} disabled={settingsLoading || settingsSaving} />
            </div>
          </div>
        </section>
        <section className="review-capacity-section review-comments-section" aria-label="GitLab 评论配置">
          <div className="review-capacity-heading">
            <div>
              <div className="review-capacity-heading-title-row">
                <strong>GitLab 评论写回</strong>
                <span className="review-capacity-tooltip-trigger" tabIndex={0} aria-describedby="review-capacity-comments-tip">
                  <CircleHelp aria-hidden="true" />
                  <span id="review-capacity-comments-tip" className="review-capacity-tooltip" role="tooltip">控制 Review 是否自动创建或更新 MR 评论。</span>
                </span>
              </div>
            </div>
          </div>
          <div className="review-comment-toggle">
            <div className="review-comment-toggle-label">
              <Label htmlFor="review-auto-send-comments">自动发送评论到 GitLab</Label>
              <span className="review-capacity-tooltip-trigger" tabIndex={0} aria-describedby="review-capacity-auto-comments-tip">
                <CircleHelp aria-hidden="true" />
                <span id="review-capacity-auto-comments-tip" className="review-capacity-tooltip" role="tooltip">关闭后 Review 仍会执行并生成门禁结果，但不会发送或更新 GitLab 评论。</span>
              </span>
            </div>
            <button
              type="button"
              role="switch"
              id="review-auto-send-comments"
              className={`review-capacity-switch ${autoSendComments ? "is-enabled" : ""}`}
              aria-checked={autoSendComments}
              aria-label={`自动发送评论到 GitLab${autoSendComments ? "，已开启" : "，已关闭"}`}
              title={autoSendComments ? "关闭自动发送评论" : "开启自动发送评论"}
              disabled={settingsLoading || settingsSaving || !reviewSettings}
              onClick={() => setAutoSendComments((current) => !current)}
            >
              <span className="review-capacity-switch-thumb" aria-hidden="true" />
            </button>
          </div>
        </section>
        <div className="review-capacity-actions">
          <AdminPermissionTooltip isAdmin={isAdmin} tooltipId="review-capacity-admin-save-tip">
            <Button variant="outline" size="sm" type="button" onClick={() => void saveCapacity()} disabled={!isAdmin || settingsLoading || settingsSaving || !reviewSettings}>{settingsLoading ? "读取中…" : settingsSaving ? "保存中…" : "保存配置"}</Button>
          </AdminPermissionTooltip>
        </div>
      </div>
    </section>
  );
}
