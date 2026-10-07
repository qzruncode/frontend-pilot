import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { JiraConnectionInputSchema } from "./contracts.js";
import { isMissingFileError } from "./errors.js";

export interface JiraConnection {
  baseUrl: string;
  apiBaseUrl: string;
  projectKey: string;
  username: string;
  token: string;
}

export interface JiraConnectionFallback {
  baseUrl: string;
  apiBaseUrl: string;
  projectKey?: string;
  username: string;
  token: string;
}

export interface JiraConnectionStorePort {
  read(fallback: JiraConnectionFallback): Promise<JiraConnection>;
  write(connection: JiraConnection): Promise<JiraConnection>;
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
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/\\'/g, "'");
  return trimmed;
}

function parseEnvFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values.set(match[1], parseEnvValue(match[2]));
  }
  return values;
}

function formatEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+\-]+$/.test(value) ? value : JSON.stringify(value);
}

function validateConnection(connection: JiraConnection): JiraConnection {
  const parsed = JiraConnectionInputSchema.safeParse(connection);
  if (!parsed.success) throw new Error("Jira 连接配置格式不正确");
  return { ...parsed.data, token: parsed.data.token ?? "" };
}

function updateEnvLine(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=\\s*).*$`);
  const index = lines.findIndex((line) => pattern.test(line));
  if (index >= 0) {
    lines[index] = `${lines[index].match(pattern)?.[1] ?? `${key}=`}${formatEnvValue(value)}`;
    return lines.join("\n");
  }
  const next = content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  return `${next}${key}=${formatEnvValue(value)}\n`;
}

export class JiraConnectionStore implements JiraConnectionStorePort {
  private readonly envPath: string;

  constructor(private readonly cwd = process.cwd()) {
    this.envPath = path.join(cwd, ".env");
  }

  async read(fallback: JiraConnectionFallback): Promise<JiraConnection> {
    const values = parseEnvFile(await this.readEnvContent());
    return validateConnection({
      baseUrl: values.get("JIRA_BASE_URL") || values.get("JIRA_URL") || fallback.baseUrl,
      apiBaseUrl: values.get("JIRA_API_BASE_URL") || fallback.apiBaseUrl,
      projectKey: (values.get("JIRA_PROJECT_KEY") || fallback.projectKey || "AIP").trim().toUpperCase(),
      username: values.get("JIRA_USERNAME") || values.get("JIRA_USER") || fallback.username,
      token: values.get("JIRA_TOKEN") || values.get("JIRA_PASSWORD") || values.get("JIRA_API_TOKEN") || fallback.token,
    });
  }

  async write(connection: JiraConnection): Promise<JiraConnection> {
    const validated = validateConnection(connection);
    let content = await this.readEnvContent();
    content = updateEnvLine(content, "JIRA_BASE_URL", validated.baseUrl);
    content = updateEnvLine(content, "JIRA_API_BASE_URL", validated.apiBaseUrl);
    content = updateEnvLine(content, "JIRA_PROJECT_KEY", validated.projectKey);
    content = updateEnvLine(content, "JIRA_USERNAME", validated.username);
    content = updateEnvLine(content, "JIRA_TOKEN", validated.token);
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
}
