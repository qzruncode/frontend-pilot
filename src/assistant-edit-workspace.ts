import { execFile as execFileCallback, type ExecFileOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitLabConnection } from "./gitlab-connection.js";
import {
  askpassScript,
  cleanupWorkspace,
  repositoryUrl,
  safeSegment,
  type CommandRunner,
} from "./review-workspace.js";

const MAX_PATCH_BYTES = 160_000;
const MAX_DIFF_BYTES = 500_000;

const execFile: CommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFileCallback(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) {
      reject(error);
      return;
    }
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

export interface AssistantEditWorkspaceInput {
  ownerKey: string;
  sessionId: string;
  projectId: string;
  projectPath: string;
  baseRef: string;
  connection: GitLabConnection;
}

export interface AssistantEditWorkspace {
  path: string;
  baseSha: string;
  dispose(): Promise<void>;
}

export interface AssistantEditWorkspaceProviderOptions {
  environment?: Record<string, string | undefined>;
  rootDir: string;
  fetchDepth?: number;
  runCommand?: CommandRunner;
}

export interface AssistantEditPublishInput {
  baseSha: string;
  /** The MR head that a repair commit must advance atomically. */
  expectedRemoteSha?: string | null;
  branch: string;
  title: string;
  description: string;
  author: { name: string; email: string };
  connection: GitLabConnection;
  signal?: AbortSignal;
  validate: () => void;
  onCommitted: (sha: string) => void;
}

export class AssistantEditWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantEditWorkspaceError";
  }
}

function commandError(error: unknown, token: string): Error {
  const value = error instanceof Error ? error.message : String(error);
  const redacted = token ? value.replaceAll(token, "[redacted]") : value;
  return new Error(redacted, { cause: error });
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return `${Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8")}\n\n[diff truncated]`;
}

function normalizePatchPath(value: string): string {
  const trimmed = value.trim().replace(/^"|"$/g, "");
  if (trimmed === "/dev/null") return trimmed;
  const withoutPrefix = trimmed.replace(/^[ab]\//, "");
  if (!withoutPrefix || withoutPrefix.startsWith("/") || withoutPrefix.split("/").some((part) => part === "..")) {
    throw new AssistantEditWorkspaceError("补丁路径必须位于当前项目工作区内");
  }
  if (withoutPrefix === ".git" || withoutPrefix.startsWith(".git/")) {
    throw new AssistantEditWorkspaceError("不允许修改 Git 元数据");
  }
  if (withoutPrefix === ".gitlab-askpass.sh" || withoutPrefix.startsWith(".frontend-pilot-")) {
    throw new AssistantEditWorkspaceError("不允许修改编辑工作区的内部文件");
  }
  return withoutPrefix;
}

function isWorkspaceInternalPath(value: string): boolean {
  const normalized = value.trim().replace(/^"|"$/g, "");
  return normalized === ".gitlab-askpass.sh" || normalized.startsWith(".frontend-pilot-");
}

function hasUnstagedWorkspaceChanges(status: string): boolean {
  return status.split("\0").some((entry) => {
    if (!entry || entry.length < 3) return false;
    const filePath = entry.slice(3).split(" -> ").at(-1) ?? "";
    if (isWorkspaceInternalPath(filePath)) return false;
    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    return indexStatus === "?" || worktreeStatus !== " ";
  });
}

function patchTargetPath(patch: string): string {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const diffHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diffHeader) {
      const oldPath = normalizePatchPath(diffHeader[1]);
      const newPath = normalizePatchPath(diffHeader[2]);
      if (oldPath !== "/dev/null") paths.add(oldPath);
      if (newPath !== "/dev/null") paths.add(newPath);
      continue;
    }
    const fileHeader = /^(?:---|\+\+\+) (.+?)(?:\t.*)?$/.exec(line);
    if (!fileHeader) continue;
    const filePath = normalizePatchPath(fileHeader[1]);
    if (filePath !== "/dev/null") paths.add(filePath);
  }
  if (paths.size !== 1) throw new AssistantEditWorkspaceError("一次补丁只能修改一个文件");
  return [...paths][0];
}

