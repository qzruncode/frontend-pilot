import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { JiraOAuthService, type JiraOAuthServicePort } from "../src/jira-oauth.js";
import { JiraOAuthSessionStore } from "../src/jira-oauth-store.js";
import { config, gitlabConnectionStore, service } from "./app-fixtures.js";

function privateKey(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2_048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("JiraOAuthService", () => {
  it("performs the Jira OAuth 1.0a dance and creates a signed personal client", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      requests.push({ url, authorization });
      if (url.endsWith("/plugins/servlet/oauth/request-token")) {
        return new Response("oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true", { status: 200 });
      }
      if (url.endsWith("/plugins/servlet/oauth/access-token")) {
        return new Response("oauth_token=access-token&oauth_token_secret=access-secret", { status: 200 });
      }
      expect(url).toBe("https://jira.example/rest/api/2/myself");
      expect(authorization).toMatch(/^OAuth /);
      return new Response(JSON.stringify({ name: "jira-user", displayName: "Jira User" }), { status: 200 });
    };
    const service = new JiraOAuthService({
      baseUrl: "https://jira.example",
      apiBaseUrl: "https://jira.example/rest/api/2",
      consumerKey: "frontend-pilot",
      privateKey: privateKey(),
      redirectUri: "https://pilot.example/api/v1/jira/oauth/callback",
    }, fetchImpl);

    const authorizationUrl = await service.authorizationUrl("browser-session");
    expect(authorizationUrl).toBe("https://jira.example/plugins/servlet/oauth/authorize?oauth_token=request-token");
    await expect(service.complete("browser-session", "request-token", "verification-code")).resolves.toMatchObject({ username: "jira-user", name: "Jira User" });
    expect(service.status("browser-session")).toMatchObject({ configured: true, connected: true, identity: { username: "jira-user" } });
    expect(await service.getClient("browser-session")).not.toBeNull();
    expect(requests).toHaveLength(3);
    expect(requests[0].authorization).toMatch(/^OAuth /);
    expect(requests[1].authorization).toMatch(/^OAuth /);
    expect(requests[2].authorization).toMatch(/oauth_token/);
  });

  it("binds the OAuth callback to the browser session that started it", async () => {
    const service = new JiraOAuthService({
      baseUrl: "https://jira.example",
      apiBaseUrl: "https://jira.example/rest/api/2",
      consumerKey: "frontend-pilot",
      privateKey: privateKey(),
      redirectUri: "https://pilot.example/api/v1/jira/oauth/callback",
    }, async () => new Response("oauth_token=request-token&oauth_token_secret=request-secret", { status: 200 }));
    await service.authorizationUrl("browser-session");
    await expect(service.complete("another-session", "request-token", "verification-code")).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("restores an encrypted OAuth session for the stable product owner", async () => {
    const store = new JiraOAuthSessionStore(":memory:", "test-encryption-secret");
    const key = privateKey();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/plugins/servlet/oauth/request-token")) return new Response("oauth_token=request-token&oauth_token_secret=request-secret", { status: 200 });
      if (url.endsWith("/plugins/servlet/oauth/access-token")) return new Response("oauth_token=access-token&oauth_token_secret=access-secret", { status: 200 });
      expect(new Headers(init?.headers).get("authorization")).toMatch(/oauth_token/);
      return new Response(JSON.stringify({ name: "jira-user", displayName: "Jira User" }), { status: 200 });
    };
    const oauthConfig = {
      baseUrl: "https://jira.example",
      apiBaseUrl: "https://jira.example/rest/api/2",
      consumerKey: "frontend-pilot",
      privateKey: key,
      redirectUri: "https://pilot.example/api/v1/jira/oauth/callback",
    };
    try {
      const service = new JiraOAuthService(oauthConfig, fetchImpl, store);
      const authorizationUrl = await service.authorizationUrl("product:user-1");
      const token = new URL(authorizationUrl!).searchParams.get("oauth_token")!;
      await service.complete("product:user-1", token, "verification-code");
      const restarted = new JiraOAuthService(oauthConfig, fetchImpl, store);
      expect(restarted.status("product:user-1")).toMatchObject({ connected: true, identity: { username: "jira-user" } });
      expect(await restarted.getClient("product:user-1")).not.toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("Jira OAuth routes", () => {
  it("starts and completes a browser-session redirect", async () => {
    const oauth: JiraOAuthServicePort = {
      status: () => ({ configured: true, connected: false, identity: null }),
      async authorizationUrl() { return "https://jira.example/plugins/servlet/oauth/authorize?oauth_token=request-token"; },
      async complete() { return { username: "jira-user", name: "Jira User", avatarUrl: null }; },
      disconnect() {},
      async getClient() { return null; },
    };
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore(), jiraOAuthService: oauth });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: config.webOrigin },
        payload: { username: config.loginUsername, password: config.loginPassword },
      });
      const setCookie = login.headers["set-cookie"];
      const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const headers = { cookie: cookie?.split(";", 1)[0] ?? "" };
      const status = await app.inject({ method: "GET", url: "/api/v1/jira/oauth/status", headers });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ configured: true, connected: false });
      const start = await app.inject({ method: "GET", url: "/api/v1/jira/oauth/start", headers });
      expect(start.statusCode).toBe(302);
      expect(start.headers.location).toContain("https://jira.example/plugins/servlet/oauth/authorize");
      const callback = await app.inject({ method: "GET", url: "/api/v1/jira/oauth/callback?oauth_token=request-token&oauth_verifier=verification-code", headers });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe("http://localhost:5173/jira-workbench?oauth=connected");
    } finally {
      await app.close();
    }
  });
});
