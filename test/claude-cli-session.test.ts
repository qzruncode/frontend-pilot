import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeCliEnvironment, ClaudeCliSessionManager } from "../src/claude-cli-session.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 4_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Promise did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("ClaudeCliSessionManager", () => {
  it("does not inherit service secrets into an interactive CLI environment", () => {
    const environment = buildClaudeCliEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/app",
        SHELL: "/bin/bash",
        DATABASE_URL: "postgres://service-secret",
        GITLAB_TOKEN: "gitlab-service-secret",
        JIRA_TOKEN: "jira-service-secret",
        NODE_OPTIONS: "--require ./service-secret.js",
      },
      {
        DATABASE_URL: "runtime-secret",
        API_TIMEOUT_MS: "15000",
        COREPACK_HOME: "/opt/corepack",
        NPM_CONFIG_REGISTRY: "http://npm.example.com/",
        COREPACK_NPM_REGISTRY: "http://corepack-registry.example.com",
        CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES: "1",
      },
      {
        ANTHROPIC_BASE_URL: "https://model.example.com",
        ANTHROPIC_AUTH_TOKEN: "user-model-token",
        CLAUDE_MODEL: "user-model",
      },
    );

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/app",
      SHELL: "/bin/bash",
      COREPACK_HOME: "/opt/corepack",
      COREPACK_NPM_REGISTRY: "http://corepack-registry.example.com",
      CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES: "1",
      ANTHROPIC_BASE_URL: "https://model.example.com",
      ANTHROPIC_AUTH_TOKEN: "user-model-token",
      CLAUDE_MODEL: "user-model",
    });
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("GITLAB_TOKEN");
    expect(environment).not.toHaveProperty("JIRA_TOKEN");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("API_TIMEOUT_MS");
    expect(environment).not.toHaveProperty("NPM_CONFIG_REGISTRY");
  });

  it("normalizes messages for the interactive CLI and closes its gateway proxy", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-claude-cli-"));
    const commandPath = path.join(rootDir, "fake-claude");
    let resolveRequest: (request: { path: string; baseUrl: string; body: unknown }) => void = () => undefined;
    const upstreamRequest = new Promise<{ path: string; baseUrl: string; body: unknown }>((resolve) => {
      resolveRequest = resolve;
    });
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      resolveRequest({
        path: request.url ?? "",
        baseUrl: String(request.headers["x-claude-cli-base-url"] ?? ""),
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content: [{ type: "text", text: "OK" }] }));
    });
    const upstreamPort = await listen(upstream);
    await writeFile(commandPath, `#!/usr/bin/env node
const configuredBaseUrl = process.env.ANTHROPIC_BASE_URL;
const baseUrl = configuredBaseUrl.endsWith("/") ? configuredBaseUrl : configuredBaseUrl + "/";
const messages = [
  { role: "user", content: "检查文件" },
  { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "文件内容" }] },
  { role: "system", content: [{ type: "text", text: "动态系统提醒" }] }
];
fetch(new URL("v1/messages", baseUrl), {
  method: "POST",
  headers: { "content-type": "application/json", "x-claude-cli-base-url": configuredBaseUrl },
  body: JSON.stringify({ system: "静态系统提示", messages })
}).then(async (response) => {
  console.log("GATEWAY_PROBE_STATUS=" + response.status);
  await response.arrayBuffer();
}).catch((error) => console.error("GATEWAY_PROBE_ERROR=" + error.message));
process.stdin.resume();
`, { mode: 0o700 });
    const manager = new ClaudeCliSessionManager({
      rootDir: path.join(rootDir, "workspaces"),
      command: commandPath,
      environment: { CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES: "1" },
      settingsProvider: async () => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}/vibecoding` }),
    });

    try {
      const project = await manager.createProject("user:test-user", "test-user", "gateway-compatibility");
      const terminal = await manager.openTerminal("user:test-user", project.id, null, 120, 32, project.sessions[0].id);
      let terminalOutput = "";
      terminal.onEvent((event) => {
        if (event.type === "output") terminalOutput += event.data;
        else if (event.type === "error") terminalOutput += event.message;
      });

      let received: { path: string; baseUrl: string; body: unknown };
      try {
        received = await withTimeout(upstreamRequest);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${terminalOutput}`);
      }
      expect(received.path).toBe("/vibecoding/v1/messages");
      expect(received.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vibecoding\/?$/);
      expect(received.body).toEqual({
        system: "静态系统提示",
        messages: [
          { role: "user", content: "检查文件" },
          { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] },
          { role: "user", content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "文件内容" },
            { type: "text", text: "动态系统提醒" },
          ] },
        ],
      });

      await manager.close();
      const proxyUrl = new URL("v1/messages", received.baseUrl.endsWith("/") ? received.baseUrl : `${received.baseUrl}/`);
      await expect(fetch(proxyUrl)).rejects.toThrow();
    } finally {
      await manager.close();
      await closeServer(upstream);
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 10_000);

  it("creates multiple sessions under one project", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-claude-cli-"));
    const manager = new ClaudeCliSessionManager({
      rootDir,
      settingsProvider: async () => ({}),
    });

    try {
      const project = await manager.createProject("user:test-user", "test-user", "multi-session");
      const firstSession = project.sessions[0];
      const secondSession = await manager.createSession("user:test-user", project.id);
      const [listedProject] = await manager.listProjects("user:test-user");

      expect(firstSession).toMatchObject({ name: "会话 1", status: "stopped" });
      expect(secondSession).toMatchObject({ name: "会话 2", status: "stopped" });
      expect(secondSession.id).not.toBe(firstSession.id);
      expect(listedProject.sessions.map((session) => session.id)).toEqual([firstSession.id, secondSession.id]);
    } finally {
      await manager.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("deletes a session without deleting the project workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-claude-cli-"));
    const manager = new ClaudeCliSessionManager({
      rootDir,
      settingsProvider: async () => ({}),
    });

    try {
      const project = await manager.createProject("user:test-user", "test-user", "delete-session");
      const firstSession = project.sessions[0];
      const secondSession = await manager.createSession("user:test-user", project.id);

      const updatedProject = await manager.deleteSession("user:test-user", project.id, secondSession.id);

      expect(updatedProject.sessions.map((session) => session.id)).toEqual([firstSession.id]);
      expect(await manager.listProjects("user:test-user")).toMatchObject([{ id: project.id, sessions: [{ id: firstSession.id }] }]);
      await expect(access(project.cwd)).resolves.toBeUndefined();
    } finally {
      await manager.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("renames a project and its sessions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-claude-cli-"));
    const manager = new ClaudeCliSessionManager({
      rootDir,
      settingsProvider: async () => ({}),
    });

    try {
      const project = await manager.createProject("user:test-user", "test-user", "rename-me");
      const session = project.sessions[0];

      const renamedProject = await manager.renameProject("user:test-user", project.id, "renamed-project");
      const renamedSession = await manager.renameSession("user:test-user", project.id, session.id, "renamed-session");

      expect(renamedProject.name).toBe("renamed-project");
      expect(renamedSession.sessions).toMatchObject([{ id: session.id, name: "renamed-session" }]);
      expect(await manager.listProjects("user:test-user")).toMatchObject([{ name: "renamed-project", sessions: [{ name: "renamed-session" }] }]);
    } finally {
      await manager.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("deletes the project metadata and local workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-claude-cli-"));
    const manager = new ClaudeCliSessionManager({
      rootDir,
      settingsProvider: async () => ({}),
    });

    try {
      const project = await manager.createProject("user:test-user", "test-user", "delete-me");
      expect(await manager.listProjects("user:test-user")).toHaveLength(1);

      await manager.deleteProject("user:test-user", project.id);

      expect(await manager.listProjects("user:test-user")).toEqual([]);
      await expect(access(project.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await manager.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
