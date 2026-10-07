import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createJiraOAuthHeader, JiraClient, type JiraClientPort, type JiraOAuthCredentials } from "./jira-client.js";
import type { JiraIdentity } from "./jira-workbench.js";
import type { JiraOAuthSession, JiraOAuthSessionStorePort } from "./jira-oauth-store.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;

const OAuthTokenResponseSchema = z.object({
  oauth_token: z.string().min(1),
  oauth_token_secret: z.string().min(1),
}).passthrough();

export interface JiraOAuthConfig {
  baseUrl: string;
  apiBaseUrl: string;
  consumerKey: string;
  privateKey: string;
  redirectUri: string;
}

export interface JiraOAuthStatus {
  configured: boolean;
  connected: boolean;
  identity: JiraIdentity | null;
}

export interface JiraOAuthServicePort {
  status(sessionKey: string): JiraOAuthStatus;
  authorizationUrl(sessionKey: string): Promise<string | null>;
  complete(sessionKey: string, token: string, verifier: string): Promise<JiraIdentity>;
  disconnect(sessionKey: string): void;
  adoptSession?(fromKey: string, toKey: string): void;
  getClient(sessionKey: string): Promise<JiraClientPort | null>;
}

export class JiraOAuthError extends Error {
  constructor(readonly code: "not_configured" | "request_token_failed" | "invalid_state" | "token_exchange_failed" | "invalid_token_response" | "identity_failed") {
    super(code);
    this.name = "JiraOAuthError";
  }
}

type PendingRequest = {
  sessionKey: string;
  tokenSecret: string;
  expiresAt: number;
};

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function toIdentity(user: JiraIdentity): JiraIdentity {
  return {
    username: user.username.trim(),
    name: user.name.trim() || user.username.trim() || "Jira 用户",
    avatarUrl: user.avatarUrl ?? null,
  };
}

function parseTokenResponse(payload: string): { token: string; tokenSecret: string } | null {
  const values = new URLSearchParams(payload);
  const parsed = OAuthTokenResponseSchema.safeParse({
    oauth_token: values.get("oauth_token"),
    oauth_token_secret: values.get("oauth_token_secret"),
  });
  return parsed.success ? { token: parsed.data.oauth_token, tokenSecret: parsed.data.oauth_token_secret } : null;
}

