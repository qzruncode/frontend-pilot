import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitLabConnectionInputSchema } from "./contracts.js";
import { isMissingFileError } from "./errors.js";

export interface GitLabConnection {
  baseUrl: string;
  apiBaseUrl: string;
  token: string;
}

export interface GitLabConnectionFallback {
  apiBaseUrl: string;
  token: string;
  baseUrl?: string;
}

export interface GitLabConnectionStorePort {
  read(fallback: GitLabConnectionFallback): Promise<GitLabConnection>;
  write(connection: GitLabConnection): Promise<GitLabConnection>;
}

const BASE_URL_KEYS = ["GITLAB_BASE_URL"] as const;
const API_BASE_URL_KEYS = ["GITLAB_API_BASE_URL", "GITLAB_API_URL"] as const;
const TOKEN_KEYS = ["GITLAB_TOKEN", "GITLAB_PERSONAL_ACCESS_TOKEN", "GITLAB__PERSONAL_ACCESS_TOKEN"] as const;

function deriveBaseUrl(apiBaseUrl: string): string {
  try {
    const parsed = new URL(apiBaseUrl);
    parsed.pathname = parsed.pathname.replace(/\/api\/v4\/?$/, "") || "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return apiBaseUrl.replace(/\/api\/v4\/?$/, "").replace(/\/$/, "");
  }
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/\\'/g, "'");
  }
  return trimmed;
}

function formatEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+\-]+$/.test(value) ? value : JSON.stringify(value);
}

function parseEnvFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values.set(match[1], parseEnvValue(match[2]));
  }
  return values;
}

function validateConnection(connection: GitLabConnection): GitLabConnection {
  const parsed = GitLabConnectionInputSchema.safeParse(connection);
  if (!parsed.success) throw new Error("GitLab 连接配置格式不正确");
  return { ...parsed.data, token: parsed.data.token ?? "" };
}

function firstExistingKey(values: Map<string, string>, keys: readonly string[], fallback: string): string {
  return keys.find((key) => values.has(key)) ?? fallback;
}

function updateEnvLine(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  const keyPattern = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=\\s*).*$`);
  const index = lines.findIndex((line) => keyPattern.test(line));
  if (index >= 0) {
    lines[index] = `${lines[index].match(keyPattern)?.[1] ?? `${key}=`}${formatEnvValue(value)}`;
    return lines.join("\n");
  }
  const next = content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  return `${next}${key}=${formatEnvValue(value)}\n`;
}

export class GitLabConnectionStore implements GitLabConnectionStorePort {
  private readonly envPath: string;

  constructor(private readonly cwd = process.cwd()) {
    this.envPath = path.join(cwd, ".env");
  }

  async read(fallback: GitLabConnectionFallback): Promise<GitLabConnection> {
    const envFile = await this.readEnvFile();
    const apiBaseUrlKey = API_BASE_URL_KEYS.find((key) => envFile.has(key));
    const tokenKey = TOKEN_KEYS.find((key) => envFile.has(key));
    const apiBaseUrl = apiBaseUrlKey ? envFile.get(apiBaseUrlKey) ?? fallback.apiBaseUrl : fallback.apiBaseUrl;
    return validateConnection({
      baseUrl: envFile.has("GITLAB_BASE_URL")
        ? envFile.get("GITLAB_BASE_URL") ?? deriveBaseUrl(apiBaseUrl)
        : fallback.baseUrl || deriveBaseUrl(apiBaseUrl),
      apiBaseUrl,
      token: tokenKey ? envFile.get(tokenKey) ?? fallback.token : fallback.token,
    });
  }

  async write(connection: GitLabConnection): Promise<GitLabConnection> {
    const validated = validateConnection(connection);
    let content = await this.readEnvContent();
    const values = parseEnvFile(content);
    const baseUrlKey = firstExistingKey(values, BASE_URL_KEYS, "GITLAB_BASE_URL");
    const apiBaseUrlKey = firstExistingKey(values, API_BASE_URL_KEYS, "GITLAB_API_BASE_URL");
    const tokenKey = firstExistingKey(values, TOKEN_KEYS, "GITLAB_TOKEN");
    content = updateEnvLine(content, baseUrlKey, validated.baseUrl);
    content = updateEnvLine(content, apiBaseUrlKey, validated.apiBaseUrl);
    content = updateEnvLine(content, tokenKey, validated.token);

    await mkdir(path.dirname(this.envPath), { recursive: true, mode: 0o700 });
    await writeFile(this.envPath, content, { encoding: "utf8", mode: 0o600 });
    await chmod(this.envPath, 0o600);
    return validated;
  }

  private async readEnvContent(): Promise<string> {
    try {
      return await readFile(this.envPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return "";
      throw error;
    }
  }

  private async readEnvFile(): Promise<Map<string, string>> {
    return parseEnvFile(await this.readEnvContent());
  }
}
