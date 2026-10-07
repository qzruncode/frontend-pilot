import { useIntegrationApi } from "./integration-api-context";
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, LogIn, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { ApiError, type GitLabOAuthStatus } from "./api";
import type { FeedbackHandlers } from "./assistant-settings";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { Button } from "@/components/ui/button";
import { IntegrationAccountCard } from "./integration-account-card";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return typeof error.details === "string" ? error.details : error.message;
  }
  return error instanceof Error ? error.message : "无法读取 GitLab 登录状态";
}

function initials(name: string, username: string): string {
  const value = name.trim() || username.trim() || "G";
  return value.slice(0, 2).toUpperCase();
}

function connectionStatus(status: GitLabOAuthStatus | null): { label: string; tone: "connected" | "unavailable" | "neutral" } {
  if (status?.connected) return { label: "已连接", tone: "connected" };
  if (status && !status.configured) return { label: "暂不可用", tone: "unavailable" };
  return { label: "未连接", tone: "neutral" };
}

type GitLabOAuthPanelProps = {
  inspection?: boolean;
  sessionReady: boolean;
  returnTo?: string;
  hideWhenConnected?: boolean;
  onStatusChange?: (status: GitLabOAuthStatus) => void;
} & FeedbackHandlers;

export function GitLabOAuthPanel({ inspection = false, sessionReady, returnTo, hideWhenConnected = false, onStatusChange, onNotice, onError }: GitLabOAuthPanelProps) {
  const { disconnectGitLabOAuth, getGitLabOAuthStatus, startGitLabOAuth } = useIntegrationApi();
  const [status, setStatus] = useState<GitLabOAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"login" | "logout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onStatusChangeRef = useRef(onStatusChange);
  const onNoticeRef = useRef(onNotice);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
    onNoticeRef.current = onNotice;
    onErrorRef.current = onError;
  }, [onError, onNotice, onStatusChange]);

  const loadStatus = useCallback(() => {
    if (!sessionReady) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void getGitLabOAuthStatus()
      .then((next) => {
        setStatus(next);
        onStatusChangeRef.current?.(next);
        onErrorRef.current(null);
      })
      .catch((error) => { const message = errorMessage(error); setError(message); onErrorRef.current(message); })
      .finally(() => setLoading(false));
  }, [getGitLabOAuthStatus, sessionReady]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const connect = () => {
    setBusy("login");
    startGitLabOAuth(returnTo);
  };

  const disconnect = async () => {
    setBusy("logout");
    try {
      const next = await disconnectGitLabOAuth();
      setStatus(next);
      onStatusChangeRef.current?.(next);
      onNoticeRef.current("GitLab 账号已退出，工作台需要重新连接账号");
    } catch (error) {
      onErrorRef.current(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const identity = status?.identity;
  const connection = connectionStatus(status);

  if (!loading && !error && hideWhenConnected && status?.connected) return null;

  return (
    <IntegrationAccountCard service="GitLab" description={inspection ? "读取项目与代码，执行巡检" : "使用你的 GitLab 权限访问项目"} status={loading ? "检查中" : error ? "读取失败" : connection.label} tone={error ? "unavailable" : connection.tone}>
      {loading ? (
        <div className="gitlab-oauth-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>正在读取账号状态…</span></div>
      ) : error ? (
        <div className="integration-account-message is-error" role="alert"><CircleAlert aria-hidden="true" /><span>{error}</span><Button variant="outline" size="sm" onClick={loadStatus}><RefreshCw aria-hidden="true" />重试</Button></div>
      ) : !status?.configured ? (
        <div className="gitlab-oauth-not-configured" role="status">
          <CircleAlert aria-hidden="true" />
          <div><strong>GitLab 登录尚未开放</strong><span>请联系管理员完成 GitLab 授权配置，然后重新检查。</span></div>
          <Button variant="outline" size="sm" type="button" onClick={loadStatus} disabled={loading}>
            {loading ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}重新检查
          </Button>
        </div>
      ) : status.connected && identity ? (
        <div className="gitlab-oauth-connected">
          <div className="gitlab-oauth-account">
            <span className="gitlab-oauth-avatar" aria-hidden="true">{initials(identity.name, identity.username)}</span>
            <span><strong>{identity.name}</strong><small>@{identity.username}</small></span>
          </div>
          <div className="gitlab-oauth-actions">
            <Button variant="outline" type="button" onClick={connect} disabled={busy !== null}>
              {busy === "login" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}切换账号
            </Button>
            <Button variant="ghost" type="button" onClick={() => void disconnect()} disabled={busy !== null}>
              {busy === "logout" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <LogOut aria-hidden="true" />}退出
            </Button>
          </div>
        </div>
      ) : (
        <div className="gitlab-oauth-login">
          <div><ShieldCheck aria-hidden="true" /><span>{inspection ? "连接维护人员的 GitLab 账号，选择可访问的项目并开始代码巡检。" : "连接后，工作台将按照你的账号展示项目、指派和审查请求。"}</span></div>
          <Button type="button" onClick={connect} disabled={!sessionReady || busy !== null}>
            {busy === "login" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <LogIn aria-hidden="true" />}使用 GitLab 登录
          </Button>
        </div>
      )}

    </IntegrationAccountCard>
  );
}

const DRAWER_EXIT_DURATION_MS = 220;

export function GitLabOAuthDrawer({ inspection = false, open, sessionReady, onClose, onStatusChange, onNotice, onError }: { inspection?: boolean; open: boolean; sessionReady: boolean; onClose: () => void; onStatusChange?: (status: GitLabOAuthStatus) => void } & FeedbackHandlers) {
  const [rendered, setRendered] = useState(open);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setIsClosing(false);
    } else if (rendered && !isClosing) {
      setIsClosing(true);
    }
  }, [isClosing, open, rendered]);

  useEffect(() => {
    if (!isClosing) return;
    const timer = window.setTimeout(() => setRendered(false), DRAWER_EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [isClosing]);

  const requestClose = useCallback(() => {
    if (isClosing) return;
    onClose();
    setIsClosing(true);
  }, [isClosing, onClose]);

  if (!rendered) return null;
  return (
    <ReviewDrawerShell
      size="compact"
      eyebrow={inspection ? "巡检工作台" : "GitLab 工作台"}
      title="连接设置"
      titleId="gitlab-oauth-drawer-title"
      closeLabel="关闭 GitLab 连接设置"
      isClosing={isClosing}
      onRequestClose={requestClose}
      contentClassName="gitlab-oauth-drawer-content"
    >
      <GitLabOAuthPanel inspection={inspection} sessionReady={sessionReady} onStatusChange={onStatusChange} onNotice={onNotice} onError={onError} />
    </ReviewDrawerShell>
  );
}
