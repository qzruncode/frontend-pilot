import { execFile as execFileCallback, type ExecFileOptions } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isMissingFileError } from "./errors.js";

const FETCH_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const FETCH_HTTP_LOW_SPEED_LIMIT_BYTES_PER_SECOND = "1024";
const FETCH_HTTP_LOW_SPEED_TIME_SECONDS = "120";
const TRANSIENT_GIT_FETCH_ERROR = /(?:curl\s+56\b|recv failure|send failure|connection reset|connection refused|connection timed out|connection aborted|failed to connect|could not connect to server|remote end hung up unexpectedly|unexpected disconnect|early eof|rpc failed|operation too slow|low speed|econnreset|econnrefused|etimedout|timed out|temporary failure in name resolution|could not resolve host|network is unreachable|requested url returned error:\s*5\d{2})/i;

const execFile: CommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFileCallback(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) {
      reject(error);
      return;
    }
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

export interface ReviewWorkspaceInput {
  jobId: string;
  projectId: string;
  projectPath: string | null;
  sourceProjectPath: string | null;
  targetProjectPath: string | null;
  mrIid: string;
  targetBranch: string | null;
  headSha: string | null;
}

export interface ReviewWorkspace {
  path: string;
  /** Git authentication variables used by tools running inside this workspace. */
  gitEnvironment?: Record<string, string | undefined>;
  dispose(): Promise<void>;
}

export interface ReviewWorkspaceProvider {
  /** Acquire the persistent workspace for an MR, updating its checked-out refs when needed. */
  create(input: ReviewWorkspaceInput, options?: { signal?: AbortSignal }): Promise<ReviewWorkspace>;
  /** Remove the persistent workspace when the MR session reaches its terminal lifecycle. */
  disposeReview?(input: Pick<ReviewWorkspaceInput, "projectId" | "mrIid">): Promise<void>;
  updateConnection?(connection: { gitlabApiBaseUrl: string; gitlabToken: string }): void;
}

export interface RepositoryWorkspaceInput {
  jobId: string;
  projectId: string;
  projectPath: string;
  branch: string;
  headSha: string;
}

export interface RepositoryWorkspaceProvider {
  createRepository(input: RepositoryWorkspaceInput, options?: { signal?: AbortSignal }): Promise<ReviewWorkspace>;
}

export type CommandRunner = (
  file: string,
  args: string[],
  options: ExecFileOptions & { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export interface GitReviewWorkspaceProviderOptions {
  environment?: Record<string, string | undefined>;
  rootDir: string;
  gitlabApiBaseUrl: string;
  gitlabToken: string;
  /** Review workspaces should behave like a normal local clone, including complete history and refs. */
  fullHistory?: boolean;
  fetchDepth?: number;
  claudeTrustFile?: string;
  runCommand?: CommandRunner;
}

type TrustProject = Record<string, unknown>;
type ClaudeTrustConfig = Record<string, unknown> & { projects?: Record<string, TrustProject> };

let trustFileQueue = Promise.resolve();

function withTrustFileLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = trustFileQueue.then(operation, operation);
  trustFileQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function readTrustConfig(filePath: string): Promise<ClaudeTrustConfig> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Claude trust file must contain an object");
    return value as ClaudeTrustConfig;
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }
}

async function writeTrustConfig(filePath: string, config: ClaudeTrustConfig): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export async function trustWorkspace(filePath: string, workspacePath: string): Promise<() => Promise<void>> {
  return withTrustFileLock(async () => {
    const config = await readTrustConfig(filePath);
    const projects = config.projects ?? {};
    const previous = projects[workspacePath];
    if (previous?.hasTrustDialogAccepted === true) return async () => undefined;

    projects[workspacePath] = { ...previous, hasTrustDialogAccepted: true };
    await writeTrustConfig(filePath, { ...config, projects });
    return async () => withTrustFileLock(async () => {
      const current = await readTrustConfig(filePath);
      const currentProjects = current.projects ?? {};
      if (previous) currentProjects[workspacePath] = previous;
      else delete currentProjects[workspacePath];
      await writeTrustConfig(filePath, { ...current, projects: currentProjects });
    });
  });
}

export function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return normalized || "unknown";
}

