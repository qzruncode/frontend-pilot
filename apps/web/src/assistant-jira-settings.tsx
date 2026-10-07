import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleX, Lock, LoaderCircle, Play, Save, Unlock } from "lucide-react";
import {
  ApiError,
  getJiraConnection,
  revealJiraConnectionToken,
  saveJiraConnection,
  testJiraConnection,
  type JiraConnectionInput,
} from "./api";
import { AdminPermissionTooltip } from "./admin-permission-tooltip";
import { DEFAULT_JIRA_CONNECTION, type FeedbackHandlers } from "./assistant-settings";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type JiraTestState = {
  status: "idle" | "testing" | "success" | "error";
  message?: string;
  userName?: string;
  latencyMs?: number;
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "当前会话没有权限，请刷新页面后重试。";
    if (error.status === 502) return typeof error.details === "string" ? error.details : "Jira 连接失败，请检查地址和凭据。";
    return typeof error.details === "string" ? error.details : error.message;
  }
  return error instanceof Error ? error.message : "Jira 连接失败";
}

type JiraConnectionPanelProps = { sessionReady: boolean; isAdmin: boolean; onSaved?: () => void } & FeedbackHandlers;

export function JiraConnectionPanel({ sessionReady, isAdmin, onSaved, onNotice, onError }: JiraConnectionPanelProps) {
  const [connection, setConnection] = useState<JiraConnectionInput>(DEFAULT_JIRA_CONNECTION);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revealingToken, setRevealingToken] = useState(false);
  const [testState, setTestState] = useState<JiraTestState>({ status: "idle" });

  useEffect(() => {
    if (!sessionReady) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void getJiraConnection()
      .then((next) => {
        if (!active) return;
        setConnection({ ...next, token: "" });
        setTokenConfigured(next.tokenConfigured);
        setTokenVisible(false);
        onError(null);
      })
      .catch((error) => {
        if (active) onError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onError, sessionReady]);

  const updateConnection = (patch: Partial<JiraConnectionInput>) => {
    setConnection((current) => ({ ...current, ...patch }));
    onError(null);
    setTestState({ status: "idle" });
  };

  const input = (): JiraConnectionInput => ({
    baseUrl: connection.baseUrl.trim(),
    apiBaseUrl: connection.apiBaseUrl.trim(),
    projectKey: connection.projectKey.trim().toUpperCase(),
    username: connection.username.trim(),
    ...(connection.token?.trim() ? { token: connection.token.trim() } : {}),
  });

  const validate = (): boolean => {
    if (!connection.baseUrl.trim() || !connection.apiBaseUrl.trim() || !connection.projectKey.trim()) {
      onError("请填写 Jira 地址、API 地址和项目 Key");
      return false;
    }
    if (!connection.username.trim() && !connection.token?.trim() && !tokenConfigured) {
      onError("请填写 Jira 用户名，或直接填写 REST Token");
      return false;
    }
    if (!sessionReady) {
      onError("页面会话尚未建立，请稍后再试");
      return false;
    }
    return true;
  };

  const saveConnection = async () => {
    if (!isAdmin) {
      onError("只有管理员可以保存 Jira 服务配置。");
      return;
    }
    if (!validate()) return;
    setSaving(true);
    try {
      const next = await saveJiraConnection(input());
      setConnection({ ...next, token: "" });
      setTokenConfigured(next.tokenConfigured);
      setTokenVisible(false);
      onSaved?.();
      onNotice("Jira 连接配置已保存，并已应用到当前服务");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (!validate()) return;
    setTestState({ status: "testing" });
    try {
      const result = await testJiraConnection(input());
      setTestState({ status: "success", message: result.message, userName: result.userName, latencyMs: result.latencyMs });
      onNotice(`${result.message}${result.latencyMs !== undefined ? ` · ${result.latencyMs}ms` : ""}`);
    } catch (error) {
      const message = errorMessage(error);
      setTestState({ status: "error", message });
      onError(message);
    }
  };

  const toggleTokenVisibility = async () => {
    if (tokenVisible) {
      setTokenVisible(false);
      return;
    }
    if (connection.token?.trim() || !tokenConfigured) {
      setTokenVisible(true);
      return;
    }
    if (!isAdmin) {
      onError("只有管理员可以显示已保存的 Jira 凭据。");
      return;
    }
    setRevealingToken(true);
    try {
      const result = await revealJiraConnectionToken();
      setConnection((current) => ({ ...current, token: result.token }));
      setTokenVisible(true);
      onError(null);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setRevealingToken(false);
    }
  };

  return (
    <section className="jira-settings-panel" aria-label="Jira 连接配置">
      <div className="jira-settings-card">
        <div className="jira-settings-heading"><div><h2>连接公司的 Jira</h2><p>工作台会读取当前项目的问题、状态和评论，并通过同一连接发布评论。</p></div><span className={`jira-settings-state jira-settings-state-${tokenConfigured ? "connected" : "empty"}`}>{tokenConfigured ? <CircleCheck aria-hidden="true" /> : <CircleX aria-hidden="true" />}{tokenConfigured ? "凭据已配置" : "等待配置"}</span></div>
        <div className="jira-settings-grid">
          <label className="jira-settings-field jira-settings-field-wide"><span>Jira 地址</span><Input type="url" value={connection.baseUrl} onChange={(event) => updateConnection({ baseUrl: event.target.value })} placeholder="https://jira.example.com" /><small>用于打开问题详情的网页地址。</small></label>
          <label className="jira-settings-field jira-settings-field-wide"><span>Jira REST API 地址</span><Input type="url" value={connection.apiBaseUrl} onChange={(event) => updateConnection({ apiBaseUrl: event.target.value })} placeholder="https://jira.example.com/rest/api/2" /><small>Jira Server 通常以 /rest/api/2 结尾。</small></label>
          <label className="jira-settings-field"><span>默认项目 Key</span><Input value={connection.projectKey} onChange={(event) => updateConnection({ projectKey: event.target.value.toUpperCase() })} placeholder="DEMO" autoCapitalize="characters" /><small>列表和概览默认只查询这个项目。</small></label>
          <label className="jira-settings-field"><span>用户名 / 邮箱</span><Input value={connection.username} onChange={(event) => updateConnection({ username: event.target.value })} placeholder="jira-user" autoComplete="username" /></label>
          <label className="jira-settings-field jira-settings-field-wide"><span>访问 Token / 密码 {tokenConfigured && <em>已配置</em>}</span><span className="jira-token-input"><Input type={tokenVisible ? "text" : "password"} value={connection.token ?? ""} onChange={(event) => updateConnection({ token: event.target.value })} placeholder="留空保留当前凭据" autoComplete="new-password" spellCheck={false} className="jira-token-input-field" /><Button variant="ghost" size="icon" type="button" className="jira-token-visibility-toggle" aria-label={tokenVisible ? "隐藏 Jira 凭据" : revealingToken ? "正在读取 Jira 凭据" : "显示 Jira 凭据"} title={tokenVisible ? "隐藏 Jira 凭据" : revealingToken ? "正在读取 Jira 凭据" : "显示 Jira 凭据"} onClick={() => void toggleTokenVisibility()} disabled={revealingToken}>{revealingToken ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : tokenVisible ? <Unlock aria-hidden="true" /> : <Lock aria-hidden="true" />}</Button></span><small>支持 Jira Server 的用户名 + 密码，也可填部署方提供的访问 Token；点击锁可显示已保存凭据。</small></label>
        </div>
        <div className="jira-settings-footer"><AdminPermissionTooltip isAdmin={isAdmin} tooltipId="jira-settings-admin-save-tip"><Button variant="outline" type="button" onClick={() => void saveConnection()} disabled={!isAdmin || loading || saving || testState.status === "testing"}>{saving ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Save aria-hidden="true" />}保存配置</Button></AdminPermissionTooltip><Button type="button" onClick={() => void testConnection()} disabled={loading || saving || testState.status === "testing"}>{testState.status === "testing" ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Play aria-hidden="true" />}测试连接</Button></div>
        {testState.status !== "idle" && <div className={`jira-settings-test-result jira-settings-test-result-${testState.status}`} role={testState.status === "error" ? "alert" : "status"}>{testState.status === "testing" && <LoaderCircle aria-hidden="true" className="is-spinning" />}{testState.status === "success" && <CircleCheck aria-hidden="true" />}{testState.status === "error" && <CircleX aria-hidden="true" />}<span>{testState.status === "testing" ? "正在读取 Jira 当前用户…" : testState.message}</span>{testState.latencyMs !== undefined && <small>{testState.userName} · {testState.latencyMs}ms</small>}</div>}
      </div>
    </section>
  );
}

const DRAWER_EXIT_DURATION_MS = 220;

export function JiraConnectionDrawer({ open, sessionReady, isAdmin, onClose, onSaved, onNotice, onError }: { open: boolean; sessionReady: boolean; isAdmin: boolean; onClose: () => void; onSaved?: () => void } & FeedbackHandlers) {
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
      eyebrow="Jira 工作台"
      title="连接设置"
      titleId="jira-connection-drawer-title"
      closeLabel="关闭 Jira 连接设置"
      isClosing={isClosing}
      onRequestClose={requestClose}
      contentClassName="jira-connection-drawer-content"
    >
      <JiraConnectionPanel sessionReady={sessionReady} isAdmin={isAdmin} onSaved={onSaved} onNotice={onNotice} onError={onError} />
    </ReviewDrawerShell>
  );
}
