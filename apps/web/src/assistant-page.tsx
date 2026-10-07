import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useMatch, useNavigate } from "react-router-dom";
import { AssistantFocusContextSchema, type AssistantFocusContext, type ReviewJob } from "@contracts";
import { AssistantChatView } from "./assistant-chat-view";
import { AssistantDeleteDialog } from "./assistant-delete-dialog";
import { AssistantNavigationDrawer } from "./assistant-navigation-drawer";
import { AssistantSettingsLayer } from "./assistant-settings-layer";
import {
  ASSISTANT_HOME_PATH,
  ASSISTANT_ROUTE_PATHS,
  INSPECTION_CONFIG_ROUTE,
  assistantPathForNavigation,
  readLegacyAssistantNavigationState,
  type AssistantNavigationState,
} from "./assistant-navigation-state";
import type { SettingsItem } from "./assistant-settings";
import { AssistantSidebar } from "./assistant-sidebar";
import { type ChatMessage, type Conversation } from "./assistant-types";
import { loadConversations } from "./assistant-conversation-utils";
import { getAssistantEditSession, listAssistantEditSessions, trackUserActivity, type AssistantEditOperation, type AssistantEditSession } from "./api";
import { mergeAssistantEditOperations } from "./assistant-conversation-utils";
import { useAssistantConversationRuntime } from "./use-assistant-conversation-runtime";
import { useAssistantPageActions } from "./use-assistant-page-actions";
import { FeedbackToast } from "@/components/ui/feedback-toast";
import { Button } from "@/components/ui/button";

const SETTINGS_EXIT_DURATION_MS = 220;
const MOBILE_NAVIGATION_MEDIA_QUERY = "(max-width: 760px)";
const EDIT_SESSION_STORAGE_KEY_PREFIX = "frontend-pilot.assistant.edit-session";

function editSessionStorageKey(username: string): string {
  return `${EDIT_SESSION_STORAGE_KEY_PREFIX}:${encodeURIComponent(username)}`;
}

function readStoredEditSessionId(username: string): string | null {
  try {
    return window.localStorage.getItem(editSessionStorageKey(username));
  } catch {
    return null;
  }
}

function storeEditSessionId(username: string, sessionId: string | null): void {
  try {
    const key = editSessionStorageKey(username);
    if (sessionId) window.localStorage.setItem(key, sessionId);
    else window.localStorage.removeItem(key);
  } catch {
    // The server-side session remains the source of truth when storage is unavailable.
  }
}

type AssistantPageProps = {
  inspectionAccess?: boolean;
  renderReviewWorkbenchPage?: () => ReactNode;
  renderClaudeCliPage?: () => ReactNode;
  renderInspectionWorkbenchPage?: () => ReactNode;
  renderReviewToolsPage?: () => ReactNode;
  renderGitLabWorkbenchPage?: () => ReactNode;
  renderJiraWorkbenchPage?: () => ReactNode;
  renderReviewSettingsPage?: () => ReactNode;
  renderReviewHistoryPage?: (focusReviewId?: string, onFocusChange?: (id: string | null) => void) => ReactNode;
  renderReviewRulesPage?: () => ReactNode;
  renderFeedbackPage?: () => ReactNode;
  renderFeedbackAdminPage?: () => ReactNode;
  renderUserManagementPage?: () => ReactNode;
  renderUserActivityPage?: () => ReactNode;
  onReviewTaskChanged?: () => void | Promise<void>;
  reviewJobs: ReviewJob[];
  sessionReady: boolean;
  sessionLoading: boolean;
  isAdmin: boolean;
  username: string | null;
  loggingOut: boolean;
  onLogout: () => void;
  claudeConfigured: boolean | null;
  externalError?: string | null;
  externalNotice?: string | null;
};

type AssistantLaunchState = {
  assistantLaunch?: {
    focusContext?: unknown;
    prompt?: unknown;
  };
};

