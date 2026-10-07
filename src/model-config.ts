import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { ClaudeSettingsSchema, type ClaudeSettings } from "./contracts.js";
import { isMissingFileError, safeErrorMessage } from "./errors.js";

export interface ClaudeSettingsStore {
  read(): Promise<ClaudeSettings>;
  write(settings: ClaudeSettings): Promise<ClaudeSettings>;
  close?: () => void | Promise<void>;
}

export type ClaudeSettingsEnvironment = Record<string, string | undefined>;
export type ClaudeSettingsProvider = () => Promise<ClaudeSettingsEnvironment>;

const CLAUDE_ENVIRONMENT_PREFIXES = ["ANTHROPIC_", "CLAUDE_"] as const;
const CLAUDE_ENVIRONMENT_EXTRA_KEYS = new Set(["API_TIMEOUT_MS"]);
const CLAUDE_RUNTIME_ENVIRONMENT_KEYS = new Set(["CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES"]);

function isClaudeEnvironmentKey(key: string): boolean {
  return CLAUDE_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)) || CLAUDE_ENVIRONMENT_EXTRA_KEYS.has(key);
}

export function claudeSettingsFromEnvironment(environment: ClaudeSettingsEnvironment): ClaudeSettings {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    if (!isClaudeEnvironmentKey(key)) continue;
    env[key] = value;
  }
  return ClaudeSettingsSchema.parse({ env });
}

export function withoutClaudeSettingsEnvironment(environment: ClaudeSettingsEnvironment): ClaudeSettingsEnvironment {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !isClaudeEnvironmentKey(key) || CLAUDE_RUNTIME_ENVIRONMENT_KEYS.has(key)),
  );
}

const MODEL_CONFIG_TEST_TIMEOUT_MS = 15_000;
export const CLAUDE_SECRET_MASK = "[已配置，未显示]";
const CLAUDE_SECRET_ENV_KEYS = new Set(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);

export interface ClaudeSettingsTestResult {
  ok: true;
  baseUrl: string;
  model: string;
  latencyMs: number;
  message: string;
}

export function publicClaudeSettings(settings: ClaudeSettings, revealSecrets = false): ClaudeSettings {
  if (revealSecrets) return settings;
  const env = { ...settings.env };
  for (const key of CLAUDE_SECRET_ENV_KEYS) {
    if (env[key]) env[key] = CLAUDE_SECRET_MASK;
  }
  return { ...settings, env };
}

export function mergeClaudeSettings(current: ClaudeSettings, incoming: ClaudeSettings): ClaudeSettings {
  const env = { ...incoming.env };
  for (const key of CLAUDE_SECRET_ENV_KEYS) {
    const incomingValue = env[key];
    if (incomingValue === undefined || incomingValue === CLAUDE_SECRET_MASK) {
      const currentValue = current.env[key];
      if (currentValue) env[key] = currentValue;
      else delete env[key];
    } else if (incomingValue === "") {
      delete env[key];
    }
  }
  return { ...incoming, env };
}

function parseProjectSettings(value: unknown): ClaudeSettings {
  const parsed = ClaudeSettingsSchema.safeParse(value);
  if (!parsed.success) throw new Error("Claude 配置 JSON 格式不正确");
  return parsed.data;
}

function modelEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function responseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function providerErrorMessage(value: unknown): string {
  const body = responseObject(value);
  const error = responseObject(body.error);
  const message = error.message ?? body.message;
  return typeof message === "string" && message.trim() ? message.trim() : "模型服务返回了错误响应";
}

function responseText(value: unknown): string {
  const body = responseObject(value);
  const content = Array.isArray(body.content) ? body.content : [];
  return content
    .map((item) => responseObject(item).text)
    .filter((item): item is string => typeof item === "string")
    .join("")
    .trim();
}

function connectionFailureMessage(error: unknown): string {
  const primary = safeErrorMessage(error, "网络请求失败");
  if (!(error instanceof Error) || !("cause" in error) || !(error.cause instanceof Error)) return primary;

  const cause = error.cause;
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : "";
  const message = safeErrorMessage(cause, "");
  const detail = [code ? `错误码 ${code}` : "", message && message !== primary ? message : ""].filter(Boolean).join("；");
  return detail ? `${primary}（${detail}）` : primary;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  return "cause" in error && isTimeoutError(error.cause);
}

function parseProviderResponse(bodyText: string): unknown {
  if (bodyText.length > 100_000 || !bodyText.trim()) return null;
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
}

function requiredClaudeEnv(settings: ClaudeSettings, key: string): string {
  const value = settings.env[key]?.trim();
  if (!value) throw new Error(`模型配置缺少 ${key}`);
  return value;
}

