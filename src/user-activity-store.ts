import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  USER_ACTIVITY_ACTIONS,
  UserActivityActionSchema,
  type UserActivityAction,
  type UserActivityResponse,
} from "./api-contracts.js";

const MAX_PERSISTED_EVENTS = 200_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface UserActivityStorePort {
  record(input: { username: string; action: UserActivityAction; path: string; createdAt?: string }): void;
  stats(options?: UserActivityStatsOptions): UserActivityResponse;
  close(): void;
}

export interface UserActivityStatsOptions {
  days?: number;
  user?: string;
  action?: UserActivityAction;
  usersPage?: number;
  usersPageSize?: number;
  recentPage?: number;
  recentPageSize?: number;
}

interface ActivitySqlRow {
  id?: unknown;
  username?: unknown;
  action?: unknown;
  path?: unknown;
  created_at?: unknown;
  date?: unknown;
  total?: unknown;
  users?: unknown;
  total_events?: unknown;
  active_users?: unknown;
  login_count?: unknown;
  page_view_count?: unknown;
  assistant_message_count?: unknown;
  review_action_count?: unknown;
  feedback_submit_count?: unknown;
  settings_update_count?: unknown;
  last_active_at?: unknown;
  count?: unknown;
}

function boundedDays(days: number | undefined): number {
  const value = Number.isFinite(days) ? Math.floor(days ?? 30) : 30;
  return Math.max(1, Math.min(90, value));
}

function boundedPage(page: number | undefined): number {
  const value = Number.isFinite(page) ? Math.floor(page ?? 1) : 1;
  return Math.max(1, value);
}

function boundedPageSize(pageSize: number | undefined): number {
  const value = Number.isFinite(pageSize) ? Math.floor(pageSize ?? DEFAULT_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, value));
}

function pageForTotal(page: number, pageSize: number, total: number): number {
  return total === 0 ? 1 : Math.min(page, Math.ceil(total / pageSize));
}

function dateRange(days: number): { from: string; to: string } {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setUTCHours(0, 0, 0, 0);
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

function dateKeys(from: string, days: number): string[] {
  const date = new Date(from);
  return Array.from({ length: days }, () => {
    const key = date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 1);
    return key;
  });
}

function numberValue(value: unknown): number {
  return Number(value ?? 0);
}

function nullableValue(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function normalizedActivityPath(pathValue: string): string {
  const normalizedPath = pathValue.split("?", 1)[0] || "/";
  return normalizedPath.slice(0, 256);
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => "\\" + match);
}

function activityFilter(
  range: { from: string; to: string },
  user: string | undefined,
  action: UserActivityAction | undefined,
): { where: string; params: string[] } {
  const clauses = ["created_at >= ?", "created_at <= ?"];
  const params = [range.from, range.to];
  if (user) {
    clauses.push("LOWER(username) LIKE LOWER(?) ESCAPE '\\'");
    params.push("%" + escapeLikePattern(user) + "%");
  }
  if (action) {
    clauses.push("action = ?");
    params.push(action);
  }
  return { where: clauses.join(" AND "), params };
}

