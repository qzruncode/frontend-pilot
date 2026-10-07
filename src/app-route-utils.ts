import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  BROWSER_SESSION_COOKIE,
  bearerToken,
  browserSessionIdentity,
  cookieValue,
  isValidBrowserSession,
  secureEqual,
  tokenHash,
} from "./auth.js";
import { getBrowserSessionRequestContext } from "./browser-session-store.js";
import type { AppConfig } from "./config.js";
import type { GitLabConnection } from "./gitlab-connection.js";
import type { ProductUser, UserStorePort } from "./user-store.js";

export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: "invalid_trigger_token" });
}

export function hasTriggerAccess(request: FastifyRequest, config: AppConfig, userStore?: UserStorePort): boolean {
  if (!config.triggerToken) return false;
  if (hasServiceBearerAccess(request, config)) return true;
  const sessionContext = getBrowserSessionRequestContext(request);
  if (sessionContext) return userStore ? Boolean(browserSessionUser(request, config, userStore)) : true;
  const session = cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
  if (!isValidBrowserSession(session, config.triggerToken)) return false;
  return userStore ? Boolean(browserSessionUser(request, config, userStore)) : true;
}

export function hasAdminAccess(request: FastifyRequest, config: AppConfig, userStore: UserStorePort): boolean {
  if (!config.triggerToken) return false;
  if (hasServiceBearerAccess(request, config)) return true;
  return browserSessionUser(request, config, userStore)?.role === "admin";
}

export function adminRequired(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ error: "admin_required", details: "只有管理员可以执行此操作" });
}

export function requireAdminAccess(request: FastifyRequest, reply: FastifyReply, config: AppConfig, userStore: UserStorePort): boolean {
  if (!hasTriggerAccess(request, config, userStore)) {
    unauthorized(reply);
    return false;
  }
  if (!hasAdminAccess(request, config, userStore)) {
    adminRequired(reply);
    return false;
  }
  return true;
}

export function hasServiceBearerAccess(request: FastifyRequest, config: AppConfig): boolean {
  return Boolean(config.triggerToken) && secureEqual(bearerToken(request.headers.authorization), config.triggerToken);
}

export function browserSessionKey(request: FastifyRequest, config: AppConfig, userStore?: UserStorePort): string | null {
  const sessionContext = getBrowserSessionRequestContext(request);
  if (sessionContext) {
    if (userStore && !browserSessionUser(request, config, userStore)) return null;
    return sessionContext.sessionKey;
  }
  const session = cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
  if (!isValidBrowserSession(session, config.triggerToken)) return null;
  return userStore && !browserSessionUser(request, config, userStore) ? null : tokenHash(session);
}

export function browserSessionUser(request: FastifyRequest, config: AppConfig, userStore: UserStorePort): ProductUser | null {
  if (!config.triggerToken) return null;
  const sessionContext = getBrowserSessionRequestContext(request);
  if (sessionContext) {
    const user = userStore.findById(sessionContext.userId);
    return user?.enabled ? user : null;
  }
  const session = cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
  if (!isValidBrowserSession(session, config.triggerToken)) return null;
  const identity = browserSessionIdentity(session, config.triggerToken);
  const username = identity?.username || config.loginUsername;
  if (!username) return null;
  const user = userStore.findByUsername(username);
  return user?.enabled ? user : null;
}

export function productAccountKey(request: FastifyRequest, config: AppConfig, userStore: UserStorePort): string | null {
  const user = browserSessionUser(request, config, userStore);
  return user ? `product:${user.id}` : null;
}

export function isAllowedWebOrigin(request: FastifyRequest, config: AppConfig): boolean {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  if (config.webOrigin === "*") return Boolean(origin);
  if (origin && origin === config.webOrigin) return true;

  const referer = typeof request.headers.referer === "string" ? request.headers.referer : undefined;
  if (!referer) return false;
  try {
    return new URL(referer).origin === config.webOrigin;
  } catch {
    return false;
  }
}

export function zodError(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({
    error: "invalid_request",
    details: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
  });
}

const IdParamsSchema = z.object({ id: z.string().trim().min(1).max(128) }).strict();

export function parseIdParam(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): string | null {
  const parsed = IdParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    zodError(reply, parsed.error);
    return null;
  }
  return parsed.data.id;
}

export function writeSse(response: NodeJS.WritableStream, event: string, payload: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function publicGitLabConnection(connection: GitLabConnection, revealSecrets = false): {
  baseUrl: string;
  apiBaseUrl: string;
  token: string;
  tokenConfigured: boolean;
} {
  return {
    baseUrl: connection.baseUrl,
    apiBaseUrl: connection.apiBaseUrl,
    token: revealSecrets ? connection.token : "",
    tokenConfigured: Boolean(connection.token),
  };
}
