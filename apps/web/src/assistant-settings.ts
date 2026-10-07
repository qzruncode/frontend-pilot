import type { LucideIcon } from "lucide-react";
import { Activity, BarChart3, Box, ClipboardCheck, Database, GitPullRequest, ListChecks, MessageSquarePlus, Settings2, Sparkles, Terminal, Users } from "lucide-react";
import type { ClaudeSettings, GitLabConnectionInput, JiraConnectionInput } from "./api";

export type FeedbackHandlers = {
  onNotice: (message: string) => void;
  onError: (message: string | null) => void;
};

export type SettingsItem = {
  id: "models" | "claude-cli" | "review-workbench" | "inspection-workbench" | "review-tools" | "review-settings" | "runs" | "gitlab-workbench" | "gitlab" | "jira-workbench" | "jira" | "rules" | "feedback" | "feedback-admin" | "users" | "user-activity";
  label: string;
  icon: LucideIcon;
  visible?: boolean;
  adminOnly?: boolean;
};

export const settingsItems: SettingsItem[] = [
  { id: "models", label: "模型配置", icon: Box },
  { id: "claude-cli", label: "Claude CLI 工作台", icon: Terminal },
  { id: "gitlab-workbench", label: "GitLab 工作台", icon: GitPullRequest },
  { id: "jira-workbench", label: "Jira 工作台", icon: ListChecks },
  { id: "review-workbench", label: "Review 工作台", icon: ListChecks },
  { id: "inspection-workbench", label: "巡检工作台", icon: ClipboardCheck },
  { id: "feedback", label: "意见反馈", icon: MessageSquarePlus },
  { id: "feedback-admin", label: "反馈管理", icon: ListChecks, adminOnly: true },
  { id: "users", label: "用户管理", icon: Users, adminOnly: true },
  { id: "user-activity", label: "用户行为", icon: BarChart3, adminOnly: true },
];

// These entries keep old URLs and migration links readable without exposing duplicate menu items.
export const legacySettingsItems: SettingsItem[] = [
  { id: "gitlab", label: "GitLab 连接", icon: Database },
  { id: "jira", label: "Jira 服务配置", icon: Database, adminOnly: true },
  { id: "review-settings", label: "Review 配置", icon: Settings2 },
  { id: "rules", label: "Review 规则", icon: Activity },
  { id: "review-tools", label: "Review 工具", icon: Sparkles },
  { id: "runs", label: "Review 记录", icon: ListChecks },
];

export const allSettingsItems: SettingsItem[] = [...settingsItems, ...legacySettingsItems];

export type ClaudeEnvKey =
  | "ANTHROPIC_AUTH_TOKEN"
  | "ANTHROPIC_BASE_URL"
  | "CLAUDE_CODE_AUTO_COMPACT_WINDOW"
  | "CLAUDE_CODE_MAX_CONTEXT_TOKENS"
  | "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS"
  | "CLAUDE_CODE_MAX_OUTPUT_TOKENS"
  | "CLAUDE_CODE_TOTAL_TOKENS_REMINDER"
  | "CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES"
  | "CLAUDE_THINKING_MODE"
  | "CLAUDE_THINKING_BUDGET_TOKENS"
  | "CLAUDE_CODE_EFFORT_LEVEL"
  | "ANTHROPIC_MODEL"
  | "ANTHROPIC_DEFAULT_SONNET_MODEL"
  | "ANTHROPIC_DEFAULT_OPUS_MODEL"
  | "ANTHROPIC_DEFAULT_HAIKU_MODEL";

export const CLAUDE_ENV_FIELDS: Array<{
  key: ClaudeEnvKey;
  description: string;
  type?: "password" | "text" | "url";
}> = [
  { key: "ANTHROPIC_AUTH_TOKEN", description: "模型认证令牌，可直接查看和编辑；留空表示清除当前令牌。", type: "text" },
  { key: "ANTHROPIC_BASE_URL", description: "Claude API 网关地址。", type: "url" },
  { key: "CLAUDE_CODE_AUTO_COMPACT_WINDOW", description: "Claude Code 自动压缩上下文窗口。" },
  { key: "CLAUDE_CODE_MAX_CONTEXT_TOKENS", description: "兼容模型实际可接受的上下文上限；用于在达到上限前触发自动压缩。" },
  { key: "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS", description: "单次读取文件最多返回的 token 数，避免大文件撑满兼容模型上下文。" },
  { key: "CLAUDE_CODE_MAX_OUTPUT_TOKENS", description: "单次模型请求的最大输出 token 数；兼容网关建议使用 4096，避免 SDK 默认值过大。" },
  { key: "CLAUDE_CODE_TOTAL_TOKENS_REMINDER", description: "token 余量提醒模式；兼容 Anthropic 网关建议填写 off。" },
  { key: "CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES", description: "兼容网关拒绝工具结果后的 system 消息时填写 1；由本地兼容层合并到顶层 system。" },
  { key: "CLAUDE_THINKING_MODE", description: "助手思考模式：adaptive、enabled 或 disabled；兼容模型遇到续轮卡顿时可选 disabled。" },
  { key: "CLAUDE_THINKING_BUDGET_TOKENS", description: "固定思考模式的 token 预算；建议兼容模型使用 4096。" },
  { key: "CLAUDE_CODE_EFFORT_LEVEL", description: "助手推理强度：low、medium、high、xhigh 或 max。" },
  { key: "ANTHROPIC_MODEL", description: "当前使用的 Claude 模型 ID。" },
  { key: "ANTHROPIC_DEFAULT_SONNET_MODEL", description: "Sonnet 角色使用的模型 ID。" },
  { key: "ANTHROPIC_DEFAULT_OPUS_MODEL", description: "Opus 角色使用的模型 ID。" },
  { key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", description: "Haiku 角色使用的模型 ID。" },
];

export function serializeClaudeSettings(settings: ClaudeSettings): string {
  return JSON.stringify(settings, null, 2);
}

export function emptyClaudeSettings(): ClaudeSettings {
  return { env: {} };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function normalizeClaudeSettings(value: unknown): ClaudeSettings {
  const raw = objectValue(value);
  if (!raw) throw new Error("JSON 顶层必须是对象");
  const envRaw = objectValue(raw.env);
  if (!envRaw) throw new Error("JSON 必须包含 env 对象");
  if (Object.keys(envRaw).length > 100) throw new Error("env 最多支持 100 个配置项");
  const env: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(envRaw)) {
    if (key.trim().length === 0 || key.length > 256) throw new Error(`env.${key} 的字段名长度无效`);
    if (typeof envValue !== "string") throw new Error(`env.${key} 必须是字符串`);
    if (envValue.length > 16_000) throw new Error(`env.${key} 不能超过 16000 个字符`);
    env[key] = envValue;
  }
  return { ...raw, env };
}

export function envValue(settings: ClaudeSettings, key: ClaudeEnvKey): string {
  return settings.env[key] ?? "";
}

export const DEFAULT_GITLAB_CONNECTION: GitLabConnectionInput = {
  baseUrl: "https://gitlab.example.com",
  apiBaseUrl: "https://gitlab.example.com/api/v4",
  token: "",
};

export const DEFAULT_JIRA_CONNECTION: JiraConnectionInput = {
  baseUrl: "https://jira.example.com",
  apiBaseUrl: "https://jira.example.com/rest/api/2",
  projectKey: "DEMO",
  username: "",
  token: "",
};
