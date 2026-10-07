import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { config, gitlabConnectionStore, service } from "./app-fixtures.js";
import { GitLabProjectsResponseSchema } from "../src/contracts.js";

const base = "/api/v1/inspections";
function cookie(response: { headers: { "set-cookie"?: string | string[] } }) {
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)?.split(";")[0] ?? "";
}
async function systemLogin(app: FastifyInstance, username = "pilot-admin") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: config.webOrigin }, payload: { username, password: config.loginPassword } });
  expect(response.statusCode).toBe(200);
  return cookie(response);
}
describe("inspection secondary login", () => {
  it("returns the shared project list contract after connecting the maintainer's GitLab", async () => {
    const apiAuthorization: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/merge_requests/")) apiAuthorization.push(new Headers(init?.headers).get("authorization") ?? "");
      const body = url.includes("/oauth/token") ? { access_token: "inspection-token" }
        : url.endsWith("/changes") ? { changes: [] }
        : url.includes("/notes?") || url.includes("/pipelines?") ? []
        : url.endsWith("/notes") ? { id: 12, body: "巡检维护人员评论" }
        : url.endsWith("/merge_requests/9") ? { id: 90, iid: 9, project_id: 42, title: "修复 #TEST-42", state: "merged" }
        : url.includes("/projects?") ? [{ id: 42, name: "Inspection demo", path_with_namespace: "quality/demo", default_branch: "main" }]
          : { id: 7, username: "inspection-user", name: "Inspection User" };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const app = await buildApp({ config: { ...config, gitlabOAuthClientId: "test-client", gitlabOAuthClientSecret: "test-secret" }, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    try {
      const parent = await systemLogin(app);
      const headers = { cookie: parent, origin: config.webOrigin };
      await app.inject({ method: "POST", url: `${base}/maintainers`, headers, payload: { username: "maintenance", password: "test-password" } });
      const login = await app.inject({ method: "POST", url: `${base}/auth/login`, headers, payload: { username: "maintenance", password: "test-password" } });
      const session = { ...headers, cookie: `${parent}; ${cookie(login)}` };
      const start = await app.inject({ url: `${base}/gitlab/oauth/start`, headers: session });
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const callback = await app.inject({ url: `${base}/gitlab/oauth/callback?code=test-code&state=${state}`, headers: session });
      expect(callback.statusCode).toBe(302);
      const response = await app.inject({ url: `${base}/gitlab/projects`, headers: session });
      expect(response.statusCode).toBe(200);
      const result = GitLabProjectsResponseSchema.parse(response.json());
      expect(result.projects[0]).toMatchObject({ id: "42", pathWithNamespace: "quality/demo", customReviewProfile: false });
      expect(result.profiles.length).toBeGreaterThan(0);
      expect(result.projects[0]?.reviewProfileName).toBe(result.profiles.find((profile) => profile.isDefault)?.name);
      expect((await app.inject({ url: "/api/v1/gitlab/oauth/status", headers })).json().connected).toBe(false);
      const mr = await app.inject({ url: `${base}/gitlab/merge-requests/42/9`, headers: session });
      expect(mr.statusCode).toBe(200);
      expect(mr.json()).toMatchObject({ iid: "9", state: "merged" });
      const note = await app.inject({ method: "POST", url: `${base}/gitlab/merge-requests/42/9/notes`, headers: session, payload: { body: "巡检维护人员评论" } });
      expect(note.statusCode).toBe(200);
      expect(apiAuthorization.length).toBeGreaterThan(0);
      expect(apiAuthorization.every(value => value === "Bearer inspection-token")).toBe(true);
      expect((await app.inject({ url: `${base}/gitlab/merge-requests/42/9`, headers: { ...session, "x-inspection-maintainer-id": "another-maintainer" } })).statusCode).toBe(409);
      expect((await app.inject({ url: "/api/v1/gitlab/merge-requests/42/9", headers })).statusCode).toBe(428);
      expect((await app.inject({ method: "POST", url: `${base}/gitlab/merge-requests/42/9/review`, headers: session })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `${base}/ai-tasks`, headers, payload: { runId: "r", findingId: "f" } })).statusCode).toBe(428);
    } finally { await app.close(); vi.unstubAllGlobals(); }
  });
  it("preserves the deployment base path for GitLab OAuth redirects", async () => {
    const deployedConfig = {
      ...config,
      gitlabOAuthClientId: "test-client",
      gitlabOAuthClientSecret: "test-secret",
      gitlabOAuthRedirectUri: "http://localhost:5173/pilot/api/v1/gitlab/oauth/callback",
    };
    const app = await buildApp({ config: deployedConfig, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    try {
      const parent = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: deployedConfig.webOrigin },
        payload: { username: "pilot-admin", password: deployedConfig.loginPassword },
      });
      expect(parent.statusCode).toBe(200);
      const parentCookie = cookie(parent);
      const headers = { cookie: parentCookie, origin: deployedConfig.webOrigin };
      const created = await app.inject({ method: "POST", url: `${base}/maintainers`, headers, payload: { username: "maintenance", password: "test-password" } });
      expect(created.statusCode).toBe(201);
      const login = await app.inject({ method: "POST", url: `${base}/auth/login`, headers, payload: { username: "maintenance", password: "test-password" } });
      expect(login.statusCode).toBe(200);
      const session = `${parentCookie}; ${cookie(login)}`;
      const start = await app.inject({ url: `${base}/gitlab/oauth/start`, headers: { ...headers, cookie: session } });
      expect(start.statusCode).toBe(302);
      expect(new URL(start.headers.location!).searchParams.get("redirect_uri")).toBe("http://localhost:5173/pilot/api/v1/inspections/gitlab/oauth/callback");
      const callback = await app.inject({ url: `${base}/gitlab/oauth/callback`, headers: { ...headers, cookie: session } });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe("http://localhost:5173/pilot/inspection-workbench?accounts=1&oauth=error");
    } finally { await app.close(); }
  });
  it("requires independent credentials, binds the parent session, grants ordinary users access and revokes it live", async () => {
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    try {
      const admin = await systemLogin(app);
      const ordinary = await systemLogin(app, "pilot-user");
      const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, session: string, payload?: object) => app.inject({ method, url, headers: { cookie: session, origin: config.webOrigin }, payload });
      expect((await call("GET", `${base}/projects`, admin)).statusCode).toBe(428);
      expect((await call("GET", `${base}/auth/status`, ordinary)).statusCode).toBe(403);
      expect((await app.inject({ url: `${base}/projects`, headers: { authorization: `Bearer ${config.triggerToken}` } })).statusCode).toBe(403);
      const created = await call("POST", `${base}/maintainers`, admin, { username: "maintainer-a", password: "maintenance-password" });
      expect(created.statusCode).toBe(201);
      const maintainer = created.json().user;
      expect(created.payload).not.toContain("maintenance-password");
      expect(created.payload).not.toContain("passwordHash");
      expect((await call("POST", `${base}/auth/login`, admin, { username: "pilot-admin", password: config.loginPassword })).statusCode).toBe(401);
      const loggedIn = await call("POST", `${base}/auth/login`, admin, { username: "maintainer-a", password: "maintenance-password" });
      expect(loggedIn.statusCode).toBe(200);
      const inspectionSetCookie = loggedIn.headers["set-cookie"];
      const inspectionCookieHeader = Array.isArray(inspectionSetCookie) ? inspectionSetCookie[0] : inspectionSetCookie;
      expect(inspectionCookieHeader).toContain("Path=/;");
      const secondary = cookie(loggedIn);
      const session = `${admin}; ${secondary}`;
      expect((await call("GET", `${base}/projects`, session)).statusCode).toBe(200);
      expect((await call("GET", `${base}/jira/account`, session)).json().tokenConfigured).toBe(false);
      expect((await call("GET", `${base}/gitlab/projects`, session)).statusCode).toBe(428);
      expect((await call("GET", `${base}/jira/issues/TEST-1`, session)).statusCode).toBe(428);
      const newParent = await systemLogin(app);
      expect((await call("GET", `${base}/projects`, `${newParent}; ${secondary}`)).statusCode).toBe(200);
      const users = (await call("GET", "/api/v1/users", admin)).json().users;
      const user = users.find((entry: { username: string }) => entry.username === "pilot-user");
      await call("PATCH", `/api/v1/users/${user.id}`, admin, { inspectionAccess: true });
      expect((await call("GET", `${base}/auth/status`, ordinary)).statusCode).toBe(200);
      expect((await call("GET", `${base}/maintainers`, ordinary)).statusCode).toBe(403);
      const ordinaryLogin = await call("POST", `${base}/auth/login`, ordinary, { username: "maintainer-a", password: "maintenance-password" });
      const ordinarySession = `${ordinary}; ${cookie(ordinaryLogin)}`;
      expect((await call("GET", `${base}/projects`, ordinarySession)).statusCode).toBe(200);
      await call("PATCH", `/api/v1/users/${user.id}`, admin, { inspectionAccess: false });
      expect((await call("GET", `${base}/projects`, ordinarySession)).statusCode).toBe(403);
      const updated = await call("PATCH", `${base}/maintainers/${maintainer.id}`, admin, { enabled: false });
      expect(updated.payload).not.toContain("passwordHash");
      expect((await call("GET", `${base}/projects`, session)).statusCode).toBe(428);
      expect((await call("GET", "/api/v1/auth/status", session)).json().username).toBe("pilot-admin");
    } finally { await app.close(); }
  });
});