function useTransientMessage(message: string | null) {
  const [visibleMessage, setVisibleMessage] = useState<string | null>(message);
  useEffect(() => {
    setVisibleMessage(message);
    if (!message) return;
    const timer = window.setTimeout(() => setVisibleMessage(null), 3_500);
    return () => window.clearTimeout(timer);
  }, [message]);
  return { message: visibleMessage, dismiss: () => setVisibleMessage(null) };
}

function useCurrentAssistantNavigation(): AssistantNavigationState | null {
  const modelsMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS.models, end: true });
  const claudeCliMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS["claude-cli"], end: true });
  const reviewWorkbenchMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS["review-workbench"], end: true });
  const inspectionConfigMatch = useMatch({ path: INSPECTION_CONFIG_ROUTE, end: true });
  const inspectionWorkbenchMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS["inspection-workbench"], end: true });
  const reviewToolsMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS["review-tools"], end: true });
  const gitlabWorkbenchMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS["gitlab-workbench"], end: true });
  const jiraWorkbenchMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS["jira-workbench"], end: true });
  const reviewSettingsMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS["review-settings"], end: true });
  const reviewHistoryMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS.runs, end: true });
  const reviewHistoryDetailMatch = useMatch({ path: `${ASSISTANT_ROUTE_PATHS.runs}/:reviewId`, end: true });
  const gitlabMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS.gitlab, end: true });
  const jiraMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS.jira, end: true });
  const rulesMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS.rules, end: true });
  const feedbackMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS.feedback, end: true });
  const feedbackAdminMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS["feedback-admin"], end: true });
  const usersMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS.users, end: true });
  const userActivityMatch = useMatch({ path: ASSISTANT_ROUTE_PATHS["user-activity"], end: true });

  if (modelsMatch) return { activeItem: "models", reviewHistoryFocusId: null };
  if (claudeCliMatch) return { activeItem: "claude-cli", reviewHistoryFocusId: null };
  if (reviewWorkbenchMatch) return { activeItem: "review-workbench", reviewHistoryFocusId: null };
  if (inspectionConfigMatch || inspectionWorkbenchMatch) return { activeItem: "inspection-workbench", reviewHistoryFocusId: null };
  if (reviewToolsMatch) return { activeItem: "review-tools", reviewHistoryFocusId: null };
  if (gitlabWorkbenchMatch) return { activeItem: "gitlab-workbench", reviewHistoryFocusId: null };
  if (jiraWorkbenchMatch) return { activeItem: "jira-workbench", reviewHistoryFocusId: null };
  if (reviewSettingsMatch) return { activeItem: "review-settings", reviewHistoryFocusId: null };
  if (reviewHistoryDetailMatch) return { activeItem: "runs", reviewHistoryFocusId: reviewHistoryDetailMatch.params.reviewId ?? null };
  if (reviewHistoryMatch) return { activeItem: "runs", reviewHistoryFocusId: null };
  if (gitlabMatch) return { activeItem: "gitlab", reviewHistoryFocusId: null };
  if (jiraMatch) return { activeItem: "jira", reviewHistoryFocusId: null };
  if (rulesMatch) return { activeItem: "rules", reviewHistoryFocusId: null };
  if (feedbackMatch) return { activeItem: "feedback", reviewHistoryFocusId: null };
  if (feedbackAdminMatch) return { activeItem: "feedback-admin", reviewHistoryFocusId: null };
  if (usersMatch) return { activeItem: "users", reviewHistoryFocusId: null };
  if (userActivityMatch) return { activeItem: "user-activity", reviewHistoryFocusId: null };
  return null;
}

function isMobileNavigationViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_NAVIGATION_MEDIA_QUERY).matches;
}

