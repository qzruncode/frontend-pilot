import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AssistantStoredMessage } from "./assistant-store.js";
import type { AssistantEditRunnerContext } from "./assistant-edit-service.js";
import type { AppRouteContext } from "./app-route-context.js";
import { AssistantFocusContextSchema } from "./contracts.js";
import { browserSessionUser, hasServiceBearerAccess, hasTriggerAccess, parseIdParam, productAccountKey, unauthorized, writeSse, zodError } from "./app-route-utils.js";

const ListAssistantConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const AssistantMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(12_000),
}).strict();

const AssistantMessageParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
  messageId: z.string().trim().min(1).max(128),
}).strict();

const AssistantChatBodySchema = z.object({
  conversationId: z.string().trim().min(1).max(128),
  messageId: z.string().trim().min(1).max(128).optional(),
  runId: z.string().trim().min(1).max(128).optional(),
  afterSequence: z.coerce.number().int().min(0).max(5_000).default(0),
  message: z.string().trim().min(1).max(8_000),
  history: z.array(AssistantMessageSchema).max(40).default([]),
  focusContext: AssistantFocusContextSchema.optional(),
  editSessionId: z.string().trim().min(1).max(128).optional(),
}).strict();

export function registerAssistantRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.get("/api/v1/assistant/conversations", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = ListAssistantConversationsQuerySchema.safeParse(request.query);
    if (!parsed.success) return zodError(reply, parsed.error);
    const user = browserSessionUser(request, context.config, context.userStore);
    return reply.send({ conversations: context.assistantStore.listConversations(parsed.data.limit, user ? `user:${user.username}` : undefined) });
  });

  app.get<{ Params: { id: string } }>("/api/v1/assistant/conversations/:id", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const id = parseIdParam(request, reply);
    if (!id) return;
    const user = browserSessionUser(request, context.config, context.userStore);
    const conversation = context.assistantStore.getConversation(id, 200, user ? `user:${user.username}` : undefined);
    return conversation ? reply.send(conversation) : reply.code(404).send({ error: "assistant_conversation_not_found" });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/assistant/conversations/:id", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const id = parseIdParam(request, reply);
    if (!id) return;
    const user = browserSessionUser(request, context.config, context.userStore);
    return reply.send({ deleted: context.assistantStore.deleteConversation(id, user ? `user:${user.username}` : undefined) });
  });

  app.delete<{ Params: { id: string; messageId: string } }>("/api/v1/assistant/conversations/:id/messages/:messageId", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = AssistantMessageParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    const user = browserSessionUser(request, context.config, context.userStore);
    const ownerKey = user ? `user:${user.username}` : undefined;
    const conversation = context.assistantStore.getConversation(parsed.data.id, 1, ownerKey);
    if (!conversation) return reply.code(404).send({ error: "assistant_conversation_not_found" });
    if (conversation.activeRun?.status === "running") return reply.code(409).send({ error: "assistant_run_active", details: "助手正在生成，暂时不能修改会话消息" });
    return reply.send({ deleted: context.assistantStore.deleteMessage(parsed.data.id, parsed.data.messageId, ownerKey) });
  });

  app.post<{ Params: { id: string; messageId: string } }>("/api/v1/assistant/conversations/:id/messages/:messageId/rewind", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = AssistantMessageParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    const user = browserSessionUser(request, context.config, context.userStore);
    const ownerKey = user ? `user:${user.username}` : undefined;
    const conversation = context.assistantStore.getConversation(parsed.data.id, 1, ownerKey);
    if (!conversation) return reply.code(404).send({ error: "assistant_conversation_not_found" });
    if (conversation.activeRun?.status === "running") return reply.code(409).send({ error: "assistant_run_active", details: "助手正在生成，暂时不能修改会话消息" });
    return reply.send({ deleted: context.assistantStore.deleteMessagesFrom(parsed.data.id, parsed.data.messageId, ownerKey) });
  });

  app.post<{ Params: { id: string } }>("/api/v1/assistant/runs/:id/cancel", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const id = parseIdParam(request, reply);
    if (!id) return;
    const user = browserSessionUser(request, context.config, context.userStore);
    const run = context.assistantStore.getRun(id, 0, user ? `user:${user.username}` : undefined);
    if (!run) return reply.code(404).send({ error: "assistant_run_not_found" });
    return reply.send({ canceled: context.assistantExecution.cancel(id) });
  });

  app.post("/api/v1/assistant/stream", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = AssistantChatBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    if (!context.config.dryRun && !context.claudeState.configured) {
      return reply.code(503).send({ error: "claude_not_configured" });
    }
    const user = browserSessionUser(request, context.config, context.userStore);
    const ownerKey = user ? `user:${user.username}` : undefined;
    let editSession: AssistantEditRunnerContext | null = null;
    if (parsed.data.editSessionId) {
      const editOwnerKey = ownerKey ?? (hasServiceBearerAccess(request, context.config) ? "service" : null);
      if (!editOwnerKey) return unauthorized(reply);
      editSession = await context.assistantEditService.getRunnerContext(parsed.data.editSessionId, editOwnerKey);
      if (!editSession) return reply.code(404).send({ error: "assistant_edit_session_not_found" });
    }
    const conversationId = parsed.data.conversationId;
    const existingConversation = context.assistantStore.getConversation(conversationId, 200, ownerKey);
    if (ownerKey && !existingConversation && context.assistantStore.getConversation(conversationId)) {
      return reply.code(403).send({ error: "assistant_conversation_forbidden" });
    }

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let detached = false;
    let unsubscribe: (() => void) | null = null;
    const detach = (): void => {
      if (detached) return;
      detached = true;
      unsubscribe?.();
      unsubscribe = null;
    };
    response.on("close", detach);
    request.raw.on("aborted", detach);
    response.write("retry: 2000\n\n");
    writeSse(response, "status", { message: "正在恢复助手流程" });

    if (!existingConversation) {
      const history = parsed.data.history;
      const title = history.find((item) => item.role === "user")?.content.slice(0, 80);
      history.forEach((message, index) => {
        context.assistantStore.appendMessage(conversationId, {
          id: `${conversationId}:history:${index}`,
          role: message.role,
          content: message.content,
          createdAt: new Date(Date.now() + index).toISOString(),
        }, title, ownerKey);
      });
    }

    const conversation = context.assistantStore.getConversation(conversationId, 200, ownerKey);
    const userMessageId = parsed.data.messageId ?? randomUUID();
    const userMessage: AssistantStoredMessage = {
      id: userMessageId,
      role: "user",
      content: parsed.data.message,
      createdAt: new Date().toISOString(),
    };
    context.assistantStore.appendMessage(
      conversationId,
      userMessage,
      conversation && conversation.messages.length > 0 ? undefined : parsed.data.message.slice(0, 80),
      ownerKey,
    );
    const persistedConversation = context.assistantStore.getConversation(conversationId, 200, ownerKey);
    const requestedRun = parsed.data.runId ? context.assistantStore.getRun(parsed.data.runId, 0, ownerKey) : null;
    const runRecord = requestedRun
      && requestedRun.conversationId === conversationId
      && requestedRun.userMessageId === userMessageId
      ? { run: requestedRun, created: false }
      : context.assistantExecution.createRun(conversationId, userMessageId);
    const reviewStats = context.service.stats();
    const recentReviews = context.service.listJobs(8).map((job) => ({
      id: job.id,
      projectPath: job.projectPath,
      mrIid: job.mrIid,
      status: job.status,
      summary: job.result?.summary ?? null,
      findingCount: job.result?.findingCount ?? null,
      createdAt: job.createdAt,
    }));

    const sendRunEvent = (event: { event: string; payload: Record<string, unknown> }): void => {
      if (detached || response.destroyed) return;
      writeSse(response, event.event, event.payload);
      if (event.event === "done" || event.event === "error") {
        detach();
        if (!response.writableEnded) response.end();
      }
    };
    writeSse(response, "status", {
      runId: runRecord.run.id,
      conversationId,
      messageId: userMessageId,
      message: "已连接助手流程",
      phase: "start",
    });
    const runUnsubscribe = context.assistantExecution.subscribe(runRecord.run.id, parsed.data.afterSequence, sendRunEvent);
    unsubscribe = runUnsubscribe;
    if (detached) runUnsubscribe();
    if (runRecord.created) {
      context.assistantExecution.start(runRecord.run, {
        messages: (persistedConversation?.messages ?? [userMessage]).map((message) => ({
          role: message.role,
          content: message.content,
        })),
        reviewContext: { ...reviewStats, recentReviews },
        focusContext: parsed.data.focusContext,
        editSession: editSession ?? undefined,
        runtimeContext: {
          productUsername: user?.username ?? null,
          getGitLabClient: (() => {
            const sessionKey = productAccountKey(request, context.config, context.userStore);
            return sessionKey ? () => context.gitlabOAuth.getClient(sessionKey) : undefined;
          })(),
          getJiraClient: (() => {
            const sessionKey = productAccountKey(request, context.config, context.userStore);
            return sessionKey ? () => context.jiraOAuth.getClient(sessionKey) : undefined;
          })(),
          editSession: editSession ?? undefined,
        },
      });
    }
  });
}