function normalizeUnifiedDiff(patch: string): string {
  const lines = patch.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[index]);
    if (!match) continue;
    let oldCount = 0;
    let newCount = 0;
    let bodyLines = 0;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.startsWith("@@ ") || line.startsWith("diff --git ")) break;
      if (line.startsWith("\\ No newline at end of file")) continue;
      const marker = line[0];
      if (marker !== " " && marker !== "+" && marker !== "-") break;
      bodyLines += 1;
      if (marker === " ") {
        oldCount += 1;
        newCount += 1;
      } else if (marker === "+") {
        newCount += 1;
      } else {
        oldCount += 1;
      }
    }
    if (bodyLines === 0) continue;
    const formatRange = (start: string, count: number) => count === 1 ? start : `${start},${count}`;
    lines[index] = `@@ -${formatRange(match[1], oldCount)} +${formatRange(match[3], newCount)} @@${match[5]}`;
  }
  return lines.join("\n");
}

function resolveWorkspacePath(workspacePath: string, relativePath: string): string {
  const normalized = normalizePatchPath(relativePath);
  if (normalized === "/dev/null") throw new AssistantEditWorkspaceError("文件路径无效");
  const root = path.resolve(workspacePath);
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new AssistantEditWorkspaceError("文件路径必须位于当前项目工作区内");
  }
  return target;
}

