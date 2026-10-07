import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
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

describe("administrator access boundaries", () => {
  it("keeps feedback details and configuration writes behind the administrator role", async () => {
    let modelConfig = { env: { ANTHROPIC_MODEL: "test-model" } };
    const app = await buildApp({
      config,
      reviewService: service(),
      gitlabConnectionStore: gitlabConnectionStore(),
      modelConfigStore: {
        async read() { return modelConfig; },
        async write(next) { modelConfig = next; return modelConfig; },
      },
      feedbackStore: {
        create() { return { id: "feedback-1", receivedAt: "2026-08-20T00:00:00.000Z" }; },
        list() { return { items: [], total: 0 }; },
        get() { return null; },
        delete() { return false; },
        close() {},
      },
    });
    try {
      const userCookie = await login(app, config.loginUsername, config.loginPassword);
      const adminCookie = await login(app, "pilot-admin", config.loginPassword);
      const userHeaders = { cookie: userCookie };
      const adminHeaders = { cookie: adminCookie };

      expect((await app.inject({ method: "GET", url: "/api/v1/feedback", headers: userHeaders })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/api/v1/feedback", headers: adminHeaders })).statusCode).toBe(200);

      const reviewPayload = { reviewConcurrency: 2, autoSendComments: false };
      expect((await app.inject({ method: "PUT", url: "/api/v1/review-settings", headers: userHeaders, payload: reviewPayload })).statusCode).toBe(403);
      expect((await app.inject({ method: "PUT", url: "/api/v1/review-settings", headers: adminHeaders, payload: reviewPayload })).statusCode).toBe(200);

      const modelPayload = { env: { ANTHROPIC_MODEL: "admin-model" } };
      expect((await app.inject({ method: "PUT", url: "/api/v1/model-config", headers: userHeaders, payload: modelPayload })).statusCode).toBe(403);
      expect((await app.inject({ method: "PUT", url: "/api/v1/model-config", headers: adminHeaders, payload: modelPayload })).statusCode).toBe(200);

      const gitlabPayload = { baseUrl: "https://gitlab.example.com", apiBaseUrl: "https://gitlab.example.com/api/v4" };
      expect((await app.inject({ method: "PUT", url: "/api/v1/gitlab-connection", headers: userHeaders, payload: gitlabPayload })).statusCode).toBe(403);
      expect((await app.inject({ method: "PUT", url: "/api/v1/gitlab-connection", headers: adminHeaders, payload: gitlabPayload })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
