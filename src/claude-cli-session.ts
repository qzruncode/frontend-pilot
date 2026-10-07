import { execFile as execFileCallback, type ExecFileOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { prepareClaudeGatewayCompatibility, type ClaudeGatewayCompatibilityHandle } from "./claude-gateway-compat.js";
import { createClaudeCliPreviewProxy, extractClaudeCliPreviewTargets, isClaudeCliPreviewTargetAvailable, type ClaudeCliPreviewEndpoint, type ClaudeCliPreviewProtocol, type ClaudeCliPreviewProxy } from "./claude-cli-preview.js";
import type { ClaudeCliProject, ClaudeCliSession } from "./contracts.js";
import type { GitLabConnection } from "./gitlab-connection.js";
import { askpassScript, repositoryUrl, safeSegment } from "./review-workspace.js";

const PROJECT_METADATA_FILE = ".frontend-pilot-claude-project.json";
const GITLAB_ASKPASS_FILE = ".gitlab-askpass.sh";
const INTERNAL_GIT_FILES = [PROJECT_METADATA_FILE, GITLAB_ASKPASS_FILE];
const MAX_OUTPUT_BUFFER_BYTES = 200_000;
const CLAUDE_CLI_INHERITED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "ComSpec",
  "USER",
  "USERNAME",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "COLORTERM",
  "CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "COREPACK_HOME",
  "COREPACK_NPM_REGISTRY",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
]);

type SessionMetadata = Pick<ClaudeCliSession, "id" | "name" | "createdAt"> & {
  cliSessionId: string;
};

type ProjectMetadata = Pick<ClaudeCliProject, "id" | "name" | "createdAt"> & {
  repositoryPath?: string;
  defaultBranch?: string | null;
  sessions?: SessionMetadata[];
};

export interface ClaudeCliRepositorySource {
  projectPath: string;
  defaultBranch: string | null;
  connection: GitLabConnection;
}

export type ClaudeCliTerminalEvent =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; message: string };

export interface ClaudeCliTerminalConnection {
  project: ClaudeCliProject;
  onEvent(listener: (event: ClaudeCliTerminalEvent) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  stop(): void;
}

export interface ClaudeCliSessionManagerOptions {
  rootDir: string;
  command?: string;
  fetchDepth?: number;
  previewHost?: string;
  environment?: Record<string, string | undefined>;
  settingsProvider: () => Promise<Record<string, string>>;
}

interface ManagedSession {
  ownerKey: string;
  metadata: ProjectMetadata;
  session: SessionMetadata;
  cwd: string;
  process: pty.IPty | null;
  starting: Promise<void> | null;
  connection: GitLabConnection | null;
  output: string;
  listeners: Set<(event: ClaudeCliTerminalEvent) => void>;
  gatewayCompatibility?: ClaudeGatewayCompatibilityHandle;
  previewProxies: Map<number, ClaudeCliPreviewProxy>;
  previewStarting: Map<number, Promise<ClaudeCliPreviewProxy>>;
}

type CommandRunner = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

const execFile: CommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFileCallback(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) {
      reject(error);
      return;
    }
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function projectId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("Claude CLI 项目标识无效");
  return value;
}

function normalizeName(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) throw new Error(`${label}不能为空且不能超过 128 个字符`);
  return normalized;
}

function clampTerminalSize(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(maximum, value!)) : fallback;
}

function trimOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BUFFER_BYTES) return value;
  return Buffer.from(value, "utf8").subarray(-MAX_OUTPUT_BUFFER_BYTES).toString("utf8");
}

