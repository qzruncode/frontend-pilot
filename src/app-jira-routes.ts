import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { JiraApiError, JiraClient, JiraCreateOptionError, resolveJiraCreateIssueInput, type JiraClientPort } from "./jira-client.js";
import { jiraAttachmentUploadFailure, parseJiraAttachmentUpload } from "./jira-attachment-upload.js";
import { loadJiraBoard } from "./jira-board.js";
import { JiraConnectionInputSchema, JiraCreateIssueInputSchema, JiraCredentialInputSchema, type JiraIssue } from "./contracts.js";
import type { AppRouteContext } from "./app-route-context.js";
import { browserSessionUser, hasTriggerAccess, productAccountKey, requireAdminAccess, unauthorized, zodError } from "./app-route-utils.js";
import { safeErrorMessage } from "./errors.js";

const JiraIssueScopeSchema = z.enum(["assigned_to_me", "reported_by_me", "all"]);
const JiraIssueStateSchema = z.enum(["review", "todo", "in_progress", "acceptance", "done", "all"]);
const JiraIssueQuerySchema = z.object({
  scope: JiraIssueScopeSchema.default("assigned_to_me"),
  state: JiraIssueStateSchema.default("todo"),
  search: z.string().trim().max(200).optional(),
  projectKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).optional(),
  assignee: z.string().trim().max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
  page: z.coerce.number().int().min(1).max(100).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(25),
}).strict();

const JiraBoardQuerySchema = z.object({
  member: z.string().trim().max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
}).strict();

const JiraCreateIssueSupportingFieldSchema = z.enum(["assignees", "components", "fixVersions", "labels"]);
const JiraCreateIssueSupportingQuerySchema = z.object({ query: z.string().trim().max(256).optional() }).strict();

const JiraIssueParamsSchema = z.object({
  key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}-\d+$/).max(80),
}).strict();

