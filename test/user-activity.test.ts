import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { config, gitlabConnectionStore, service } from "./app-fixtures.js";
import { UserActivityStore } from "../src/user-activity-store.js";

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

describe("user activity statistics", () => {
  it("migrates the legacy action constraint before recording Jira activity", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-user-activity-"));
    const databasePath = path.join(tempDir, "activity.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE user_activity_events (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('login', 'page_view', 'assistant_message', 'assistant_cancel', 'review_submit', 'review_cancel', 'review_retry', 'feedback_submit', 'settings_update', 'user_management', 'gitlab_connect', 'gitlab_action', 'jira_connect')),
        path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_user_activity_events_created_at ON user_activity_events (created_at DESC);
      INSERT INTO user_activity_events VALUES ('legacy-1', 'alice', 'page_view', '/jira-workbench', '2026-09-15T01:00:00.000Z');
    `);
    legacy.close();
    try {
      const store = new UserActivityStore(databasePath);
      store.record({ username: "alice", action: "jira_action", path: "/api/v1/jira/ai-tasks/task-1/retry", createdAt: "2026-09-15T02:00:00.000Z" });
      const stats = store.stats({ days: 90, user: "alice" });
      expect(stats.summary.totalEvents).toBe(2);
      expect(stats.actionCounts).toEqual(expect.arrayContaining([{ action: "jira_action", count: 1 }]));
      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("records authenticated behavior and keeps statistics administrator-only", async () => {
    const app = await buildApp({ config, reviewService: service(), gitlabConnectionStore: gitlabConnectionStore() });
    try {
      const userCookie = await login(app, config.loginUsername, config.loginPassword);
      const adminCookie = await login(app, "pilot-admin", config.loginPassword);
      const userHeaders = { cookie: userCookie };
      const adminHeaders = { cookie: adminCookie };

      const pageView = await app.inject({
        method: "POST",
        url: "/api/v1/user-activity",
        headers: userHeaders,
        payload: { path: "/feedback" },
      });
      expect(pageView.statusCode).toBe(201);

      const feedback = await app.inject({
        method: "POST",
        url: "/api/v1/feedback",
        headers: userHeaders,
        payload: { category: "experience", rating: 5, message: "很好用" },
      });
      expect(feedback.statusCode).toBe(201);

      const denied = await app.inject({ method: "GET", url: "/api/v1/user-activity?days=7", headers: userHeaders });
      expect(denied.statusCode).toBe(403);

      const response = await app.inject({ method: "GET", url: "/api/v1/user-activity?days=7", headers: adminHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        days: 7,
        trend: expect.any(Array),
        summary: {
          activeUsers: 2,
          pageViewCount: 1,
          feedbackSubmitCount: 1,
        },
      });
      expect(response.json().trend).toHaveLength(7);
      expect(response.json().users).toEqual(expect.arrayContaining([
        expect.objectContaining({ username: config.loginUsername, pageViewCount: 1 }),
        expect.objectContaining({ username: "pilot-admin" }),
      ]));
      expect(response.json().actionCounts).toEqual(expect.arrayContaining([
        { action: "login", count: 2 },
        { action: "page_view", count: 1 },
        { action: "feedback_submit", count: 1 },
      ]));

      const filtered = await app.inject({
        method: "GET",
        url: "/api/v1/user-activity?days=7&user=" + encodeURIComponent(config.loginUsername) + "&action=page_view&usersPageSize=1&recentPageSize=1",
        headers: adminHeaders,
      });
      expect(filtered.statusCode).toBe(200);
      expect(filtered.json()).toMatchObject({
        usersTotal: 1,
        usersPage: 1,
        usersPageSize: 1,
        recentTotal: 1,
        recentPage: 1,
        recentPageSize: 1,
      });
      expect(filtered.json().users).toHaveLength(1);
      expect(filtered.json().recent).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
