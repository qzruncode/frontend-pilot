import { Suspense, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { ModelSettingsPanel } from "./assistant-model-settings";
import { GitLabConnectionPanel } from "./assistant-gitlab-settings";
import { JiraConnectionPanel } from "./assistant-jira-settings";
import { SettingsPlaceholder } from "./assistant-settings-placeholder";
import { allSettingsItems, type FeedbackHandlers, type SettingsItem } from "./assistant-settings";
import { Button } from "@/components/ui/button";

type AssistantSettingsLayerProps = {
  activeItem: SettingsItem["id"];
  sessionReady: boolean;
  isAdmin: boolean;
  onClose: () => void;
  isClosing: boolean;
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
  renderReviewWorkbenchPage?: () => ReactNode;
  renderClaudeCliPage?: () => ReactNode;
  renderInspectionWorkbenchPage?: () => ReactNode;
  renderReviewToolsPage?: () => ReactNode;
  renderGitLabWorkbenchPage?: () => ReactNode;
  renderJiraWorkbenchPage?: () => ReactNode;
  renderReviewSettingsPage?: () => ReactNode;
  renderReviewHistoryPage?: () => ReactNode;
  renderReviewRulesPage?: () => ReactNode;
  renderFeedbackPage?: () => ReactNode;
  renderFeedbackAdminPage?: () => ReactNode;
  renderUserManagementPage?: () => ReactNode;
  renderUserActivityPage?: () => ReactNode;
};

export function AssistantSettingsLayer({
  activeItem,
  sessionReady,
  isAdmin,
  onClose,
  isClosing,
  onNotice,
  onError,
  renderReviewWorkbenchPage,
  renderClaudeCliPage,
  renderInspectionWorkbenchPage,
  renderReviewToolsPage,
  renderGitLabWorkbenchPage,
  renderJiraWorkbenchPage,
  renderReviewSettingsPage,
  renderReviewHistoryPage,
  renderReviewRulesPage,
  renderFeedbackPage,
  renderFeedbackAdminPage,
  renderUserManagementPage,
  renderUserActivityPage,
}: AssistantSettingsLayerProps) {
  const feedback: FeedbackHandlers = { onNotice, onError };
  const selectedItem = allSettingsItems.find((item) => item.id === activeItem) ?? allSettingsItems[0];

  const renderPage = (item: SettingsItem["id"]): ReactNode => (
      item === "models" ? <ModelSettingsPanel sessionReady={sessionReady} isAdmin={isAdmin} {...feedback} />
      : item === "claude-cli" && renderClaudeCliPage ? renderClaudeCliPage()
        : item === "review-workbench" && renderReviewWorkbenchPage ? renderReviewWorkbenchPage()
          : item === "inspection-workbench" && renderInspectionWorkbenchPage ? renderInspectionWorkbenchPage()
          : item === "review-tools" && renderReviewToolsPage ? renderReviewToolsPage()
          : item === "gitlab-workbench" && renderGitLabWorkbenchPage ? renderGitLabWorkbenchPage()
            : item === "jira-workbench" && renderJiraWorkbenchPage ? renderJiraWorkbenchPage()
              : item === "review-settings" && renderReviewSettingsPage ? renderReviewSettingsPage()
                : item === "runs" && renderReviewHistoryPage ? renderReviewHistoryPage()
                  : item === "gitlab" ? <GitLabConnectionPanel sessionReady={sessionReady} isAdmin={isAdmin} {...feedback} />
                    : item === "jira" ? <JiraConnectionPanel sessionReady={sessionReady} isAdmin={isAdmin} {...feedback} />
                      : item === "rules" && renderReviewRulesPage ? renderReviewRulesPage()
                        : item === "feedback" && renderFeedbackPage ? renderFeedbackPage()
                          : item === "feedback-admin" && renderFeedbackAdminPage ? renderFeedbackAdminPage()
                            : item === "users" && renderUserManagementPage ? renderUserManagementPage()
                              : item === "user-activity" && renderUserActivityPage ? renderUserActivityPage()
                                : <SettingsPlaceholder item={allSettingsItems.find((entry) => entry.id === item) ?? selectedItem} />
  );

  const renderPageFrame = (item: SettingsItem["id"]) => (
    <div key={item} className="model-settings-page-frame is-entering">
      <Suspense fallback={<div className="model-settings-page-loading" role="status">正在加载页面…</div>}>
        {renderPage(item)}
      </Suspense>
    </div>
  );

  return (
    <div className={`model-settings-page-layer ${isClosing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="model-settings-page-title" aria-busy={isClosing}>
      <header className="model-settings-page-header">
        <Button variant="ghost" className="model-settings-page-back" type="button" onClick={onClose}><ArrowLeft aria-hidden="true" /><span>返回助手</span></Button>
        <div className="model-settings-page-title"><strong id="model-settings-page-title">{selectedItem.label}</strong></div>
      </header>
      <main className="model-settings-page-content">
        <div className="model-settings-page-transition">
          {renderPageFrame(activeItem)}
        </div>
      </main>
    </div>
  );
}
