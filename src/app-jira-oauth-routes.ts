import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppRouteContext } from "./app-route-context.js";
import { JiraOAuthError } from "./jira-oauth.js";
import { browserSessionUser, hasTriggerAccess, productAccountKey, unauthorized } from "./app-route-utils.js";

const OAuthCallbackQuerySchema = z.object({
  oauth_token: z.string().trim().max(512).optional(),
  oauth_verifier: z.string().trim().max(512).optional(),
  oauth_problem: z.string().trim().max(256).optional(),
}).passthrough();

type OAuthRedirectState = "connected" | "error" | "not_configured";

function workbenchRedirect(context: AppRouteContext, state: OAuthRedirectState): string {
  const callback = context.config.jiraOAuthRedirectUri ?? `${context.config.webOrigin}/api/v1/jira/oauth/callback`;
  const url = new URL(callback);
  const workbenchPath = url.pathname.replace(/\/api\/v1\/jira\/oauth\/callback\/?$/, "/jira-workbench");
  url.pathname = workbenchPath === url.pathname ? "/jira-workbench" : workbenchPath;
  url.search = "";
  url.searchParams.set("oauth", state);
  return url.toString();
}

function oauthErrorCode(error: unknown): string {
  return error instanceof JiraOAuthError ? error.code : "oauth_failed";
}

export function registerJiraOAuthRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.get("/api/v1/jira/oauth/status", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const sessionKey = productAccountKey(request, context.config, context.userStore);
    return reply.header("cache-control", "no-store").send(context.jiraOAuth.status(sessionKey ?? ""));
  });

  app.get("/api/v1/jira/oauth/start", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const sessionKey = productAccountKey(request, context.config, context.userStore);
    if (!sessionKey) return unauthorized(reply);
    try {
      const url = await context.jiraOAuth.authorizationUrl(sessionKey);
      if (!url) return reply.code(503).send({ error: "jira_oauth_not_configured", details: "管理员尚未配置 Jira OAuth 应用" });
      return reply.redirect(url);
    } catch (error) {
      request.log.warn({ code: oauthErrorCode(error) }, "Jira OAuth authorization failed");
      return reply.code(502).send({ error: "jira_oauth_start_failed", details: "无法发起 Jira 登录，请检查 Jira OAuth 应用配置" });
    }
  });

  app.get("/api/v1/jira/oauth/callback", async (request, reply) => {
    const parsed = OAuthCallbackQuerySchema.safeParse(request.query);
    if (!parsed.success || parsed.data.oauth_problem || !parsed.data.oauth_token || !parsed.data.oauth_verifier || !hasTriggerAccess(request, context.config, context.userStore)) {
      return reply.redirect(workbenchRedirect(context, "error"));
    }
    const sessionKey = productAccountKey(request, context.config, context.userStore);
    if (!sessionKey) return reply.redirect(workbenchRedirect(context, "error"));
    try {
      await context.jiraOAuth.complete(sessionKey, parsed.data.oauth_token, parsed.data.oauth_verifier);
      return reply.redirect(workbenchRedirect(context, "connected"));
    } catch (error) {
      request.log.warn({ code: oauthErrorCode(error) }, "Jira OAuth callback failed");
      return reply.redirect(workbenchRedirect(context, "error"));
    }
  });

  app.post("/api/v1/jira/oauth/disconnect", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const sessionKey = productAccountKey(request, context.config, context.userStore);
    if (sessionKey) context.jiraOAuth.disconnect(sessionKey);
    const user = browserSessionUser(request, context.config, context.userStore);
    if (user) context.jiraUserCredentialStore.delete(user.username);
    return reply.header("cache-control", "no-store").send(context.jiraOAuth.status(sessionKey ?? ""));
  });
}
