import { Activity, ListChecks, Settings2, Sparkles } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { getGitLabConnection } from "./api";
import { GitLabConnectionDrawer } from "./assistant-gitlab-settings";
import { Button } from "@/components/ui/button";

type ReviewWorkbenchTab = "tools" | "settings" | "rules" | "runs";

type ReviewWorkbenchPageProps = {
  sessionReady: boolean;
  isAdmin: boolean;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
  renderReviewToolsPage: () => ReactNode;
  renderReviewSettingsPage: () => ReactNode;
  renderReviewRulesPage: () => ReactNode;
  renderReviewHistoryPage: () => ReactNode;
};

const tabs: Array<{ id: ReviewWorkbenchTab; label: string; note: string; icon: LucideIcon }> = [
  { id: "tools", label: "Review 工具", note: "提交与追踪", icon: Sparkles },
  { id: "settings", label: "Review 配置", note: "队列与评论", icon: Settings2 },
  { id: "rules", label: "Review 规则", note: "审查标准", icon: Activity },
  { id: "runs", label: "Review 记录", note: "历史任务", icon: ListChecks },
];

export function ReviewWorkbenchPage({ sessionReady, isAdmin, onNotice, onError, renderReviewToolsPage, renderReviewSettingsPage, renderReviewRulesPage, renderReviewHistoryPage }: ReviewWorkbenchPageProps) {
  const [activeTab, setActiveTab] = useState<ReviewWorkbenchTab>("tools");
  const [gitlabConnectionOpen, setGitlabConnectionOpen] = useState(false);
  const [gitlabConfigured, setGitlabConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (!sessionReady) {
      setGitlabConfigured(null);
      return;
    }
    let active = true;
    void getGitLabConnection()
      .then((connection) => {
        if (active) setGitlabConfigured(connection.tokenConfigured);
      })
      .catch(() => {
        if (active) setGitlabConfigured(null);
      });
    return () => {
      active = false;
    };
  }, [sessionReady]);

  const content = activeTab === "tools"
    ? renderReviewToolsPage()
    : activeTab === "settings"
      ? renderReviewSettingsPage()
      : activeTab === "rules"
        ? renderReviewRulesPage()
        : renderReviewHistoryPage();

  return (
    <>
      <section className="review-workbench-page" aria-labelledby="review-workbench-title">
      <header className="review-workbench-heading">
        <div className="review-workbench-heading-copy">
          <div className="review-workbench-title-row">
            <span className="review-workbench-brand-mark" aria-hidden="true"><Sparkles /></span>
            <div>
              <h2 id="review-workbench-title">Review 工作台</h2>
              <p>集中提交审查、管理规则、调整队列并查看历史记录。</p>
            </div>
          </div>
        </div>
        <div className="review-workbench-heading-actions jira-workbench-heading-actions">
          <span className={`jira-workbench-sync ${gitlabConfigured === false ? "is-disconnected" : ""}`}>
            <i aria-hidden="true" />{gitlabConfigured === true ? "GitLab 已连接" : gitlabConfigured === false ? "GitLab 未配置" : "GitLab 连接状态"}
          </span>
          <Button
            variant="outline"
            size="sm"
            type="button"
            className="jira-action-button jira-connection-button"
            aria-haspopup="dialog"
            aria-expanded={gitlabConnectionOpen}
            onClick={() => setGitlabConnectionOpen(true)}
          >
            <Settings2 aria-hidden="true" />
            连接设置
          </Button>
        </div>
      </header>
      <nav className="review-workbench-tabs" aria-label="Review 工作台功能" role="tablist">
        <div className="review-workbench-tab-list">
          {tabs.map(({ id, label, note, icon: Icon }) => (
            <Button
              key={id}
              id={`review-workbench-tab-${id}`}
              variant="ghost"
              className={activeTab === id ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls="review-workbench-panel"
              onClick={() => setActiveTab(id)}
            >
              <Icon aria-hidden="true" />
              <span><strong>{label}</strong><small>{note}</small></span>
            </Button>
          ))}
        </div>
      </nav>
      <div id="review-workbench-panel" className="review-workbench-content" role="tabpanel" aria-labelledby={`review-workbench-tab-${activeTab}`}>
        {content}
      </div>
      </section>
      <GitLabConnectionDrawer
        open={gitlabConnectionOpen}
        sessionReady={sessionReady}
        isAdmin={isAdmin}
        onClose={() => setGitlabConnectionOpen(false)}
        onNotice={onNotice}
        onError={onError}
      />
    </>
  );
}
