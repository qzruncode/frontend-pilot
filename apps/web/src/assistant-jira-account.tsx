import { useIntegrationApi } from "./integration-api-context";
import { useCallback, useEffect, useId, useState } from "react";
import { CircleCheck, CircleX, Eye, EyeOff, LoaderCircle, LogOut, RefreshCw, Save } from "lucide-react";
import {
  ApiError,
  type JiraCredentialInput,
} from "./api";
import type { FeedbackHandlers } from "./assistant-settings";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IntegrationAccountCard } from "./integration-account-card";

type JiraTestState = {
  status: "idle" | "testing" | "success" | "error";
  message?: string;
  userName?: string;
  latencyMs?: number;
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "当前产品会话没有权限，请刷新页面后重试。";
    if (error.status === 400) return typeof error.details === "string" ? error.details : "请填写 Jira 用户名和密码。";
    if (error.status === 502) return typeof error.details === "string" ? error.details : "Jira 连接失败，请检查账号和密码。";
    return typeof error.details === "string" ? error.details : error.message;
  }
  return error instanceof Error ? error.message : "Jira 连接失败";
}

type JiraAccountPanelProps = { inspection?: boolean; sessionReady: boolean; productUsername: string | null; onSaved?: () => void | Promise<void> } & FeedbackHandlers;

