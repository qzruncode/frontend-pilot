import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppRouteContext } from "./app-route-context.js";
import { createClaudeCliPreviewUrl, type ClaudeCliPreviewEndpoint } from "./claude-cli-preview.js";
import type { ClaudeCliTerminalConnection, ClaudeCliTerminalEvent } from "./claude-cli-session.js";
import type { GitLabClientPort } from "./gitlab-client.js";
import type { GitLabConnection } from "./gitlab-connection.js";
import { browserSessionUser, hasTriggerAccess, productAccountKey, unauthorized, zodError } from "./app-route-utils.js";

const CreateProjectBodySchema = z.object({
  projectId: z.string().trim().min(1).max(128),
}).strict();
const RenameBodySchema = z.object({
  name: z.string().trim().min(1).max(128),
}).strict();

const ProjectParamsSchema = z.object({ id: z.string().trim().min(1).max(128) }).strict();
const SessionParamsSchema = ProjectParamsSchema.extend({ sessionId: z.string().uuid() }).strict();

const TerminalQuerySchema = z.object({
  cols: z.coerce.number().int().min(1).max(400).optional(),
  rows: z.coerce.number().int().min(1).max(200).optional(),
  sessionId: z.string().uuid().optional(),
  restart: z.enum(["1"]).optional(),
}).strict();

const TerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(128_000) }).strict(),
  z.object({ type: z.literal("resize"), cols: z.number().int().min(1).max(400), rows: z.number().int().min(1).max(200) }).strict(),
  z.object({ type: z.literal("stop") }).strict(),
]);

function ownerContext(request: Parameters<typeof browserSessionUser>[0], context: AppRouteContext) {
  const user = browserSessionUser(request, context.config, context.userStore);
  return user ? { user, ownerKey: `user:${user.username}` } : null;
}

async function gitlabUserAccess(request: FastifyRequest, context: AppRouteContext): Promise<{ client: GitLabClientPort; connection: GitLabConnection } | null> {
  const sessionKey = productAccountKey(request, context.config, context.userStore);
  if (!sessionKey || !context.gitlabOAuth.getConnection) return null;
  const [connection, client] = await Promise.all([
    context.gitlabOAuth.getConnection(sessionKey),
    context.gitlabOAuth.getClient(sessionKey),
  ]);
  return connection && client ? { connection, client } : null;
}

function requireOwner(request: Parameters<typeof browserSessionUser>[0], reply: Parameters<typeof unauthorized>[0], context: AppRouteContext) {
  if (!hasTriggerAccess(request, context.config, context.userStore)) {
    unauthorized(reply);
    return null;
  }
  const owner = ownerContext(request, context);
  if (!owner) {
    unauthorized(reply);
    return null;
  }
  return owner;
}

function previewUrl(request: FastifyRequest, endpoint: ClaudeCliPreviewEndpoint): string {
  const forwardedHost = request.headers["x-forwarded-host"];
  const hostHeader = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  const rawHost = hostHeader?.split(",", 1)[0]?.trim() || request.hostname;
  return createClaudeCliPreviewUrl(rawHost, endpoint);
}

