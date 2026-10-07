import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CLAUDE_SECRET_MASK } from "../src/model-config.js";
import { buildApp } from "../src/app.js";
import { config, gitlabConnectionStore, service } from "./app-fixtures.js";

function sessionCookie(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return value?.split(";", 1)[0] ?? "";
}

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: config.webOrigin },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response.headers["set-cookie"]);
}

describe("user management API", () => {
  it("masks service credentials for ordinary users and restricts connection tests to admins", async () => {
    const settings = { env: {
      ANTHROPIC_AUTH_TOKEN: "private-model-token",
      ANTHROPIC_API_KEY: "private-model-key",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_MODEL: "test-model",
    } };
    const app = await buildApp({
      config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore(),
      modelConfigStore: { async read() { return settings; }, async write(next) { return next; } },
    });
    try {
      const ordinary = await login(app, config.loginUsername, config.loginPassword);
      const admin = await login(app, "pilot-admin", config.loginPassword);
      const model = await app.inject({ method: "GET", url: "/api/v1/model-config", headers: { cookie: ordinary } });
      expect(model.statusCode).toBe(200);
      expect(model.json().env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: CLAUDE_SECRET_MASK, ANTHROPIC_API_KEY: CLAUDE_SECRET_MASK });
      expect(model.payload).not.toContain("private-model");
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("private-model-token");
      const gitlab = await app.inject({ method: "GET", url: "/api/v1/gitlab-connection", headers: { cookie: ordinary } });
      expect(gitlab.statusCode).toBe(200);
      expect(gitlab.json()).toMatchObject({ token: "", tokenConfigured: true });
      expect(gitlab.payload).not.toContain("gitlab-token");
      for (const url of ["/api/v1/model-config/test", "/api/v1/gitlab-connection/test"]) {
        const blocked = await app.inject({ method: "POST", url, headers: { cookie: ordinary }, payload: {} });
        expect(blocked.statusCode).toBe(403);
        const anonymous = await app.inject({ method: "POST", url, payload: {} });
        expect(anonymous.statusCode).toBe(401);
      }
      const adminModel = await app.inject({ method: "GET", url: "/api/v1/model-config", headers: { cookie: admin } });
      expect(adminModel.json()).toEqual(settings);
      const adminGitlab = await app.inject({ method: "GET", url: "/api/v1/gitlab-connection", headers: { cookie: admin } });
      expect(adminGitlab.json().token).toBe("gitlab-token");
    } finally {
      await app.close();
    }
  });

  it("lets pilot-admin maintain accounts and blocks ordinary users", async () => {
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    try {
      const adminCookie = await login(app, "pilot-admin", config.loginPassword);
      const list = await app.inject({ method: "GET", url: "/api/v1/users", headers: { cookie: adminCookie } });
      expect(list.statusCode).toBe(200);
      expect(list.json().users.map((user: { username: string }) => user.username)).toEqual(["pilot-admin", "pilot-user"]);
      expect(list.payload).not.toContain("password_hash");
      const admin = list.json().users.find((user: { username: string; id: string; password: string | null }) => user.username === "pilot-admin");
      if (!admin) throw new Error("pilot-admin was not bootstrapped");
      expect(admin.password).toBe(config.loginPassword);

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/users",
        headers: { cookie: adminCookie },
        payload: { username: "pilot-demo", password: "demo-password" },
      });
      expect(created.statusCode).toBe(201);
      const createdUser = created.json().user as { id: string; username: string; password: string | null; role: string; enabled: boolean };
      expect(createdUser).toMatchObject({ username: "pilot-demo", password: "demo-password", role: "user", enabled: true });

      const regularCookie = await login(app, config.loginUsername, config.loginPassword);
      const forbidden = await app.inject({ method: "GET", url: "/api/v1/users", headers: { cookie: regularCookie } });
      expect(forbidden.statusCode).toBe(403);

      const updated = await app.inject({
        method: "PATCH",
        url: `/api/v1/users/${createdUser.id}`,
        headers: { cookie: adminCookie },
        payload: { username: "pilot-renamed", password: "new-demo-password" },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().user).toMatchObject({ username: "pilot-renamed", password: "new-demo-password" });

      const disabled = await app.inject({
        method: "PATCH",
        url: `/api/v1/users/${createdUser.id}`,
        headers: { cookie: adminCookie },
        payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json().user.enabled).toBe(false);

      const disabledLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: config.webOrigin },
        payload: { username: "pilot-renamed", password: "new-demo-password" },
      });
      expect(disabledLogin.statusCode).toBe(401);

      const selfDisable = await app.inject({
        method: "PATCH",
        url: `/api/v1/users/${admin.id}`,
        headers: { cookie: adminCookie },
        payload: { enabled: false },
      });
      expect(selfDisable.statusCode).toBe(400);

      const deleted = await app.inject({ method: "DELETE", url: `/api/v1/users/${createdUser.id}`, headers: { cookie: adminCookie } });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ deleted: true });

      const selfDelete = await app.inject({ method: "DELETE", url: `/api/v1/users/${admin.id}`, headers: { cookie: adminCookie } });
      expect(selfDelete.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
