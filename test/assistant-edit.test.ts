import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { SDKMessage, Options as ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";
import { buildApp } from "../src/app.js";
import { AssistantEditService } from "../src/assistant-edit-service.js";
import type { AssistantEditSessionView } from "../src/assistant-edit-service.js";
import { AssistantEditStore } from "../src/assistant-edit-store.js";
import { GitAssistantEditWorkspaceProvider } from "../src/assistant-edit-workspace.js";
import { ClaudeAgentSdkAssistantRunner } from "../src/assistant-runner.js";
import type { AssistantToolContext } from "../src/assistant-tools.js";
import { config, gitlabConnectionStore, service } from "./app-fixtures.js";

const runCommand = promisify(execFile);

function reviewContext(): AssistantToolContext {
  return {
    reviewService: {
      stats: () => ({ queued: 0, running: 0, completed: 0, failed: 0, superseded: 0, canceled: 0 }),
      listJobs: () => [],
      getJob: () => null,
      getProgressEvents: () => null,
      async enqueue() { throw new Error("not used"); },
      async cancel() { return null; },
    },
    gitlab: { async getMergeRequest() { return {}; } },
    reviewRules: { async list() { return []; } },
  };
}

describe("AssistantEditService", () => {
  it("applies a patch directly and records the completed operation", async () => {
    const store = new AssistantEditStore(":memory:");
    let currentSha: string | null = "before";
    let applied = false;
    let disposed = false;
    const provider = {
      async create() { return { path: "/tmp/assistant-edit-test", baseSha: "abcdef1234567890", async dispose() { disposed = true; } }; },
      async exists() { return true; },
      async fileSha256() { return currentSha; },
      async checkPatch(_workspacePath: string, _path: string, patch: string) { return patch; },
      async applyPatch() { applied = true; currentSha = "after"; },
      async diff() { return { diff: "diff --git a/src/a.ts b/src/a.ts", changedFiles: applied ? 1 : 0 }; },
      async dispose() { disposed = true; },
    } as unknown as GitAssistantEditWorkspaceProvider;
    const service = new AssistantEditService(store, provider);
    const session = await service.createSession({ ownerKey: "user:alice", projectId: "7", projectPath: "group/demo", baseRef: "main" }, {
      baseUrl: "https://gitlab.example",
      apiBaseUrl: "https://gitlab.example/api/v4",
      token: "secret",
    });
    expect(session.retentionMode).toBe("auto");
    const appliedOperation = await service.applyFilePatch(session.id, "user:alice", {
      path: "src/a.ts",
      patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      summary: "更新示例实现",
    });

    expect(appliedOperation.status).toBe("applied");
    expect(applied).toBe(true);
    expect((await service.getSession(session.id, "user:alice"))?.pendingOperationCount).toBe(0);
    expect((await service.getSession(session.id, "user:alice"))?.status).toBe("active");
    expect(await service.listSessions("user:alice")).toEqual([expect.objectContaining({
      id: session.id,
      projectPath: "group/demo",
      baseRef: "main",
    })]);
    expect(await service.listSessions("user:bob")).toEqual([]);

    await service.closeSession(session.id, "user:alice");
    expect(disposed).toBe(true);
    store.close();
  });

  it("rejects a stale file version before applying a patch", async () => {
    const store = new AssistantEditStore(":memory:");
    let currentSha: string | null = "before";
    const provider = {
      async create() { return { path: "/tmp/assistant-edit-conflict", baseSha: "abcdef1234567890", async dispose() {} }; },
      async exists() { return true; },
      async fileSha256() { return currentSha; },
      async checkPatch(_workspacePath: string, _path: string, patch: string) { return patch; },
      async applyPatch() {},
      async diff() { return { diff: "", changedFiles: 0 }; },
      async dispose() {},
    } as unknown as GitAssistantEditWorkspaceProvider;
    const service = new AssistantEditService(store, provider);
    const session = await service.createSession({ ownerKey: "service", projectId: "7", projectPath: "group/demo", baseRef: "main" }, {
      baseUrl: "https://gitlab.example",
      apiBaseUrl: "https://gitlab.example/api/v4",
      token: "secret",
    });
    currentSha = "changed-elsewhere";
    await expect(service.applyFilePatch(session.id, "service", {
      path: "README.md",
      patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
      summary: "更新文档",
      expectedFileSha256: "before",
    })).rejects.toMatchObject({ code: "conflict" });
    store.close();
  });

  it("allows a user to pin an edit workspace beyond the default lease", async () => {
    vi.useFakeTimers();
    const store = new AssistantEditStore(":memory:");
    let disposed = false;
    const provider = {
      async create() { return { path: "/tmp/assistant-edit-pinned", baseSha: "abcdef1234567890", async dispose() { disposed = true; } }; },
      async exists() { return true; },
      async fileSha256() { return "before"; },
      async checkPatch(_workspacePath: string, _path: string, patch: string) { return patch; },
      async applyPatch() {},
      async diff() { return { diff: "", changedFiles: 0 }; },
      async dispose() { disposed = true; },
    } as unknown as GitAssistantEditWorkspaceProvider;
    try {
      const service = new AssistantEditService(store, provider);
      const session = await service.createSession({ ownerKey: "user:alice", projectId: "7", projectPath: "group/demo", baseRef: "main" }, {
        baseUrl: "https://gitlab.example",
        apiBaseUrl: "https://gitlab.example/api/v4",
        token: "secret",
      });
      const pinned = await service.setRetentionMode(session.id, "user:alice", "pinned");
      expect(pinned.retentionMode).toBe("pinned");

      vi.setSystemTime(new Date(Date.parse(session.expiresAt) + 1));
      const recovered = await service.getSession(session.id, "user:alice");

      expect(recovered?.status).toBe("active");
      expect(recovered?.retentionMode).toBe("pinned");
      expect(disposed).toBe(false);

      const autoCleanup = await service.setRetentionMode(session.id, "user:alice", "auto");
      expect(autoCleanup.retentionMode).toBe("auto");
      expect(Date.parse(autoCleanup.expiresAt)).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
      store.close();
    }
  });

});

describe("GitAssistantEditWorkspaceProvider", () => {
  it("validates, applies, and reports a staged single-file diff", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "frontend-pilot-edit-"));
    try {
      await runCommand("git", ["init", "--quiet"], { cwd: workspacePath });
      await writeFile(path.join(workspacePath, "src.ts"), "old\n");
      await runCommand("git", ["add", "src.ts"], { cwd: workspacePath });
      await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "base"], { cwd: workspacePath });
      const provider = new GitAssistantEditWorkspaceProvider({ rootDir: path.dirname(workspacePath) });
      const patch = "diff --git a/src.ts b/src.ts\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n-old\n+new\n";
      await provider.checkPatch(workspacePath, "src.ts", patch);
      await provider.applyPatch(workspacePath, "src.ts", patch);
      expect(await readFile(path.join(workspacePath, "src.ts"), "utf8")).toBe("new\n");
      const diff = await provider.diff(workspacePath);
      expect(diff.changedFiles).toBe(1);
      expect(diff.diff).toContain("+new");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("stages native file edits and new files while excluding workspace internals", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "frontend-pilot-edit-native-"));
    try {
      await runCommand("git", ["init", "--quiet"], { cwd: workspacePath });
      await writeFile(path.join(workspacePath, "src.ts"), "old\n");
      await runCommand("git", ["add", "src.ts"], { cwd: workspacePath });
      await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "base"], { cwd: workspacePath });
      await writeFile(path.join(workspacePath, "src.ts"), "new\n");
      await writeFile(path.join(workspacePath, "created.ts"), "created\n");
      await writeFile(path.join(workspacePath, ".gitlab-askpass.sh"), "internal\n");
      await writeFile(path.join(workspacePath, ".frontend-pilot-state"), "internal\n");

      const provider = new GitAssistantEditWorkspaceProvider({ rootDir: path.dirname(workspacePath) });
      const diff = await provider.diff(workspacePath);

      expect(diff.changedFiles).toBe(2);
      expect(diff.diff).toContain("+new");
      expect(diff.diff).toContain("created.ts");
      expect(diff.diff).not.toContain("gitlab-askpass");
      expect(diff.diff).not.toContain("frontend-pilot-state");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("normalizes inaccurate unified diff hunk counts from an edit proposal", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "frontend-pilot-edit-normalize-"));
    try {
      await runCommand("git", ["init", "--quiet"], { cwd: workspacePath });
      await writeFile(path.join(workspacePath, "README.md"), "last line\n");
      await runCommand("git", ["add", "README.md"], { cwd: workspacePath });
      await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "base"], { cwd: workspacePath });
      const provider = new GitAssistantEditWorkspaceProvider({ rootDir: path.dirname(workspacePath) });
      const malformedPatch = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,4 @@\n last line\n+\n+<!-- edit-flow-test -->\n";
      const normalizedPatch = await provider.checkPatch(workspacePath, "README.md", malformedPatch);
      expect(normalizedPatch).toContain("@@ -1 +1,3 @@");
      await provider.applyPatch(workspacePath, "README.md", normalizedPatch);
      expect(await readFile(path.join(workspacePath, "README.md"), "utf8")).toBe("last line\n\n<!-- edit-flow-test -->\n");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});

