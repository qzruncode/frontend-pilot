import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  GitLabMrAiRepairTaskActionResponseSchema,
  GitLabMrAiRepairTaskDetailSchema,
  GitLabMrAiRepairTaskResponseSchema,
} from "./api-contracts.js";
import type { AppRouteContext } from "./app-route-context.js";
import { browserSessionUser, hasTriggerAccess, unauthorized, zodError } from "./app-route-utils.js";
import { GitLabMrAiRepairConflictError, type GitLabMrAiRepairIdentity } from "./gitlab-mr-ai-service.js";
import { safeErrorMessage } from "./errors.js";

const mrParams = z.object({
  projectId: z.string().trim().min(1).max(128),
  iid: z.string().trim().regex(/^\d+$/).max(32),
}).strict();
const idParams = z.object({ id: z.string().uuid() }).strict();
const startBody = z.object({ confirmed: z.literal(true) }).strict();

function identityFor(request: FastifyRequest, context: AppRouteContext, reply: FastifyReply): GitLabMrAiRepairIdentity | null {
  const user = browserSessionUser(request, context.config, context.userStore);
  if (!user) {
    unauthorized(reply);
    return null;
  }
  return { userId: user.id, username: user.username };
}

export function registerGitLabMrAiRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.register(async (secured) => {
    secured.addHook("preHandler", async (request, reply) => {
      if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    });
    secured.setErrorHandler((error, _request, reply) => {
      if (error instanceof GitLabMrAiRepairConflictError) return reply.code(409).send({ error: "gitlab_mr_ai_conflict", details: error.message });
      return reply.code(400).send({ error: "gitlab_mr_ai_failed", details: safeErrorMessage(error, "GitLab MR AI 自动修复失败") });
    });

    secured.get<{ Params: { projectId: string; iid: string } }>("/api/v1/gitlab/merge-requests/:projectId/:iid/ai-task", async (request, reply) => {
      const params = mrParams.safeParse(request.params);
      if (!params.success) return zodError(reply, params.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      return reply.send(GitLabMrAiRepairTaskResponseSchema.parse({ task: await context.gitlabMrAiRepair.find(params.data.projectId, params.data.iid, identity) }));
    });

    secured.post<{ Params: { projectId: string; iid: string } }>("/api/v1/gitlab/merge-requests/:projectId/:iid/ai-task", async (request, reply) => {
      const params = mrParams.safeParse(request.params);
      const body = startBody.safeParse(request.body);
      if (!params.success) return zodError(reply, params.error);
      if (!body.success) return zodError(reply, body.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      if (!context.claudeState.configured) return reply.code(503).send({ error: "model_not_configured", details: "请先配置助手模型" });
      const task = await context.gitlabMrAiRepair.start(params.data.projectId, params.data.iid, body.data, identity);
      return reply.code(202).send(GitLabMrAiRepairTaskActionResponseSchema.parse({ task }));
    });

    secured.get<{ Params: { id: string } }>("/api/v1/gitlab/ai-tasks/:id", async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return zodError(reply, params.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      return reply.send(GitLabMrAiRepairTaskDetailSchema.parse(await context.gitlabMrAiRepair.detail(params.data.id, identity)));
    });

    secured.post<{ Params: { id: string } }>("/api/v1/gitlab/ai-tasks/:id/retry", async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return zodError(reply, params.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      return reply.send(GitLabMrAiRepairTaskActionResponseSchema.parse({ task: context.gitlabMrAiRepair.retry(params.data.id, identity) }));
    });

    secured.post<{ Params: { id: string } }>("/api/v1/gitlab/ai-tasks/:id/cancel", async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return zodError(reply, params.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      return reply.send(GitLabMrAiRepairTaskActionResponseSchema.parse({ task: context.gitlabMrAiRepair.cancel(params.data.id, identity) }));
    });
  });
}
