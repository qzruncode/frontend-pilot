import { randomBytes } from "node:crypto";
import { z } from "zod";
import { GitLabClient, type GitLabClientPort, type GitLabCurrentUser } from "./gitlab-client.js";
import type { GitLabConnection } from "./gitlab-connection.js";
import type { GitLabIdentity } from "./gitlab-workbench.js";
import type { GitLabOAuthSession, GitLabOAuthSessionStorePort } from "./gitlab-oauth-store.js";

const OAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
}).passthrough();

const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;

export interface GitLabOAuthConfig {
  baseUrl: string;
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

export interface GitLabOAuthStatus {
  configured: boolean;
  connected: boolean;
  identity: GitLabIdentity | null;
}

export type GitLabOAuthCompletion = GitLabIdentity & { returnTo?: string };

export interface GitLabOAuthServicePort {
  status(sessionKey: string): GitLabOAuthStatus;
  authorizationUrl(sessionKey: string, returnTo?: string): string | null;
  complete(sessionKey: string, code: string, state: string, credentialKey?: string): Promise<GitLabOAuthCompletion>;
  disconnect(sessionKey: string): void;
  adoptSession?(fromKey: string, toKey: string): void;
  getClient(sessionKey: string): Promise<GitLabClientPort | null>;
  getConnection?(sessionKey: string): Promise<GitLabConnection | null>;
}

export class GitLabOAuthError extends Error {
  constructor(readonly code: "not_configured" | "invalid_state" | "token_exchange_failed" | "invalid_token_response") {
    super(code);
    this.name = "GitLabOAuthError";
  }
}

type PendingState = { sessionKey: string; expiresAt: number; returnTo?: string };

function toIdentity(user: GitLabCurrentUser): GitLabIdentity {
  return {
    id: user.id === undefined || user.id === null ? null : String(user.id),
    username: user.username?.trim() ?? "",
    name: user.name?.trim() || user.username?.trim() || "GitLab 用户",
    webUrl: user.web_url ?? null,
    avatarUrl: null,
  };
}

export class GitLabOAuthService implements GitLabOAuthServicePort {
  private readonly states = new Map<string, PendingState>();
  private readonly sessions = new Map<string, GitLabOAuthSession>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GitLabOAuthConfig, fetchImpl = fetch, private readonly sessionStore?: GitLabOAuthSessionStorePort) {
    this.fetchImpl = fetchImpl;
  }

  status(sessionKey: string): GitLabOAuthStatus {
    const session = this.loadSession(sessionKey);
    if (session?.expiresAt && session.expiresAt <= Date.now() && !session.refreshToken) {
      this.removeSession(sessionKey);
      return { configured: this.isConfigured(), connected: false, identity: null };
    }
    return {
      configured: this.isConfigured(),
      connected: Boolean(session),
      identity: session?.identity ?? null,
    };
  }

  authorizationUrl(sessionKey: string, returnTo?: string): string | null {
    if (!this.isConfigured()) return null;
    this.removeExpiredStates();
    const state = randomBytes(24).toString("base64url");
    this.states.set(state, { sessionKey, expiresAt: Date.now() + OAUTH_STATE_TTL_MS, returnTo: returnTo?.trim() || undefined });
    const url = new URL(`${this.config.baseUrl.replace(/\/+$/, "")}/oauth/authorize`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", this.config.scope);
    return url.toString();
  }

  async complete(sessionKey: string, code: string, state: string, credentialKey = sessionKey): Promise<GitLabOAuthCompletion> {
    const pending = this.states.get(state);
    this.states.delete(state);
    if (!pending || pending.expiresAt <= Date.now() || pending.sessionKey !== sessionKey) {
      throw new GitLabOAuthError("invalid_state");
    }
    const token = await this.exchangeToken({ code, grant_type: "authorization_code", redirect_uri: this.config.redirectUri });
    const user = await new GitLabClient({ baseUrl: this.config.apiBaseUrl, token: token.accessToken, authMode: "bearer", fetchImpl: this.fetchImpl }).getCurrentUser();
    const identity = toIdentity(user);
    const session: GitLabOAuthSession = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresIn ? Date.now() + token.expiresIn * 1_000 : undefined,
      identity,
    };
    this.persistSession(credentialKey, session);
    this.sessions.set(credentialKey, session);
    return pending.returnTo ? { ...identity, returnTo: pending.returnTo } : identity;
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

  async getClient(sessionKey: string): Promise<GitLabClientPort | null> {
    const session = this.loadSession(sessionKey);
    if (!session) return null;
    if (session.expiresAt && session.expiresAt <= Date.now() + 30_000) {
      if (!session.refreshToken) {
        this.removeSession(sessionKey);
        return null;
      }
      const refresh = this.refreshes.get(sessionKey) ?? this.refreshSession(sessionKey, session);
      this.refreshes.set(sessionKey, refresh);
      try {
        await refresh;
      } catch {
        this.removeSession(sessionKey);
        return null;
      } finally {
        this.refreshes.delete(sessionKey);
      }
    }
    const current = this.sessions.get(sessionKey);
    return current ? new GitLabClient({ baseUrl: this.config.apiBaseUrl, token: current.accessToken, authMode: "bearer", fetchImpl: this.fetchImpl }) : null;
  }

  async getConnection(sessionKey: string): Promise<GitLabConnection | null> {
    const client = await this.getClient(sessionKey);
    if (!client) return null;
    const session = this.loadSession(sessionKey);
    return session
      ? { baseUrl: this.config.baseUrl, apiBaseUrl: this.config.apiBaseUrl, token: session.accessToken }
      : null;
  }

  private isConfigured(): boolean {
    return Boolean(this.config.baseUrl && this.config.apiBaseUrl && this.config.clientId && this.config.clientSecret && this.config.redirectUri);
  }

  private async refreshSession(sessionKey: string, session: GitLabOAuthSession): Promise<void> {
    if (!session.refreshToken) return;
    const token = await this.exchangeToken({ grant_type: "refresh_token", refresh_token: session.refreshToken });
    const refreshed: GitLabOAuthSession = {
      ...session,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? session.refreshToken,
      expiresAt: token.expiresIn ? Date.now() + token.expiresIn * 1_000 : undefined,
    };
    this.persistSession(sessionKey, refreshed);
    this.sessions.set(sessionKey, refreshed);
  }

  private async exchangeToken(parameters: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
    const body = new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...parameters });
    const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/+$/, "")}/oauth/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new GitLabOAuthError("token_exchange_failed");
    const parsed = OAuthTokenResponseSchema.safeParse(payload);
    if (!parsed.success) throw new GitLabOAuthError("invalid_token_response");
    return { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token, expiresIn: parsed.data.expires_in };
  }

  private removeExpiredStates(): void {
    const now = Date.now();
    for (const [state, pending] of this.states) {
      if (pending.expiresAt <= now) this.states.delete(state);
    }
  }

  private loadSession(sessionKey: string): GitLabOAuthSession | undefined {
    const current = this.sessions.get(sessionKey);
    if (current) return current;
    if (!this.sessionStore || !sessionKey) return undefined;
    const stored = this.sessionStore.read(sessionKey, this.providerKey());
    if (stored) this.sessions.set(sessionKey, stored);
    return stored ?? undefined;
  }

  private persistSession(sessionKey: string, session: GitLabOAuthSession): void {
    this.sessionStore?.write(sessionKey, this.providerKey(), session);
  }

  private removeSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.sessionStore?.delete(sessionKey, this.providerKey());
  }

  private providerKey(): string {
    return [this.config.baseUrl, this.config.apiBaseUrl, this.config.clientId].join("\u0000");
  }
}