describe("Claude edit mode", () => {
  it("uses native Claude file tools inside the isolated workspace", async () => {
    let prompt = "";
    let options: ClaudeAgentOptions | undefined;
    let contextFactoryCalls = 0;
    const query = async function* ({ prompt: receivedPrompt, options: receivedOptions }: { prompt: string; options?: ClaudeAgentOptions }): AsyncIterable<SDKMessage> {
      prompt = receivedPrompt;
      options = receivedOptions;
      yield { type: "result", subtype: "success", result: "已完成修改" } as unknown as SDKMessage;
    };
    const runner = new ClaudeAgentSdkAssistantRunner({ query, assistantToolContextFactory: async () => { contextFactoryCalls += 1; return reviewContext(); } });
    await runner.run({
      messages: [{ role: "user", content: "请修复这个文件" }],
      editSession: {
        id: "edit-session",
        ownerKey: "user:alice",
        projectPath: "group/demo",
        baseRef: "main",
        baseSha: "abcdef1234567890",
        workspacePath: "/tmp/assistant-edit-test",
        pendingOperationCount: 0,
      },
    });
    expect(prompt).toContain("当前会话已开启代码编辑模式");
    expect(prompt).toContain("工作目录为 /tmp/assistant-edit-test");
    expect(prompt).toContain("项目标识 group/demo 不是本地目录前缀");
    expect(prompt).toContain("Claude 原生 Edit 或 Write");
    expect(options?.cwd).toBe("/tmp/assistant-edit-test");
    expect(options?.settingSources).toEqual([]);
    expect(options?.tools).toEqual(["Read", "Grep", "Glob", "Edit", "Write"]);
    expect(options?.allowedTools).toEqual(["Read", "Grep", "Glob", "Edit", "Write"]);
    expect(options?.disallowedTools).toEqual(["Bash", "NotebookEdit", "Task", "Agent"]);
    expect(options?.permissionMode).toBe("acceptEdits");
    expect(options?.mcpServers).toBeUndefined();
    expect(contextFactoryCalls).toBe(0);
    expect(options?.hooks?.PreToolUse?.[0]?.matcher).toBe("^(Read|Grep|Glob|Edit|Write)$");

    const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(hook).toBeDefined();
    const outside = await hook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "../outside.ts" },
        tool_use_id: "write-outside",
        session_id: "session",
        transcript_path: "",
        cwd: "/tmp/assistant-edit-test",
      } as Parameters<NonNullable<typeof hook>>[0],
      "write-outside",
      { signal: new AbortController().signal },
    );
    expect(outside).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });

    const inside = await hook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "src/a.ts", content: "new" },
        tool_use_id: "write-inside",
        session_id: "session",
        transcript_path: "",
        cwd: "/tmp/assistant-edit-test",
      } as Parameters<NonNullable<typeof hook>>[0],
      "write-inside",
      { signal: new AbortController().signal },
    );
    expect(inside).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        updatedInput: { file_path: "/tmp/assistant-edit-test/src/a.ts" },
      },
    });
  });
});

