import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppRouteContext } from "./app-route-context.js";
import {
  BROWSER_SESSION_COOKIE,
  cookieValue,
  isValidBrowserSession,
} from "./auth.js";
import { sessionMaxAgeSeconds } from "./browser-session-store.js";
import { browserSessionUser as readBrowserSessionUser, isAllowedWebOrigin, zodError } from "./app-route-utils.js";

const LoginBodySchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(512),
}).strict();

function loginConfigured(context: AppRouteContext): boolean {
  return Boolean(context.config.triggerToken && context.userStore.hasUsers());
}

function authResponse(context: AppRouteContext, request: FastifyRequest) {
  const user = readBrowserSessionUser(request, context.config, context.userStore);
  return {
    configured: loginConfigured(context),
    authenticated: Boolean(user),
    username: user?.username ?? null,
    role: user?.role ?? null,
    inspectionAccess: Boolean(user && (user.role === "admin" || user.inspectionAccess)),
  };
}

function setSessionCookie(reply: { header(name: string, value: string): unknown }, context: AppRouteContext, session: string, maxAge = context.config.authSessionIdleTtlSeconds ?? 7 * 24 * 60 * 60): void {
  const secure = context.config.webOrigin.startsWith("https://") ? "; Secure" : "";
  reply.header(
    "set-cookie",
    `${BROWSER_SESSION_COOKIE}=${encodeURIComponent(session)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure}`,
  );
}

function clearSessionCookie(reply: { header(name: string, value: string): unknown }, context: AppRouteContext): void {
  const secure = context.config.webOrigin.startsWith("https://") ? "; Secure" : "";
  reply.header(
    "set-cookie",
    `${BROWSER_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
  );
}

function recordAuthActivity(context: AppRouteContext, request: FastifyRequest, username: string, action: "login" | "logout"): void {
  try {
    context.userActivityStore.record({ username, action, path: `/api/v1/auth/${action}` });
  } catch (error) {
    request.log.warn({ err: error }, "failed to record authentication activity");
  }
}

export function registerAuthRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.get("/api/v1/auth/status", async (request, reply) => reply.send(authResponse(context, request)));

  app.post("/api/v1/auth/login", async (request, reply) => {
    if (!isAllowedWebOrigin(request, context.config)) {
      return reply.code(403).send({ error: "browser_session_origin_not_allowed" });
    }
    if (!loginConfigured(context)) {
      return reply.code(503).send({ error: "login_not_configured", details: "服务端尚未配置产品登录账号" });
    }

    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    const user = context.userStore.verifyCredentials(parsed.data.username, parsed.data.password);
    if (!user) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    recordAuthActivity(context, request, user.username, "login");
    const session = context.browserSessionStore.create(user, {
      now: Date.now(),
      idleTtlSeconds: context.config.authSessionIdleTtlSeconds ?? 7 * 24 * 60 * 60,
      absoluteTtlSeconds: context.config.authSessionAbsoluteTtlSeconds ?? 30 * 24 * 60 * 60,
    });
    setSessionCookie(reply, context, session.token, sessionMaxAgeSeconds(session.record));
    return reply.send({ configured: true, authenticated: true, username: user.username, role: user.role, inspectionAccess: user.role === "admin" || Boolean(user.inspectionAccess) });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (!isAllowedWebOrigin(request, context.config)) {
      return reply.code(403).send({ error: "browser_session_origin_not_allowed" });
    }
    const user = readBrowserSessionUser(request, context.config, context.userStore);
    if (user) recordAuthActivity(context, request, user.username, "logout");
    const session = cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
    if (session) context.browserSessionStore.revoke(session);
    context.inspectionAccounts.clearSession(reply);
    clearSessionCookie(reply, context);
    return reply.send({ configured: loginConfigured(context), authenticated: false, username: null, role: null });
  });

  // Legacy clients may still call this endpoint, but it can only renew an existing session.
  // It no longer creates an authenticated session for an anonymous browser.
  app.post("/api/v1/session", async (request, reply) => {
    if (!isAllowedWebOrigin(request, context.config)) {
      return reply.code(403).send({ error: "browser_session_origin_not_allowed" });
    }
    const user = readBrowserSessionUser(request, context.config, context.userStore);
    const existing = cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
    if (!context.config.triggerToken || !user || !existing) {
      return reply.code(401).send({ error: "auth_session_expired", details: "登录会话已过期，请重新登录" });
    }
    const idleTtlSeconds = context.config.authSessionIdleTtlSeconds ?? 7 * 24 * 60 * 60;
    const now = Date.now();
    const current = context.browserSessionStore.read(existing, now);
    const refreshWindowSeconds = context.config.authSessionRefreshWindowSeconds ?? 24 * 60 * 60;
    const currentForUser = current?.id === user.id ? current : null;
    if (currentForUser && currentForUser.idleExpiresAt - now <= refreshWindowSeconds * 1_000) {
      const refreshed = context.browserSessionStore.touch(existing, { now, idleTtlSeconds });
      if (refreshed) setSessionCookie(reply, context, existing, sessionMaxAgeSeconds(refreshed, now));
    } else if (currentForUser) {
      // The session is still well inside its idle window; avoid rewriting the
      // database and cookie on every foreground heartbeat.
    } else if (isValidBrowserSession(existing, context.config.triggerToken)) {
      const migrated = context.browserSessionStore.create(user, {
        now,
        idleTtlSeconds,
        absoluteTtlSeconds: context.config.authSessionAbsoluteTtlSeconds ?? 30 * 24 * 60 * 60,
      });
      setSessionCookie(reply, context, migrated.token, sessionMaxAgeSeconds(migrated.record, now));
      context.inspectionAccounts.refreshSession(request, reply);
    } else {
      return reply.code(401).send({ error: "auth_session_expired", details: "登录会话已过期，请重新登录" });
    }
    return reply.send({ configured: loginConfigured(context), authenticated: true, username: user.username, role: user.role, inspectionAccess: user.role === "admin" || Boolean(user.inspectionAccess) });
  });
}
