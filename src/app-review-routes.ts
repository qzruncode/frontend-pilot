import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CreateCiReviewBodySchema,
  CreateReviewBodySchema,
  ResolveMergeRequestBodySchema,
  UpdateReviewSettingsBodySchema,
  type ReviewProgressEvent,
} from "./contracts.js";
import { GitLabApiError, InvalidMergeRequestUrlError } from "./gitlab-client.js";
import { ReviewDeleteError, ReviewRetryError, ReviewTerminalError } from "./review-service.js";
import { headerValue, tokenHash } from "./auth.js";
import type { AppRouteContext } from "./app-route-context.js";
import { hasTriggerAccess, parseIdParam, requireAdminAccess, unauthorized, writeSse, zodError } from "./app-route-utils.js";

const ListReviewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const TERMINAL_REVIEW_STATUSES = new Set(["completed", "failed", "superseded", "canceled"]);

function currentHead(mergeRequest: { diff_refs?: { head_sha?: string | null } | null; sha?: string | null }): string | null {
  return mergeRequest.sha?.trim() || mergeRequest.diff_refs?.head_sha?.trim() || null;
}

export function registerReviewRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.post("/api/v1/merge-requests/resolve", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = ResolveMergeRequestBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    if (!context.gitlabClient.resolveMergeRequestUrl) {
      return reply.code(503).send({ error: "merge_request_resolution_not_configured" });
    }

    try {
      return reply.send(await context.gitlabClient.resolveMergeRequestUrl(parsed.data.url));
    } catch (error) {
      if (error instanceof InvalidMergeRequestUrlError) {
        return reply.code(400).send({ error: "invalid_merge_request_url", details: error.message });
      }
      if (error instanceof GitLabApiError) {
        return reply.code(502).send({ error: "gitlab_api_error", details: error.message });
      }
      throw error;
    }
  });

  app.post("/api/v1/ci/reviews", async (request, reply) => {
    const jobToken = headerValue(request.headers["job-token"]);
    if (!jobToken) return reply.code(401).send({ error: "invalid_ci_job_token" });
    if (!context.gitlabClient.getJobByToken) {
      return reply.code(503).send({ error: "gitlab_ci_job_auth_not_configured" });
    }
    const parsed = CreateCiReviewBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);

    let ciJob;
    try {
      ciJob = await context.gitlabClient.getJobByToken(jobToken);
    } catch (error) {
      if (error instanceof GitLabApiError && (error.status === 401 || error.status === 403)) {
        return reply.code(401).send({ error: "invalid_ci_job_token" });
      }
      throw error;
    }

    const jobProjectId = String(ciJob.pipeline.project_id);
    if (
      String(ciJob.id) !== parsed.data.jobId
      || String(ciJob.pipeline.id) !== parsed.data.pipelineId
      || jobProjectId !== parsed.data.projectId
      || ciJob.commit.id !== parsed.data.headSha
      || ciJob.pipeline.source !== "merge_request_event"
      || (ciJob.web_url && ciJob.web_url !== parsed.data.jobUrl)
    ) {
      return reply.code(401).send({ error: "ci_job_context_mismatch" });
    }

    let mergeRequest;
    try {
      mergeRequest = await context.gitlabClient.getMergeRequest(parsed.data.projectId, parsed.data.mrIid);
    } catch (error) {
      if (error instanceof GitLabApiError) {
        return reply.code(502).send({ error: "gitlab_api_error", details: error.message });
      }
      throw error;
    }
    const actualHeadSha = currentHead(mergeRequest);
    if (actualHeadSha && actualHeadSha !== parsed.data.headSha) {
      return reply.code(409).send({ error: "review_head_is_stale", currentHeadSha: actualHeadSha });
    }

    const { projectId, projectPath, mrIid, headSha, targetBranch } = parsed.data;
    try {
      const result = await context.service.enqueue(
        { projectId, projectPath, mrIid, headSha, targetBranch, source: "gitlab-ci" },
        {
          ciBinding: {
            jobId: parsed.data.jobId,
            pipelineId: parsed.data.pipelineId,
            jobUrl: parsed.data.jobUrl,
            tokenHash: tokenHash(jobToken),
          },
        },
      );
      return reply.code(202).send({ accepted: true, ...result });
    } catch (error) {
      if (error instanceof ReviewTerminalError) {
        return reply.code(409).send({ error: "merge_request_terminal", state: error.state, details: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/ci/reviews/:id", async (request, reply) => {
    const jobToken = headerValue(request.headers["job-token"]);
    if (!jobToken) return reply.code(401).send({ error: "invalid_ci_job_token" });
    const id = parseIdParam(request, reply);
    if (!id) return;
    const job = context.service.getCiJob(id, tokenHash(jobToken));
    return job ? reply.send(job) : reply.code(401).send({ error: "invalid_ci_job_token" });
  });

  app.get<{ Params: { id: string } }>("/api/v1/reviews/:id/events", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const id = parseIdParam(request, reply);
    if (!id) return;
    const job = context.service.getJob(id);
    if (!job) return reply.code(404).send({ error: "review_not_found" });

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
      response.write(`id: ${event.id}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`);
    };

    response.on("close", cleanup);
    request.raw.on("close", cleanup);
    response.write("retry: 2000\n\n");
    unsubscribe = context.service.subscribeToProgress(id, writeProgress);
    for (const event of context.service.getProgressEvents(id) ?? []) writeProgress(event);

    const latest = context.service.getJob(id);
    if (!latest || TERMINAL_REVIEW_STATUSES.has(latest.status)) response.end();
  });

  app.get("/api/v1/reviews", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = ListReviewsQuerySchema.safeParse(request.query);
    if (!parsed.success) return zodError(reply, parsed.error);
    return reply.send({ jobs: context.service.listJobs(parsed.data.limit), stats: context.service.stats() });
  });

  app.get("/api/v1/review-settings", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    return reply.send({ settings: context.service.getSettings() });
  });

  app.put("/api/v1/review-settings", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const parsed = UpdateReviewSettingsBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    return reply.send({ settings: context.service.updateSettings(parsed.data.reviewConcurrency, parsed.data.autoSendComments) });
  });

  app.post("/api/v1/reviews", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = CreateReviewBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const result = await context.service.enqueue({ ...parsed.data, source: "api" });
      return reply.code(202).send({ accepted: true, ...result });
    } catch (error) {
      if (error instanceof ReviewTerminalError) {
        return reply.code(409).send({ error: "merge_request_terminal", state: error.state, details: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/reviews/:id", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const id = parseIdParam(request, reply);
    if (!id) return;
    const job = context.service.getJob(id);
    return job ? reply.send(job) : reply.code(404).send({ error: "review_not_found" });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/reviews/:id", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const id = parseIdParam(request, reply);
    if (!id) return;
    try {
      const deleted = await context.service.delete(id);
      return deleted === null
        ? reply.code(404).send({ error: "review_not_found" })
        : reply.send({ deleted });
    } catch (error) {
      if (error instanceof ReviewDeleteError) {
        return reply.code(409).send({ error: "review_delete_not_allowed", details: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/reviews/:id/cancel", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const id = parseIdParam(request, reply);
    if (!id) return;
    const job = await context.service.cancel(id);
    return job ? reply.send(job) : reply.code(404).send({ error: "review_not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/v1/reviews/:id/retry", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const id = parseIdParam(request, reply);
    if (!id) return;
    try {
      const result = await context.service.retry(id);
      return result
        ? reply.code(202).send({ accepted: true, ...result })
        : reply.code(404).send({ error: "review_not_found" });
    } catch (error) {
      if (error instanceof ReviewRetryError) {
        return reply.code(409).send({ error: "review_retry_not_allowed", details: error.message });
      }
      throw error;
    }
  });
}