describe("Assistant edit HTTP routes", () => {
  it("creates an edit session and passes its isolated context into the assistant run", async () => {
    let receivedSessionId: string | undefined;
    const session: AssistantEditSessionView = {
      id: "edit-session",
      projectId: "7",
      projectPath: "group/demo",
      baseRef: "main",
      baseSha: "abcdef1234567890",
      status: "active",
      retentionMode: "auto",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      changedFiles: 0,
      pendingOperationCount: 0,
      operations: [],
    };
    const editService = {
      async createSession() { return session; },
      async getRunnerContext() {
        return {
          id: session.id,
          ownerKey: "service",
          projectPath: session.projectPath,
          baseRef: session.baseRef,
          baseSha: session.baseSha,
          workspacePath: "/tmp/assistant-edit-route-test",
          pendingOperationCount: 0,
        };
      },
      async listSessions() { return [session]; },
      async setRetentionMode(_id: string, _ownerKey: string, retentionMode: "auto" | "pinned") { return { ...session, retentionMode }; },
    } as unknown as AssistantEditService;
    const assistantRunner = {
      async run(input: { editSession?: { id: string } }) {
        receivedSessionId = input.editSession?.id;
        return "编辑模式已连接";
      },
    };
    const gitlab = {
      async getMergeRequest() { return {}; },
      async getReviewSnapshot() { return { mergeRequest: {}, changes: [] }; },
      async listProjects() {
        return [{
          id: "7",
          name: "Demo",
          path: "demo",
          pathWithNamespace: "group/demo",
          nameWithNamespace: "Group / Demo",
          webUrl: null,
          defaultBranch: "main",
          visibility: "private",
          lastActivityAt: null,
          avatarUrl: null,
        }];
      },
    };
    const app = await buildApp({
      config,
      reviewService: service(),
      assistantRunner,
      assistantEditService: editService,
      gitlab,
      gitlabConnectionStore: gitlabConnectionStore(),
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/assistant/edit-sessions",
      headers: { authorization: "Bearer trigger-token" },
      payload: { projectId: "7", projectPath: "group/demo", baseRef: "main" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().session).toMatchObject({ id: "edit-session", projectPath: "group/demo" });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/assistant/edit-sessions",
      headers: { authorization: "Bearer trigger-token" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().sessions).toMatchObject([{ projectPath: "group/demo", baseRef: "main" }]);

    const retention = await app.inject({
      method: "POST",
      url: "/api/v1/assistant/edit-sessions/edit-session/retention",
      headers: { authorization: "Bearer trigger-token" },
      payload: { retentionMode: "pinned" },
    });
    expect(retention.statusCode).toBe(200);
    expect(retention.json().session).toMatchObject({ id: "edit-session", retentionMode: "pinned" });

    const streamed = await app.inject({
      method: "POST",
      url: "/api/v1/assistant/stream",
      headers: { authorization: "Bearer trigger-token" },
      payload: { conversationId: "edit-conversation", message: "请修改代码", history: [], editSessionId: "edit-session" },
    });
    expect(streamed.statusCode).toBe(200);
    expect(receivedSessionId).toBe("edit-session");
    await app.close();
  });
});