const JiraAttachmentParamsSchema = JiraIssueParamsSchema.extend({
  attachmentId: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

const JiraCommentBodySchema = z.object({
  body: z.string().trim().min(1).max(50_000),
}).strict();

const JiraTransitionBodySchema = z.object({
  transitionId: z.string().trim().min(1).max(80),
}).strict();

function publicJiraConnection(connection: { baseUrl: string; apiBaseUrl: string; projectKey: string; username: string; token: string }) {
  return {
    baseUrl: connection.baseUrl,
    apiBaseUrl: connection.apiBaseUrl,
    projectKey: connection.projectKey,
    username: connection.username,
    tokenConfigured: Boolean(connection.token),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jiraErrorDetails(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const messages: string[] = [];
  if (Array.isArray(body.errorMessages)) {
    messages.push(...body.errorMessages.filter((message): message is string => typeof message === "string"));
  }
  if (isRecord(body.errors)) {
    for (const [field, message] of Object.entries(body.errors)) {
      if (typeof message === "string") messages.push(`${field}：${message}`);
    }
  }
  return messages.map((message) => message.trim()).filter(Boolean).slice(0, 6).join("；").slice(0, 800) || null;
}

function jiraFailure(reply: FastifyReply, error: unknown, fallback: string): FastifyReply {
  if (error instanceof JiraCreateOptionError) {
    return reply.code(400).send({ error: "invalid_jira_create_option", details: error.message });
  }
  if (error instanceof JiraApiError) {
    const status = error.status ?? "错误";
    const isOAuthChallenge = error.authChallenge?.toLowerCase().includes("oauth") ?? false;
    const jiraDetails = jiraErrorDetails(error.body);
    const details = isOAuthChallenge
      ? "Jira 账号或访问 Token 已失效，请重新填写并测试。"
      : `Jira 返回 HTTP ${status}${jiraDetails ? `：${jiraDetails}` : ""}`;
    return reply.code(502).send({ error: "jira_api_error", details });
  }
  return reply.code(500).send({ error: "jira_workbench_failed", details: fallback });
}

function connectionFor(context: AppRouteContext) {
  return context.initialJiraConnection;
}

function productUser(request: Parameters<typeof browserSessionUser>[0], context: AppRouteContext) {
  return browserSessionUser(request, context.config, context.userStore);
}

async function jiraClientForRequest(request: Parameters<typeof browserSessionUser>[0], context: AppRouteContext): Promise<{ client: JiraClientPort | null; personal: boolean }> {
  const user = productUser(request, context);
  const sessionKey = productAccountKey(request, context.config, context.userStore);
  const oauthClient = sessionKey ? await context.jiraOAuth.getClient(sessionKey) : null;
  return {
    client: oauthClient ?? (user ? context.jiraClientForUser(user.username) : context.initialJiraConnection.token ? context.jiraClient : null),
    personal: Boolean(user),
  };
}

function configuredJira(reply: FastifyReply, jira: JiraClientPort | null, personal: boolean): jira is JiraClientPort {
  if (jira) return true;
  reply.code(428).send(personal
    ? { error: "jira_account_required", details: "请先连接你的 Jira 账号" }
    : { error: "jira_connection_required", details: "请先在 Jira 连接设置中填写访问凭据" });
  return false;
}

function publicJiraAccount(connection: { baseUrl: string; apiBaseUrl: string; projectKey: string }, credential: { jiraUsername: string; token: string } | null, oauthConnected = false, oauthUsername = "") {
  return {
    baseUrl: connection.baseUrl,
    apiBaseUrl: connection.apiBaseUrl,
    projectKey: connection.projectKey,
    username: credential?.jiraUsername || oauthUsername,
    tokenConfigured: Boolean(credential?.token) || oauthConnected,
  };
}

function inlineAttachmentFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function registerJiraRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.get("/api/v1/jira-connection", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    try {
      const connection = await context.jiraConnectionStore.read(context.fallbackJiraConnection);
      return reply.header("cache-control", "no-store").send(publicJiraConnection(connection));
    } catch (error) {
      return reply.code(500).send({ error: "jira_connection_read_failed", details: "无法读取 Jira 连接配置" });
    }
  });

  app.post("/api/v1/jira-connection/reveal-token", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    try {
      const connection = await context.jiraConnectionStore.read(context.fallbackJiraConnection);
      if (!connection.token) return reply.code(404).send({ error: "jira_token_not_configured", details: "当前没有已保存的 Jira 凭据" });
      return reply.header("cache-control", "no-store").send({ token: connection.token });
    } catch (error) {
      return reply.code(500).send({ error: "jira_token_read_failed", details: "无法读取 Jira 凭据" });
    }
  });

  app.put("/api/v1/jira-connection", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const parsed = JiraConnectionInputSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const current = await context.jiraConnectionStore.read(context.fallbackJiraConnection);
      const connection = await context.jiraConnectionStore.write({
        ...parsed.data,
        token: parsed.data.token === undefined ? current.token : parsed.data.token.trim(),
      });
      if (context.jiraClient instanceof JiraClient) context.jiraClient.updateConnection(connection);
      Object.assign(context.initialJiraConnection, connection);
      return reply.send(publicJiraConnection(connection));
    } catch (error) {
      return reply.code(500).send({ error: "jira_connection_write_failed", details: "无法保存 Jira 连接配置" });
    }
  });

  app.post("/api/v1/jira-connection/test", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const parsed = JiraConnectionInputSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const current = await context.jiraConnectionStore.read(context.fallbackJiraConnection);
      const token = parsed.data.token === undefined ? current.token : parsed.data.token.trim();
      if (!token) return reply.code(400).send({ error: "jira_token_required", details: "请填写 Jira 访问凭据" });
      const client = new JiraClient({ ...parsed.data, token });
      const startedAt = Date.now();
      const user = await client.getCurrentUser();
      return reply.send({
        ok: true,
        baseUrl: parsed.data.baseUrl,
        apiBaseUrl: parsed.data.apiBaseUrl,
        projectKey: parsed.data.projectKey,
        userName: user.name || user.username || "当前 Jira 用户",
        username: user.username || null,
        latencyMs: Date.now() - startedAt,
        message: `已连接 Jira，当前身份：${user.name || user.username || "当前 Jira 用户"}`,
      });
    } catch (error) {
      return jiraFailure(reply, error, "Jira 连接测试失败");
    }
  });

  app.get("/api/v1/jira/account", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const user = productUser(request, context);
    if (!user) return unauthorized(reply);
    try {
      const connection = await context.jiraConnectionStore.read(context.fallbackJiraConnection);
      const oauth = context.jiraOAuth.status(productAccountKey(request, context.config, context.userStore) ?? "");
      return reply.header("cache-control", "no-store").send(publicJiraAccount(connection, context.jiraUserCredentialStore.read(user.username), oauth.connected, oauth.identity?.username ?? ""));
    } catch (error) {
      return reply.code(500).send({ error: "jira_account_read_failed", details: "无法读取当前用户的 Jira 凭据" });
    }
  });

  app.put("/api/v1/jira/account", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const user = productUser(request, context);
    if (!user) return unauthorized(reply);
    const parsed = JiraCredentialInputSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const current = context.jiraUserCredentialStore.read(user.username);
      const token = parsed.data.token?.trim() || current?.token || "";
      if (!token) return reply.code(400).send({ error: "jira_credentials_required", details: "请填写 Jira Token 或密码" });
      context.jiraUserCredentialStore.write(user.username, { jiraUsername: parsed.data.username, token });
      const sessionKey = productAccountKey(request, context.config, context.userStore);
      if (sessionKey) context.jiraOAuth.disconnect(sessionKey);
      const connection = await context.jiraConnectionStore.read(context.fallbackJiraConnection);
      const oauth = context.jiraOAuth.status(sessionKey ?? "");
      return reply.header("cache-control", "no-store").send(publicJiraAccount(connection, context.jiraUserCredentialStore.read(user.username), oauth.connected, oauth.identity?.username ?? ""));
    } catch (error) {
      return reply.code(500).send({ error: "jira_account_write_failed", details: "无法保存当前用户的 Jira 凭据" });
    }
  });

  app.post("/api/v1/jira/account/test", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const user = productUser(request, context);
    if (!user) return unauthorized(reply);
    const parsed = JiraCredentialInputSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const current = context.jiraUserCredentialStore.read(user.username);
      const token = parsed.data.token?.trim() || current?.token || "";
      if (!token) return reply.code(400).send({ error: "jira_credentials_required", details: "请填写 Jira Token 或密码" });
      const connection = await context.jiraConnectionStore.read(context.fallbackJiraConnection);
      const client = new JiraClient({ ...connection, username: parsed.data.username, token });
      const startedAt = Date.now();
      const jiraUser = await client.getCurrentUser();
      return reply.send({
        ok: true,
        baseUrl: connection.baseUrl,
        apiBaseUrl: connection.apiBaseUrl,
        projectKey: connection.projectKey,
        userName: jiraUser.name || jiraUser.username || "当前 Jira 用户",
        username: jiraUser.username || null,
        latencyMs: Date.now() - startedAt,
        message: `已连接 Jira，当前身份：${jiraUser.name || jiraUser.username || "当前 Jira 用户"}`,
      });
    } catch (error) {
      return jiraFailure(reply, error, "Jira 个人账号连接测试失败");
    }
  });

  app.delete("/api/v1/jira/account", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const user = productUser(request, context);
    if (!user) return unauthorized(reply);
    try {
      context.jiraUserCredentialStore.delete(user.username);
      const sessionKey = productAccountKey(request, context.config, context.userStore);
      if (sessionKey) context.jiraOAuth.disconnect(sessionKey);
      const connection = await context.jiraConnectionStore.read(context.fallbackJiraConnection);
      return reply.header("cache-control", "no-store").send(publicJiraAccount(connection, null));
    } catch (error) {
      return reply.code(500).send({ error: "jira_account_delete_failed", details: "无法退出当前用户的 Jira 账号" });
    }
  });

  app.get("/api/v1/jira/overview", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await jiraClientForRequest(request, context);
    if (!configuredJira(reply, jira, personal)) return reply;
    try {
      const projectKey = connectionFor(context).projectKey;
      const [user, assigned, reported, recent] = await Promise.all([
        jira.getCurrentUser(),
        jira.listIssues({ scope: "assigned_to_me", state: "todo", projectKey, page: 1, perPage: 8 }),
        jira.listIssues({ scope: "reported_by_me", state: "todo", projectKey, page: 1, perPage: 8 }),
        jira.listIssues({ scope: "all", state: "all", projectKey, page: 1, perPage: 8 }),
      ]);
      return reply.send({
        user,
        assigned: assigned.issues,
        assignedTotal: assigned.total,
        reported: reported.issues,
        reportedTotal: reported.total,
        recent: recent.issues,
        recentTotal: recent.total,
      });
    } catch (error) {
      return jiraFailure(reply, error, "无法读取 Jira 工作台概览");
    }
  });

  app.get("/api/v1/jira/board", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await jiraClientForRequest(request, context);
    if (!configuredJira(reply, jira, personal)) return reply;
    const parsed = JiraBoardQuerySchema.safeParse(request.query);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send(await loadJiraBoard(jira, connectionFor(context).projectKey, context.userStore.list(), parsed.data.member));
    } catch (error) {
      return jiraFailure(reply, error, "无法读取 Jira 团队看板");
    }
  });

  app.get("/api/v1/jira/issues", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await jiraClientForRequest(request, context);
    if (!configuredJira(reply, jira, personal)) return reply;
    const parsed = JiraIssueQuerySchema.safeParse(request.query);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const projectKey = parsed.data.projectKey || connectionFor(context).projectKey;
      const result = await jira.listIssues({
        ...parsed.data,
        projectKey,
      });
      return reply.send(result);
    } catch (error) {
      return jiraFailure(reply, error, "无法读取 Jira 问题列表");
    }
  });

  app.get<{ Params: { key: string } }>("/api/v1/jira/issues/:key/inspection-ai-source", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = JiraIssueParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    const maintainer = context.inspectionAccounts.current(request);
    if (!maintainer) return reply.header("cache-control", "no-store").send({ source: null, maintainerId: null });
    try {
      const source = context.inspectionAi.findJiraSource(parsed.data.key, context.inspectionAccounts.identity(request));
      return reply.header("cache-control", "no-store").send({ source, maintainerId: source ? maintainer.id : null });
    } catch (error) {
      return reply.code(409).send({ error: "inspection_ai_source_unavailable", details: safeErrorMessage(error, "当前巡检会话无法读取此 Jira 的来源") });
    }
  });

  registerJiraIssueRoutes(app, context);
}