export function buildClaudeCliEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv,
  runtimeEnvironment: Record<string, string | undefined>,
  configuredEnvironment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const safeInheritedEnvironment = Object.fromEntries(
    Object.entries({ ...inheritedEnvironment, ...runtimeEnvironment })
      .filter(([key]) => CLAUDE_CLI_INHERITED_ENV_KEYS.has(key)),
  );
  return { ...safeInheritedEnvironment, ...configuredEnvironment };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function terminalLaunch(shell: string, command: string, args: string[] = [], runtimeBin?: string): { file: string; args: string[] } {
  const commandLine = [shellQuote(command), ...args.map(shellQuote)].join(" ");
  if (process.platform === "win32") {
    return { file: shell, args: ["/d", "/s", "/c", `${command} ${args.map((arg) => `"${arg.replaceAll('"', '\\"')}"`).join(" ")} & ${shell} /d /k`] };
  }
  const runtimePath = runtimeBin ? `export PATH=${shellQuote(runtimeBin)}:"$PATH"; ` : "";
  const fallbackShell = runtimeBin
    ? `exec env PATH=${shellQuote(runtimeBin)}:"$PATH" ${shellQuote(shell)} -i`
    : `exec ${shellQuote(shell)} -il`;
  return {
    file: shell,
    args: ["-ilc", `${runtimePath}${commandLine}; ${fallbackShell}`],
  };
}

function alignRuntimePath(environment: Record<string, string | undefined>): void {
  const runtimeBin = path.dirname(process.execPath);
  const existingPath = environment.PATH ?? "";
  const pathEntries = existingPath.split(path.delimiter).filter((entry) => entry && entry !== runtimeBin);
  environment.PATH = [runtimeBin, ...pathEntries].join(path.delimiter);
}

export class ClaudeCliSessionManager {
  private readonly rootDir: string;
  private readonly command: string;
  private readonly fetchDepth: number;
  private readonly previewHost: string;
  private readonly environment: Record<string, string | undefined>;
  private readonly settingsProvider: () => Promise<Record<string, string>>;
  private readonly sessions = new Map<string, ManagedSession>();

  constructor({ rootDir, command = "claude", fetchDepth = 50, previewHost = "127.0.0.1", environment = {}, settingsProvider }: ClaudeCliSessionManagerOptions) {
    this.rootDir = path.resolve(rootDir);
    this.command = command.trim() || "claude";
    this.fetchDepth = Math.max(1, Math.floor(fetchDepth));
    this.previewHost = previewHost.trim() || "127.0.0.1";
    this.environment = environment;
    this.settingsProvider = settingsProvider;
  }

