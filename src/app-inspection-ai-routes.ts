import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppRouteContext } from "./app-route-context.js";
import { zodError } from "./app-route-utils.js";
import { safeErrorMessage } from "./errors.js";
import { InspectionAiConflictError } from "./inspection-ai-service.js";

const source = z.object({ runId: z.string().min(1).max(128), findingId: z.string().min(1).max(128) }).strict();
export function registerInspectionAiRoutes(app: FastifyInstance, context: AppRouteContext) {
  app.register(async (secured) => {
    secured.addHook("preHandler", async (request, reply) => { context.inspectionAccounts.requireMaintainer(request, reply); });
    secured.setErrorHandler((error, _request, reply) => {
      if (error instanceof InspectionAiConflictError) return reply.code(409).send({ error: "inspection_ai_conflict", details: error.message });
      return reply.code(400).send({ error: "inspection_ai_failed", details: safeErrorMessage(error, "AI 处理请求失败") });
    });
    secured.get("/api/v1/inspections/ai-tasks", async (request, reply) => {
      const parsed = source.safeParse(request.query);
      if (!parsed.success) return zodError(reply, parsed.error);
      return { task: context.inspectionAi.find(parsed.data.runId, parsed.data.findingId, context.inspectionAccounts.identity(request)) };
    });
    secured.post("/api/v1/inspections/ai-tasks", async (request, reply) => {
      const parsed = source.safeParse(request.body);
      if (!parsed.success) return zodError(reply, parsed.error);
      if (!context.claudeState.configured) return reply.code(503).send({ error: "model_not_configured", details: "请先配置助手模型" });
      return reply.code(202).send({ task: context.inspectionAi.start(parsed.data.runId, parsed.data.findingId, context.inspectionAccounts.identity(request)) });
    });
    secured.get<{ Params: { id: string } }>("/api/v1/inspections/ai-tasks/:id", async (request) => context.inspectionAi.detail(request.params.id, context.inspectionAccounts.identity(request)));
    secured.post<{ Params: { id: string } }>("/api/v1/inspections/ai-tasks/:id/reprocess", async (request) => context.inspectionAi.reprocess(request.params.id, context.inspectionAccounts.identity(request)));
    secured.post<{ Params: { id: string } }>("/api/v1/inspections/ai-tasks/:id/retry", async (request) => ({ task: context.inspectionAi.retry(request.params.id, context.inspectionAccounts.identity(request)) }));
    secured.post<{ Params: { id: string } }>("/api/v1/inspections/ai-tasks/:id/cancel", async (request) => ({ task: context.inspectionAi.cancel(request.params.id, context.inspectionAccounts.identity(request)) }));
  });
}