export function registerJiraIssueRoutes(app: FastifyInstance, context: AppRouteContext, options?: {
  prefix: string;
  client: (request: Parameters<typeof browserSessionUser>[0]) => Promise<JiraClientPort | null>;
  onIssueRead?: (request: Parameters<typeof browserSessionUser>[0], issue: JiraIssue) => void;
}): void {
  const prefix = options?.prefix ?? "/api/v1/jira";
  const resolveClient = options ? async (request: Parameters<typeof browserSessionUser>[0]) => ({ client: await options.client(request), personal: true })
    : (request: Parameters<typeof browserSessionUser>[0]) => jiraClientForRequest(request, context);
  app.post(`${prefix}/issues`, async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await resolveClient(request);
    if (!configuredJira(reply, jira, personal)) return reply;
    const parsed = JiraCreateIssueInputSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const projectKey = connectionFor(context).projectKey;
      const input = await resolveJiraCreateIssueInput(jira, projectKey, parsed.data);
      return reply.code(201).send(await jira.createIssue(projectKey, input));
    } catch (error) {
      return jiraFailure(reply, error, "无法创建 Jira 问题");
    }
  });

  app.post<{ Params: { key: string } }>(`${prefix}/issues/:key/attachments`, async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await resolveClient(request);
    if (!configuredJira(reply, jira, personal)) return reply;
    const parsed = JiraIssueParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const attachments = await parseJiraAttachmentUpload(request);
      await jira.addAttachments(parsed.data.key, attachments);
      return reply.code(201).send({ uploaded: attachments.length });
    } catch (error) {
      const uploadFailure = jiraAttachmentUploadFailure(error);
      if (uploadFailure) return reply.code(uploadFailure.status).send({ error: "jira_attachment_upload_invalid", details: uploadFailure.message });
      return jiraFailure(reply, error, "无法上传 Jira 附件");
    }
  });

  app.get(`${prefix}/issues/create-options`, async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await resolveClient(request);
    if (!configuredJira(reply, jira, personal)) return reply;
    try {
      return reply.send(await jira.getCreateIssueOptions(connectionFor(context).projectKey));
    } catch (error) {
      return jiraFailure(reply, error, "无法读取 Jira 新建问题选项");
    }
  });

  app.get(`${prefix}/issues/create-options/supporting`, async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await resolveClient(request);
    if (!configuredJira(reply, jira, personal)) return reply;
    try {
      return reply.send(await jira.getCreateIssueSupportingOptions(connectionFor(context).projectKey));
    } catch (error) {
      return jiraFailure(reply, error, "无法读取 Jira 新建问题的协作选项");
    }
  });

  app.get<{ Params: { field: string } }>(`${prefix}/issues/create-options/supporting/:field`, async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await resolveClient(request);
    if (!configuredJira(reply, jira, personal)) return reply;
    const field = JiraCreateIssueSupportingFieldSchema.safeParse(request.params.field);
    if (!field.success) return zodError(reply, field.error);
    const query = JiraCreateIssueSupportingQuerySchema.safeParse(request.query);
    if (!query.success) return zodError(reply, query.error);
    try {
      const projectKey = connectionFor(context).projectKey;
      switch (field.data) {
        case "assignees": return reply.send({ assignees: await jira.listAssignableUsers(projectKey, query.data.query || undefined) });
        case "components": return reply.send({ components: await jira.listProjectComponents(projectKey) });
        case "fixVersions": return reply.send({ fixVersions: await jira.listProjectVersions(projectKey) });
        case "labels": return reply.send({ labels: await jira.listLabels(projectKey) });
      }
    } catch (error) {
      return jiraFailure(reply, error, "无法读取 Jira 新建问题的单项协作选项");
    }
  });

  app.get(`${prefix}/issues/create-options/advanced`, async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await resolveClient(request);
    if (!configuredJira(reply, jira, personal)) return reply;
    try {
      return reply.send(await jira.getCreateIssueAdvancedOptions(connectionFor(context).projectKey));
    } catch (error) {
      return jiraFailure(reply, error, "无法读取 Jira 新建问题的更多选项");
    }
  });

  app.get<{ Params: { key: string } }>(`${prefix}/issues/:key`, async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await resolveClient(request);
    if (!configuredJira(reply, jira, personal)) return reply;
    const parsed = JiraIssueParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const issue = await jira.getIssue(parsed.data.key);
      options?.onIssueRead?.(request, issue);
      return reply.send(issue);
    } catch (error) {
      return jiraFailure(reply, error, "无法读取 Jira 问题详情");
    }
  });

  app.get<{ Params: { key: string; attachmentId: string } }>(`${prefix}/issues/:key/attachments/:attachmentId`, async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await resolveClient(request);
    if (!configuredJira(reply, jira, personal)) return reply;
    const parsed = JiraAttachmentParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    const range = typeof request.headers.range === "string" ? request.headers.range : undefined;
    try {
      const download = await jira.getAttachment(parsed.data.key, parsed.data.attachmentId, range);
      if (!download.response.body) return reply.code(502).send({ error: "jira_attachment_empty", details: "Jira 没有返回附件内容" });
      const contentType = download.response.headers.get("content-type") || download.attachment.mimeType || "application/octet-stream";
      const contentLength = download.response.headers.get("content-length") || (download.attachment.size === null ? null : String(download.attachment.size));
      const contentRange = download.response.headers.get("content-range");
      const acceptRanges = download.response.headers.get("accept-ranges");
      reply.code(download.response.status)
        .header("cache-control", "private, no-store")
        .header("content-type", contentType)
        .header("content-disposition", `inline; filename*=UTF-8''${inlineAttachmentFilename(download.attachment.filename)}`);
      if (contentLength) reply.header("content-length", contentLength);
      if (contentRange) reply.header("content-range", contentRange);
      if (acceptRanges) reply.header("accept-ranges", acceptRanges);
      return reply.send(Readable.fromWeb(download.response.body as NodeReadableStream<Uint8Array>));
    } catch (error) {
      if (error instanceof JiraApiError && error.status === 404) return reply.code(404).send({ error: "jira_attachment_not_found", details: "附件不存在或不属于当前问题" });
      return jiraFailure(reply, error, "无法读取 Jira 附件");
    }
  });

  app.get<{ Params: { key: string } }>(`${prefix}/issues/:key/transitions`, async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await resolveClient(request);
    if (!configuredJira(reply, jira, personal)) return reply;
    const parsed = JiraIssueParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ transitions: await jira.getTransitions(parsed.data.key) });
    } catch (error) {
      return jiraFailure(reply, error, "无法读取 Jira 可用状态");
    }
  });

  app.post<{ Params: { key: string } }>(`${prefix}/issues/:key/transitions`, async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await resolveClient(request);
    if (!configuredJira(reply, jira, personal)) return reply;
    const params = JiraIssueParamsSchema.safeParse(request.params);
    if (!params.success) return zodError(reply, params.error);
    const body = JiraTransitionBodySchema.safeParse(request.body);
    if (!body.success) return zodError(reply, body.error);
    try {
      const issue = await jira.transitionIssue(params.data.key, body.data.transitionId);
      options?.onIssueRead?.(request, issue);
      return reply.send(issue);
    } catch (error) {
      return jiraFailure(reply, error, "无法更新 Jira 问题状态");
    }
  });

  app.post<{ Params: { key: string } }>(`${prefix}/issues/:key/comments`, async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const { client: jira, personal } = await resolveClient(request);
    if (!configuredJira(reply, jira, personal)) return reply;
    const params = JiraIssueParamsSchema.safeParse(request.params);
    if (!params.success) return zodError(reply, params.error);
    const body = JiraCommentBodySchema.safeParse(request.body);
    if (!body.success) return zodError(reply, body.error);
    try {
      const comment = await jira.addComment(params.data.key, body.data.body);
      return reply.code(201).send({ comment });
    } catch (error) {
      return jiraFailure(reply, error, "无法发布 Jira 评论");
    }
  });
}