export function JiraAccountPanel({ inspection = false, sessionReady, productUsername, onSaved, onNotice, onError }: JiraAccountPanelProps) {
  const { disconnectJiraAccount, getJiraAccount, saveJiraAccount, testJiraAccount } = useIntegrationApi();
  const [credentials, setCredentials] = useState<JiraCredentialInput>({ username: "", token: "" });
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testState, setTestState] = useState<JiraTestState>({ status: "idle" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const fieldId = useId();

  const loadAccount = useCallback(() => {
    if (!sessionReady) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    void getJiraAccount()
      .then((next) => {
        setCredentials({ username: next.username, token: "" });
        setTokenConfigured(next.tokenConfigured);
        setTokenVisible(false);
        setTestState({ status: "idle" });
        onError(null);
      })
      .catch((error) => { const message = errorMessage(error); setLoadError(message); onError(message); })
      .finally(() => setLoading(false));
  }, [getJiraAccount, onError, sessionReady]);

  useEffect(() => loadAccount(), [loadAccount]);

  const updateCredentials = (patch: Partial<JiraCredentialInput>) => {
    setCredentials((current) => ({ ...current, ...patch }));
    setTestState({ status: "idle" });
    onError(null);
  };

  const input = (): JiraCredentialInput => ({
    username: credentials.username.trim(),
    ...(credentials.token?.trim() ? { token: credentials.token.trim() } : {}),
  });

  const validate = (): boolean => {
    if (!credentials.username.trim()) {
      setTestState({ status: "error", message: "请填写 Jira 用户名或邮箱。" });
      onError("请填写 Jira 用户名或邮箱。");
      return false;
    }
    if (!credentials.token?.trim() && !tokenConfigured) {
      setTestState({ status: "error", message: "请填写 Jira 密码或访问 Token。" });
      onError("请填写 Jira 密码或访问 Token。");
      return false;
    }
    if (!sessionReady) {
      onError("页面会话尚未建立，请稍后再试。");
      return false;
    }
    return true;
  };

  const connectAccount = async () => {
    if (!validate()) return;
    const payload = input();
    setSaving(true);
    setTestState({ status: "testing" });
    try {
      const result = await testJiraAccount(payload);
      setTestState({ status: "success", message: result.message, userName: result.userName, latencyMs: result.latencyMs });
      const next = await saveJiraAccount(payload);
      setCredentials({ username: next.username, token: "" });
      setTokenConfigured(next.tokenConfigured);
      setTokenVisible(false);
      await onSaved?.();
      onNotice(inspection ? "巡检 Jira 账号已连接并保存。" : "Jira 账号已连接并保存，工作台已刷新。");
    } catch (error) {
      const message = errorMessage(error);
      setTestState({ status: "error", message });
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      const next = await disconnectJiraAccount();
      setCredentials({ username: next.username, token: "" });
      setTokenConfigured(next.tokenConfigured);
      setTokenVisible(false);
      setTestState({ status: "idle" });
      await onSaved?.();
      onNotice("你的 Jira 账号已退出。");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDisconnecting(false);
    }
  };

  const statusLabel = tokenConfigured ? "已配置" : "未连接";
  const busy = loading || saving || disconnecting;

  return (
    <IntegrationAccountCard service="Jira" description={inspection ? "将巡检问题同步为 Jira 任务" : `为 ${productUsername || "当前用户"} 连接 Jira`} status={loading ? "检查中" : loadError ? "读取失败" : statusLabel} tone={loadError ? "unavailable" : tokenConfigured ? "connected" : "neutral"}>
      {loading ? <div className="gitlab-oauth-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取账号状态…</div> : loadError ? <div className="integration-account-message is-error" role="alert"><CircleX aria-hidden="true" /><span>{loadError}</span><Button variant="outline" size="sm" onClick={loadAccount}><RefreshCw aria-hidden="true" />重试</Button></div> : <form className="integration-account-form" onSubmit={(event) => { event.preventDefault(); void connectAccount(); }}>
        <div className="auth-field">
          <Label htmlFor={`${fieldId}-username`}>Jira 用户名 / 邮箱</Label>
          <Input id={`${fieldId}-username`} value={credentials.username} onChange={(event) => updateCredentials({ username: event.target.value })} placeholder="输入 Jira 用户名或邮箱" autoComplete="section-jira username" disabled={busy} />
        </div>
        <div className="auth-field">
          <Label htmlFor={`${fieldId}-token`}>密码 / 访问 Token</Label>
          <div className="auth-password-field"><Input id={`${fieldId}-token`} type={tokenVisible ? "text" : "password"} value={credentials.token ?? ""} onChange={(event) => updateCredentials({ token: event.target.value })} placeholder={tokenConfigured ? "留空保留当前凭据" : "输入 Jira 密码或 Token"} autoComplete="section-jira current-password" spellCheck={false} disabled={busy} /><Button variant="ghost" size="icon" type="button" className="auth-password-toggle" aria-label={tokenVisible ? "隐藏 Jira 密码" : "显示 Jira 密码"} aria-pressed={tokenVisible} disabled={busy} onClick={() => setTokenVisible((visible) => !visible)}>{tokenVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</Button></div>
          <small>{tokenConfigured ? "凭据已保存，留空即可保留。" : "支持 Jira 密码或访问 Token。"}</small>
        </div>
        <div className="integration-account-form-actions">
          <Button type="submit" disabled={busy}>{saving ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Save aria-hidden="true" />}{saving ? "正在连接…" : "登录并保存"}</Button>
          {tokenConfigured && <Button variant="ghost" type="button" onClick={() => void disconnect()} disabled={busy}>{disconnecting ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <LogOut aria-hidden="true" />}退出账号</Button>}
        </div>
        {testState.status !== "idle" && <div className={`jira-settings-test-result jira-settings-test-result-${testState.status}`} role={testState.status === "error" ? "alert" : "status"}>{testState.status === "testing" && <LoaderCircle aria-hidden="true" className="is-spinning" />}{testState.status === "success" && <CircleCheck aria-hidden="true" />}{testState.status === "error" && <CircleX aria-hidden="true" />}<span>{testState.status === "testing" ? "正在读取 Jira 当前用户…" : testState.message}</span>{testState.latencyMs !== undefined && <small>{testState.userName} · {testState.latencyMs}ms</small>}</div>}
      </form>}
    </IntegrationAccountCard>
  );
}

const DRAWER_EXIT_DURATION_MS = 220;

export function JiraAccountDrawer({ inspection = false, open, sessionReady, productUsername, onClose, onSaved, onNotice, onError }: { inspection?: boolean; open: boolean; sessionReady: boolean; productUsername: string | null; onClose: () => void; onSaved?: () => void | Promise<void> } & FeedbackHandlers) {
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
  return <ReviewDrawerShell size="compact" eyebrow={inspection ? "巡检工作台" : "Jira 工作台"} title="连接设置" titleId="jira-account-drawer-title" closeLabel="关闭 Jira 连接设置" isClosing={isClosing} onRequestClose={requestClose} contentClassName="jira-connection-drawer-content"><JiraAccountPanel inspection={inspection} sessionReady={sessionReady} productUsername={productUsername} onSaved={onSaved} onNotice={onNotice} onError={onError} /></ReviewDrawerShell>;
}