export function registerClaudeCliRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.get("/api/v1/claude-cli/projects", async (request, reply) => {
    const owner = requireOwner(request, reply, context);
    if (!owner) return;
    try {
      return reply.send({ projects: await context.claudeCli.listProjects(owner.ownerKey) });
    } catch (error) {
      return reply.code(500).send({ error: "claude_cli_projects_failed", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/claude-cli/projects", async (request, reply) => {
    const owner = requireOwner(request, reply, context);
    if (!owner) return;
    const parsed = CreateProjectBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    let access: { client: GitLabClientPort; connection: GitLabConnection } | null;
    try {
      access = await gitlabUserAccess(request, context);
    } catch {
      return reply.code(502).send({ error: "gitlab_oauth_unavailable", details: "无法读取 GitLab 登录状态" });
    }
    if (!access) return reply.code(428).send({ error: "gitlab_oauth_required", details: "请先连接你的 GitLab 账号，再创建 Claude 代码工作区" });
    if (!access.client.getProject) return reply.code(503).send({ error: "gitlab_capability_not_configured", details: "当前 GitLab 客户端不支持读取项目详情" });
    try {
      const gitlabProject = await access.client.getProject(parsed.data.projectId);
      if (!gitlabProject.pathWithNamespace) return reply.code(400).send({ error: "gitlab_project_invalid", details: "GitLab 项目路径为空，无法拉取代码" });
      const project = await context.claudeCli.createProject(owner.ownerKey, owner.user.username, gitlabProject.name, {
        projectPath: gitlabProject.pathWithNamespace,
        defaultBranch: gitlabProject.defaultBranch,
        connection: access.connection,
      });
      return reply.code(201).send({ project });
    } catch (error) {
      return reply.code(400).send({ error: "claude_cli_project_create_failed", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/v1/claude-cli/projects/:id", async (request, reply) => {
    const owner = requireOwner(request, reply, context);
    if (!owner) return;
    const params = ProjectParamsSchema.safeParse(request.params);
    const body = RenameBodySchema.safeParse(request.body);
    if (!params.success) return zodError(reply, params.error);
    if (!body.success) return zodError(reply, body.error);
    try {
      return reply.send({ project: await context.claudeCli.renameProject(owner.ownerKey, params.data.id, body.data.name) });
    } catch (error) {
      return reply.code(404).send({ error: "claude_cli_project_not_found", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/claude-cli/projects/:id/sessions", async (request, reply) => {
    const owner = requireOwner(request, reply, context);
    if (!owner) return;
    const parsed = ProjectParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.code(201).send({ session: await context.claudeCli.createSession(owner.ownerKey, parsed.data.id) });
    } catch (error) {
      return reply.code(404).send({ error: "claude_cli_project_not_found", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch<{ Params: { id: string; sessionId: string } }>("/api/v1/claude-cli/projects/:id/sessions/:sessionId", async (request, reply) => {
    const owner = requireOwner(request, reply, context);
    if (!owner) return;
    const params = SessionParamsSchema.safeParse(request.params);
    const body = RenameBodySchema.safeParse(request.body);
    if (!params.success) return zodError(reply, params.error);
    if (!body.success) return zodError(reply, body.error);
    try {
      return reply.send({ project: await context.claudeCli.renameSession(owner.ownerKey, params.data.id, params.data.sessionId, body.data.name) });
    } catch (error) {
      return reply.code(404).send({ error: "claude_cli_session_not_found", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { id: string; sessionId: string } }>("/api/v1/claude-cli/projects/:id/sessions/:sessionId", async (request, reply) => {
    const owner = requireOwner(request, reply, context);
    if (!owner) return;
    const parsed = SessionParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ project: await context.claudeCli.deleteSession(owner.ownerKey, parsed.data.id, parsed.data.sessionId) });
    } catch (error) {
      return reply.code(404).send({ error: "claude_cli_session_not_found", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/claude-cli/projects/:id/stop", async (request, reply) => {
    const owner = requireOwner(request, reply, context);
    if (!owner) return;
    const parsed = ProjectParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ project: await context.claudeCli.stop(owner.ownerKey, parsed.data.id) });
    } catch (error) {
      return reply.code(404).send({ error: "claude_cli_project_not_found", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string; sessionId: string } }>("/api/v1/claude-cli/projects/:id/sessions/:sessionId/stop", async (request, reply) => {
    const owner = requireOwner(request, reply, context);
    if (!owner) return;
    const parsed = SessionParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ project: await context.claudeCli.stop(owner.ownerKey, parsed.data.id, parsed.data.sessionId) });
    } catch (error) {
      return reply.code(404).send({ error: "claude_cli_session_not_found", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string; sessionId: string } }>("/api/v1/claude-cli/projects/:id/sessions/:sessionId/preview-ports", async (request, reply) => {
    const owner = requireOwner(request, reply, context);
    if (!owner) return;
    const parsed = SessionParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const endpoints = await context.claudeCli.listPreviewPorts(owner.ownerKey, parsed.data.id, parsed.data.sessionId);
      return reply.send({ ports: endpoints.map((endpoint) => ({ port: endpoint.port, url: previewUrl(request, endpoint) })) });
    } catch (error) {
      return reply.code(404).send({ error: "claude_cli_session_not_found", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/claude-cli/projects/:id", async (request, reply) => {
    const owner = requireOwner(request, reply, context);
    if (!owner) return;
    const parsed = ProjectParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      await context.claudeCli.deleteProject(owner.ownerKey, parsed.data.id);
      return reply.send({ deleted: true });
    } catch (error) {
      return reply.code(404).send({ error: "claude_cli_project_not_found", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { cols?: string; rows?: string } }>(
    "/api/v1/claude-cli/projects/:id/terminal",
    { websocket: true },
    async (socket, request) => {
      const owner = ownerContext(request, context);
      if (!owner || !hasTriggerAccess(request, context.config, context.userStore)) {
        socket.close(1008, "未登录");
        return;
      }
      const params = ProjectParamsSchema.safeParse(request.params);
      const query = TerminalQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        socket.close(1008, "终端参数无效");
        return;
      }

      let access: { client: GitLabClientPort; connection: GitLabConnection } | null;
      try {
        access = await gitlabUserAccess(request, context);
      } catch {
        socket.close(1011, "无法读取 GitLab 登录状态");
        return;
      }
      if (!access) {
        socket.close(1008, "请先连接 GitLab");
        return;
      }

      let terminal: ClaudeCliTerminalConnection;
      try {
        terminal = await context.claudeCli.openTerminal(owner.ownerKey, params.data.id, access.connection, query.data.cols, query.data.rows, query.data.sessionId, query.data.restart === "1");
      } catch (error) {
        socket.close(1011, error instanceof Error ? error.message : "无法启动 Claude CLI");
        return;
      }

      const send = (event: ClaudeCliTerminalEvent): void => {
        if (socket.readyState === 1) socket.send(JSON.stringify(event));
      };
      const detach = terminal.onEvent(send);
      socket.send(JSON.stringify({ type: "ready", project: terminal.project }));
      socket.on("message", (raw: unknown) => {
        let rawMessage: unknown;
        try {
          rawMessage = JSON.parse(String(raw));
        } catch {
          send({ type: "error", message: "终端消息必须是 JSON" });
          return;
        }
        const parsedMessage = TerminalMessageSchema.safeParse(rawMessage);
        if (!parsedMessage.success) {
          send({ type: "error", message: "终端消息格式无效" });
          return;
        }
        if (parsedMessage.data.type === "input") terminal.write(parsedMessage.data.data);
        else if (parsedMessage.data.type === "resize") terminal.resize(parsedMessage.data.cols, parsedMessage.data.rows);
        else terminal.stop();
      });
      socket.on("close", detach);
      socket.on("error", detach);
    },
  );
}
