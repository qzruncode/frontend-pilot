import type { FastifyInstance } from "fastify";
import {
  ClaudeSettingsSchema,
  CreateReviewProfileBodySchema,
  CreateReviewRuleBodySchema,
  DeleteReviewProfileBodySchema,
  DeleteReviewRuleBodySchema,
  GitLabConnectionInputSchema,
  ReorderReviewRulesBodySchema,
  UpdateReviewRuleBodySchema,
} from "./contracts.js";
import { GitLabApiError, GitLabClient } from "./gitlab-client.js";
import { mergeClaudeSettings, publicClaudeSettings, testClaudeSettings } from "./model-config.js";
import { safeErrorMessage } from "./errors.js";
import type { AppRouteContext } from "./app-route-context.js";
import { hasAdminAccess, hasTriggerAccess, publicGitLabConnection, requireAdminAccess, unauthorized, zodError } from "./app-route-utils.js";

export function registerModelConfigRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.post("/api/v1/model-config/test", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const parsed = ClaudeSettingsSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const current = await context.modelConfigStore.read();
      return reply.send(await testClaudeSettings(mergeClaudeSettings(current, parsed.data)));
    } catch (error) {
      return reply.code(502).send({ error: "model_config_test_failed", details: safeErrorMessage(error, "模型配置测试失败") });
    }
  });

  app.get("/api/v1/model-config", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    try {
      return reply.send(publicClaudeSettings(await context.modelConfigStore.read(), hasAdminAccess(request, context.config, context.userStore)));
    } catch (error) {
      return reply.code(500).send({ error: "model_config_read_failed", details: safeErrorMessage(error, "无法读取数据库中的模型配置") });
    }
  });

  app.put("/api/v1/model-config", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const parsed = ClaudeSettingsSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const current = await context.modelConfigStore.read();
      const saved = await context.modelConfigStore.write(mergeClaudeSettings(current, parsed.data));
      if (saved.env.ANTHROPIC_AUTH_TOKEN || saved.env.ANTHROPIC_API_KEY) context.claudeState.configured = true;
      return reply.send(saved);
    } catch (error) {
      return reply.code(500).send({ error: "model_config_write_failed", details: safeErrorMessage(error, "无法保存数据库中的模型配置") });
    }
  });
}

export function registerReviewRulesRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.get("/api/v1/review-rules", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    try {
      return reply.send({ profiles: await context.reviewRulesStore.list() });
    } catch (error) {
      return reply.code(500).send({ error: "review_rules_read_failed", details: safeErrorMessage(error, "无法读取审查规则") });
    }
  });

  app.post("/api/v1/review-profiles", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = CreateReviewProfileBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.code(201).send({ profile: await context.reviewRulesStore.createProfile(parsed.data) });
    } catch (error) {
      return reply.code(409).send({ error: "review_profile_create_failed", details: safeErrorMessage(error, "无法创建审查 profile") });
    }
  });

  app.delete("/api/v1/review-profiles", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = DeleteReviewProfileBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      await context.reviewRulesStore.deleteProfile(parsed.data);
      return reply.send({ deleted: true });
    } catch (error) {
      return reply.code(409).send({ error: "review_profile_delete_failed", details: safeErrorMessage(error, "无法删除审查 profile") });
    }
  });

  app.post("/api/v1/review-rules", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = CreateReviewRuleBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.code(201).send({ profile: await context.reviewRulesStore.createRule(parsed.data) });
    } catch (error) {
      return reply.code(409).send({ error: "review_rule_create_failed", details: safeErrorMessage(error, "无法创建审查规则") });
    }
  });

  app.put("/api/v1/review-rules", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = UpdateReviewRuleBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ profile: await context.reviewRulesStore.updateRule(parsed.data) });
    } catch (error) {
      return reply.code(409).send({ error: "review_rule_update_failed", details: safeErrorMessage(error, "无法保存审查规则") });
    }
  });

  app.delete("/api/v1/review-rules", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = DeleteReviewRuleBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ profile: await context.reviewRulesStore.deleteRule(parsed.data) });
    } catch (error) {
      return reply.code(409).send({ error: "review_rule_delete_failed", details: safeErrorMessage(error, "无法删除审查规则") });
    }
  });

  app.patch("/api/v1/review-rules/order", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const parsed = ReorderReviewRulesBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ profile: await context.reviewRulesStore.reorderRules(parsed.data) });
    } catch (error) {
      return reply.code(409).send({ error: "review_rule_reorder_failed", details: safeErrorMessage(error, "无法保存审查规则顺序") });
    }
  });
}

export function registerGitLabConnectionRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.get("/api/v1/gitlab-connection", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    try {
      const connection = await context.gitlabConnectionStore.read(context.fallbackGitLabConnection);
      return reply.send(publicGitLabConnection(connection, hasAdminAccess(request, context.config, context.userStore)));
    } catch (error) {
      return reply.code(500).send({ error: "gitlab_connection_read_failed", details: safeErrorMessage(error, "无法读取 GitLab 连接配置") });
    }
  });

  app.put("/api/v1/gitlab-connection", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const parsed = GitLabConnectionInputSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const current = await context.gitlabConnectionStore.read(context.fallbackGitLabConnection);
      const connection = await context.gitlabConnectionStore.write({
        baseUrl: parsed.data.baseUrl,
        apiBaseUrl: parsed.data.apiBaseUrl,
        token: parsed.data.token === undefined ? current.token : parsed.data.token.trim(),
      });
      if (context.gitlabClient instanceof GitLabClient) {
        context.gitlabClient.updateConnection({ baseUrl: connection.apiBaseUrl, token: connection.token });
      }
      context.workspaceProvider?.updateConnection?.({
        gitlabApiBaseUrl: connection.apiBaseUrl,
        gitlabToken: connection.token,
      });
      Object.assign(context.initialGitLabConnection, connection);
      return reply.send(publicGitLabConnection(connection, hasAdminAccess(request, context.config, context.userStore)));
    } catch (error) {
      return reply.code(500).send({ error: "gitlab_connection_write_failed", details: safeErrorMessage(error, "无法保存 GitLab 连接配置") });
    }
  });

  app.post("/api/v1/gitlab-connection/test", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const parsed = GitLabConnectionInputSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const current = await context.gitlabConnectionStore.read(context.fallbackGitLabConnection);
      const token = parsed.data.token === undefined ? current.token : parsed.data.token.trim();
      if (!token) return reply.code(400).send({ error: "gitlab_token_required", details: "请填写 GitLab Token" });
      const client = new GitLabClient({ baseUrl: parsed.data.apiBaseUrl, token });
      const startedAt = Date.now();
      const user = await client.getCurrentUser();
      const userLabel = user.name?.trim() || user.username?.trim() || "当前 Token";
      return reply.send({
        ok: true,
        baseUrl: parsed.data.baseUrl,
        apiBaseUrl: parsed.data.apiBaseUrl,
        userName: userLabel,
        username: user.username ?? null,
        latencyMs: Date.now() - startedAt,
        message: `已连接 GitLab，当前身份：${userLabel}`,
      });
    } catch (error) {
      if (error instanceof GitLabApiError) {
        return reply.code(502).send({ error: "gitlab_connection_test_failed", details: `GitLab 返回 HTTP ${error.status ?? "错误"}` });
      }
      return reply.code(502).send({ error: "gitlab_connection_test_failed", details: safeErrorMessage(error, "GitLab 连接测试失败") });
    }
  });
}