export class JiraOAuthService implements JiraOAuthServicePort {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessions = new Map<string, JiraOAuthSession>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: JiraOAuthConfig, fetchImpl = fetch, private readonly sessionStore?: JiraOAuthSessionStorePort) {
    this.fetchImpl = fetchImpl;
  }

  status(sessionKey: string): JiraOAuthStatus {
    const session = this.loadSession(sessionKey);
    return {
      configured: this.isConfigured(),
      connected: Boolean(session),
      identity: session?.identity ?? null,
    };
  }

  async authorizationUrl(sessionKey: string): Promise<string | null> {
    if (!this.isConfigured()) return null;
    this.removeExpiredPending();
    const requestToken = await this.requestToken();
    this.pending.set(requestToken.token, {
      sessionKey,
      tokenSecret: requestToken.tokenSecret,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    });
    const url = new URL(endpoint(this.config.baseUrl, "/plugins/servlet/oauth/authorize"));
    url.searchParams.set("oauth_token", requestToken.token);
    return url.toString();
  }

  async complete(sessionKey: string, token: string, verifier: string): Promise<JiraIdentity> {
    const pending = this.pending.get(token);
    this.pending.delete(token);
    if (!pending || pending.expiresAt <= Date.now() || pending.sessionKey !== sessionKey) {
      throw new JiraOAuthError("invalid_state");
    }
    const accessToken = await this.accessToken(token, verifier);
    const credentials: JiraOAuthCredentials = {
      consumerKey: this.config.consumerKey,
      privateKey: this.config.privateKey,
      accessToken: accessToken.token,
      accessTokenSecret: accessToken.tokenSecret,
    };
    let identity: JiraIdentity;
    try {
      const user = await new JiraClient({
        baseUrl: this.config.baseUrl,
        apiBaseUrl: this.config.apiBaseUrl,
        oauth: credentials,
        fetchImpl: this.fetchImpl,
      }).getCurrentUser();
      identity = toIdentity(user);
    } catch {
      throw new JiraOAuthError("identity_failed");
    }
    const session: JiraOAuthSession = { credentials, identity };
    this.persistSession(sessionKey, session);
    this.sessions.set(sessionKey, session);
    return identity;
  }

  disconnect(sessionKey: string): void {
    this.removeSession(sessionKey);
  }

  adoptSession(fromKey: string, toKey: string): void {
    if (!fromKey || !toKey || fromKey === toKey || this.loadSession(toKey)) return;
    const session = this.loadSession(fromKey);
    if (!session) return;
    this.persistSession(toKey, session);
    this.sessions.set(toKey, session);
    this.removeSession(fromKey);
  }

  async getClient(sessionKey: string): Promise<JiraClientPort | null> {
    const session = this.loadSession(sessionKey);
    if (!session) return null;
    return new JiraClient({
      baseUrl: this.config.baseUrl,
      apiBaseUrl: this.config.apiBaseUrl,
      oauth: session.credentials,
      fetchImpl: this.fetchImpl,
    });
  }

  private isConfigured(): boolean {
    return Boolean(this.config.baseUrl && this.config.apiBaseUrl && this.config.consumerKey && this.config.privateKey && this.config.redirectUri);
  }

  private loadSession(sessionKey: string): JiraOAuthSession | undefined {
    const current = this.sessions.get(sessionKey);
    if (current) return current;
    if (!this.sessionStore || !sessionKey) return undefined;
    const stored = this.sessionStore.read(sessionKey, this.providerKey());
    if (stored) this.sessions.set(sessionKey, stored);
    return stored ?? undefined;
  }

  private persistSession(sessionKey: string, session: JiraOAuthSession): void {
    this.sessionStore?.write(sessionKey, this.providerKey(), session);
  }

  private removeSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.sessionStore?.delete(sessionKey, this.providerKey());
  }

  private providerKey(): string {
    return [this.config.baseUrl, this.config.apiBaseUrl, this.config.consumerKey].join("\u0000");
  }

  private async requestToken(): Promise<{ token: string; tokenSecret: string }> {
    const url = endpoint(this.config.baseUrl, "/plugins/servlet/oauth/request-token");
    const oauth = {
      oauth_callback: this.config.redirectUri,
      oauth_consumer_key: this.config.consumerKey,
      oauth_nonce: randomBytes(18).toString("base64url"),
      oauth_signature_method: "RSA-SHA1",
      oauth_timestamp: String(Math.floor(Date.now() / 1_000)),
      oauth_version: "1.0",
    };
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/x-www-form-urlencoded",
        authorization: createJiraOAuthHeader("POST", url, oauth, this.config.privateKey),
      },
    });
    const payload = await response.text();
    if (!response.ok) throw new JiraOAuthError("request_token_failed");
    const parsed = parseTokenResponse(payload);
    if (!parsed) throw new JiraOAuthError("invalid_token_response");
    return parsed;
  }

  private async accessToken(token: string, verifier: string): Promise<{ token: string; tokenSecret: string }> {
    const url = endpoint(this.config.baseUrl, "/plugins/servlet/oauth/access-token");
    const oauth = {
      oauth_consumer_key: this.config.consumerKey,
      oauth_nonce: randomBytes(18).toString("base64url"),
      oauth_signature_method: "RSA-SHA1",
      oauth_timestamp: String(Math.floor(Date.now() / 1_000)),
      oauth_token: token,
      oauth_verifier: verifier,
      oauth_version: "1.0",
    };
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/x-www-form-urlencoded",
        authorization: createJiraOAuthHeader("POST", url, oauth, this.config.privateKey),
      },
    });
    const payload = await response.text();
    if (!response.ok) throw new JiraOAuthError("token_exchange_failed");
    const parsed = parseTokenResponse(payload);
    if (!parsed) throw new JiraOAuthError("invalid_token_response");
    return parsed;
  }

  private removeExpiredPending(): void {
    const now = Date.now();
    for (const [token, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(token);
    }
  }
}