export function AssistantPage({
  inspectionAccess = false,
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
  onReviewTaskChanged,
  reviewJobs,
  sessionReady,
  sessionLoading,
  isAdmin,
  username,
  loggingOut,
  onLogout,
  claudeConfigured,
  externalError,
  externalNotice,
}: AssistantPageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentNavigation = useCurrentAssistantNavigation();
  const legacyNavigation = useMemo(() => readLegacyAssistantNavigationState(location.search), [location.search]);
  const activeNavigation = currentNavigation ?? legacyNavigation;
  const modelSettingsOpen = Boolean(activeNavigation);
  const activeSettingsItem = activeNavigation?.activeItem ?? "models";
  const reviewHistoryFocusId = activeNavigation?.reviewHistoryFocusId ?? null;
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeConversationId, setActiveConversationId] = useState("new-conversation");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [focusContext, setFocusContext] = useState<AssistantFocusContext | undefined>();
  const [editSession, setEditSession] = useState<AssistantEditSession | null>(null);
  const [editSessionHydrated, setEditSessionHydrated] = useState(false);
  const [editPanelOpen, setEditPanelOpen] = useState(false);
  const [navigationMenuOpen, setNavigationMenuOpen] = useState(false);
  const [settingsLayerClosing, setSettingsLayerClosing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const settingsCloseTimerRef = useRef<number | null>(null);
  const shouldFollowChatRef = useRef(true);
  const editSessionTouchedRef = useRef(false);
  const lastTrackedActivityPathRef = useRef<string | null>(null);
  const showRuntimeNotice = useCallback((message: string) => setNotice(message), []);
  const handleEditOperationApplied = useCallback((operation: AssistantEditOperation) => {
    setEditSession((current) => {
      if (!current || current.id !== operation.sessionId) return current;
      const operations = mergeAssistantEditOperations(current.operations, operation);
      const pendingOperationCount = operations.filter((item) => item.status === "pending").length;
      return {
        ...current,
        status: pendingOperationCount > 0 ? "approval_pending" : "active",
        operations,
        pendingOperationCount,
      };
    });
    void getAssistantEditSession(operation.sessionId)
      .then(({ session }) => setEditSession((current) => current?.id === session.id ? session : current))
      .catch(() => undefined);
  }, []);

  const handleEditSessionChange = useCallback((session: AssistantEditSession | null) => {
    editSessionTouchedRef.current = true;
    setEditSession(session);
    if (username) storeEditSessionId(username, session?.id ?? null);
  }, [username]);

  useEffect(() => {
    if (!sessionReady || !username || editSessionHydrated) return;
    let active = true;
    const storedSessionId = readStoredEditSessionId(username);
    void listAssistantEditSessions()
      .then(({ sessions }) => {
        if (!active || editSessionTouchedRef.current) return;
        const storedSession = storedSessionId ? sessions.find((session) => session.id === storedSessionId) : undefined;
        const nextSession = storedSession ?? sessions[0] ?? null;
        setEditSession((current) => current ?? nextSession);
        if (nextSession) storeEditSessionId(username, nextSession.id);
        else if (storedSessionId) storeEditSessionId(username, null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setEditSessionHydrated(true);
      });
    return () => {
      active = false;
    };
  }, [editSessionHydrated, sessionReady, username]);
  const runtime = useAssistantConversationRuntime({
    conversations,
    setConversations,
    activeConversationId,
    sessionReady,
    focusContext,
    editSessionId: editSession?.id,
    onEditOperationProposed: handleEditOperationApplied,
    onReviewTaskChanged,
    setNotice: showRuntimeNotice,
  });
  const actions = useAssistantPageActions({
    conversations,
    setConversations,
    activeConversation: runtime.activeConversation,
    draft,
    setDraft,
    sessionReady,
    sessionLoading,
    runtime,
    setActiveConversationId,
    setSidebarOpen,
    setNotice,
    setShowScrollToLatest,
    shouldFollowChatRef,
  });
  const [feedbackErrorToast, externalErrorToast, externalNoticeToast, noticeToast] = [
    useTransientMessage(feedbackError),
    useTransientMessage(externalError ?? null),
    useTransientMessage(externalNotice ?? null),
    useTransientMessage(notice),
  ];
  const visibleConversations = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? conversations.filter((conversation) => conversation.title.toLowerCase().includes(normalized)) : conversations;
  }, [conversations, query]);

  const showNotice = useCallback((message: string) => {
    setFeedbackError(null);
    setNotice(message);
  }, []);

  const showError = useCallback((message: string | null) => {
    setFeedbackError(message);
    if (message) setNotice(null);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const scroll = chatScrollRef.current;
      if (scroll && shouldFollowChatRef.current) scroll.scrollTop = scroll.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversationId, runtime.activeMessageSignature, runtime.sending]);

  const handleChatScroll = useCallback(() => {
    const scroll = chatScrollRef.current;
    if (!scroll) return;
    const atLatest = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 48;
    shouldFollowChatRef.current = atLatest;
    setShowScrollToLatest((current) => (current === !atLatest ? current : !atLatest));
  }, []);

  const scrollToLatest = useCallback(() => {
    const scroll = chatScrollRef.current;
    shouldFollowChatRef.current = true;
    setShowScrollToLatest(false);
    scroll?.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (currentNavigation || !legacyNavigation) return;
    navigate(assistantPathForNavigation(legacyNavigation), { replace: true });
  }, [currentNavigation, legacyNavigation, navigate]);

  useEffect(() => {
    if (location.pathname !== ASSISTANT_HOME_PATH || !location.state || typeof location.state !== "object") return;
    const launch = (location.state as AssistantLaunchState).assistantLaunch;
    if (!launch) return;
    const parsedContext = AssistantFocusContextSchema.safeParse(launch.focusContext);
    if (!parsedContext.success || typeof launch.prompt !== "string" || !launch.prompt.trim()) return;
    setFocusContext(parsedContext.data);
    setDraft(launch.prompt);
    navigate(ASSISTANT_HOME_PATH, { replace: true, state: null });
  }, [location.key, location.pathname, location.state, navigate]);

  useEffect(() => {
    if (isMobileNavigationViewport()) setNavigationMenuOpen(false);
  }, [activeNavigation, location.key]);

  useEffect(() => {
    if (activeNavigation) setSettingsLayerClosing(false);
  }, [location.pathname, location.search]);

  useEffect(() => () => {
    if (settingsCloseTimerRef.current !== null) window.clearTimeout(settingsCloseTimerRef.current);
  }, []);

  const toggleNavigationMenu = useCallback(() => {
    setNavigationMenuOpen((open) => !open);
  }, []);

  const closeNavigationMenuAfterNavigation = useCallback(() => {
    if (isMobileNavigationViewport()) setNavigationMenuOpen(false);
  }, []);

  const selectSettingsItem = useCallback((item: SettingsItem) => {
    closeNavigationMenuAfterNavigation();
    navigate(assistantPathForNavigation({ activeItem: item.id, reviewHistoryFocusId: null }));
  }, [closeNavigationMenuAfterNavigation, navigate]);

  const openReviewToolsPage = useCallback(() => {
    closeNavigationMenuAfterNavigation();
    navigate(assistantPathForNavigation({ activeItem: "review-tools", reviewHistoryFocusId: null }));
  }, [closeNavigationMenuAfterNavigation, navigate]);

  const openReviewRun = useCallback((reviewId: string) => {
    closeNavigationMenuAfterNavigation();
    navigate(assistantPathForNavigation({ activeItem: "runs", reviewHistoryFocusId: reviewId }));
    void onReviewTaskChanged?.();
  }, [closeNavigationMenuAfterNavigation, navigate, onReviewTaskChanged]);

  const updateReviewHistoryFocus = useCallback((reviewId: string | null) => {
    if (activeSettingsItem !== "runs") return;
    navigate(assistantPathForNavigation({ activeItem: "runs", reviewHistoryFocusId: reviewId }), { replace: true });
  }, [activeSettingsItem, navigate]);

  const closeSettings = useCallback(() => {
    if (settingsLayerClosing || settingsCloseTimerRef.current !== null) return;
    setSettingsLayerClosing(true);
    const exitDuration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : SETTINGS_EXIT_DURATION_MS;
    settingsCloseTimerRef.current = window.setTimeout(() => {
      settingsCloseTimerRef.current = null;
      navigate(ASSISTANT_HOME_PATH);
    }, exitDuration);
  }, [navigate, settingsLayerClosing]);

  const copyMessage = useCallback(async (message: ChatMessage) => {
    if (!message.text) return;
    try {
      await navigator.clipboard.writeText(message.text);
      setNotice("回复已复制");
    } catch {
      setNotice("复制失败，请手动选择文本");
    }
  }, []);

  const connectionLabel = sessionLoading ? "正在连接服务" : !sessionReady ? "服务未就绪" : runtime.sending ? "正在生成" : runtime.conversationSyncing || !runtime.conversationsHydrated ? "正在同步会话" : claudeConfigured === false ? "助手未配置" : "服务已就绪";
  const canSend = sessionReady && !runtime.sending && !actions.messageActionBusy;
  const showWelcome = !(runtime.activeConversation?.messages.some((message) => message.role === "user") ?? false);
  const pendingDeletion = actions.pendingDeletion;
  const deletionDialogTitle = pendingDeletion?.kind === "message" ? "删除这条消息" : pendingDeletion?.title ?? "删除会话";
  const deletionDialogDescription = pendingDeletion?.kind === "message"
    ? "这条消息删除后不可恢复；如果是用户消息，对应的助手回复也会一并删除。"
    : "会话中的消息、运行记录和过程事件都会被删除，删除后不可恢复。";

  useEffect(() => {
    if (!sessionReady || lastTrackedActivityPathRef.current === location.pathname) return;
    lastTrackedActivityPathRef.current = location.pathname;
    void trackUserActivity(location.pathname).catch(() => undefined);
  }, [location.pathname, sessionReady]);

  return (
    <div className={`assistant-app-shell ${navigationMenuOpen ? "is-navigation-open" : ""}`}>
      <AssistantSidebar
        conversations={conversations}
        activeConversationId={runtime.activeConversation?.id}
        visibleConversations={visibleConversations}
        query={query}
        selectionMode={actions.selectionMode}
        selectedConversationIds={actions.selectedConversationIds}
        sidebarOpen={sidebarOpen}
        onQueryChange={setQuery}
        onSelectConversation={(conversationId) => { shouldFollowChatRef.current = true; setShowScrollToLatest(false); setActiveConversationId(conversationId); setSidebarOpen(false); }}
        onToggleSelection={actions.toggleConversationSelection}
        onToggleSelectionMode={actions.toggleSelectionMode}
        onDeleteConversation={actions.deleteConversation}
        onDeleteSelected={actions.deleteConversations}
        conversationDeleteBusy={actions.conversationDeleteBusy}
        onNewConversation={actions.startNewConversation}
      />
      {sidebarOpen && <Button variant="ghost" className="assistant-sidebar-backdrop" type="button" aria-label="关闭会话列表" onClick={() => setSidebarOpen(false)} />}
      <AssistantChatView
        activeConversation={runtime.activeConversation}
        showWelcome={showWelcome}
        canSend={canSend}
        sending={runtime.sending}
        draft={draft}
        assistantStatus={runtime.assistantStatus}
        showScrollToLatest={showScrollToLatest}
        chatScrollRef={chatScrollRef}
        onScroll={handleChatScroll}
        onScrollToLatest={scrollToLatest}
        onDraftChange={setDraft}
        focusContext={focusContext}
        onClearFocusContext={() => setFocusContext(undefined)}
        onSend={actions.sendMessage}
        onStop={actions.stopGeneration}
        onOpenReviewTools={openReviewToolsPage}
        onOpenReviewRun={openReviewRun}
        reviewJobs={reviewJobs}
        onCopy={(message) => void copyMessage(message)}
        onRetry={actions.retryMessage}
        onEdit={actions.editMessage}
        onDelete={actions.deleteMessage}
        onCancelEdit={actions.cancelEdit}
        editingMessageId={actions.editingMessageId}
        messageActionBusy={actions.messageActionBusy}
        messageActionStatus={actions.messageActionStatus}
        onNewConversation={actions.startNewConversation}
        onOpenSidebar={() => setSidebarOpen(true)}
        navigationMenuOpen={navigationMenuOpen}
        onOpenNavigationMenu={toggleNavigationMenu}
        editSession={editSession}
        editPanelOpen={editPanelOpen}
        onToggleEditPanel={() => setEditPanelOpen((open) => !open)}
        onEditSessionChange={handleEditSessionChange}
        onNotice={setNotice}
      />
      <AssistantDeleteDialog
        open={Boolean(pendingDeletion)}
        title={deletionDialogTitle}
        description={deletionDialogDescription}
        busy={actions.conversationDeleteBusy || actions.messageActionBusy}
        onCancel={actions.cancelDeletion}
        onConfirm={actions.confirmDeletion}
      />
      {(externalErrorToast.message || externalNoticeToast.message || feedbackErrorToast.message || noticeToast.message) && (
        <div className="feedback-toast-stack">
          {externalErrorToast.message && <FeedbackToast title="操作失败" message={externalErrorToast.message} variant="error" onDismiss={externalErrorToast.dismiss} />}
          {feedbackErrorToast.message && <FeedbackToast title="操作失败" message={feedbackErrorToast.message} variant="error" onDismiss={() => { feedbackErrorToast.dismiss(); setFeedbackError(null); }} />}
          {externalNoticeToast.message && <FeedbackToast title="操作完成" message={externalNoticeToast.message} variant="success" onDismiss={externalNoticeToast.dismiss} />}
          {noticeToast.message && <FeedbackToast title="操作完成" message={noticeToast.message} variant="success" onDismiss={() => { noticeToast.dismiss(); setNotice(null); }} />}
        </div>
      )}
      {modelSettingsOpen && (
        <AssistantSettingsLayer
          activeItem={activeSettingsItem}
          sessionReady={sessionReady}
          isAdmin={isAdmin}
          onClose={closeSettings}
          isClosing={settingsLayerClosing}
          onNotice={showNotice}
          onError={showError}
          renderReviewWorkbenchPage={renderReviewWorkbenchPage}
          renderClaudeCliPage={renderClaudeCliPage}
          renderInspectionWorkbenchPage={renderInspectionWorkbenchPage}
          renderReviewToolsPage={renderReviewToolsPage}
          renderGitLabWorkbenchPage={renderGitLabWorkbenchPage}
          renderJiraWorkbenchPage={renderJiraWorkbenchPage}
          renderReviewSettingsPage={renderReviewSettingsPage}
          renderReviewHistoryPage={renderReviewHistoryPage ? () => renderReviewHistoryPage(reviewHistoryFocusId ?? undefined, updateReviewHistoryFocus) : undefined}
          renderReviewRulesPage={renderReviewRulesPage}
          renderFeedbackPage={renderFeedbackPage}
          renderFeedbackAdminPage={renderFeedbackAdminPage}
          renderUserManagementPage={renderUserManagementPage}
          renderUserActivityPage={renderUserActivityPage}
        />
      )}
      <AssistantNavigationDrawer
        inspectionAccess={inspectionAccess}
        open={navigationMenuOpen}
        activeItem={modelSettingsOpen ? activeSettingsItem : undefined}
        isAdmin={isAdmin}
        username={username}
        loggingOut={loggingOut}
        onClose={() => setNavigationMenuOpen(false)}
        onSelectItem={selectSettingsItem}
        onLogout={onLogout}
      />
      <span className="sr-only" aria-live="polite">{connectionLabel}</span>
    </div>
  );
}
