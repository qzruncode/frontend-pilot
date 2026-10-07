import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppRouteContext } from "./app-route-context.js";
import { inspectionGitLabOAuthRedirectUri } from "./inspection-accounts.js";
import { productAccountKey, zodError } from "./app-route-utils.js";
import { CreateUserInputSchema, UpdateUserInputSchema, JiraCredentialInputSchema } from "./contracts.js";
import { registerJiraIssueRoutes } from "./app-jira-routes.js";
import { registerGitLabRoutes } from "./app-gitlab-routes.js";
import { JiraClient } from "./jira-client.js";
import { UserStoreError } from "./user-store.js";

export function registerInspectionAccountRoutes(app: FastifyInstance, context: AppRouteContext): void {
  const accounts = context.inspectionAccounts;
  const base = "/api/v1/inspections";
  const workbenchRedirect = (state: "connected" | "error") => {
    const url = new URL(inspectionGitLabOAuthRedirectUri(context.config));
    url.pathname = url.pathname.replace(/\/api\/v1\/inspections\/gitlab\/oauth\/callback\/?$/, "/inspection-workbench");
    url.search = "";
    url.searchParams.set("accounts", "1");
    url.searchParams.set("oauth", state);
    return url.toString();
  };
  const publicUser = (user: ReturnType<typeof accounts.users.findById>) => user ? { id: user.id, username: user.username, enabled: user.enabled } : null;
  const userResponse = (user: NonNullable<ReturnType<typeof accounts.users.findById>>) => ({ ...publicUser(user), password: null, role: "user", createdAt: user.createdAt, updatedAt: user.updatedAt });
  app.get(`${base}/auth/status`, async (request, reply) => {
    const operator = accounts.requireOperator(request, reply);
    if (!operator) return;
    return reply.header("cache-control", "no-store").send({ maintainer: publicUser(accounts.current(request)), operator: { id: operator.id, username: operator.username }, canManage: operator.role === "admin" });
  });
  app.post(`${base}/auth/login`, async (request, reply) => {
    if (!accounts.requireOperator(request, reply)) return;
    const parsed = z.object({ username: z.string().trim().min(1).max(128), password: z.string().min(1).max(512) }).strict().safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    const user = accounts.users.verifyCredentials(parsed.data.username, parsed.data.password);
    if (!user) return reply.code(401).send({ error: "invalid_credentials", details: "维护人员账号或密码错误，或账号已停用" });
    accounts.setSession(request, reply, user);
    return reply.send({ maintainer: publicUser(user) });
  });
  app.post(`${base}/auth/refresh`, async (request, reply) => {
    if (!accounts.requireOperator(request, reply)) return;
    const user = accounts.refreshSession(request, reply);
    if (!user) return reply.code(428).send({ error: "inspection_login_required", details: "巡检登录已过期，请重新登录维护人员账号" });
    return reply.send({ maintainer: publicUser(user) });
  });
  app.post(`${base}/auth/logout`, async (request, reply) => {
    if (!accounts.requireOperator(request, reply)) return;
    accounts.setSession(request, reply, null);
    return reply.send({ loggedOut: true });
  });
  app.register(async (admin) => {
    admin.addHook("preHandler", async (request, reply) => {
      const operator = accounts.requireOperator(request, reply);
      if (operator && operator.role !== "admin") return reply.code(403).send({ error: "admin_required" });
    });
    admin.get(`${base}/maintainers`, async () => ({ users: accounts.users.list().map(userResponse), total: accounts.users.countUsers() }));
    admin.post(`${base}/maintainers`, async (request, reply) => {
      const parsed = CreateUserInputSchema.safeParse(request.body);
      if (!parsed.success) return zodError(reply, parsed.error);
      try { return reply.code(201).send({ user: userResponse(accounts.users.create(parsed.data)) }); }
      catch (error) { if (error instanceof UserStoreError) return reply.code(409).send({ error: "username_taken", details: "维护人员账号已存在" }); throw error; }
    });
    admin.patch<{ Params: { id: string } }>(`${base}/maintainers/:id`, async (request, reply) => {
      const parsed = UpdateUserInputSchema.safeParse(request.body);
      if (!parsed.success) return zodError(reply, parsed.error);
      try {
        const user = accounts.users.update(request.params.id, parsed.data);
        return user ? reply.send({ user: userResponse(user) }) : reply.code(404).send({ error: "maintainer_not_found" });
      } catch (error) { if (error instanceof UserStoreError) return reply.code(409).send({ error: "username_taken" }); throw error; }
    });
    admin.delete<{ Params: { id: string } }>(`${base}/maintainers/:id`, async (request) => {
      accounts.gitlab.disconnect(request.params.id);
      accounts.jiraCredentials.delete(request.params.id);
      return { deleted: accounts.users.delete(request.params.id) };
    });
  });
  registerGitLabRoutes(app, context, {
    prefix: `${base}/gitlab`, allowReview: false,
    authorize: (request, reply) => Boolean(accounts.requireMaintainer(request, reply)),
    getClient: async (request, reply) => {
      const client = await accounts.gitlab.getClient(accounts.current(request)!.id);
      if (!client) reply.code(428).send({ error: "gitlab_oauth_required", details: "请连接巡检 GitLab 账号" });
      return client;
    },
    listProfiles: (request) => context.inspectionRulesStore.list(accounts.current(request)!.id),
  });
  app.register(async (secured) => {
    secured.addHook("preHandler", async (request, reply) => { accounts.requireMaintainer(request, reply); });
    secured.get(`${base}/gitlab/oauth/status`, async (request) => {
      const id = accounts.current(request)!.id;
      await accounts.gitlab.getClient(id);
      return accounts.gitlab.status(id);
    });
    secured.get(`${base}/gitlab/oauth/start`, async (request, reply) => {
      // Bind the authorization attempt to both the parent browser session and the maintainer.
      const url = accounts.gitlab.authorizationUrl(`${accounts.current(request)!.id}:${productAccountKey(request, context.config, context.userStore)}`);
      return url ? reply.redirect(url) : reply.code(503).send({ error: "gitlab_oauth_not_configured", details: "服务端尚未配置 GitLab OAuth 应用" });
    });
    secured.get(`${base}/gitlab/oauth/callback`, async (request, reply) => {
      const parsed = z.object({ code: z.string(), state: z.string() }).safeParse(request.query);
      const user = accounts.current(request)!;
      try {
        if (!parsed.success) throw new Error("invalid_callback");
        const attemptKey = `${user.id}:${productAccountKey(request, context.config, context.userStore)}`;
        await accounts.gitlab.complete(attemptKey, parsed.data.code, parsed.data.state, user.id);
        return reply.redirect(workbenchRedirect("connected"));
      } catch { return reply.redirect(workbenchRedirect("error")); }
    });
    secured.post(`${base}/gitlab/oauth/disconnect`, async (request) => {
      const id = accounts.current(request)!.id;
      accounts.gitlab.disconnect(id);
      return accounts.gitlab.status(id);
    });
    const jiraAccount = (id: string) => {
      const credential = accounts.jiraCredentials.read(id);
      const { baseUrl, apiBaseUrl, projectKey } = accounts.jiraConnection;
      return { baseUrl, apiBaseUrl, projectKey, username: credential?.jiraUsername ?? "", tokenConfigured: Boolean(credential) };
    };
    secured.get(`${base}/jira/account`, async (request) => jiraAccount(accounts.current(request)!.id));
    secured.post(`${base}/jira/account/test`, async (request, reply) => {
      const parsed = JiraCredentialInputSchema.safeParse(request.body);
      if (!parsed.success) return zodError(reply, parsed.error);
      const token = parsed.data.token || accounts.jiraCredentials.read(accounts.current(request)!.id)?.token;
      if (!token) return reply.code(400).send({ error: "jira_credentials_required" });
      const started = Date.now();
      try {
        const user = await new JiraClient({ ...accounts.jiraConnection, username: parsed.data.username, token }).getCurrentUser();
        return { ok: true, baseUrl: accounts.jiraConnection.baseUrl, apiBaseUrl: accounts.jiraConnection.apiBaseUrl, projectKey: accounts.jiraConnection.projectKey, username: user.username, message: "Jira 连接成功", userName: user.name || user.username, latencyMs: Date.now() - started };
      } catch { return reply.code(400).send({ error: "jira_authentication_failed", details: "Jira 账号验证失败" }); }
    });
    secured.put(`${base}/jira/account`, async (request, reply) => {
      const parsed = JiraCredentialInputSchema.safeParse(request.body);
      if (!parsed.success) return zodError(reply, parsed.error);
      const id = accounts.current(request)!.id;
      const token = parsed.data.token || accounts.jiraCredentials.read(id)?.token;
      if (!token) return reply.code(400).send({ error: "jira_credentials_required" });
      try {
        const client = new JiraClient({ ...accounts.jiraConnection, username: parsed.data.username, token });
        await client.getCurrentUser();
        accounts.jiraCredentials.write(id, { jiraUsername: parsed.data.username, token });
        return jiraAccount(id);
      } catch { return reply.code(400).send({ error: "jira_authentication_failed", details: "Jira 账号验证失败，请检查账号和访问凭据" }); }
    });
    secured.delete(`${base}/jira/account`, async (request) => {
      const id = accounts.current(request)!.id;
      accounts.jiraCredentials.delete(id);
      return jiraAccount(id);
    });
    registerJiraIssueRoutes(secured, context, {
      prefix: `${base}/jira`,
      client: async (request) => accounts.jiraClient(accounts.current(request)!.id),
      onIssueRead: (request, issue) => context.inspectionService.updateJiraIssueStatus(accounts.identity(request), issue),
    });
  });
}
