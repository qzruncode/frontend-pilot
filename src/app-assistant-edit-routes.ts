import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppRouteContext } from "./app-route-context.js";
import { AssistantEditError } from "./assistant-edit-service.js";
import { browserSessionUser, hasServiceBearerAccess, hasTriggerAccess, productAccountKey, unauthorized, zodError } from "./app-route-utils.js";

const EditSessionParamsSchema = z.object({ id: z.string().trim().min(1).max(128) }).strict();
const EditOperationParamsSchema = EditSessionParamsSchema.extend({ operationId: z.string().trim().min(1).max(128) }).strict();
const CreateEditSessionBodySchema = z.object({
  projectId: z.string().trim().min(1).max(256),
  projectPath: z.string().trim().min(1).max(512).optional(),
  baseRef: z.string().trim().min(1).max(256).optional(),
}).strict();
const EditSessionRetentionBodySchema = z.object({
  retentionMode: z.enum(["auto", "pinned"]),
}).strict();

function ownerKeyForRequest(request: FastifyRequest, context: AppRouteContext): string | null {
  if (hasServiceBearerAccess(request, context.config)) return "service";
  const user = browserSessionUser(request, context.config, context.userStore);
  return user ? `user:${user.username}` : null;
}

function editFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AssistantEditError) {
    const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : error.code === "invalid" ? 400 : 409;
    return reply.code(status).send({ error: `assistant_edit_${error.code}`, details: error.message });
  }
  return reply.code(500).send({ error: "assistant_edit_failed", details: "代码编辑操作失败" });
}

async function resolveGitLabAccess(request: FastifyRequest, context: AppRouteContext): Promise<{
  ownerKey: string;
  connection: { baseUrl: string; apiBaseUrl: string; token: string };
  client: import("./gitlab-client.js").GitLabClientPort;
} | null> {
  if (hasServiceBearerAccess(request, context.config)) {
    if (!context.initialGitLabConnection.token) return null;
    return { ownerKey: "service", connection: context.initialGitLabConnection, client: context.gitlabClient };
  }
  const sessionKey = productAccountKey(request, context.config, context.userStore);
  if (!sessionKey || !context.gitlabOAuth.getConnection) return null;
  const [connection, client] = await Promise.all([
    context.gitlabOAuth.getConnection(sessionKey),
    context.gitlabOAuth.getClient(sessionKey),
  ]);
  if (!connection || !client) return null;
  return { ownerKey: ownerKeyForRequest(request, context) ?? `session:${sessionKey}`, connection, client };
}

async function resolveProject(
  client: import("./gitlab-client.js").GitLabClientPort,
  projectId: string,
  requestedPath?: string,
): Promise<{ projectPath: string; defaultBranch: string | null }> {
  if (client.listProjects) {
    const projects = await client.listProjects({ search: requestedPath ?? projectId, page: 1, perPage: 50 });
    const project = projects.find((item) => item.id === projectId || item.pathWithNamespace === requestedPath || item.pathWithNamespace === projectId);
    if (project) return { projectPath: project.pathWithNamespace, defaultBranch: project.defaultBranch };
  }
  if (requestedPath) return { projectPath: requestedPath, defaultBranch: null };
  throw new AssistantEditError("invalid", "无法确认项目路径，请重新选择 GitLab 项目");
}

export function registerAssistantEditRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.post("/api/v1/assistant/edit-sessions", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = CreateEditSessionBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    const access = await resolveGitLabAccess(request, context);
    if (!access) return reply.code(428).send({ error: "gitlab_oauth_required", details: "请先连接 GitLab，或配置可用于编辑工作区的服务令牌" });
    try {
      const project = await resolveProject(access.client, parsed.data.projectId, parsed.data.projectPath);
      const baseRef = parsed.data.baseRef ?? project.defaultBranch ?? "main";
      const session = await context.assistantEditService.createSession({
        ownerKey: access.ownerKey,
        projectId: parsed.data.projectId,
        projectPath: project.projectPath,
        baseRef,
      }, access.connection);
      return reply.code(201).send({ session });
    } catch (error) {
      return editFailure(reply, error);
    }
  });

  app.get("/api/v1/assistant/edit-sessions", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const ownerKey = ownerKeyForRequest(request, context);
    if (!ownerKey) return unauthorized(reply);
    try {
      return reply.send({ sessions: await context.assistantEditService.listSessions(ownerKey) });
    } catch (error) {
      return editFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/assistant/edit-sessions/:id", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = EditSessionParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    const ownerKey = ownerKeyForRequest(request, context);
    if (!ownerKey) return unauthorized(reply);
    try {
      const session = await context.assistantEditService.getSession(parsed.data.id, ownerKey);
      return session ? reply.send({ session }) : reply.code(404).send({ error: "assistant_edit_session_not_found" });
    } catch (error) {
      return editFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/assistant/edit-sessions/:id/diff", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = EditSessionParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    const ownerKey = ownerKeyForRequest(request, context);
    if (!ownerKey) return unauthorized(reply);
    try {
      return reply.send(await context.assistantEditService.getDiff(parsed.data.id, ownerKey));
    } catch (error) {
      return editFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/assistant/edit-sessions/:id/retention", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsedParams = EditSessionParamsSchema.safeParse(request.params);
    if (!parsedParams.success) return zodError(reply, parsedParams.error);
    const parsedBody = EditSessionRetentionBodySchema.safeParse(request.body);
    if (!parsedBody.success) return zodError(reply, parsedBody.error);
    const ownerKey = ownerKeyForRequest(request, context);
    if (!ownerKey) return unauthorized(reply);
    try {
      const session = await context.assistantEditService.setRetentionMode(parsedParams.data.id, ownerKey, parsedBody.data.retentionMode);
      return reply.send({ session });
    } catch (error) {
      return editFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string; operationId: string } }>("/api/v1/assistant/edit-sessions/:id/operations/:operationId/approve", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = EditOperationParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    const ownerKey = ownerKeyForRequest(request, context);
    if (!ownerKey) return unauthorized(reply);
    try {
      const operation = await context.assistantEditService.approveOperation(parsed.data.id, parsed.data.operationId, ownerKey);
      const session = await context.assistantEditService.getSession(parsed.data.id, ownerKey);
      return reply.send({ operation, session });
    } catch (error) {
      return editFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string; operationId: string } }>("/api/v1/assistant/edit-sessions/:id/operations/:operationId/reject", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = EditOperationParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    const ownerKey = ownerKeyForRequest(request, context);
    if (!ownerKey) return unauthorized(reply);
    try {
      const operation = await context.assistantEditService.rejectOperation(parsed.data.id, parsed.data.operationId, ownerKey);
      const session = await context.assistantEditService.getSession(parsed.data.id, ownerKey);
      return reply.send({ operation, session });
    } catch (error) {
      return editFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/assistant/edit-sessions/:id/close", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = EditSessionParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    const ownerKey = ownerKeyForRequest(request, context);
    if (!ownerKey) return unauthorized(reply);
    try {
      const session = await context.assistantEditService.closeSession(parsed.data.id, ownerKey);
      return session ? reply.send({ session }) : reply.code(404).send({ error: "assistant_edit_session_not_found" });
    } catch (error) {
      return editFailure(reply, error);
    }
  });
}