  async createProject(ownerKey: string, username: string, name: string, source?: ClaudeCliRepositorySource): Promise<ClaudeCliProject> {
    const normalizedName = normalizeName(name, "项目名称");
    const repositoryPath = source ? normalizeRepositoryPath(source.projectPath) : undefined;
    const defaultBranch = source ? normalizeBranch(source.defaultBranch) : undefined;
    const normalizedSource = source && repositoryPath
      ? { ...source, projectPath: repositoryPath, defaultBranch: defaultBranch ?? null }
      : undefined;
    const id = randomUUID();
    const cwd = this.projectPath(ownerKey, id);
    const metadata: ProjectMetadata = {
      id,
      name: normalizedName,
      createdAt: new Date().toISOString(),
      sessions: [this.newSessionMetadata(1)],
      ...(repositoryPath ? { repositoryPath, defaultBranch } : {}),
    };
    try {
      await mkdir(cwd, { recursive: true });
      const gitEnvironment = normalizedSource ? await this.gitEnvironment(cwd, normalizedSource.connection.token) : process.env;
      await this.initializeRepository(cwd, normalizedSource, gitEnvironment);
      await this.configureGitIdentity(cwd, username, gitEnvironment);
      await this.excludeInternalFiles(cwd);
      await this.writeMetadata(cwd, metadata);
      return this.toPublicProject(ownerKey, metadata);
    } catch (error) {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`创建 Claude CLI 项目失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async listProjects(ownerKey: string): Promise<ClaudeCliProject[]> {
    const ownerDir = this.ownerPath(ownerKey);
    let entries;
    try {
      entries = await readdir(ownerDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingPath(error)) return [];
      throw error;
    }
    const projects: ClaudeCliProject[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadata = await this.readMetadata(path.join(ownerDir, entry.name));
      if (!metadata) continue;
      projects.push(this.toPublicProject(ownerKey, metadata));
    }
    return projects.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createSession(ownerKey: string, id: string): Promise<ClaudeCliSession> {
    const metadata = await this.findOwnedProject(ownerKey, id);
    const sessions = await this.ensureSessions(metadata, this.projectPath(ownerKey, metadata.id));
    const session = this.newSessionMetadata(sessions.length + 1);
    metadata.sessions = [...sessions, session];
    await this.writeMetadata(this.projectPath(ownerKey, metadata.id), metadata);
    return this.toPublicSession(ownerKey, metadata, session);
  }

  async renameProject(ownerKey: string, id: string, name: string): Promise<ClaudeCliProject> {
    const metadata = await this.findOwnedProject(ownerKey, id);
    const normalizedName = normalizeName(name, "项目名称");
    metadata.name = normalizedName;
    for (const managed of this.sessions.values()) {
      if (managed.ownerKey === ownerKey && managed.metadata.id === metadata.id) managed.metadata.name = normalizedName;
    }
    await this.writeMetadata(this.projectPath(ownerKey, metadata.id), metadata);
    return this.toPublicProject(ownerKey, metadata);
  }

  async renameSession(ownerKey: string, id: string, sessionId: string, name: string): Promise<ClaudeCliProject> {
    const metadata = await this.findOwnedProject(ownerKey, id);
    const cwd = this.projectPath(ownerKey, metadata.id);
    const sessions = await this.ensureSessions(metadata, cwd);
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) throw new Error("Claude CLI 会话不存在");
    session.name = normalizeName(name, "会话名称");
    const managed = this.sessions.get(this.sessionKey(ownerKey, metadata.id, session.id));
    if (managed) managed.session.name = session.name;
    metadata.sessions = sessions;
    await this.writeMetadata(cwd, metadata);
    return this.toPublicProject(ownerKey, metadata);
  }

  async deleteSession(ownerKey: string, id: string, sessionId: string): Promise<ClaudeCliProject> {
    const metadata = await this.findOwnedProject(ownerKey, id);
    const cwd = this.projectPath(ownerKey, metadata.id);
    const sessions = await this.ensureSessions(metadata, cwd);
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) throw new Error("Claude CLI 会话不存在");

    const key = this.sessionKey(ownerKey, metadata.id, session.id);
    const managed = this.sessions.get(key);
    if (managed?.starting) await managed.starting.catch(() => undefined);
    if (managed) await this.closePreviewProxies(managed);
    managed?.listeners.clear();
    managed?.process?.kill();
    if (managed) await this.closeGatewayCompatibility(managed);
    this.sessions.delete(key);

    metadata.sessions = sessions.filter((entry) => entry.id !== session.id);
    await this.writeMetadata(cwd, metadata);
    return this.toPublicProject(ownerKey, metadata);
  }

  async openTerminal(ownerKey: string, id: string, connection: GitLabConnection | null, cols?: number, rows?: number, sessionId?: string, restart = false): Promise<ClaudeCliTerminalConnection> {
    const metadata = await this.findOwnedProject(ownerKey, id);
    if (metadata.repositoryPath && !connection) throw new Error("请先连接 GitLab，再打开代码工作区");
    const sessions = await this.ensureSessions(metadata, this.projectPath(ownerKey, metadata.id));
    const sessionMetadata = sessions.find((session) => session.id === sessionId) ?? (sessionId ? undefined : sessions[0]);
    if (!sessionMetadata) throw new Error("Claude CLI 会话不存在");
    const key = this.sessionKey(ownerKey, metadata.id, sessionMetadata.id);
    const session = this.sessions.get(key) ?? {
      ownerKey,
      metadata,
      session: sessionMetadata,
      cwd: this.projectPath(ownerKey, metadata.id),
      process: null,
      starting: null,
      connection,
      output: "",
      listeners: new Set(),
      previewProxies: new Map(),
      previewStarting: new Map(),
    } satisfies ManagedSession;
    if (connection) session.connection = connection;
    this.sessions.set(key, session);
    if (restart) {
      if (session.starting) await session.starting.catch(() => undefined);
      if (session.process) {
        await this.closePreviewProxies(session);
        const process = session.process;
        session.process = null;
        process.kill();
        await this.closeGatewayCompatibility(session);
      }
    }
    await this.ensureStarted(session, cols, rows);
    return {
      project: this.toPublicProject(ownerKey, metadata),
      onEvent: (listener) => {
        session.listeners.add(listener);
        if (session.output) listener({ type: "output", data: session.output });
        return () => session.listeners.delete(listener);
      },
      write: (data) => session.process?.write(data),
      resize: (nextCols, nextRows) => {
        if (!session.process) return;
        session.process.resize(clampTerminalSize(nextCols, 120, 400), clampTerminalSize(nextRows, 32, 200));
      },
      stop: () => this.stop(ownerKey, metadata.id, sessionMetadata.id),
    };
  }

  async listPreviewPorts(ownerKey: string, id: string, sessionId: string): Promise<ClaudeCliPreviewEndpoint[]> {
    const metadata = await this.findOwnedProject(ownerKey, id);
    const sessions = await this.ensureSessions(metadata, this.projectPath(ownerKey, metadata.id));
    const sessionMetadata = sessions.find((session) => session.id === sessionId);
    if (!sessionMetadata) throw new Error("Claude CLI 会话不存在");
    const managed = this.sessions.get(this.sessionKey(ownerKey, metadata.id, sessionMetadata.id));
    if (!managed?.process) return [];
    await this.refreshPreviewPorts(managed);
    return [...managed.previewProxies.values()].map(({ port, proxyPort, token, protocol }) => ({ port, proxyPort, token, protocol }));
  }

  async stop(ownerKey: string, id: string, sessionId?: string): Promise<ClaudeCliProject> {
    const metadata = await this.findOwnedProject(ownerKey, id);
    const sessionEntries = await this.ensureSessions(metadata, this.projectPath(ownerKey, metadata.id));
    const sessions = sessionId ? sessionEntries.filter((session) => session.id === sessionId) : sessionEntries;
    if (sessionId && sessions.length === 0) throw new Error("Claude CLI 会话不存在");
    for (const sessionEntry of sessions) this.sessions.get(this.sessionKey(ownerKey, metadata.id, sessionEntry.id))?.process?.kill();
    return this.toPublicProject(ownerKey, metadata, new Set(sessions.map((session) => session.id)));
  }

  async deleteProject(ownerKey: string, id: string): Promise<void> {
    const metadata = await this.findOwnedProject(ownerKey, id);
    const matchingSessions = [...this.sessions.entries()].filter(([, session]) => session.ownerKey === ownerKey && session.metadata.id === metadata.id);
    for (const [, session] of matchingSessions) {
      if (session.starting) await session.starting.catch(() => undefined);
      await this.closePreviewProxies(session);
      session.process?.kill();
      await this.closeGatewayCompatibility(session);
    }
    try {
      await rm(this.projectPath(ownerKey, metadata.id), { recursive: true, force: true });
    } finally {
      for (const [key] of matchingSessions) this.sessions.delete(key);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async (session) => {
      await this.closePreviewProxies(session);
      session.process?.kill();
      await this.closeGatewayCompatibility(session);
    }));
    this.sessions.clear();
  }

  private async refreshPreviewPorts(session: ManagedSession): Promise<void> {
    const targets = extractClaudeCliPreviewTargets(session.output);
    const availableTargets = new Map<number, ClaudeCliPreviewProtocol>();
    await Promise.all(targets.map(async ({ port, protocol }) => {
      if (await isClaudeCliPreviewTargetAvailable(port)) availableTargets.set(port, protocol);
    }));
    await Promise.all([...session.previewProxies.entries()].map(async ([port, existingProxy]) => {
      if (availableTargets.get(port) === existingProxy.protocol) return;
      session.previewProxies.delete(port);
      await existingProxy.close();
    }));
    await Promise.all([...availableTargets.entries()].map(async ([port, protocol]) => {
      const existingProxy = session.previewProxies.get(port);
      if (existingProxy?.protocol === protocol) return;
      if (existingProxy) {
        session.previewProxies.delete(port);
        await existingProxy.close();
      }
      const existing = session.previewStarting.get(port);
      if (existing) {
        await existing;
        return;
      }
      const starting = createClaudeCliPreviewProxy(port, this.previewHost, protocol);
      session.previewStarting.set(port, starting);
      try {
        session.previewProxies.set(port, await starting);
      } catch {
        // The CLI can print a port before the development server is ready.
        // The next terminal output or port poll will retry creation.
      } finally {
        if (session.previewStarting.get(port) === starting) session.previewStarting.delete(port);
      }
    }));
  }

  private async closePreviewProxies(session: ManagedSession): Promise<void> {
    await Promise.all([...session.previewStarting.values()].map((starting) => starting.catch(() => undefined)));
    session.previewStarting.clear();
    const proxies = [...session.previewProxies.values()];
    session.previewProxies.clear();
    await Promise.all(proxies.map((proxy) => proxy.close()));
  }

  private async closeGatewayCompatibility(session: ManagedSession): Promise<void> {
    const compatibility = session.gatewayCompatibility;
    session.gatewayCompatibility = undefined;
    await compatibility?.close();
  }

  private async ensureStarted(session: ManagedSession, cols?: number, rows?: number): Promise<void> {
    if (session.process) {
      session.process.resize(clampTerminalSize(cols, 120, 400), clampTerminalSize(rows, 32, 200));
      return;
    }
    if (session.starting) {
      await session.starting;
      return;
    }
    session.starting = this.spawn(session, cols, rows);
    try {
      await session.starting;
    } finally {
      session.starting = null;
    }
  }

  private async spawn(session: ManagedSession, cols?: number, rows?: number): Promise<void> {
    const configuredEnvironment = await this.settingsProvider();
    const env: Record<string, string | undefined> = {
      ...buildClaudeCliEnvironment(process.env, this.environment, configuredEnvironment),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
    alignRuntimePath(env);
    if (session.metadata.repositoryPath && session.connection) {
      const gitEnvironment = await this.gitEnvironment(session.cwd, session.connection.token);
      env.GIT_TERMINAL_PROMPT = gitEnvironment.GIT_TERMINAL_PROMPT;
      env.GIT_ASKPASS = gitEnvironment.GIT_ASKPASS;
      env.GITLAB_REVIEW_TOKEN = gitEnvironment.GITLAB_REVIEW_TOKEN;
    }
    const shell = process.platform === "win32"
      ? env.ComSpec?.trim() || "cmd.exe"
      : env.SHELL?.trim() || "/bin/sh";
    const canResume = await this.hasClaudeConversation(session.cwd, session.session.cliSessionId, env);
    if (!canResume) session.session.cliSessionId = randomUUID();
    const launchArgs = canResume
      ? ["--resume", session.session.cliSessionId]
      : ["--session-id", session.session.cliSessionId, "--name", session.session.name];
    const launch = terminalLaunch(shell, this.command, launchArgs, path.dirname(process.execPath));
    await this.writeMetadata(session.cwd, session.metadata);
    session.output = "";
    let gatewayCompatibility: ClaudeGatewayCompatibilityHandle | undefined;
    try {
      gatewayCompatibility = await prepareClaudeGatewayCompatibility(env);
      const child = pty.spawn(launch.file, launch.args, {
        name: "xterm-256color",
        cols: clampTerminalSize(cols, 120, 400),
        rows: clampTerminalSize(rows, 32, 200),
        cwd: session.cwd,
        env: gatewayCompatibility.environment,
      });
      session.gatewayCompatibility = gatewayCompatibility;
      session.process = child;
      child.onData((data) => {
        session.output = trimOutput(`${session.output}${data}`);
        void this.refreshPreviewPorts(session);
        this.emit(session, { type: "output", data });
      });
      child.onExit(({ exitCode, signal }) => {
        if (session.process !== child) return;
        session.process = null;
        void this.closePreviewProxies(session);
        void this.closeGatewayCompatibility(session);
        this.emit(session, { type: "exit", exitCode, signal });
      });
    } catch (error) {
      if (session.gatewayCompatibility === gatewayCompatibility) session.gatewayCompatibility = undefined;
      await gatewayCompatibility?.close();
      const message = `无法启动 Claude CLI 终端（${this.command}）：${error instanceof Error ? error.message : String(error)}`;
      this.emit(session, { type: "error", message });
      throw new Error(message, { cause: error });
    }
  }

  private async initializeRepository(cwd: string, source: ClaudeCliRepositorySource | undefined, environment: NodeJS.ProcessEnv): Promise<void> {
    await this.runGit(["init", "--quiet"], cwd, environment);
    if (!source) return;
    await this.runGit(["remote", "add", "origin", repositoryUrl(source.connection.apiBaseUrl, source.projectPath)], cwd, environment);
    if (source.defaultBranch) {
      await this.runGit(["fetch", "--no-tags", "--depth", String(this.fetchDepth), "origin", source.defaultBranch], cwd, environment);
      await this.runGit(["checkout", "--quiet", "-b", source.defaultBranch, "--track", `origin/${source.defaultBranch}`], cwd, environment);
      return;
    }
    await this.runGit(["fetch", "--no-tags", "--depth", String(this.fetchDepth), "origin", "HEAD"], cwd, environment);
    await this.runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], cwd, environment);
  }

  private async configureGitIdentity(cwd: string, username: string, environment: NodeJS.ProcessEnv): Promise<void> {
    await this.runGit(["config", "user.name", username.trim() || "Claude CLI 用户"], cwd, environment);
    await this.runGit(["config", "user.email", `${safeSegment(username || "user")}@localhost`], cwd, environment);
  }

  private async gitEnvironment(cwd: string, token: string): Promise<NodeJS.ProcessEnv> {
    const askpassPath = path.join(cwd, GITLAB_ASKPASS_FILE);
    await writeFile(askpassPath, askpassScript(), { mode: 0o700 });
    await chmod(askpassPath, 0o700);
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askpassPath,
      GITLAB_REVIEW_TOKEN: token,
    };
  }

  private async excludeInternalFiles(cwd: string): Promise<void> {
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    let content = "";
    try {
      content = await readFile(excludePath, "utf8");
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    const missing = INTERNAL_GIT_FILES.filter((file) => !content.split(/\r?\n/).includes(file));
    if (missing.length > 0) await writeFile(excludePath, `${content}${content && !content.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  }

  private async findOwnedProject(ownerKey: string, id: string): Promise<ProjectMetadata> {
    const normalizedId = projectId(id);
    const metadata = await this.readMetadata(this.projectPath(ownerKey, normalizedId));
    if (!metadata || metadata.id !== normalizedId) throw new Error("Claude CLI 项目不存在");
    return metadata;
  }

  private async readMetadata(cwd: string): Promise<ProjectMetadata | null> {
    try {
      const value: unknown = JSON.parse(await readFile(path.join(cwd, PROJECT_METADATA_FILE), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const metadata = value as Partial<ProjectMetadata>;
      if (typeof metadata.id !== "string" || typeof metadata.name !== "string" || typeof metadata.createdAt !== "string") return null;
      return {
        id: metadata.id,
        name: metadata.name,
        createdAt: metadata.createdAt,
        ...(typeof metadata.repositoryPath === "string" && metadata.repositoryPath.trim() ? { repositoryPath: metadata.repositoryPath.trim() } : {}),
        ...(metadata.defaultBranch === null || typeof metadata.defaultBranch === "string" ? { defaultBranch: metadata.defaultBranch } : {}),
        ...(Array.isArray(metadata.sessions) ? { sessions: metadata.sessions.flatMap((session) => this.parseSessionMetadata(session)) } : {}),
      };
    } catch (error) {
      if (isMissingPath(error)) return null;
      return null;
    }
  }

  private async writeMetadata(cwd: string, metadata: ProjectMetadata): Promise<void> {
    await writeFile(path.join(cwd, PROJECT_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  }

  private async runGit(args: string[], cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    await execFile("git", args, { cwd, env: environment, maxBuffer: 2 * 1024 * 1024 });
  }

  private projectPath(ownerKey: string, id: string): string {
    return path.join(this.ownerPath(ownerKey), projectId(id));
  }

  private ownerPath(ownerKey: string): string {
    return path.join(this.rootDir, safeSegment(ownerKey));
  }

  private newSessionMetadata(index: number): SessionMetadata {
    const id = randomUUID();
    return {
      id,
      name: `会话 ${index}`,
      createdAt: new Date().toISOString(),
      cliSessionId: id,
    };
  }

  private parseSessionMetadata(value: unknown): SessionMetadata[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const session = value as Partial<SessionMetadata>;
    if (typeof session.id !== "string" || !/^[a-f0-9-]{36}$/iu.test(session.id) || typeof session.name !== "string" || !session.name.trim() || typeof session.createdAt !== "string" || typeof session.cliSessionId !== "string" || !/^[a-f0-9-]{36}$/iu.test(session.cliSessionId)) return [];
    return [{
      id: session.id,
      name: session.name.trim(),
      createdAt: session.createdAt,
      cliSessionId: session.cliSessionId,
    }];
  }

  private sessionMetadata(metadata: ProjectMetadata): SessionMetadata[] {
    if (metadata.sessions) return metadata.sessions;
    return [{
      id: metadata.id,
      name: "主会话",
      createdAt: metadata.createdAt,
      cliSessionId: metadata.id,
    }];
  }

  private async ensureSessions(metadata: ProjectMetadata, cwd: string): Promise<SessionMetadata[]> {
    const sessions = this.sessionMetadata(metadata);
    if (!metadata.sessions) {
      metadata.sessions = sessions;
      await this.writeMetadata(cwd, metadata);
    }
    return sessions;
  }

  private sessionKey(ownerKey: string, projectIdValue: string, sessionId: string): string {
    return `${safeSegment(ownerKey)}:${projectIdValue}:${sessionId}`;
  }

  private isRunning(ownerKey: string, projectIdValue: string, sessionId: string): boolean {
    return Boolean(this.sessions.get(this.sessionKey(ownerKey, projectIdValue, sessionId))?.process);
  }

  private toPublicSession(ownerKey: string, metadata: ProjectMetadata, session: SessionMetadata, stoppedSessionIds = new Set<string>()): ClaudeCliSession {
    return {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      status: stoppedSessionIds.has(session.id) ? "stopped" : this.isRunning(ownerKey, metadata.id, session.id) ? "running" : "stopped",
    };
  }

  private toPublicProject(ownerKey: string, metadata: ProjectMetadata, stoppedSessionIds = new Set<string>()): ClaudeCliProject {
    const sessions = this.sessionMetadata(metadata).map((session) => this.toPublicSession(ownerKey, metadata, session, stoppedSessionIds));
    return {
      id: metadata.id,
      name: metadata.name,
      createdAt: metadata.createdAt,
      cwd: this.projectPath(ownerKey, metadata.id),
      status: sessions.some((session) => session.status === "running") ? "running" : "stopped",
      sessions,
    };
  }

  private emit(session: ManagedSession, event: ClaudeCliTerminalEvent): void {
    for (const listener of session.listeners) listener(event);
  }

  private async hasClaudeConversation(cwd: string, cliSessionId: string, environment: Record<string, string | undefined>): Promise<boolean> {
    const configDir = environment.CLAUDE_CONFIG_DIR?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(environment.HOME?.trim() || process.env.HOME?.trim() || homedir(), ".claude");
    const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    try {
      const content = await readFile(path.join(configDir, "projects", projectDir, `${cliSessionId}.jsonl`), "utf8");
      return content.split(/\r?\n/).some((line) => {
        if (!line.trim()) return false;
        try {
          const entry: unknown = JSON.parse(line);
          return Boolean(entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { type?: unknown }).type === "user");
        } catch {
          return false;
        }
      });
    } catch (error) {
      if (isMissingPath(error)) return false;
      return false;
    }
  }
}

function normalizeRepositoryPath(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/u.test(segment))) {
    throw new Error("GitLab 项目路径无效");
  }
  return normalized;
}

function normalizeBranch(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.startsWith("-") || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}