export function classifyUserActivity(method: string, pathValue: string): UserActivityAction | null {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = pathValue.split("?", 1)[0];

  if (normalizedMethod === "POST" && normalizedPath === "/api/v1/assistant/stream") return "assistant_message";
  if (normalizedMethod === "POST" && /^\/api\/v1\/assistant\/runs\/[^/]+\/cancel$/.test(normalizedPath)) return "assistant_cancel";
  if (normalizedMethod === "POST" && normalizedPath === "/api/v1/reviews") return "review_submit";
  if (normalizedMethod === "POST" && /^\/api\/v1\/reviews\/[^/]+\/cancel$/.test(normalizedPath)) return "review_cancel";
  if (normalizedMethod === "POST" && /^\/api\/v1\/reviews\/[^/]+\/retry$/.test(normalizedPath)) return "review_retry";
  if (normalizedMethod === "DELETE" && /^\/api\/v1\/reviews\/[^/]+$/.test(normalizedPath)) return "review_cancel";
  if (normalizedMethod === "POST" && normalizedPath === "/api/v1/feedback") return "feedback_submit";
  if ((normalizedMethod === "POST" || normalizedMethod === "PATCH" || normalizedMethod === "DELETE") && /^\/api\/v1\/users(?:\/[^/]+)?$/.test(normalizedPath)) return "user_management";
  if (normalizedMethod === "PUT" && [
    "/api/v1/model-config",
    "/api/v1/review-settings",
    "/api/v1/gitlab-connection",
    "/api/v1/jira-connection",
    "/api/v1/jira/account",
  ].includes(normalizedPath)) return "settings_update";
  if ((normalizedMethod === "POST" || normalizedMethod === "PUT" || normalizedMethod === "PATCH" || normalizedMethod === "DELETE") && /^\/api\/v1\/review-(?:rules|profiles)(?:\/.*)?$/.test(normalizedPath)) return "review_rules_update";
  if (normalizedMethod === "POST" && normalizedPath === "/api/v1/gitlab/oauth/disconnect") return "gitlab_connect";
  if ((normalizedMethod === "POST" || normalizedMethod === "DELETE") && normalizedPath === "/api/v1/jira/account") return "jira_connect";
  if (normalizedMethod === "POST" && /^\/api\/v1\/gitlab\//.test(normalizedPath)) return "gitlab_action";
  if (normalizedMethod === "POST" && normalizedPath === "/api/v1/jira-connection/test") return "jira_connect";
  if (normalizedMethod === "POST" && normalizedPath === "/api/v1/jira/account/test") return "jira_connect";
  if (normalizedMethod === "POST" && /^\/api\/v1\/jira\//.test(normalizedPath)) return "jira_action";
  if (normalizedMethod === "POST" && normalizedPath === "/api/v1/merge-requests/resolve") return "gitlab_action";
  return null;
}

export class UserActivityStore implements UserActivityStorePort {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  record(input: { username: string; action: UserActivityAction; path: string; createdAt?: string }): void {
    this.ensureOpen();
    const username = input.username.trim().slice(0, 128);
    if (!username) return;
    const action = UserActivityActionSchema.parse(input.action);
    const parsedDate = input.createdAt ? new Date(input.createdAt) : new Date();
    const createdAt = Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();
    this.db.prepare(`
      INSERT INTO user_activity_events (id, username, action, path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), username, action, normalizedActivityPath(input.path), createdAt);
    this.db.prepare(`
      DELETE FROM user_activity_events
      WHERE id IN (
        SELECT id FROM user_activity_events
        ORDER BY created_at DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(MAX_PERSISTED_EVENTS);
  }

  stats(options: UserActivityStatsOptions = {}): UserActivityResponse {
    this.ensureOpen();
    const bounded = boundedDays(options.days);
    const range = dateRange(bounded);
    const user = options.user?.trim().slice(0, 128) || undefined;
    const action = options.action ? UserActivityActionSchema.parse(options.action) : undefined;
    const usersPageSize = boundedPageSize(options.usersPageSize);
    const recentPageSize = boundedPageSize(options.recentPageSize);
    const requestedUsersPage = boundedPage(options.usersPage);
    const requestedRecentPage = boundedPage(options.recentPage);
    const query = () => activityFilter(range, user, action);

    const summaryQuery = query();
    const summaryRow = this.db.prepare(
      "SELECT COUNT(*) AS total_events, COUNT(DISTINCT username) AS active_users, " +
      "SUM(CASE WHEN action = 'login' THEN 1 ELSE 0 END) AS login_count, " +
      "SUM(CASE WHEN action = 'page_view' THEN 1 ELSE 0 END) AS page_view_count, " +
      "SUM(CASE WHEN action = 'assistant_message' THEN 1 ELSE 0 END) AS assistant_message_count, " +
      "SUM(CASE WHEN action IN ('review_submit', 'review_cancel', 'review_retry', 'gitlab_action', 'jira_action') THEN 1 ELSE 0 END) AS review_action_count, " +
      "SUM(CASE WHEN action = 'feedback_submit' THEN 1 ELSE 0 END) AS feedback_submit_count, " +
      "SUM(CASE WHEN action = 'settings_update' THEN 1 ELSE 0 END) AS settings_update_count " +
      "FROM user_activity_events WHERE " + summaryQuery.where,
    ).get(...summaryQuery.params) as ActivitySqlRow | undefined;

    const actionQuery = query();
    const actionRows = this.db.prepare(
      "SELECT action, COUNT(*) AS count FROM user_activity_events WHERE " + actionQuery.where + " GROUP BY action",
    ).all(...actionQuery.params) as ActivitySqlRow[];
    const actionCounts = new Map(actionRows.map((row) => [String(row.action), numberValue(row.count)]));

    const trendQuery = query();
    const trendRows = this.db.prepare(
      "SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS total, COUNT(DISTINCT username) AS users " +
      "FROM user_activity_events WHERE " + trendQuery.where +
      " GROUP BY substr(created_at, 1, 10) ORDER BY date ASC",
    ).all(...trendQuery.params) as ActivitySqlRow[];
    const trendByDate = new Map(trendRows.map((row) => [String(row.date), row]));

    const userTotalQuery = query();
    const userTotalRow = this.db.prepare(
      "SELECT COUNT(*) AS count FROM (SELECT username FROM user_activity_events WHERE " +
      userTotalQuery.where + " GROUP BY username)",
    ).get(...userTotalQuery.params) as ActivitySqlRow | undefined;
    const usersTotal = numberValue(userTotalRow?.count);
    const usersPage = pageForTotal(requestedUsersPage, usersPageSize, usersTotal);

    const usersQuery = query();
    const userRows = this.db.prepare(
      "SELECT username, COUNT(*) AS total, " +
      "SUM(CASE WHEN action = 'login' THEN 1 ELSE 0 END) AS login_count, " +
      "SUM(CASE WHEN action = 'page_view' THEN 1 ELSE 0 END) AS page_view_count, " +
      "SUM(CASE WHEN action = 'assistant_message' THEN 1 ELSE 0 END) AS assistant_message_count, " +
      "SUM(CASE WHEN action IN ('review_submit', 'review_cancel', 'review_retry', 'gitlab_action', 'jira_action') THEN 1 ELSE 0 END) AS review_action_count, " +
      "MAX(created_at) AS last_active_at FROM user_activity_events WHERE " + usersQuery.where +
      " GROUP BY username ORDER BY total DESC, last_active_at DESC, username ASC LIMIT ? OFFSET ?",
    ).all(...usersQuery.params, usersPageSize, (usersPage - 1) * usersPageSize) as ActivitySqlRow[];

    const recentTotalQuery = query();
    const recentTotalRow = this.db.prepare(
      "SELECT COUNT(*) AS count FROM user_activity_events WHERE " + recentTotalQuery.where,
    ).get(...recentTotalQuery.params) as ActivitySqlRow | undefined;
    const recentTotal = numberValue(recentTotalRow?.count);
    const recentPage = pageForTotal(requestedRecentPage, recentPageSize, recentTotal);

    const recentQuery = query();
    const recentRows = this.db.prepare(
      "SELECT id, username, action, path, created_at FROM user_activity_events WHERE " + recentQuery.where +
      " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    ).all(...recentQuery.params, recentPageSize, (recentPage - 1) * recentPageSize) as ActivitySqlRow[];

    return {
      days: bounded,
      from: range.from,
      to: range.to,
      summary: {
        totalEvents: numberValue(summaryRow?.total_events),
        activeUsers: numberValue(summaryRow?.active_users),
        loginCount: numberValue(summaryRow?.login_count),
        pageViewCount: numberValue(summaryRow?.page_view_count),
        assistantMessageCount: numberValue(summaryRow?.assistant_message_count),
        reviewActionCount: numberValue(summaryRow?.review_action_count),
        feedbackSubmitCount: numberValue(summaryRow?.feedback_submit_count),
        settingsUpdateCount: numberValue(summaryRow?.settings_update_count),
      },
      actionCounts: USER_ACTIVITY_ACTIONS.map((activityAction) => ({
        action: activityAction,
        count: actionCounts.get(activityAction) ?? 0,
      })),
      trend: dateKeys(range.from, bounded).map((date) => {
        const row = trendByDate.get(date);
        return { date, total: numberValue(row?.total), users: numberValue(row?.users) };
      }),
      users: userRows.map((row) => ({
        username: String(row.username),
        total: numberValue(row.total),
        loginCount: numberValue(row.login_count),
        pageViewCount: numberValue(row.page_view_count),
        assistantMessageCount: numberValue(row.assistant_message_count),
        reviewActionCount: numberValue(row.review_action_count),
        lastActiveAt: nullableValue(row.last_active_at),
      })),
      usersTotal,
      usersPage,
      usersPageSize,
      recent: recentRows.map((row) => ({
        id: String(row.id),
        username: String(row.username),
        action: UserActivityActionSchema.parse(row.action),
        path: String(row.path),
        createdAt: String(row.created_at),
      })),
      recentTotal,
      recentPage,
      recentPageSize,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private migrate(): void {
    const allowedActions = USER_ACTIVITY_ACTIONS.map((action) => `'${action}'`).join(", ");
    const existingTable = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_activity_events'",
    ).get() as { sql?: unknown } | undefined;
    const existingSql = String(existingTable?.sql ?? "").toLowerCase();
    if (existingTable && !existingSql.includes("'jira_action'")) {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db.exec(`
          ALTER TABLE user_activity_events RENAME TO user_activity_events_legacy;
          DROP INDEX IF EXISTS idx_user_activity_events_created_at;
          DROP INDEX IF EXISTS idx_user_activity_events_username_created_at;
          DROP INDEX IF EXISTS idx_user_activity_events_action_created_at;
          CREATE TABLE user_activity_events (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN (${allowedActions})),
            path TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          INSERT INTO user_activity_events (id, username, action, path, created_at)
            SELECT id, username, action, path, created_at FROM user_activity_events_legacy;
          DROP TABLE user_activity_events_legacy;
        `);
        this.db.exec("COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK;");
        throw error;
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_activity_events (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN (${allowedActions})),
        path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_user_activity_events_created_at
        ON user_activity_events (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_user_activity_events_username_created_at
        ON user_activity_events (username, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_user_activity_events_action_created_at
        ON user_activity_events (action, created_at DESC);
    `);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("user activity store is closed");
  }
}
