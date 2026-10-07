import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SubmitFeedbackBodySchema } from "./contracts.js";
import type { AppRouteContext } from "./app-route-context.js";
import { hasTriggerAccess, parseIdParam, requireAdminAccess, unauthorized, zodError } from "./app-route-utils.js";
import { safeErrorMessage } from "./errors.js";
import { feedbackUploadFailure, parseFeedbackSubmission } from "./feedback-upload.js";

const ListFeedbackQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

const FeedbackAttachmentParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
  attachmentId: z.string().trim().min(1).max(128),
}).strict();

export function registerFeedbackRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.get("/api/v1/feedback", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const parsed = ListFeedbackQuerySchema.safeParse(request.query);
    if (!parsed.success) return zodError(reply, parsed.error);
    return reply.send(context.feedbackStore.list(parsed.data.limit));
  });

  app.get<{ Params: { id: string } }>("/api/v1/feedback/:id", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    const feedback = context.feedbackStore.get(id);
    return feedback ? reply.send(feedback) : reply.code(404).send({ error: "feedback_not_found" });
  });

  app.get<{ Params: { id: string; attachmentId: string } }>("/api/v1/feedback/:id/attachments/:attachmentId", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const parsed = FeedbackAttachmentParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    const attachment = context.feedbackStore.readAttachment?.(parsed.data.id, parsed.data.attachmentId);
    if (!attachment) return reply.code(404).send({ error: "feedback_attachment_not_found" });
    reply
      .header("cache-control", "private, no-store")
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`)
      .type(attachment.mimeType);
    return reply.send(createReadStream(attachment.filePath));
  });

  app.delete<{ Params: { id: string } }>("/api/v1/feedback/:id", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    const deleted = context.feedbackStore.delete(id);
    return deleted ? reply.send({ deleted: true }) : reply.code(404).send({ error: "feedback_not_found" });
  });

  app.post("/api/v1/feedback", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);

    try {
      const { body, attachments } = await parseFeedbackSubmission(request);
      const parsed = SubmitFeedbackBodySchema.safeParse(body);
      if (!parsed.success) return zodError(reply, parsed.error);
      const submission = context.feedbackStore.create({
        ...parsed.data,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      return reply.code(201).send({ accepted: true, receivedAt: submission.receivedAt });
    } catch (error) {
      const uploadFailure = feedbackUploadFailure(error);
      if (uploadFailure) return reply.code(uploadFailure.status).send({ error: "feedback_upload_invalid", details: uploadFailure.message });
      return reply.code(500).send({
        error: "feedback_submit_failed",
        details: safeErrorMessage(error, "意见暂时无法提交，请稍后重试"),
      });
    }
  });
}
