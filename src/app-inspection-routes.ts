import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { InspectionDeleteError, InspectionOwnershipError } from "./inspection-service.js";
import {
  CreateInspectionProfileBodySchema,
  CreateInspectionJiraBodySchema,
  CreateInspectionRuleBodySchema,
  DeleteInspectionProfileBodySchema,
  DeleteInspectionRuleBodySchema,
  ReorderInspectionRulesBodySchema,
  SaveInspectionPromptBodySchema,
  SaveInspectionOwnerPromptBodySchema,
  StartInspectionBodySchema,
  UpdateInspectionRuleBodySchema,
  UpsertInspectionProjectBodySchema,
  type ReviewProgressEvent,
} from "./contracts.js";
import type { AppRouteContext } from "./app-route-context.js";
import { parseIdParam, writeSse, zodError } from "./app-route-utils.js";
import { INSPECTION_OWNER_PROMPT_ID } from "./inspection-prompts.js";

const ListInspectionRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

const InspectionProjectParamsSchema = z.object({
  projectId: z.string().trim().min(1).max(128),
}).strict();

const InspectionFindingParamsSchema = z.object({
  runId: z.string().trim().min(1).max(128),
  findingId: z.string().trim().min(1).max(128),
}).strict();

const TERMINAL_INSPECTION_STATUSES = new Set(["completed", "failed", "canceled"]);

function failure(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown, code = "inspection_request_failed") {
  if (error instanceof InspectionOwnershipError) {
    return reply.code(403).send({ error: "inspection_maintainer_mismatch", details: error.message });
  }
  return reply.code(400).send({ error: code, details: error instanceof Error ? error.message : String(error) });
}

