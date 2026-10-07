import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Code2, LoaderCircle, Play, RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import { ApiError, getClaudeSettings, saveClaudeSettings, testClaudeSettings, type ClaudeSettings } from "./api";
import { AdminPermissionTooltip } from "./admin-permission-tooltip";
import {
  CLAUDE_ENV_FIELDS,
  type ClaudeEnvKey,
  emptyClaudeSettings,
  envValue,
  normalizeClaudeSettings,
  serializeClaudeSettings,
  type FeedbackHandlers,
} from "./assistant-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type ModelTestState = "idle" | "testing";
type ModelTestResult = {
  status: "success" | "error";
  message: string;
  latencyMs?: number;
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "页面会话已失效，请刷新页面后重试。";
    if (error.status === 502) return typeof error.details === "string" ? error.details : "模型服务连接失败，请检查地址和配置。";
    if (typeof error.details === "string") return error.details;
    return error.message;
  }
  return error instanceof Error ? error.message : "Claude 配置操作失败";
}

export function ModelSettingsPanel({ sessionReady, isAdmin, onNotice, onError }: { sessionReady: boolean; isAdmin: boolean } & FeedbackHandlers) {
  const [settings, setSettings] = useState<ClaudeSettings>(emptyClaudeSettings);
  const [jsonText, setJsonText] = useState(() => serializeClaudeSettings(emptyClaudeSettings()));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [testState, setTestState] = useState<ModelTestState>("idle");
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!sessionReady) return;
    let active = true;
    void getClaudeSettings()
      .then((next) => {
        if (!active || dirtyRef.current) return;
        setSettings(next);
        setJsonText(serializeClaudeSettings(next));
        setJsonError(null);
        setSaved(false);
        dirtyRef.current = false;
      })
      .catch((error) => {
        if (active) onError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [onError, reloadToken, sessionReady]);

  const updateEnv = (key: ClaudeEnvKey, value: string) => {
    const next = { ...settings, env: { ...settings.env, [key]: value } };
    setSettings(next);
    setJsonText(serializeClaudeSettings(next));
    setJsonError(null);
    onError(null);
    setSaved(false);
    dirtyRef.current = true;
    setTestState("idle");
    setTestResult(null);
  };

  const updateModel = (value: string) => {
    const next = { ...settings, model: value };
    setSettings(next);
    setJsonText(serializeClaudeSettings(next));
    setJsonError(null);
    onError(null);
    setSaved(false);
    dirtyRef.current = true;
    setTestState("idle");
    setTestResult(null);
  };

  const handleJsonChange = (value: string) => {
    setJsonText(value);
    setSaved(false);
    dirtyRef.current = true;
    setTestState("idle");
    setTestResult(null);
    try {
      const next = normalizeClaudeSettings(JSON.parse(value) as unknown);
      setSettings(next);
      setJsonError(null);
      onError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "JSON 格式不正确";
      setJsonError(message);
      onError(message);
    }
  };

  const saveConfig = async () => {
    if (!isAdmin) return onError("只有管理员可以保存模型配置。");
    if (jsonError) return onError(jsonError);
    if (!sessionReady) return onError("页面会话尚未建立，请稍后再试");
    setSaving(true);
    try {
      const next = await saveClaudeSettings(settings);
      setSettings(next);
      setJsonText(serializeClaudeSettings(next));
      setJsonError(null);
      setSaved(true);
      dirtyRef.current = false;
      onNotice("Claude 项目配置已保存");
    } catch (error) {
      setSaved(false);
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const resetConfig = () => {
    dirtyRef.current = false;
    setReloadToken((value) => value + 1);
    setTestState("idle");
    setTestResult(null);
  };

  const runTest = async () => {
    if (!isAdmin) return onError("只有管理员可以测试模型配置。");
    if (jsonError) {
      onError(null);
      setTestResult({ status: "error", message: jsonError });
      return;
    }
    if (!sessionReady) {
      onError(null);
      setTestResult({ status: "error", message: "页面会话尚未建立，请稍后再试" });
      return;
    }
    setTestResult(null);
    setTestState("testing");
    try {
      const result = await testClaudeSettings(settings);
      onError(null);
      setTestResult({ status: "success", message: result.message, latencyMs: result.latencyMs });
    } catch (error) {
      const message = errorMessage(error);
      setTestResult({ status: "error", message });
    } finally {
      setTestState("idle");
    }
  };

  return (
    <section className="model-settings-panel" aria-labelledby="model-settings-title">
      <div className="model-settings-heading">
        <div>
          <h3 id="model-settings-title">Claude 项目配置</h3>
          <p>配置保存在项目数据库中；只有管理员可以查看、编辑和测试认证令牌；普通用户看到掩码。配置测试只验证单轮连接，不代表右侧任务的多轮工具执行。</p>
        </div>
      </div>
      <div className="model-settings-columns">
        <div className="model-settings-form">
          <div className="model-settings-section-title">
            <span className="model-settings-section-icon"><SlidersHorizontal aria-hidden="true" /></span>
            <span><strong>Claude env 参数</strong><small>字段名与数据库中的模型配置完全一致</small></span>
          </div>
          <label className="model-settings-field model-settings-field-wide model-settings-model-field">
            <span>model</span>
            <Input
              value={settings.model ?? ""}
              onChange={(event) => updateModel(event.target.value)}
              disabled={testState === "testing"}
              autoComplete="off"
              spellCheck={false}
            />
            <small>右侧助手和 Review 运行器实际使用的模型；留空时回退到 env.ANTHROPIC_MODEL。</small>
          </label>
          <div className="model-settings-grid">
            {CLAUDE_ENV_FIELDS.map((field) => (
              <label className="model-settings-field model-settings-field-wide" key={field.key}>
                <span>{field.key}</span>
                <Input
                  type={field.type ?? "text"}
                  value={envValue(settings, field.key)}
                  onChange={(event) => updateEnv(field.key, event.target.value)}
                  disabled={testState === "testing"}
                  autoComplete="off"
                  spellCheck={false}
                />
                <small>{field.description}</small>
              </label>
            ))}
          </div>
        </div>
        <div className="model-settings-json-column">
          <div className="model-settings-section-title model-settings-json-title">
            <span className="model-settings-section-icon"><Code2 aria-hidden="true" /></span>
            <span><strong>JSON 配置</strong></span>
          </div>
          <Textarea
            value={jsonText}
            onChange={(event) => handleJsonChange(event.target.value)}
            className="model-settings-json-editor"
            disabled={testState === "testing"}
            spellCheck={false}
            aria-label="模型配置 JSON"
            aria-invalid={Boolean(jsonError)}
          />
        </div>
      </div>
      {testState === "testing" && (
        <div className="model-settings-test-result is-testing" role="status" aria-live="polite">
          <LoaderCircle aria-hidden="true" className="is-spinning" />
          <span><strong>正在测试配置</strong>正在等待模型服务返回结果，请稍候。</span>
        </div>
      )}
      {testState !== "testing" && testResult && (
        <div className={`model-settings-test-result is-${testResult.status}`} role={testResult.status === "error" ? "alert" : "status"} aria-live="polite">
          {testResult.status === "error" ? <CircleAlert aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
          <span>
            <strong>{testResult.status === "error" ? "测试失败" : "测试成功"}</strong>
            {testResult.message}
            {testResult.latencyMs === undefined ? "" : ` · ${testResult.latencyMs}ms`}
          </span>
        </div>
      )}
      <div className="model-settings-footer">
        <Button variant="ghost" className="model-settings-reset" type="button" onClick={resetConfig} disabled={testState === "testing"}>
          <RotateCcw aria-hidden="true" />重新读取项目配置
        </Button>
        <div className="model-settings-footer-actions">
          {saved && <span className="model-settings-saved"><CheckCircle2 aria-hidden="true" />已保存</span>}
          <AdminPermissionTooltip isAdmin={isAdmin} tooltipId="model-settings-admin-save-tip">
            <Button variant="outline" type="button" onClick={() => void saveConfig()} disabled={!isAdmin || saving || testState === "testing"}>
              {saving ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Save aria-hidden="true" />}保存配置
            </Button>
          </AdminPermissionTooltip>
          <Button
            className="model-settings-test-button"
            type="button"
            onClick={() => void runTest()}
            disabled={!isAdmin || testState === "testing"}
            aria-busy={testState === "testing"}
          >
            {testState === "testing" ? <LoaderCircle aria-hidden="true" className="is-spinning" /> : <Play aria-hidden="true" />}
            {testState === "testing" ? "测试中…" : "测试当前配置"}
          </Button>
        </div>
      </div>
    </section>
  );
}