async function fileSha256(workspacePath: string, relativePath: string): Promise<string | null> {
  const target = resolveWorkspacePath(workspacePath, relativePath);
  const root = path.resolve(workspacePath);
  let current = root;
  try {
    if ((await lstat(current)).isSymbolicLink()) throw new AssistantEditWorkspaceError("不允许通过符号链接访问工作区外的文件");
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new AssistantEditWorkspaceError("不允许通过符号链接访问工作区外的文件");
    } catch (error) {
      if (isMissingPath(error)) return null;
      throw error;
    }
  }
  try {
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new AssistantEditWorkspaceError("只允许修改普通文件");
    const content = await readFile(target);
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

export class GitAssistantEditWorkspaceProvider {
  private readonly rootDir: string;
  private readonly environment: Record<string, string | undefined>;
  private readonly fetchDepth: number;
  private readonly runCommand: CommandRunner;
  private readonly diffLocks = new Map<string, Promise<void>>();

  constructor({
    environment = {},
    rootDir,
    fetchDepth = 50,
    runCommand = execFile,
  }: AssistantEditWorkspaceProviderOptions) {
    this.rootDir = path.resolve(rootDir);
    this.environment = environment;
    this.fetchDepth = Math.max(1, fetchDepth);
    this.runCommand = runCommand;
  }

  async create(input: AssistantEditWorkspaceInput, { signal }: { signal?: AbortSignal } = {}): Promise<AssistantEditWorkspace> {
    const workspacePath = path.join(
      this.rootDir,
      safeSegment(input.ownerKey),
      safeSegment(input.projectId),
      safeSegment(input.sessionId),
    );
    const askpassPath = path.join(workspacePath, ".gitlab-askpass.sh");
    const environment: Record<string, string | undefined> = {
      ...process.env,
      ...this.environment,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askpassPath,
      GITLAB_REVIEW_TOKEN: input.connection.token,
    };
    const commandOptions: ExecFileOptions & { signal?: AbortSignal } = {
      cwd: workspacePath,
      env: environment,
      maxBuffer: 8 * 1024 * 1024,
      signal,
    };
    const runGit = async (args: string[]) => this.runCommand("git", args, commandOptions);
    try {
      await mkdir(path.dirname(workspacePath), { recursive: true });
      await mkdir(workspacePath, { recursive: false });
      await writeFile(askpassPath, askpassScript(), { mode: 0o700 });
      await runGit(["init", "--quiet"]);
      await runGit(["remote", "add", "origin", repositoryUrl(input.connection.apiBaseUrl, input.projectPath)]);
      await runGit(["fetch", "--no-tags", "--depth", String(this.fetchDepth), "origin", input.baseRef]);
      await runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
      const baseSha = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
      if (!/^[a-f0-9]{7,64}$/i.test(baseSha)) throw new AssistantEditWorkspaceError("GitLab 返回了无效的基线提交");
      let ready = true;
      return {
        path: workspacePath,
        baseSha,
        dispose: async () => {
          if (!ready) return;
          ready = false;
          await cleanupWorkspace(workspacePath, null);
        },
      };
    } catch (error) {
      try {
        await cleanupWorkspace(workspacePath, null);
      } catch (cleanupError) {
        throw new Error(
          `编辑工作区初始化失败：${commandError(error, input.connection.token).message}；清理失败：${commandError(cleanupError, input.connection.token).message}`,
          { cause: error },
        );
      }
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new Error(`编辑工作区初始化失败：${commandError(error, input.connection.token).message}`, { cause: error });
    }
  }

  async exists(workspacePath: string): Promise<boolean> {
    try {
      return (await stat(workspacePath)).isDirectory();
    } catch (error) {
      if (isMissingPath(error)) return false;
      throw error;
    }
  }

  async dispose(workspacePath: string): Promise<void> {
    await cleanupWorkspace(workspacePath, null);
  }

  async fileSha256(workspacePath: string, relativePath: string): Promise<string | null> {
    return fileSha256(workspacePath, relativePath);
  }

  async checkPatch(workspacePath: string, relativePath: string, patch: string): Promise<string> {
    const normalizedPatch = normalizeUnifiedDiff(patch);
    this.assertPatch(relativePath, normalizedPatch);
    await this.withPatchFile(workspacePath, normalizedPatch, async (patchPath, runGit) => {
      await runGit(["apply", "--check", "--whitespace=nowarn", patchPath]);
    });
    return normalizedPatch;
  }

  async applyPatch(workspacePath: string, relativePath: string, patch: string): Promise<void> {
    const normalizedPatch = normalizeUnifiedDiff(patch);
    this.assertPatch(relativePath, normalizedPatch);
    await this.withPatchFile(workspacePath, normalizedPatch, async (patchPath, runGit) => {
      await runGit(["apply", "--index", "--whitespace=nowarn", patchPath]);
    });
  }

  async diff(workspacePath: string): Promise<{ diff: string; changedFiles: number }> {
    const previous = this.diffLocks.get(workspacePath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.diffLocks.set(workspacePath, current);
    await previous;
    try {
      const commandOptions: ExecFileOptions = { cwd: workspacePath, env: { ...process.env, ...this.environment }, maxBuffer: 8 * 1024 * 1024 };
      const status = await this.runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], commandOptions);
      if (hasUnstagedWorkspaceChanges(status.stdout)) await this.stageWorkspace(workspacePath, commandOptions);
      const result = await this.runCommand("git", ["diff", "--cached", "--no-ext-diff", "--binary"], commandOptions);
      const names = await this.runCommand("git", ["diff", "--cached", "--name-only", "-z"], commandOptions);
      return {
        diff: truncate(result.stdout, MAX_DIFF_BYTES),
        changedFiles: names.stdout.split("\0").map((item) => item.trim()).filter(Boolean).length,
      };
    } finally {
      release();
      if (this.diffLocks.get(workspacePath) === current) this.diffLocks.delete(workspacePath);
    }
  }

  async publish(workspacePath: string, input: AssistantEditPublishInput): Promise<string> {
    const options = { cwd: workspacePath, maxBuffer: 8 * 1024 * 1024, signal: input.signal,
      env: { ...process.env, ...this.environment, GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: path.join(workspacePath, ".gitlab-askpass.sh"), GITLAB_REVIEW_TOKEN: input.connection.token } };
    const git = (args: string[]) => this.runCommand("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], options);
    const check = () => { input.signal?.throwIfAborted(); input.validate(); };
    try {
      check();
      await git(["check-ref-format", "--branch", input.branch]);
      const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
      let parentSha: string | null = null;
      if (head === input.baseSha) {
        if (!(await this.diff(workspacePath)).changedFiles) throw new AssistantEditWorkspaceError("助手没有产生代码改动，未创建 MR");
        check();
        await git(["-c", `user.name=${input.author.name}`, "-c", `user.email=${input.author.email}`,
          "commit", "--quiet", "-m", input.title, "-m", input.description]);
        parentSha = input.baseSha;
      } else {
        // An interrupted publication can resume only the exact commit made for this task.
        parentSha = (await git(["rev-parse", "HEAD^"])).stdout.trim();
        const subject = (await git(["show", "-s", "--format=%s", "HEAD"])).stdout.trim();
        const stagedChanges = (await this.diff(workspacePath)).changedFiles;
        const interruptedFirstPublication = parentSha === input.baseSha && subject === input.title && !stagedChanges;
        const interruptedRepairPublication = input.expectedRemoteSha !== undefined
          && parentSha === input.expectedRemoteSha && subject === input.title && !stagedChanges;
        if (!interruptedFirstPublication && !interruptedRepairPublication) {
          if (input.expectedRemoteSha !== undefined && head === input.expectedRemoteSha && stagedChanges > 0) {
            parentSha = input.expectedRemoteSha;
            check();
            await git(["-c", `user.name=${input.author.name}`, "-c", `user.email=${input.author.email}`,
              "commit", "--quiet", "-m", input.title, "-m", input.description]);
          } else {
            throw new AssistantEditWorkspaceError("工作区提交已变化，不能继续发布");
          }
        }
      }
      const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
      input.onCommitted(sha);
      check();
      const ref = `refs/heads/${input.branch}`;
      const remoteSha = (await git(["ls-remote", "--heads", "origin", ref])).stdout.trim().split(/\s/)[0];
      const expectedRemoteSha = input.expectedRemoteSha ?? null;
      if (remoteSha === sha) return sha;
      if (input.expectedRemoteSha === undefined && remoteSha) {
        throw new AssistantEditWorkspaceError("目标分支已有其他提交，未覆盖远端修改");
      }
      if (expectedRemoteSha !== null && remoteSha !== expectedRemoteSha) {
        throw new AssistantEditWorkspaceError("目标分支已有其他提交，未覆盖远端修改");
      }
      if (remoteSha && remoteSha !== (parentSha ?? input.baseSha)) {
        throw new AssistantEditWorkspaceError("目标分支已有其他提交，未覆盖远端修改");
      }
      if (!remoteSha && expectedRemoteSha !== null) {
        throw new AssistantEditWorkspaceError("目标分支已被删除，未继续发布");
      }
      if (!remoteSha || expectedRemoteSha !== null) {
        check();
        const lease = expectedRemoteSha === null ? `${ref}:` : `${ref}:${expectedRemoteSha}`;
        await git(["push", `--force-with-lease=${lease}`, "origin", `${sha}:${ref}`]);
      }
      return sha;
    } catch (error) {
      throw commandError(error, input.connection.token);
    }
  }

  private assertPatch(relativePath: string, patch: string): void {
    if (!patch.trim() || Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
      throw new AssistantEditWorkspaceError(`补丁不能为空且不能超过 ${MAX_PATCH_BYTES} 字节`);
    }
    const target = patchTargetPath(patch);
    if (normalizePatchPath(relativePath) !== target) throw new AssistantEditWorkspaceError("补丁路径与目标文件不一致");
  }

  private async stageWorkspace(workspacePath: string, commandOptions: ExecFileOptions): Promise<void> {
    await this.runCommand("git", [
      "add",
      "-A",
      "--",
      ".",
      ":(exclude).gitlab-askpass.sh",
      ":(exclude).frontend-pilot-*",
    ], commandOptions);
  }

  private async withPatchFile<T>(
    workspacePath: string,
    patch: string,
    operation: (patchPath: string, runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>) => Promise<T>,
  ): Promise<T> {
    const patchPath = path.join(workspacePath, `.frontend-pilot-patch-${randomUUID()}.diff`);
    const commandOptions: ExecFileOptions = { cwd: workspacePath, env: { ...process.env, ...this.environment }, maxBuffer: 8 * 1024 * 1024 };
    const runGit = async (args: string[]) => this.runCommand("git", args, commandOptions);
    await writeFile(patchPath, patch, { mode: 0o600 });
    try {
      return await operation(patchPath, runGit);
    } finally {
      await unlink(patchPath).catch(() => undefined);
    }
  }
}

export { MAX_PATCH_BYTES };
