import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { GitLabOAuthError, GitLabOAuthService } from "../src/gitlab-oauth.js";
import { GitLabOAuthSessionStore } from "../src/gitlab-oauth-store.js";
import { config, gitlabConnectionStore, service } from "./app-fixtures.js";

describe("GitLabOAuthService", () => {
  it("exchanges the authorization code and keeps the user client in the browser session", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "oauth-access-token", refresh_token: "oauth-refresh-token", expires_in: 7_200 }), { status: 200 });
      }
      expect(url).toBe("https://gitblue.example/api/v4/user");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-access-token");
      return new Response(JSON.stringify({ id: 17, username: "personal-user", name: "Personal User", web_url: "https://gitblue.example/personal-user" }), { status: 200 });
    };
    const service = new GitLabOAuthService({
      baseUrl: "https://gitblue.example",
      apiBaseUrl: "https://gitblue.example/api/v4",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://pilot.example/gitlab/oauth/callback",
      scope: "api",
    }, fetchImpl);

    const authorizationUrl = service.authorizationUrl("browser-session");
    expect(authorizationUrl).toBeTruthy();
    const state = new URL(authorizationUrl ?? "https://invalid").searchParams.get("state");
    expect(state).toBeTruthy();

    const identity = await service.complete("browser-session", "authorization-code", state ?? "");
    expect(identity).toMatchObject({ id: "17", username: "personal-user", name: "Personal User" });
    expect(service.status("browser-session")).toMatchObject({ configured: true, connected: true, identity });
    expect(await service.getClient("browser-session")).not.toBeNull();
    expect(requests).toEqual([
      "https://gitblue.example/oauth/token",
      "https://gitblue.example/api/v4/user",
    ]);

    service.disconnect("browser-session");
    expect(service.status("browser-session")).toMatchObject({ configured: true, connected: false, identity: null });
  });

  it("restores an encrypted session after the API restarts and refreshes an expiring token", async () => {
    const store = new GitLabOAuthSessionStore(":memory:", "test-encryption-secret");
    const requests: string[] = [];
    const oauthConfig = {
      baseUrl: "https://gitblue.example",
      apiBaseUrl: "https://gitblue.example/api/v4",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://pilot.example/gitlab/oauth/callback",
      scope: "api",
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push(`${url} ${String(init?.body ?? "")}`);
      if (url.endsWith("/oauth/token")) {
        const body = String(init?.body ?? "");
        if (body.includes("grant_type=refresh_token")) {
          return new Response(JSON.stringify({ access_token: "refreshed-access-token", refresh_token: "rotated-refresh-token", expires_in: 7_200 }), { status: 200 });
        }
        return new Response(JSON.stringify({ access_token: "oauth-access-token", refresh_token: "oauth-refresh-token", expires_in: 7_200 }), { status: 200 });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-access-token");
      return new Response(JSON.stringify({ id: 17, username: "personal-user", name: "Personal User", web_url: "https://gitblue.example/personal-user" }), { status: 200 });
    };
    try {
      const service = new GitLabOAuthService(oauthConfig, fetchImpl, store);
      const authorizationUrl = service.authorizationUrl("browser-session");
      const state = new URL(authorizationUrl ?? "https://invalid").searchParams.get("state") ?? "";
      await service.complete("browser-session", "authorization-code", state);

      const providerKey = [oauthConfig.baseUrl, oauthConfig.apiBaseUrl, oauthConfig.clientId].join("\u0000");
      store.write("browser-session", providerKey, {
        accessToken: "expiring-access-token",
        refreshToken: "expiring-refresh-token",
        expiresAt: Date.now() + 1_000,
        identity: { id: "17", username: "personal-user", name: "Personal User", webUrl: "https://gitblue.example/personal-user", avatarUrl: null },
      });

      const restartedService = new GitLabOAuthService(oauthConfig, fetchImpl, store);
      expect(restartedService.status("browser-session")).toMatchObject({ connected: true, identity: { username: "personal-user" } });
      expect(await restartedService.getClient("browser-session")).not.toBeNull();
      expect(requests.some((request) => request.includes("grant_type=refresh_token"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("rejects a state from another browser session", async () => {
    const service = new GitLabOAuthService({
      baseUrl: "https://gitblue.example",
      apiBaseUrl: "https://gitblue.example/api/v4",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://pilot.example/gitlab/oauth/callback",
      scope: "api",
    });
    const authorizationUrl = service.authorizationUrl("browser-session");
    const state = new URL(authorizationUrl ?? "https://invalid").searchParams.get("state") ?? "";

    await expect(service.complete("another-session", "authorization-code", state)).rejects.toMatchObject<GitLabOAuthError>({ code: "invalid_state" });
  });

  it("starts OAuth only for an authenticated browser session", async () => {
    const app = await buildApp({
      config: {
        ...config,
        gitlabOAuthClientId: "client-id",
        gitlabOAuthClientSecret: "client-secret",
        gitlabOAuthRedirectUri: "http://localhost:5173/api/v1/gitlab/oauth/callback",
      },
      reviewService: service(),
      gitlabConnectionStore: gitlabConnectionStore(),
    });
    try {
      const session = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: config.webOrigin },
        payload: { username: config.loginUsername, password: config.loginPassword },
      });
      const setCookie = session.headers["set-cookie"];
      const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const status = await app.inject({ method: "GET", url: "/api/v1/gitlab/oauth/status", headers: { cookie: cookie?.split(";", 1)[0] ?? "" } });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ configured: true, connected: false, identity: null });

      const start = await app.inject({ method: "GET", url: "/api/v1/gitlab/oauth/start", headers: { cookie: cookie?.split(";", 1)[0] ?? "" } });
      expect(start.statusCode).toBe(302);
      expect(start.headers.location).toContain("http://gitlab.invalid/oauth/authorize");
    } finally {
      await app.close();
    }
  });

  it("returns to the GitLab workbench after OAuth callback", async () => {
    const oauth = {
      status: () => ({ configured: true, connected: false, identity: null }),
      authorizationUrl: () => "https://gitblue.example/oauth/authorize",
      async complete() {
        return { id: "17", username: "personal-user", name: "Personal User", webUrl: null, avatarUrl: null };
      },
      disconnect() {},
      async getClient() { return null; },
    };
    const app = await buildApp({
      config: {
        ...config,
        gitlabOAuthClientId: "client-id",
        gitlabOAuthClientSecret: "client-secret",
        gitlabOAuthRedirectUri: "http://localhost:5173/api/v1/gitlab/oauth/callback",
      },
      reviewService: service(),
      gitlabConnectionStore: gitlabConnectionStore(),
      gitlabOAuthService: oauth,
    });
    try {
      const session = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: config.webOrigin },
        payload: { username: config.loginUsername, password: config.loginPassword },
      });
      const setCookie = session.headers["set-cookie"];
      const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const callback = await app.inject({
        method: "GET",
        url: "/api/v1/gitlab/oauth/callback?code=authorization-code&state=oauth-state",
        headers: { cookie: cookie?.split(";", 1)[0] ?? "" },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe("http://localhost:5173/gitlab-workbench?oauth=connected");
    } finally {
      await app.close();
    }
  });

  it("keeps the OAuth return target under the deployed app base path", async () => {
    let requestedReturnTo: string | undefined;
    const oauth = {
      status: () => ({ configured: true, connected: false, identity: null }),
      authorizationUrl: (_sessionKey: string, returnTo?: string) => {
        requestedReturnTo = returnTo;
        return "https://gitblue.example/oauth/authorize";
      },
      async complete() {
        return { id: "17", username: "personal-user", name: "Personal User", webUrl: null, avatarUrl: null, returnTo: requestedReturnTo };
      },
      disconnect() {},
      async getClient() { return null; },
    };
    const app = await buildApp({
      config: {
        ...config,
        webOrigin: "https://192.0.2.10",
        gitlabOAuthClientId: "client-id",
        gitlabOAuthClientSecret: "client-secret",
        gitlabOAuthRedirectUri: "https://192.0.2.10/pilot/api/v1/gitlab/oauth/callback",
      },
      reviewService: service(),
      gitlabConnectionStore: gitlabConnectionStore(),
      gitlabOAuthService: oauth,
    });
    try {
      const session = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: "https://192.0.2.10" },
        payload: { username: config.loginUsername, password: config.loginPassword },
      });
      const setCookie = session.headers["set-cookie"];
      const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const headers = { cookie: cookie?.split(";", 1)[0] ?? "" };
      const start = await app.inject({
        method: "GET",
        url: "/api/v1/gitlab/oauth/start?returnTo=%2Fclaude-cli%3Ftab%3Dprojects",
        headers,
      });
      expect(start.statusCode).toBe(302);
      expect(requestedReturnTo).toBe("/pilot/claude-cli?tab=projects");

      const callback = await app.inject({
        method: "GET",
        url: "/api/v1/gitlab/oauth/callback?code=authorization-code&state=oauth-state",
        headers,
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe("https://192.0.2.10/pilot/claude-cli?tab=projects&oauth=connected");
    } finally {
      await app.close();
    }
  });
});