export function registerInspectionRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.get("/api/v1/inspections/rules", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    try {
      return reply.send({ profiles: await context.inspectionRulesStore.list(context.inspectionAccounts.current(request)!.id) });
    } catch (error) {
      return failure(reply, error, "inspection_rules_read_failed");
    }
  });

  app.get("/api/v1/inspections/prompts", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    try {
      return reply.send({ prompts: await context.inspectionPromptStore.list(context.inspectionAccounts.current(request)!.id) });
    } catch (error) {
      return failure(reply, error, "inspection_prompts_read_failed");
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/inspections/prompts/:id", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    try {
      return reply.send({ prompt: await context.inspectionPromptStore.read(id, context.inspectionAccounts.current(request)!.id) });
    } catch (error) {
      return failure(reply, error, "inspection_prompt_read_failed");
    }
  });

  app.put<{ Params: { id: string } }>("/api/v1/inspections/prompts/:id", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    const parsed = SaveInspectionPromptBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ prompt: await context.inspectionPromptStore.update(id, parsed.data.content, context.inspectionAccounts.current(request)!.id) });
    } catch (error) {
      return failure(reply, error, "inspection_prompt_update_failed");
    }
  });

  // Keep the original endpoint available for older clients during the prompt API migration.
  app.get("/api/v1/inspections/owner-prompt", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    try {
      return reply.send({ prompt: (await context.inspectionPromptStore.read(INSPECTION_OWNER_PROMPT_ID, context.inspectionAccounts.current(request)!.id)).content });
    } catch (error) {
      return failure(reply, error, "inspection_owner_prompt_read_failed");
    }
  });

  app.put("/api/v1/inspections/owner-prompt", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const parsed = SaveInspectionOwnerPromptBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ prompt: (await context.inspectionPromptStore.update(INSPECTION_OWNER_PROMPT_ID, parsed.data.prompt, context.inspectionAccounts.current(request)!.id)).content });
    } catch (error) {
      return failure(reply, error, "inspection_owner_prompt_update_failed");
    }
  });

  app.post("/api/v1/inspections/profiles", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const parsed = CreateInspectionProfileBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.code(201).send({ profile: await context.inspectionRulesStore.createProfile(parsed.data, context.inspectionAccounts.current(request)!.id) });
    } catch (error) {
      return reply.code(409).send({ error: "inspection_profile_create_failed", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/v1/inspections/profiles", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const parsed = DeleteInspectionProfileBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      await context.inspectionRulesStore.deleteProfile(parsed.data, context.inspectionAccounts.current(request)!.id);
      return reply.send({ deleted: true });
    } catch (error) {
      return reply.code(409).send({ error: "inspection_profile_delete_failed", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/inspections/rules", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const parsed = CreateInspectionRuleBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.code(201).send({ profile: await context.inspectionRulesStore.createRule(parsed.data, context.inspectionAccounts.current(request)!.id) });
    } catch (error) {
      return reply.code(409).send({ error: "inspection_rule_create_failed", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/v1/inspections/rules", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const parsed = UpdateInspectionRuleBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ profile: await context.inspectionRulesStore.updateRule(parsed.data, context.inspectionAccounts.current(request)!.id) });
    } catch (error) {
      return reply.code(409).send({ error: "inspection_rule_update_failed", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/v1/inspections/rules", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const parsed = DeleteInspectionRuleBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ profile: await context.inspectionRulesStore.deleteRule(parsed.data, context.inspectionAccounts.current(request)!.id) });
    } catch (error) {
      return reply.code(409).send({ error: "inspection_rule_delete_failed", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/v1/inspections/rules/order", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const parsed = ReorderInspectionRulesBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ profile: await context.inspectionRulesStore.reorderRules(parsed.data, context.inspectionAccounts.current(request)!.id) });
    } catch (error) {
      return reply.code(409).send({ error: "inspection_rules_reorder_failed", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/v1/inspections/projects", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    return reply.send({ projects: context.inspectionService.listProjects(context.inspectionAccounts.identity(request)) });
  });

  app.put<{ Params: { projectId: string } }>("/api/v1/inspections/projects/:projectId", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const params = InspectionProjectParamsSchema.safeParse(request.params);
    if (!params.success) return zodError(reply, params.error);
    const parsed = UpsertInspectionProjectBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ project: await context.inspectionService.upsertProject({ projectId: params.data.projectId, ...parsed.data, ...context.inspectionAccounts.identity(request) }) });
    } catch (error) {
      return failure(reply, error, "inspection_project_save_failed");
    }
  });

  app.post<{ Params: { projectId: string } }>("/api/v1/inspections/projects/:projectId/runs", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const params = InspectionProjectParamsSchema.safeParse(request.params);
    if (!params.success) return zodError(reply, params.error);
    const body = StartInspectionBodySchema.safeParse(request.body ?? {});
    if (!body.success) return zodError(reply, body.error);
    try {
      const result = await context.inspectionService.enqueue(params.data.projectId, "manual", context.inspectionAccounts.identity(request), body.data);
      return reply.code(202).send({ accepted: true, ...result });
    } catch (error) {
      return failure(reply, error, "inspection_run_start_failed");
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/inspections/runs/:id/retry", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    try {
      return reply.code(202).send({ accepted: true, run: await context.inspectionService.retry(id, context.inspectionAccounts.identity(request)) });
    } catch (error) {
      return failure(reply, error, "inspection_run_retry_failed");
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/inspections/runs/:id/cancel", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    const run = await context.inspectionService.cancel(id, context.inspectionAccounts.identity(request));
    return run ? reply.send(run) : reply.code(404).send({ error: "inspection_run_not_found" });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/inspections/runs/:id", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    try {
      const deleted = await context.inspectionService.delete(id, context.inspectionAccounts.identity(request));
      return deleted === null
        ? reply.code(404).send({ error: "inspection_run_not_found" })
        : reply.send({ deleted });
    } catch (error) {
      if (error instanceof InspectionDeleteError) {
        return reply.code(409).send({ error: "inspection_run_delete_not_allowed", details: error.message });
      }
      throw error;
    }
  });

  app.get("/api/v1/inspections/runs", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const parsed = ListInspectionRunsQuerySchema.safeParse(request.query);
    if (!parsed.success) return zodError(reply, parsed.error);
    await context.inspectionService.syncJiraStatuses(context.inspectionAccounts.identity(request));
    return reply.send({ runs: context.inspectionService.listRuns(parsed.data.limit, context.inspectionAccounts.identity(request)) });
  });

  app.get<{ Params: { id: string } }>("/api/v1/inspections/runs/:id", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    await context.inspectionService.syncJiraStatuses(context.inspectionAccounts.identity(request));
    const run = context.inspectionService.getRun(id, context.inspectionAccounts.identity(request));
    return run ? reply.send({ run }) : reply.code(404).send({ error: "inspection_run_not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/v1/inspections/runs/:id/authors", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    if (context.inspectionService.getRun(id)?.maintainerId !== context.inspectionAccounts.current(request)!.id) return reply.code(403).send({ error: "inspection_maintainer_mismatch", details: "请登录此巡检记录的维护人员账号，历史未绑定记录请先重跑" });
    try {
      return reply.send({ run: await context.inspectionService.resolveAuthors(id, context.inspectionAccounts.identity(request)) });
    } catch (error) {
      return failure(reply, error, "inspection_author_resolution_failed");
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/inspections/runs/:id/owners", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    if (context.inspectionService.getRun(id)?.maintainerId !== context.inspectionAccounts.current(request)!.id) return reply.code(403).send({ error: "inspection_maintainer_mismatch", details: "请登录此巡检记录的维护人员账号，历史未绑定记录请先重跑" });
    try {
      return reply.send({ run: await context.inspectionService.resolveOwners(id, context.inspectionAccounts.identity(request)) });
    } catch (error) {
      return failure(reply, error, "inspection_owner_resolution_failed");
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/inspections/runs/:id/events", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    const identity = context.inspectionAccounts.identity(request);
    const run = context.inspectionService.getRun(id, identity);
    if (!run) return reply.code(404).send({ error: "inspection_run_not_found" });

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    let unsubscribe = (): void => undefined;
    const heartbeat = setInterval(() => {
      if (!closed && !response.destroyed) response.write(": keep-alive\n\n");
    }, 15_000);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    const writeProgress = (event: ReviewProgressEvent): void => {
      if (closed || response.destroyed) return;
      writeSse(response, "progress", event);
    };

    response.on("close", cleanup);
    request.raw.on("close", cleanup);
    response.write("retry: 2000\n\n");
    unsubscribe = context.inspectionService.subscribeToProgress(id, writeProgress, identity);
    for (const event of context.inspectionService.getProgressEvents(id, identity) ?? []) writeProgress(event);

    const latest = context.inspectionService.getRun(id, identity);
    if (!latest || TERMINAL_INSPECTION_STATUSES.has(latest.status)) response.end();
  });

  app.post<{ Params: { runId: string; findingId: string } }>("/api/v1/inspections/runs/:runId/findings/:findingId/owner", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const params = InspectionFindingParamsSchema.safeParse(request.params);
    if (!params.success) return zodError(reply, params.error);
    if (context.inspectionService.getRun(params.data.runId)?.maintainerId !== context.inspectionAccounts.current(request)!.id) return reply.code(403).send({ error: "inspection_maintainer_mismatch", details: "请登录此巡检记录的维护人员账号，历史未绑定记录请先重跑" });
    try {
      return reply.send({ run: await context.inspectionService.resolveOwner(params.data.runId, params.data.findingId, context.inspectionAccounts.identity(request)) });
    } catch (error) {
      return failure(reply, error, "inspection_owner_resolution_failed");
    }
  });

  app.post<{ Params: { runId: string; findingId: string } }>("/api/v1/inspections/runs/:runId/findings/:findingId/jira", async (request, reply) => {
    if (!context.inspectionAccounts.requireMaintainer(request, reply)) return;
    const params = InspectionFindingParamsSchema.safeParse(request.params);
    if (!params.success) return zodError(reply, params.error);
    const body = CreateInspectionJiraBodySchema.safeParse(request.body ?? {});
    if (!body.success) return zodError(reply, body.error);
    if (context.inspectionService.getRun(params.data.runId)?.maintainerId !== context.inspectionAccounts.current(request)!.id) return reply.code(403).send({ error: "inspection_maintainer_mismatch", details: "请登录此巡检记录的维护人员账号，历史未绑定记录请先重跑" });
    try {
      return reply.code(201).send({ run: await context.inspectionService.createJira(params.data.runId, params.data.findingId, body.data.assignee, context.inspectionAccounts.identity(request)) });
    } catch (error) {
      return failure(reply, error, "inspection_jira_create_failed");
    }
  });
}
