import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Lock, Play, Save, ShieldCheck, SlidersHorizontal, Unlock } from "lucide-react";
import {
  ApiError,
  getGitLabConnection,
  saveGitLabConnection,
  testGitLabConnection,
  type GitLabConnectionInput,
} from "./api";
import { AdminPermissionTooltip } from "./admin-permission-tooltip";
import { DEFAULT_GITLAB_CONNECTION, type FeedbackHandlers } from "./assistant-settings";
import { ReviewDrawerShell } from "./review-drawer-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type GitLabTestState = {
  status: "idle" | "testing" | "success" | "error";
  message?: string;
  userName?: string;
  latencyMs?: number;
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "当前会话没有权限，请刷新页面后重试。";
    if (error.status === 502) return typeof error.details === "string" ? error.details : "GitLab 连接失败，请检查地址和 Token。";
    return typeof error.details === "string" ? error.details : error.message;
  }
  return error instanceof Error ? error.message : "GitLab 连接失败";
}

export function GitLabConnectionPanel({ sessionReady, isAdmin, onNotice, onError }: { sessionReady: boolean; isAdmin: boolean } & FeedbackHandlers) {
  const [connection, setConnection] = useState<GitLabConnectionInput>(DEFAULT_GITLAB_CONNECTION);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<GitLabTestState>({ status: "idle" });

  useEffect(() => {
    if (!sessionReady) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void getGitLabConnection()
      .then((next) => {
        if (!active) return;
        setConnection({ baseUrl: next.baseUrl, apiBaseUrl: next.apiBaseUrl, token: next.token });
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

  const updateConnection = (patch: Partial<GitLabConnectionInput>) => {
    setConnection((current) => ({ ...current, ...patch }));
    onError(null);
    setTestState({ status: "idle" });
  };

  const input = () => ({
    baseUrl: connection.baseUrl.trim(),
    apiBaseUrl: connection.apiBaseUrl.trim(),
    ...(connection.token?.trim() ? { token: connection.token.trim() } : {}),
  });

  const validate = (): boolean => {
    if (!connection.baseUrl.trim() || !connection.apiBaseUrl.trim()) {
      onError("请填写 GitLab 地址和 API 地址");
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
      onError("只有管理员可以保存 GitLab 机器人配置。");
      return;
    }
    if (!validate()) return;
    setSaving(true);
    try {
      const next = await saveGitLabConnection(input());
      setConnection({ baseUrl: next.baseUrl, apiBaseUrl: next.apiBaseUrl, token: next.token });
      setTokenConfigured(next.tokenConfigured);
      setTokenVisible(false);
      onNotice("GitLab 连接配置已保存，并已应用到当前服务");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (!isAdmin) return onError("只有管理员可以测试 GitLab 机器人配置。");
    if (!validate()) return;
    setTestState({ status: "testing" });
    try {
      const result = await testGitLabConnection(input());
      setTestState({ status: "success", message: result.message, userName: result.userName, latencyMs: result.latencyMs });
      onNotice(`${result.message}${result.latencyMs !== undefined ? ` · ${result.latencyMs}ms` : ""}`);
    } catch (error) {
      const message = errorMessage(error);
      setTestState({ status: "error", message });
      onError(message);
    }
  };

  return (
    <section className="gitlab-settings-panel" aria-label="GitLab 连接配置">
      <div className="gitlab-settings-notice">
        <ShieldCheck aria-hidden="true" />
        <span>页面字段对应当前项目 .env 中的 GitLab 配置；只有管理员可以查看、修改和测试机器人凭据；普通用户仅能查看连接配置状态。</span>
      </div>
      <div className="gitlab-settings-columns">
        <div className="gitlab-settings-card">
          <div className="gitlab-settings-section-title">
            <span className="gitlab-settings-section-icon"><SlidersHorizontal aria-hidden="true" /></span>
            <span><strong>Review机器人</strong><small>用于解析 MR 地址和调用 GitLab API</small></span>
          </div>
          <div className="gitlab-settings-grid">
            <label className="gitlab-settings-field gitlab-settings-field-wide">
              <span>GitLab 地址</span>
              <Input type="url" value={connection.baseUrl} onChange={(event) => updateConnection({ baseUrl: event.target.value })} placeholder="https://gitlab.example.com" />
              <small>MR 地址需要属于这个 GitLab 实例。</small>
            </label>
            <label className="gitlab-settings-field gitlab-settings-field-wide">
              <span>GitLab API 地址</span>
              <Input type="url" value={connection.apiBaseUrl} onChange={(event) => updateConnection({ apiBaseUrl: event.target.value })} placeholder="https://gitlab.example.com/api/v4" />
              <small>通常以 /api/v4 结尾；自建网关可填写实际 API 地址。</small>
            </label>
            <label className="gitlab-settings-field gitlab-settings-field-wide">
              <span>访问 Token {tokenConfigured && <em>已配置</em>}</span>
              <span className="gitlab-token-input">
                <Input
                  type={tokenVisible ? "text" : "password"}
                  value={connection.token ?? ""}
                  onChange={(event) => updateConnection({ token: event.target.value })}
                  placeholder="留空保留当前 Token"
                  autoComplete="off"
                  spellCheck={false}
                  className="gitlab-token-input-field"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  type="button"
                  className="gitlab-token-visibility-toggle"
                  aria-label={tokenVisible ? "隐藏 Token" : "显示 Token"}
                  aria-pressed={tokenVisible}
                  title={tokenVisible ? "隐藏 Token" : "显示 Token"}
                  onClick={() => setTokenVisible((visible) => !visible)}
                >
                  {tokenVisible ? <Unlock aria-hidden="true" /> : <Lock aria-hidden="true" />}
                </Button>
              </span>
              <small>建议使用具备读取项目和创建 MR 评论权限的 Token；留空表示继续使用已配置 Token。</small>
            </label>
          </div>
        </div>
      </div>
      <div className="gitlab-settings-footer">
        <div className="gitlab-settings-footer-actions">
          <AdminPermissionTooltip isAdmin={isAdmin} tooltipId="gitlab-settings-admin-save-tip">
            <Button variant="outline" type="button" onClick={() => void saveConnection()} disabled={!isAdmin || loading || saving || testState.status === "testing"}>
              {saving ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Save aria-hidden="true" />}保存配置
            </Button>
          </AdminPermissionTooltip>
          <Button className="gitlab-settings-test-button" type="button" onClick={() => void testConnection()} disabled={!isAdmin || loading || saving || testState.status === "testing"}>
            {testState.status === "testing" ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Play aria-hidden="true" />}测试连接
          </Button>
        </div>
      </div>
    </section>
  );
}

const DRAWER_EXIT_DURATION_MS = 220;

export function GitLabConnectionDrawer({ open, sessionReady, isAdmin, onClose, onNotice, onError }: { open: boolean; sessionReady: boolean; isAdmin: boolean; onClose: () => void } & FeedbackHandlers) {
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
      eyebrow="Review 工作台"
      title="GitLab 连接设置"
      titleId="gitlab-connection-drawer-title"
      closeLabel="关闭 GitLab 连接设置"
      isClosing={isClosing}
      onRequestClose={requestClose}
      contentClassName="gitlab-connection-drawer-content"
    >
      <GitLabConnectionPanel sessionReady={sessionReady} isAdmin={isAdmin} onNotice={onNotice} onError={onError} />
    </ReviewDrawerShell>
  );
}
