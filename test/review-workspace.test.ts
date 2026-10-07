import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitReviewWorkspaceProvider } from "../src/review-workspace.js";

describe("GitReviewWorkspaceProvider", () => {
  it("creates unique workspaces for concurrent jobs and cleans only its own directory", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-workspaces-"));
    const commands: Array<{ args: string[]; cwd?: string }> = [];
    const provider = new GitReviewWorkspaceProvider({
      rootDir,
      gitlabApiBaseUrl: "https://gitlab.example.com/api/v4",
      gitlabToken: "test-token",
      claudeTrustFile: path.join(rootDir, "claude.json"),
      runCommand: async (_file, args, options) => {
        commands.push({ args, cwd: options.cwd });
        if (args[0] === "init") await mkdir(path.join(String(options.cwd), ".git"), { recursive: true });
        return {
          stdout: args[0] === "rev-parse" ? "head-1\n" : "",
          stderr: "",
        };
      },
    });

    try {
      const [first, second] = await Promise.all([
        provider.create({
          jobId: "job-1",
          projectId: "16534",
          projectPath: "aip/ui/so-chart",
          sourceProjectPath: "aip/ui/so-chart",
          targetProjectPath: "aip/ui/so-chart",
          mrIid: "17",
          targetBranch: "dev",
          headSha: "head-1",
        }),
        provider.create({
          jobId: "job-2",
          projectId: "16534",
          projectPath: "aip/ui/other-chart",
          sourceProjectPath: "aip/ui/other-chart",
          targetProjectPath: "aip/ui/other-chart",
          mrIid: "18",
          targetBranch: "dev",
          headSha: "head-1",
        }),
      ]);

      expect(first.path).not.toBe(second.path);
      expect(first.path).toContain(path.join("16534", "17"));
      expect(second.path).toContain(path.join("16534", "18"));
      expect(first.gitEnvironment).toEqual(expect.objectContaining({
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: path.join(first.path, ".git", "frontend-pilot-askpass.sh"),
        GITLAB_REVIEW_TOKEN: "test-token",
      }));
      expect(commands.filter(({ args }) => args[0] === "fetch")).toHaveLength(2);
      expect(commands.filter(({ args }) => args[0] === "diff")).toHaveLength(0);
      expect(commands.every(({ cwd }) => cwd === first.path || cwd === second.path)).toBe(true);
      const trusted = JSON.parse(await readFile(path.join(rootDir, "claude.json"), "utf8")) as {
        projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      expect(Object.keys(trusted.projects ?? {})).toHaveLength(2);
      expect(Object.values(trusted.projects ?? {}).every((project) => project.hasTrustDialogAccepted)).toBe(true);

      await first.dispose();
      await expect(stat(second.path)).resolves.toBeTruthy();
      const oneTrusted = JSON.parse(await readFile(path.join(rootDir, "claude.json"), "utf8")) as {
        projects?: Record<string, unknown>;
      };
      expect(Object.keys(oneTrusted.projects ?? {})).toHaveLength(1);
      await second.dispose();
      await expect(stat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(second.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("prepares the target ref without executing a server-side diff", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-review-refs-"));
    const provider = new GitReviewWorkspaceProvider({
      rootDir,
      gitlabApiBaseUrl: "https://gitlab.example.com/api/v4",
      gitlabToken: "test-token",
      claudeTrustFile: path.join(rootDir, "claude.json"),
      runCommand: async (_file, args, options) => {
        if (args[0] === "init") await mkdir(path.join(String(options.cwd), ".git"), { recursive: true });
        return { stdout: args[0] === "rev-parse" ? "head-1\n" : "", stderr: "" };
      },
    });

    try {
      const workspace = await provider.create({
        jobId: "job-1",
        projectId: "16534",
        projectPath: "aip/ui/so-chart",
        sourceProjectPath: "aip/ui/so-chart",
        targetProjectPath: "aip/ui/so-chart",
        mrIid: "17",
        targetBranch: "dev",
        headSha: "head-1",
      });

      expect("diff" in workspace).toBe(false);
      await workspace.dispose();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("fetches a complete local-like repository for review workspaces", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-review-full-history-"));
    const commands: string[][] = [];
    const remoteNames = new Set<string>();
    let shallow = true;
    let checkedOutHead = "";
    const provider = new GitReviewWorkspaceProvider({
      rootDir,
      gitlabApiBaseUrl: "https://gitlab.example.com/api/v4",
      gitlabToken: "test-token",
      fullHistory: true,
      claudeTrustFile: path.join(rootDir, "claude.json"),
      runCommand: async (_file, args, options) => {
        commands.push(args);
        if (args[0] === "init") {
          await mkdir(path.join(String(options.cwd), ".git"), { recursive: true });
        } else if (args[0] === "remote") {
          if (args[1] === undefined) return { stdout: [...remoteNames].join("\n"), stderr: "" };
          if (args[1] === "add" && args[2]) remoteNames.add(args[2]);
        } else if (args[0] === "rev-parse") {
          if (args[1] === "--is-shallow-repository") return { stdout: `${shallow}\n`, stderr: "" };
          if (args[1] === "HEAD") return { stdout: `${checkedOutHead}\n`, stderr: "" };
          if (args[1]?.startsWith("refs/remotes/")) return { stdout: "target-ref\n", stderr: "" };
        } else if (args[0] === "fetch" && args[1] === "--unshallow") {
          shallow = false;
        } else if (args[0] === "checkout") {
          checkedOutHead = args[3] ?? "";
        }
        return { stdout: "", stderr: "" };
      },
    });

    try {
      const workspace = await provider.create({
        jobId: "job-1",
        projectId: "16534",
        projectPath: "aip/ui/so-chart",
        sourceProjectPath: "aip/fork/so-chart",
        targetProjectPath: "aip/ui/so-chart",
        mrIid: "17",
        targetBranch: "dev",
        headSha: "head-1",
      });

      const fetchCommands = commands.filter((args) => args[0] === "fetch");
      expect(fetchCommands).toEqual([
        ["fetch", "--unshallow", "--all"],
      ]);
      expect(fetchCommands.flat()).not.toContain("--depth");
      expect(fetchCommands.flat()).not.toContain("--no-tags");
      expect(commands).toContainEqual(["checkout", "--quiet", "--detach", "head-1"]);
      expect(commands.filter((args) => args[0] === "diff")).toHaveLength(0);
      await workspace.dispose();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retries a transient full-history fetch failure and continues preparing the workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-review-fetch-retry-"));
    const remoteNames = new Set<string>();
    let shallow = true;
    let checkedOutHead = "";
    let fetchAttempts = 0;
    const fetchLowSpeedSettings: Array<[string | undefined, string | undefined]> = [];
    const nonFetchLowSpeedSettings: Array<[string | undefined, string | undefined]> = [];
    const provider = new GitReviewWorkspaceProvider({
      rootDir,
      gitlabApiBaseUrl: "https://gitlab.example.com/api/v4",
      gitlabToken: "test-token",
      fullHistory: true,
      claudeTrustFile: path.join(rootDir, "claude.json"),
      runCommand: async (_file, args, options) => {
        const lowSpeedSettings: [string | undefined, string | undefined] = [
          options.env?.GIT_HTTP_LOW_SPEED_LIMIT,
          options.env?.GIT_HTTP_LOW_SPEED_TIME,
        ];
        if (args[0] === "fetch") fetchLowSpeedSettings.push(lowSpeedSettings);
        else nonFetchLowSpeedSettings.push(lowSpeedSettings);
        if (args[0] === "init") {
          await mkdir(path.join(String(options.cwd), ".git"), { recursive: true });
        } else if (args[0] === "remote") {
          if (args[1] === undefined) return { stdout: [...remoteNames].join("\n"), stderr: "" };
          if (args[1] === "add" && args[2]) remoteNames.add(args[2]);
        } else if (args[0] === "rev-parse") {
          if (args[1] === "--is-shallow-repository") return { stdout: `${shallow}\n`, stderr: "" };
          if (args[1] === "HEAD") return { stdout: `${checkedOutHead}\n`, stderr: "" };
          if (args[1]?.startsWith("refs/remotes/")) return { stdout: "target-ref\n", stderr: "" };
        } else if (args[0] === "fetch") {
          fetchAttempts += 1;
          if (fetchAttempts === 1) {
            throw Object.assign(new Error("Command failed: git fetch --unshallow --all"), {
              stderr: "fatal: unable to access: Operation too slow. Less than 1024 bytes/sec transferred the last 120 seconds",
            });
          }
          shallow = false;
        } else if (args[0] === "checkout") {
          checkedOutHead = args[3] ?? "";
        }
        return { stdout: "", stderr: "" };
      },
    });

    try {
      const workspace = await provider.create({
        jobId: "job-1",
        projectId: "16534",
        projectPath: "aip/ui/so-chart",
        sourceProjectPath: "aip/ui/so-chart",
        targetProjectPath: "aip/ui/so-chart",
        mrIid: "17",
        targetBranch: "dev",
        headSha: "head-1",
      });

      expect(fetchAttempts).toBe(2);
      expect(fetchLowSpeedSettings).toEqual([["1024", "120"], ["1024", "120"]]);
      expect(nonFetchLowSpeedSettings).not.toContainEqual(["1024", "120"]);
      await workspace.dispose();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("stops after three attempts when a transient fetch error persists", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-review-fetch-exhausted-"));
    const remoteNames = new Set<string>();
    let fetchAttempts = 0;
    const provider = new GitReviewWorkspaceProvider({
      rootDir,
      gitlabApiBaseUrl: "https://gitlab.example.com/api/v4",
      gitlabToken: "test-token",
      fullHistory: true,
      claudeTrustFile: path.join(rootDir, "claude.json"),
      runCommand: async (_file, args, options) => {
        if (args[0] === "init") {
          await mkdir(path.join(String(options.cwd), ".git"), { recursive: true });
        } else if (args[0] === "remote") {
          if (args[1] === undefined) return { stdout: [...remoteNames].join("\n"), stderr: "" };
          if (args[1] === "add" && args[2]) remoteNames.add(args[2]);
        } else if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
          return { stdout: "true\n", stderr: "" };
        } else if (args[0] === "fetch") {
          fetchAttempts += 1;
          throw Object.assign(new Error("Command failed: git fetch --unshallow --all"), {
            stderr: "error: RPC failed; curl 56 Recv failure: Connection reset by peer",
          });
        }
        return { stdout: "", stderr: "" };
      },
    });

    try {
      await expect(provider.create({
        jobId: "job-1",
        projectId: "16534",
        projectPath: "aip/ui/so-chart",
        sourceProjectPath: "aip/ui/so-chart",
        targetProjectPath: "aip/ui/so-chart",
        mrIid: "17",
        targetBranch: "dev",
        headSha: "head-1",
      })).rejects.toThrow(/failed after 3 attempts/);
      expect(fetchAttempts).toBe(3);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not retry a permanent fetch authentication error", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-review-fetch-auth-"));
    const remoteNames = new Set<string>();
    let fetchAttempts = 0;
    const provider = new GitReviewWorkspaceProvider({
      rootDir,
      gitlabApiBaseUrl: "https://gitlab.example.com/api/v4",
      gitlabToken: "test-token",
      claudeTrustFile: path.join(rootDir, "claude.json"),
      runCommand: async (_file, args, options) => {
        if (args[0] === "init") {
          await mkdir(path.join(String(options.cwd), ".git"), { recursive: true });
        } else if (args[0] === "remote") {
          if (args[1] === undefined) return { stdout: [...remoteNames].join("\n"), stderr: "" };
          if (args[1] === "add" && args[2]) remoteNames.add(args[2]);
        } else if (args[0] === "fetch") {
          fetchAttempts += 1;
          throw Object.assign(new Error("Command failed: git fetch --no-tags --depth 50 origin head-1"), {
            stderr: "fatal: Authentication failed",
          });
        }
        return { stdout: "", stderr: "" };
      },
    });

    try {
      await expect(provider.create({
        jobId: "job-1",
        projectId: "16534",
        projectPath: "aip/ui/so-chart",
        sourceProjectPath: "aip/ui/so-chart",
        targetProjectPath: "aip/ui/so-chart",
        mrIid: "17",
        targetBranch: null,
        headSha: "head-1",
      })).rejects.toThrow(/Failed to materialize review workspace: Command failed: git fetch/);
      expect(fetchAttempts).toBe(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reuses one persistent repository while updating the MR head", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-review-reuse-"));
    const commands: string[][] = [];
    let currentHead = "head-1";
    let checkedOutHead = "";
    const remoteNames = new Set<string>();
    const provider = new GitReviewWorkspaceProvider({
      rootDir,
      gitlabApiBaseUrl: "https://gitlab.example.com/api/v4",
      gitlabToken: "test-token",
      claudeTrustFile: path.join(rootDir, "claude.json"),
      runCommand: async (_file, args, options) => {
        commands.push(args);
        if (args[0] === "init") {
          await mkdir(path.join(String(options.cwd), ".git"), { recursive: true });
        } else if (args[0] === "remote") {
          if (args[1] === undefined) return { stdout: [...remoteNames].join("\n"), stderr: "" };
          if (args[1] === "add" && args[2]) remoteNames.add(args[2]);
        } else if (args[0] === "rev-parse") {
          return { stdout: `${checkedOutHead}\n`, stderr: "" };
        } else if (args[0] === "checkout") {
          checkedOutHead = currentHead;
        }
        return { stdout: "", stderr: "" };
      },
    });

    try {
      const first = await provider.create({
        jobId: "job-1",
        projectId: "16534",
        projectPath: "aip/ui/so-chart",
        sourceProjectPath: "aip/ui/so-chart",
        targetProjectPath: "aip/ui/so-chart",
        mrIid: "17",
        targetBranch: "dev",
        headSha: "head-1",
      });
      currentHead = "head-2";
      const second = await provider.create({
        jobId: "job-2",
        projectId: "16534",
        projectPath: "aip/ui/so-chart",
        sourceProjectPath: "aip/ui/so-chart",
        targetProjectPath: "aip/ui/so-chart",
        mrIid: "17",
        targetBranch: "dev",
        headSha: "head-2",
      });

      expect(second.path).toBe(first.path);
      expect(commands.filter((args) => args[0] === "init")).toHaveLength(1);
      expect(commands.filter((args) => args[0] === "fetch")).toHaveLength(4);
      await provider.disposeReview({ projectId: "16534", mrIid: "17" });
      await expect(stat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