export function repositoryUrl(apiBaseUrl: string, projectPath: string): string {
  const parsed = new URL(apiBaseUrl);
  const apiSuffix = /\/api\/v4\/?$/.test(parsed.pathname) ? parsed.pathname.replace(/\/api\/v4\/?$/, "") : "";
  const rootPath = apiSuffix.replace(/\/+$/, "");
  const encodedProjectPath = projectPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `${parsed.origin}${rootPath}/${encodedProjectPath}.git`;
}

export function askpassScript(): string {
  return [
    "#!/bin/sh",
    "case \"$1\" in",
    "  *Username*) printf '%s\\n' \"oauth2\" ;;",
    "  *) printf '%s\\n' \"$GITLAB_REVIEW_TOKEN\" ;;",
    "esac",
    "",
  ].join("\n");
}

function commandError(error: unknown, token: string): Error {
  const value = error instanceof Error ? error.message : String(error);
  const redacted = token ? value.replaceAll(token, "[redacted]") : value;
  return new Error(redacted, { cause: error });
}

function commandErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== "object" || !("stderr" in error) || typeof error.stderr !== "string") return message;
  return message.includes(error.stderr) ? message : `${message}\n${error.stderr}`;
}

function isTransientGitFetchError(error: unknown): boolean {
  return TRANSIENT_GIT_FETCH_ERROR.test(commandErrorText(error));
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Git fetch retry was aborted", { cause: reason });
  error.name = "AbortError";
  return error;
}

function waitForFetchRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }

    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal ? abortError(signal) : new Error("Git fetch retry was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export async function cleanupWorkspace(
  workspacePath: string,
  restoreTrust: (() => Promise<void>) | null,
): Promise<void> {
  let restoreError: unknown;
  try {
    await restoreTrust?.();
  } catch (error) {
    restoreError = error;
  }

  let removeError: unknown;
  try {
    await rm(workspacePath, { recursive: true, force: true });
  } catch (error) {
    if (!isMissingPath(error)) removeError = error;
  }

  if (restoreError && removeError) throw new AggregateError([restoreError, removeError], "Review workspace cleanup failed");
  if (restoreError) throw restoreError;
  if (removeError) throw removeError;
}

export class GitReviewWorkspaceProvider implements ReviewWorkspaceProvider {
  private readonly rootDir: string;
  private readonly environment: Record<string, string | undefined>;
  private gitlabApiBaseUrl: string;
  private gitlabToken: string;
  private readonly fullHistory: boolean;
  private readonly fetchDepth: number;
  private readonly claudeTrustFile: string;
  private readonly runCommand: CommandRunner;
  private readonly workspaceOperations = new Map<string, Promise<ReviewWorkspace | void>>();
  private readonly trustRestorers = new Map<string, () => Promise<void>>();

  constructor({
    environment = {},
    rootDir,
    gitlabApiBaseUrl,
    gitlabToken,
    fullHistory = false,
    fetchDepth = 50,
    claudeTrustFile = path.join(homedir(), ".claude.json"),
    runCommand = execFile,
  }: GitReviewWorkspaceProviderOptions) {
    this.rootDir = path.resolve(rootDir);
    this.environment = environment;
    this.gitlabApiBaseUrl = gitlabApiBaseUrl;
    this.gitlabToken = gitlabToken;
    this.fullHistory = fullHistory;
    this.fetchDepth = Math.max(1, fetchDepth);
    this.claudeTrustFile = claudeTrustFile;
    this.runCommand = runCommand;
  }

  updateConnection({ gitlabApiBaseUrl, gitlabToken }: { gitlabApiBaseUrl: string; gitlabToken: string }): void {
    this.gitlabApiBaseUrl = gitlabApiBaseUrl;
    this.gitlabToken = gitlabToken;
  }

  async create(input: ReviewWorkspaceInput, { signal }: { signal?: AbortSignal } = {}): Promise<ReviewWorkspace> {
    if (!input.headSha) throw new Error("Cannot create review workspace without an MR head SHA");

    const headSha = input.headSha;
    const workspacePath = this.reviewWorkspacePath(input.projectId, input.mrIid);
    return this.withWorkspaceOperation(workspacePath, () => this.materialize({
      workspacePath,
      projectId: input.projectId,
      targetProjectPath: input.targetProjectPath || input.projectPath || input.projectId,
      sourceProjectPath: input.sourceProjectPath || input.targetProjectPath || input.projectPath || input.projectId,
      targetBranch: input.targetBranch,
      headSha,
      signal,
    }));
  }

