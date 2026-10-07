import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewJob, ReviewProgressEvent, ReviewStats } from "@contracts";
import {
  cancelReview,
  deleteReview,
  getAuthStatus,
  getHealth,
  listReviews,
  logout,
  renewSession,
  retryReview,
  subscribeToReviewEvents,
  type HealthResponse,
  ApiError,
} from "./api";
import { AssistantPage } from "./assistant-page";
import { FeedbackAdminPage } from "./feedback-admin-page";
import { FeedbackPage } from "./feedback-page";
import { LoginPage } from "./login-page";
import { errorMessage, mergeProgressEvents } from "./review-ui-utils";

const ReviewDashboard = lazy(() => import("./review-dashboard").then(({ ReviewDashboard: Page }) => ({ default: Page })));
const ReviewWorkbenchPage = lazy(() => import("./review-workbench-page").then(({ ReviewWorkbenchPage: Page }) => ({ default: Page })));
const InspectionWorkbenchPage = lazy(() => import("./inspection-access-page").then(({ InspectionAccessPage: Page }) => ({ default: Page })));
const ReviewCapacityPage = lazy(() => import("./review-capacity-page").then(({ ReviewCapacityPage: Page }) => ({ default: Page })));
const ReviewHistoryPage = lazy(() => import("./review-history-page").then(({ ReviewHistoryPage: Page }) => ({ default: Page })));
const ReviewRulesPage = lazy(() => import("./review-rules-page").then(({ ReviewRulesPage: Page }) => ({ default: Page })));
const GitLabWorkbenchPage = lazy(() => import("./gitlab-workbench-page").then(({ GitLabWorkbenchPage: Page }) => ({ default: Page })));
const JiraWorkbenchPage = lazy(() => import("./jira-workbench-page").then(({ JiraWorkbenchPage: Page }) => ({ default: Page })));
const ClaudeCliWorkbenchPage = lazy(() => import("./claude-cli-workbench-page").then(({ ClaudeCliWorkbenchPage: Page }) => ({ default: Page })));
const UserManagementPage = lazy(() => import("./user-management-page").then(({ UserManagementPage: Page }) => ({ default: Page })));
const UserActivityPage = lazy(() => import("./user-activity-page").then(({ UserActivityPage: Page }) => ({ default: Page })));

const REVIEW_LIST_REFRESH_INTERVAL_MS = 5_000;
const SESSION_RENEW_INTERVAL_MS = 15 * 60_000;
const SESSION_ACTIVITY_WINDOW_MS = 30 * 60_000;

