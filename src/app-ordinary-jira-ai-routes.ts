import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OrdinaryJiraAiCheckIdSchema, OrdinaryJiraAiPrecheckLookupResponseSchema, OrdinaryJiraAiPrecheckResponseSchema, OrdinaryJiraAiSupplementResponseSchema, OrdinaryJiraAiTaskSchema, OrdinaryJiraAiTaskDetailSchema, OrdinaryJiraAiTaskSummaryResponseSchema } from "./api-contracts.js";
import type { AppRouteContext } from "./app-route-context.js";
import { browserSessionUser, hasTriggerAccess, unauthorized, zodError } from "./app-route-utils.js";
import { OrdinaryJiraAiConflictError, OrdinaryJiraAiPrecheckStaleError, type OrdinaryJiraAiIdentity } from "./ordinary-jira-ai-service.js";
import { safeErrorMessage } from "./errors.js";

const jiraKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}-\d+$/;
const keyParams = z.object({ key: z.string().trim().regex(jiraKeyPattern).max(80) }).strict();
const idParams = z.object({ id: z.string().uuid() }).strict();
const taskSummaryQuery = z.object({ keys: z.string().trim().min(1).max(12_000) }).strict();
const projectInput = z.object({
  projectId: z.string().trim().min(1).max(128),
  projectPath: z.string().trim().min(1).max(512),
  targetBranch: z.string().trim().min(1).max(255),
}).strict();
const startBody = projectInput.extend({
  precheckId: z.string().uuid(),
  confirmed: z.literal(true),
}).strict();
const supplementBody = projectInput.extend({
  precheckId: z.string().uuid(),
  checkId: OrdinaryJiraAiCheckIdSchema,
}).strict();
const confirmSupplementBody = supplementBody.extend({
  supplement: z.string().trim().min(1).max(4_000),
}).strict();

function identityFor(request: FastifyRequest, context: AppRouteContext, reply: FastifyReply): OrdinaryJiraAiIdentity | null {
  const user = browserSessionUser(request, context.config, context.userStore);
  if (!user) {
    unauthorized(reply);
    return null;
  }
  return { userId: user.id, username: user.username };
}

export function registerOrdinaryJiraAiRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.register(async (secured) => {
    secured.addHook("preHandler", async (request, reply) => {
      if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    });
    secured.setErrorHandler((error, _request, reply) => {
      if (error instanceof OrdinaryJiraAiConflictError) return reply.code(409).send({ error: "ordinary_jira_ai_conflict", details: error.message });
      if (error instanceof OrdinaryJiraAiPrecheckStaleError) return reply.code(409).send({ error: "ordinary_jira_ai_precheck_stale", details: error.message });
      return reply.code(400).send({ error: "ordinary_jira_ai_failed", details: safeErrorMessage(error, "普通 Jira AI 处理失败") });
    });

    secured.get<{ Params: { key: string } }>("/api/v1/jira/issues/:key/ai-task", async (request, reply) => {
      const params = keyParams.safeParse(request.params);
      if (!params.success) return zodError(reply, params.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      return reply.send({ task: context.ordinaryJiraAi.find(params.data.key, identity) });
    });

    secured.get("/api/v1/jira/ai-tasks", async (request, reply) => {
      const parsed = taskSummaryQuery.safeParse(request.query);
      if (!parsed.success) return zodError(reply, parsed.error);
      const keys = [...new Set(parsed.data.keys.split(",").map((key) => key.trim().toUpperCase()).filter(Boolean))];
      if (keys.length === 0 || keys.length > 200 || keys.some((key) => !jiraKeyPattern.test(key))) return reply.code(400).send({ error: "invalid_request", details: "Jira Key 列表无效或超过 200 个" });
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      return reply.send(OrdinaryJiraAiTaskSummaryResponseSchema.parse({
        tasks: context.ordinaryJiraAi.findSummaries(keys, identity),
        prechecks: context.ordinaryJiraAi.findPrecheckSummaries(keys, identity),
      }));
    });

    secured.get<{ Params: { key: string } }>("/api/v1/jira/issues/:key/ai-precheck", async (request, reply) => {
      const params = keyParams.safeParse(request.params);
      if (!params.success) return zodError(reply, params.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      return reply.send(OrdinaryJiraAiPrecheckLookupResponseSchema.parse(context.ordinaryJiraAi.findPrecheck(params.data.key, identity)));
    });

    secured.post<{ Params: { key: string } }>("/api/v1/jira/issues/:key/ai-precheck", async (request, reply) => {
      const params = keyParams.safeParse(request.params);
      const body = projectInput.safeParse(request.body);
      if (!params.success) return zodError(reply, params.error);
      if (!body.success) return zodError(reply, body.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      if (!context.claudeState.configured) return reply.code(503).send({ error: "model_not_configured", details: "请先配置助手模型" });
      const precheck = await context.ordinaryJiraAi.precheck(params.data.key, body.data, identity);
      return reply.send(OrdinaryJiraAiPrecheckResponseSchema.parse({ precheck }));
    });

    secured.post<{ Params: { key: string } }>("/api/v1/jira/issues/:key/ai-precheck/supplement", async (request, reply) => {
      const params = keyParams.safeParse(request.params);
      const body = supplementBody.safeParse(request.body);
      if (!params.success) return zodError(reply, params.error);
      if (!body.success) return zodError(reply, body.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      if (!context.claudeState.configured) return reply.code(503).send({ error: "model_not_configured", details: "请先配置助手模型" });
      const supplement = await context.ordinaryJiraAi.suggestPrecheckSupplement(params.data.key, body.data, identity);
      return reply.send(OrdinaryJiraAiSupplementResponseSchema.parse({ supplement }));
    });

    secured.post<{ Params: { key: string } }>("/api/v1/jira/issues/:key/ai-precheck/supplement/confirm", async (request, reply) => {
      const params = keyParams.safeParse(request.params);
      const body = confirmSupplementBody.safeParse(request.body);
      if (!params.success) return zodError(reply, params.error);
      if (!body.success) return zodError(reply, body.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      if (!context.claudeState.configured) return reply.code(503).send({ error: "model_not_configured", details: "请先配置助手模型" });
      const precheck = await context.ordinaryJiraAi.confirmPrecheckSupplement(params.data.key, body.data, identity);
      return reply.send(OrdinaryJiraAiPrecheckResponseSchema.parse({ precheck }));
    });

    secured.post<{ Params: { key: string } }>("/api/v1/jira/issues/:key/ai-tasks", async (request, reply) => {
      const params = keyParams.safeParse(request.params);
      const body = startBody.safeParse(request.body);
      if (!params.success) return zodError(reply, params.error);
      if (!body.success) return zodError(reply, body.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      if (!context.claudeState.configured) return reply.code(503).send({ error: "model_not_configured", details: "请先配置助手模型" });
      const task = await context.ordinaryJiraAi.start(params.data.key, body.data, identity);
      return reply.code(202).send({ task: OrdinaryJiraAiTaskSchema.parse(task) });
    });

    secured.get<{ Params: { id: string } }>("/api/v1/jira/ai-tasks/:id", async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return zodError(reply, params.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      return reply.send(OrdinaryJiraAiTaskDetailSchema.parse(await context.ordinaryJiraAi.detail(params.data.id, identity)));
    });

    secured.post<{ Params: { id: string } }>("/api/v1/jira/ai-tasks/:id/retry", async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return zodError(reply, params.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      return reply.send({ task: OrdinaryJiraAiTaskSchema.parse(context.ordinaryJiraAi.retry(params.data.id, identity)) });
    });

    secured.post<{ Params: { id: string } }>("/api/v1/jira/ai-tasks/:id/cancel", async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return zodError(reply, params.error);
      const identity = identityFor(request, context, reply);
      if (!identity) return reply;
      return reply.send({ task: OrdinaryJiraAiTaskSchema.parse(context.ordinaryJiraAi.cancel(params.data.id, identity)) });
    });
  });
}