  async disposeReview(input: Pick<ReviewWorkspaceInput, "projectId" | "mrIid">): Promise<void> {
    const workspacePath = this.reviewWorkspacePath(input.projectId, input.mrIid);
    await this.withWorkspaceOperation(workspacePath, async () => {
      const restoreTrust = this.trustRestorers.get(workspacePath) ?? null;
      await cleanupWorkspace(workspacePath, restoreTrust);
      this.trustRestorers.delete(workspacePath);
    });
  }

  async createRepository(input: RepositoryWorkspaceInput, { signal }: { signal?: AbortSignal } = {}): Promise<ReviewWorkspace> {
    if (!input.headSha) throw new Error("Cannot create repository workspace without a head SHA");
    return this.materialize({
      workspacePath: path.join(
        this.rootDir,
        safeSegment(input.projectId),
        "inspection",
        safeSegment(input.branch),
        safeSegment(input.headSha),
        safeSegment(input.jobId),
      ),
      projectId: input.projectId,
      targetProjectPath: input.projectPath,
      sourceProjectPath: input.projectPath,
      targetBranch: null,
      headSha: input.headSha,
      signal,
    });
  }

  private async materialize({
    workspacePath,
    projectId,
    targetProjectPath,
    sourceProjectPath,
    targetBranch,
    headSha,
    signal,
  }: {
    workspacePath: string;
    projectId: string;
    targetProjectPath: string;
    sourceProjectPath: string;
    targetBranch: string | null;
    headSha: string;
    signal?: AbortSignal;
  }): Promise<ReviewWorkspace> {
    const askpassPath = path.join(workspacePath, ".git", "frontend-pilot-askpass.sh");
    const gitEnvironment = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askpassPath,
      GITLAB_REVIEW_TOKEN: this.gitlabToken,
    };
    const environment = { ...this.environment, ...gitEnvironment };
    const commandOptions: ExecFileOptions & { signal?: AbortSignal } = {
      cwd: workspacePath,
      env: environment,
      maxBuffer: 8 * 1024 * 1024,
      signal,
    };
    const runGit = async (args: string[]) => {
      let attempts = 0;
      while (true) {
        attempts += 1;
        try {
          const fetchOptions = args[0] === "fetch"
            ? {
              ...commandOptions,
              env: {
                ...environment,
                GIT_HTTP_LOW_SPEED_LIMIT: FETCH_HTTP_LOW_SPEED_LIMIT_BYTES_PER_SECOND,
                GIT_HTTP_LOW_SPEED_TIME: FETCH_HTTP_LOW_SPEED_TIME_SECONDS,
              },
            }
            : commandOptions;
          return await this.runCommand("git", args, fetchOptions);
        } catch (error) {
          if (args[0] !== "fetch" || !isTransientGitFetchError(error)) throw error;
          const maxAttempts = FETCH_RETRY_DELAYS_MS.length + 1;
          if (attempts >= maxAttempts) {
            throw new Error(`git ${args.join(" ")} failed after ${attempts} attempts: ${commandErrorText(error)}`, { cause: error });
          }
          await waitForFetchRetry(FETCH_RETRY_DELAYS_MS[attempts - 1]!, signal);
        }
      }
    };
    let ready = false;
    let restoreTrust: (() => Promise<void>) | null = null;