function configuredModel(settings: ClaudeSettings): string {
  const model = settings.model?.trim() || settings.env.ANTHROPIC_MODEL?.trim();
  if (!model) throw new Error("模型配置缺少 model 或 ANTHROPIC_MODEL");
  return model;
}

export async function testClaudeSettings(settings: ClaudeSettings): Promise<ClaudeSettingsTestResult> {
  const baseUrl = requiredClaudeEnv(settings, "ANTHROPIC_BASE_URL");
  try {
    const url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    throw new Error("模型配置中的 ANTHROPIC_BASE_URL 不是有效 HTTP(S) 地址");
  }
  const authToken = settings.env.ANTHROPIC_AUTH_TOKEN?.trim();
  const apiKey = settings.env.ANTHROPIC_API_KEY?.trim();
  if (!authToken && !apiKey) throw new Error("模型配置缺少 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY");
  const model = configuredModel(settings);
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(authToken ? { authorization: `Bearer ${authToken}` } : { "x-api-key": apiKey ?? "" }),
  };

  let response: Response;
  try {
    response = await fetch(modelEndpoint(baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "请只回复 OK" }] }),
      signal: AbortSignal.timeout(MODEL_CONFIG_TEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) throw new Error(`无法连接模型服务：请求超时（${MODEL_CONFIG_TEST_TIMEOUT_MS / 1000} 秒）`, { cause: error });
    throw new Error(`无法连接模型服务：${connectionFailureMessage(error)}`, { cause: error });
  }

  const bodyText = await response.text();
  const body = parseProviderResponse(bodyText);
  if (bodyText.trim() && body === null) throw new Error("模型服务返回了无法解析的响应");
  if (!response.ok) throw new Error(`${providerErrorMessage(body)}（HTTP ${response.status}）`);
  return {
    ok: true,
    baseUrl,
    model,
    latencyMs: Date.now() - startedAt,
    message: responseText(body) || "模型已返回成功响应",
  };
}

export class ClaudeModelConfigStore implements ClaudeSettingsStore {
  private readonly settingsPath: string;

  constructor(cwd = process.cwd()) {
    this.settingsPath = path.join(cwd, ".claude", "settings.json");
  }

  async read(): Promise<ClaudeSettings> {
    try {
      const content = await readFile(this.settingsPath, "utf8");
      return parseProjectSettings(JSON.parse(content) as unknown);
    } catch (error) {
      if (isMissingFileError(error)) return ClaudeSettingsSchema.parse({ env: {} });
      if (error instanceof SyntaxError) throw new Error("Claude 配置 JSON 无法解析");
      throw error;
    }
  }

  async write(settings: ClaudeSettings): Promise<ClaudeSettings> {
    const parsed = parseProjectSettings(settings);
    await mkdir(path.dirname(this.settingsPath), { recursive: true, mode: 0o700 });
    await writeFile(this.settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return this.read();
  }
}

interface ModelConfigRow {
  settings_json: unknown;
}

const MODEL_CONFIG_KEY = "claude";

/**
 * Project model settings are persisted with the rest of the application state.
 * The legacy file-backed store above remains available for one-off migrations,
 * but the running application must use this database-backed store.
 */
export class DatabaseClaudeSettingsStore implements ClaudeSettingsStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(databasePath: string, initialSettings: ClaudeSettings = { env: {} }) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_configs (
        config_key TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    const existing = this.db.prepare(
      "SELECT config_key FROM model_configs WHERE config_key = ?",
    ).get(MODEL_CONFIG_KEY);
    if (!existing) {
      const parsed = parseProjectSettings(initialSettings);
      this.db.prepare(`
        INSERT INTO model_configs (config_key, settings_json, updated_at)
        VALUES (?, ?, ?)
      `).run(MODEL_CONFIG_KEY, JSON.stringify(parsed), new Date().toISOString());
    }
  }

  async read(): Promise<ClaudeSettings> {
    this.ensureOpen();
    const row = this.db.prepare(
      "SELECT settings_json FROM model_configs WHERE config_key = ?",
    ).get(MODEL_CONFIG_KEY) as ModelConfigRow | undefined;
    if (!row) return ClaudeSettingsSchema.parse({ env: {} });

    let value: unknown;
    try {
      value = JSON.parse(String(row.settings_json));
    } catch {
      throw new Error("数据库中的 Claude 配置 JSON 无法解析");
    }
    return parseProjectSettings(value);
  }

  async write(settings: ClaudeSettings): Promise<ClaudeSettings> {
    this.ensureOpen();
    const parsed = parseProjectSettings(settings);
    this.db.prepare(`
      INSERT INTO model_configs (config_key, settings_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(config_key) DO UPDATE SET
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at
    `).run(MODEL_CONFIG_KEY, JSON.stringify(parsed), new Date().toISOString());
    return parsed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("model config store is closed");
  }
}
