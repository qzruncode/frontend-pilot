import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppRouteContext } from "./app-route-context.js";
import { GitLabOAuthError } from "./gitlab-oauth.js";
import { hasTriggerAccess, productAccountKey, unauthorized } from "./app-route-utils.js";

const OAuthCallbackQuerySchema = z.object({
  code: z.string().trim().max(8_192).optional(),
  state: z.string().trim().max(512).optional(),
  error: z.string().trim().max(128).optional(),
}).passthrough();
const OAuthStartQuerySchema = z.object({ returnTo: z.string().trim().max(2_048).optional() }).passthrough();

type OAuthRedirectState = "connected" | "error" | "not_configured";

function appBasePath(callbackPath: string): string {
  return callbackPath.match(/^(.*)\/api\/v1\/gitlab\/oauth\/callback\/?$/)?.[1]?.replace(/\/+$/, "") ?? "";
}

function safeReturnTo(context: AppRouteContext, value?: string): string | undefined {
  const candidate = value?.trim();
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || /[\u0000-\u001f]/u.test(candidate)) return undefined;
  try {
    const base = new URL(context.config.webOrigin === "*" ? "http://frontend-pilot.invalid" : context.config.webOrigin);
    const target = new URL(candidate, base);
    if (target.origin !== base.origin || target.pathname.startsWith("/api/")) return undefined;
    const prefix = appBasePath(new URL(context.config.gitlabOAuthRedirectUri).pathname);
    const pathname = prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)
      ? `${prefix}${target.pathname}`
      : target.pathname;
    if (prefix && pathname.startsWith(`${prefix}/api/`)) return undefined;
    return `${pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}

function workbenchRedirect(context: AppRouteContext, state: OAuthRedirectState, returnTo?: string): string {
  const url = new URL(context.config.gitlabOAuthRedirectUri);
  const callbackPath = url.pathname;
  const workbenchPath = callbackPath.replace(/\/api\/v1\/gitlab\/oauth\/callback\/?$/, "/gitlab-workbench");
  const target = safeReturnTo(context, returnTo);
  if (target) {
    const targetUrl = new URL(target, url.origin);
    url.pathname = targetUrl.pathname;
    url.search = targetUrl.search;
    url.hash = targetUrl.hash;
  } else {
    url.pathname = workbenchPath === callbackPath ? "/gitlab-workbench" : workbenchPath;
    url.search = "";
    url.hash = "";
  }
  url.searchParams.set("oauth", state);
  return url.toString();
}

function oauthErrorCode(error: unknown): string {
  if (!(error instanceof GitLabOAuthError)) return "oauth_failed";
  return error.code;
}

export function registerGitLabOAuthRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.get("/api/v1/gitlab/oauth/status", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const sessionKey = productAccountKey(request, context.config, context.userStore);
    if (sessionKey) await context.gitlabOAuth.getClient(sessionKey);
    return reply.header("cache-control", "no-store").send(context.gitlabOAuth.status(sessionKey ?? ""));
  });

  app.get("/api/v1/gitlab/oauth/start", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const sessionKey = productAccountKey(request, context.config, context.userStore);
    if (!sessionKey) return unauthorized(reply);
    const parsed = OAuthStartQuerySchema.safeParse(request.query);
    const url = context.gitlabOAuth.authorizationUrl(sessionKey, parsed.success ? safeReturnTo(context, parsed.data.returnTo) : undefined);
    if (!url) return reply.code(503).send({ error: "gitlab_oauth_not_configured", details: "服务端尚未配置 GitLab OAuth 应用" });
    return reply.redirect(url);
  });

  app.get("/api/v1/gitlab/oauth/callback", async (request, reply) => {
    const parsed = OAuthCallbackQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.redirect(workbenchRedirect(context, "error"));
    if (parsed.data.error || !parsed.data.code || !parsed.data.state || !hasTriggerAccess(request, context.config, context.userStore)) {
      return reply.redirect(workbenchRedirect(context, "error"));
    }
    const sessionKey = productAccountKey(request, context.config, context.userStore);
    if (!sessionKey) return reply.redirect(workbenchRedirect(context, "error"));
    try {
      const completion = await context.gitlabOAuth.complete(sessionKey, parsed.data.code, parsed.data.state);
      return reply.redirect(workbenchRedirect(context, "connected", completion.returnTo));
    } catch (error) {
      request.log.warn({ code: oauthErrorCode(error) }, "GitLab OAuth callback failed");
      return reply.redirect(workbenchRedirect(context, "error"));
    }
  });

  app.post("/api/v1/gitlab/oauth/disconnect", async (request, reply) => {
    if (!hasTriggerAccess(request, context.config, context.userStore)) return unauthorized(reply);
    const sessionKey = productAccountKey(request, context.config, context.userStore);
    if (sessionKey) context.gitlabOAuth.disconnect(sessionKey);
    return reply.header("cache-control", "no-store").send(context.gitlabOAuth.status(sessionKey ?? ""));
  });
}