    try {
      await mkdir(path.dirname(workspacePath), { recursive: true });
      await mkdir(workspacePath, { recursive: true });

      let initialized = false;
      try {
        await stat(path.join(workspacePath, ".git"));
        initialized = true;
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
      if (!initialized) await runGit(["init", "--quiet"]);

      await this.ensureRemote(runGit, "origin", repositoryUrl(this.gitlabApiBaseUrl, targetProjectPath));
      const headRemote = sourceProjectPath === targetProjectPath ? "origin" : "source";
      if (headRemote === "source") {
        await this.ensureRemote(runGit, "source", repositoryUrl(this.gitlabApiBaseUrl, sourceProjectPath));
      }

      let checkedOutSha = "";
      try {
        checkedOutSha = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
      } catch {
        // A newly initialized repository has no HEAD yet.
      }
      const status = await runGit(["status", "--porcelain"]);
      if (status.stdout.trim()) {
        await runGit(["reset", "--hard"]);
        await runGit(["clean", "-fdx"]);
      }
      await writeFile(askpassPath, askpassScript(), { mode: 0o700 });
      await chmod(askpassPath, 0o700);
      if (this.fullHistory) {
        await this.refreshFullHistory(runGit, headRemote, headSha, targetBranch);
        if (checkedOutSha !== headSha) await runGit(["checkout", "--quiet", "--detach", headSha]);
      } else {
        if (checkedOutSha !== headSha) {
          await runGit(["fetch", "--no-tags", "--depth", String(this.fetchDepth), headRemote, headSha]);
          await runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
        }

        if (targetBranch) {
          await runGit([
            "fetch",
            "--no-tags",
            "--depth",
            String(this.fetchDepth),
            "origin",
            `+${targetBranch}:refs/remotes/origin/${targetBranch}`,
          ]);
        }
      }

      const finalHeadSha = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
      if (finalHeadSha !== headSha) {
        throw new Error(`Review workspace checked out ${finalHeadSha}, expected ${headSha}`);
      }

      ready = true;
      restoreTrust = await trustWorkspace(this.claudeTrustFile, workspacePath);
      this.trustRestorers.set(workspacePath, restoreTrust);
      return {
        path: workspacePath,
        gitEnvironment,
        dispose: async () => {
          if (!ready) return;
          await cleanupWorkspace(workspacePath, restoreTrust);
          ready = false;
          this.trustRestorers.delete(workspacePath);
        },
      };
    } catch (error) {
      try {
        await cleanupWorkspace(workspacePath, restoreTrust);
      } catch (cleanupError) {
        const cleanupMessage = commandError(cleanupError, this.gitlabToken).message;
        const primaryMessage = commandError(error, this.gitlabToken).message;
        throw new Error(`Failed to materialize review workspace: ${primaryMessage}; cleanup failed: ${cleanupMessage}`, { cause: error });
      }
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new Error(`Failed to materialize review workspace: ${commandError(error, this.gitlabToken).message}`, { cause: error });
    }
  }

  private reviewWorkspacePath(projectId: string, mrIid: string): string {
    return path.join(this.rootDir, safeSegment(projectId), safeSegment(mrIid));
  }

  private async ensureRemote(
    runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
    name: string,
    url: string,
  ): Promise<void> {
    const remotes = (await runGit(["remote"])).stdout.split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean);
    if (remotes.includes(name)) await runGit(["remote", "set-url", name, url]);
    else await runGit(["remote", "add", name, url]);
  }

  private async refreshFullHistory(
    runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
    headRemote: string,
    headSha: string,
    targetBranch: string | null,
  ): Promise<void> {
    const remotes = [...new Set(["origin", headRemote])];
    const shallow = (await runGit(["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
    if (shallow) {
      // --all matters here: a persistent workspace can contain both target
      // and source remotes, and unshallowing only one would leave the other
      // remote's history incomplete.
      await runGit(["fetch", "--unshallow", "--all"]);
    } else {
      for (const remote of remotes) await runGit(["fetch", remote]);
    }

    // A merge-request head can be unavailable from the normal branch refspec
    // (for example after a source branch was deleted), so retain the explicit
    // SHA fetch as a fallback while keeping the normal fetch local-like.
    try {
      await runGit(["cat-file", "-e", `${headSha}^{commit}`]);
    } catch {
      await runGit(["fetch", headRemote, headSha]);
    }

    if (targetBranch) {
      try {
        await runGit(["rev-parse", `refs/remotes/origin/${targetBranch}`]);
      } catch {
        await runGit(["fetch", "origin", `+${targetBranch}:refs/remotes/origin/${targetBranch}`]);
      }
    }
  }

  private async withWorkspaceOperation<T extends ReviewWorkspace | void>(
    workspacePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.workspaceOperations.get(workspacePath) ?? Promise.resolve();
    let current!: Promise<T>;
    current = previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        if (this.workspaceOperations.get(workspacePath) === current) this.workspaceOperations.delete(workspacePath);
      });
    this.workspaceOperations.set(workspacePath, current);
    return current;
  }
}