export default function App() {
  const [jobs, setJobs] = useState<ReviewJob[]>([]);
  const [reviewStats, setReviewStats] = useState<ReviewStats | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [authUsername, setAuthUsername] = useState<string | null>(null);
  const [authRole, setAuthRole] = useState<"admin" | "user" | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshInFlight = useRef(false);
  const sessionRenewInFlight = useRef(false);
  const lastSessionActivityAt = useRef(Date.now());
  const isAdmin = authRole === "admin";
  const [inspectionAccess, setInspectionAccess] = useState(false);

  const mergeProgressEvent = useCallback((jobId: string, event: ReviewProgressEvent) => {
    setJobs((current) => current.map((job) => job.id === jobId ? { ...job, progress: mergeProgressEvents(job.progress ?? [], [event]) } : job));
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionReady || refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const result = await listReviews();
      setJobs((current) => {
        const previous = new Map(current.map((job) => [job.id, job]));
        return result.jobs.map((job) => ({ ...job, progress: mergeProgressEvents(previous.get(job.id)?.progress ?? [], job.progress ?? []) }));
      });
      setReviewStats(result.stats);
      setError(null);
    } catch (refreshError) {
      setError(errorMessage(refreshError));
    } finally {
      refreshInFlight.current = false;
    }
  }, [sessionReady]);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await getHealth());
    } catch (healthError) {
      setError(errorMessage(healthError));
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const timer = window.setInterval(() => void refreshHealth(), 10_000);
    return () => window.clearInterval(timer);
  }, [refreshHealth]);

  useEffect(() => {
    let active = true;
    void getAuthStatus()
      .then((status) => {
        if (!active) return;
        setSessionReady(status.authenticated);
        setAuthUsername(status.username);
        setAuthRole(status.role);
        setInspectionAccess(status.role === "admin" || Boolean(status.inspectionAccess));
        setSessionLoading(false);
      })
      .catch((sessionError) => {
        if (!active) return;
        setSessionReady(false);
        setError(errorMessage(sessionError));
        setSessionLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const expireSession = useCallback(() => {
    setJobs([]);
    setAuthUsername(null);
    setAuthRole(null);
    setInspectionAccess(false);
    setSessionReady(false);
    setSessionLoading(false);
    setError("登录已过期，请重新登录。");
  }, []);

  useEffect(() => {
    const handleAuthExpired = () => expireSession();
    window.addEventListener("frontend-pilot:auth-expired", handleAuthExpired);
    return () => window.removeEventListener("frontend-pilot:auth-expired", handleAuthExpired);
  }, [expireSession]);

  useEffect(() => {
    if (!sessionReady) return;
    const markActivity = () => { lastSessionActivityAt.current = Date.now(); };
    const renewIfActive = async () => {
      if (document.visibilityState !== "visible" || Date.now() - lastSessionActivityAt.current > SESSION_ACTIVITY_WINDOW_MS || sessionRenewInFlight.current) return;
      sessionRenewInFlight.current = true;
      try {
        const status = await renewSession();
        setAuthUsername(status.username);
        setAuthRole(status.role);
        setInspectionAccess(status.role === "admin" || Boolean(status.inspectionAccess));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) expireSession();
      } finally {
        sessionRenewInFlight.current = false;
      }
    };
    const renewFromVisible = () => {
      if (document.visibilityState !== "visible") return;
      markActivity();
      void renewIfActive();
    };
    const activityEvents: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart"];
    activityEvents.forEach((event) => window.addEventListener(event, markActivity, { passive: true }));
    document.addEventListener("visibilitychange", renewFromVisible);
    window.addEventListener("focus", renewFromVisible);
    markActivity();
    void renewIfActive();
    const timer = window.setInterval(() => void renewIfActive(), SESSION_RENEW_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      activityEvents.forEach((event) => window.removeEventListener(event, markActivity));
      document.removeEventListener("visibilitychange", renewFromVisible);
      window.removeEventListener("focus", renewFromVisible);
    };
  }, [expireSession, sessionReady]);

  useEffect(() => {
    if (!sessionReady) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    const timer = window.setInterval(refreshWhenVisible, REVIEW_LIST_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [refresh, sessionReady]);

  const activeJobIds = useMemo(() => jobs.filter((job) => job.status === "queued" || job.status === "running").map((job) => job.id).join(","), [jobs]);

  useEffect(() => {
    if (!sessionReady || !activeJobIds) return;
    const sources = activeJobIds.split(",").filter(Boolean).map((jobId) => subscribeToReviewEvents(jobId, (event) => mergeProgressEvent(jobId, event)));
    return () => sources.forEach((source) => source.close());
  }, [activeJobIds, mergeProgressEvent, sessionReady]);

  const handleCancel = useCallback(async (job: ReviewJob) => {
    try {
      await cancelReview(job.id);
      setNotice(`已取消 !${job.mrIid} 的任务。`);
      await refresh();
    } catch (cancelError) {
      setError(errorMessage(cancelError));
    }
  }, [refresh]);

  const handleRetry = useCallback(async (job: ReviewJob): Promise<ReviewJob | null> => {
    try {
      const result = await retryReview(job.id);
      setNotice(`已重新提交 !${job.mrIid} 的审查任务。`);
      await refresh();
      return result.job;
    } catch (retryError) {
      setError(errorMessage(retryError));
      return null;
    }
  }, [refresh]);

  const handleDelete = useCallback(async (job: ReviewJob): Promise<boolean> => {
    try {
      await deleteReview(job.id);
      setNotice(`已删除 !${job.mrIid} 的 Review 记录。`);
      await refresh();
      return true;
    } catch (deleteError) {
      setError(errorMessage(deleteError));
      return false;
    }
  }, [refresh]);

  const renderReviewHistoryContent = useCallback((focusReviewId?: string, onFocusChange?: (id: string | null) => void) => (
    <ReviewHistoryPage jobs={jobs} stats={reviewStats ?? health} sessionReady={sessionReady} sessionLoading={sessionLoading} initialSelectedId={focusReviewId} onSelectedIdChange={onFocusChange} onCancel={handleCancel} onRetry={handleRetry} onDelete={handleDelete} />
  ), [handleCancel, handleDelete, handleRetry, health, jobs, reviewStats, sessionLoading, sessionReady]);

  const renderReviewToolsContent = useCallback(() => (
    <ReviewDashboard jobs={jobs} health={health} sessionReady={sessionReady} sessionLoading={sessionLoading} onRefresh={refresh} onNotice={setNotice} onError={setError} onCancel={handleCancel} />
  ), [handleCancel, health, jobs, refresh, sessionLoading, sessionReady]);

  const renderReviewRulesContent = useCallback(() => (
    <ReviewRulesPage sessionReady={sessionReady} onNotice={setNotice} onError={setError} />
  ), [sessionReady]);

  const renderReviewSettingsContent = useCallback(() => (
    <ReviewCapacityPage health={health} sessionReady={sessionReady} sessionLoading={sessionLoading} isAdmin={isAdmin} onRefresh={refresh} onNotice={setNotice} onError={setError} />
  ), [health, isAdmin, refresh, sessionLoading, sessionReady]);

  const renderReviewWorkbenchContent = useCallback(() => (
    <ReviewWorkbenchPage
      sessionReady={sessionReady}
      isAdmin={isAdmin}
      onNotice={setNotice}
      onError={setError}
      renderReviewToolsPage={renderReviewToolsContent}
      renderReviewSettingsPage={renderReviewSettingsContent}
      renderReviewRulesPage={renderReviewRulesContent}
      renderReviewHistoryPage={() => renderReviewHistoryContent()}
    />
  ), [isAdmin, renderReviewHistoryContent, renderReviewRulesContent, renderReviewSettingsContent, renderReviewToolsContent, sessionReady]);

  const renderInspectionWorkbenchContent = useCallback(() => (
    <InspectionWorkbenchPage sessionReady={sessionReady} isAdmin={isAdmin} onNotice={setNotice} onError={setError} />
  ), [isAdmin, sessionReady]);

  const renderGitLabWorkbenchContent = useCallback(() => (
    <GitLabWorkbenchPage isAdmin={isAdmin} sessionReady={sessionReady} reviewJobs={jobs} onReviewChanged={refresh} onNotice={setNotice} onError={setError} />
  ), [isAdmin, jobs, refresh, sessionReady]);

  const renderClaudeCliContent = useCallback(() => (
    <ClaudeCliWorkbenchPage sessionReady={sessionReady} onNotice={setNotice} onError={setError} />
  ), [sessionReady]);

  const renderJiraWorkbenchContent = useCallback(() => (
    <JiraWorkbenchPage sessionReady={sessionReady} username={authUsername} onNotice={setNotice} onError={setError} />
  ), [authUsername, sessionReady]);

  const renderFeedbackContent = useCallback(() => (
    <FeedbackPage sessionReady={sessionReady} sessionLoading={sessionLoading} onNotice={setNotice} onError={setError} />
  ), [sessionLoading, sessionReady]);

  const renderFeedbackAdminContent = useCallback(() => (
    <FeedbackAdminPage sessionReady={sessionReady} isAdmin={isAdmin} onNotice={setNotice} onError={setError} />
  ), [isAdmin, sessionReady]);

  const renderUserManagementContent = useCallback(() => (
    <UserManagementPage currentUsername={authUsername} isAdmin={isAdmin} onNotice={setNotice} onError={setError} />
  ), [authUsername, isAdmin]);

  const renderUserActivityContent = useCallback(() => (
    <UserActivityPage sessionReady={sessionReady} isAdmin={isAdmin} onError={setError} />
  ), [isAdmin, sessionReady]);

  const handleAuthenticated = useCallback((username: string | null, role: "admin" | "user" | null) => {
    setError(null);
    setAuthUsername(username);
    setAuthRole(role);
    void getAuthStatus().then((status) => setInspectionAccess(status.role === "admin" || Boolean(status.inspectionAccess))).catch(() => setInspectionAccess(false));
    setSessionReady(true);
    setSessionLoading(false);
  }, []);

  const handleLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setError(null);
    try {
      await logout();
      setJobs([]);
      setAuthUsername(null);
      setAuthRole(null);
      setInspectionAccess(false);
      setSessionReady(false);
      setNotice(null);
    } catch (logoutError) {
      setError(errorMessage(logoutError));
    } finally {
      setLoggingOut(false);
    }
  }, [loggingOut]);

  if (sessionLoading) {
    return <div className="auth-loading-screen" role="status">正在检查登录状态…</div>;
  }

  if (!sessionReady) {
    return <LoginPage onAuthenticated={handleAuthenticated} />;
  }

  return (
    <AssistantPage
      inspectionAccess={isAdmin || inspectionAccess}
      renderReviewWorkbenchPage={renderReviewWorkbenchContent}
      renderClaudeCliPage={renderClaudeCliContent}
      renderInspectionWorkbenchPage={renderInspectionWorkbenchContent}
      renderReviewToolsPage={renderReviewToolsContent}
      renderGitLabWorkbenchPage={renderGitLabWorkbenchContent}
      renderJiraWorkbenchPage={renderJiraWorkbenchContent}
      renderReviewSettingsPage={renderReviewSettingsContent}
      renderReviewHistoryPage={renderReviewHistoryContent}
      renderReviewRulesPage={renderReviewRulesContent}
      renderFeedbackPage={renderFeedbackContent}
      renderFeedbackAdminPage={renderFeedbackAdminContent}
      renderUserManagementPage={renderUserManagementContent}
      renderUserActivityPage={renderUserActivityContent}
      onReviewTaskChanged={refresh}
      reviewJobs={jobs}
      sessionReady={sessionReady}
      sessionLoading={sessionLoading}
      isAdmin={isAdmin}
      username={authUsername}
      loggingOut={loggingOut}
      onLogout={handleLogout}
      claudeConfigured={health?.claudeConfigured ?? null}
      externalError={error}
      externalNotice={notice}
    />
  );
}
