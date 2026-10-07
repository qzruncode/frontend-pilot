import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InspectionService } from "../src/inspection-service.js";
import { InspectionStore } from "../src/inspection-store.js";
import { jiraIdentityForAuthor } from "../src/inspection-ownership.js";
import { registerInspectionRoutes } from "../src/app-inspection-routes.js";
import type { AppRouteContext } from "../src/app-route-context.js";
import type { InspectionFinding, InspectionFindingReportInput, InspectionOwnership, JiraIdentity, JiraIssue } from "../src/contracts.js";
import type { GitLabClientPort } from "../src/gitlab-client.js";
import type { JiraClientPort } from "../src/jira-client.js";
import { config } from "./app-fixtures.js";

const studio: InspectionFindingReportInput = { scope: "file", severity: "medium", category: "文件规模", line: 1,
  path: "src/pages/Connectors/components/StudioConnectionCreateDialog.tsx", issue: "组件 818 行，超过 600 行上限", suggestion: "拆分表单逻辑" };
const song: JiraIdentity = { username: "yun.song-cn", name: "SongYun 宋云", avatarUrl: null };
const chen: JiraIdentity = { username: "chenglong.chen", name: "陈成龙", email: "chenglong.chen@example.com", avatarUrl: null };
function setup(owner: string | null = null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "inspection-assignment-"));
  const filename = path.join(dir, "inspection.sqlite");
  const store = new InspectionStore(filename);
  const state = { findings: [{ ...studio }], streamed: [] as InspectionFindingReportInput[], users: [song, chen], owner, reason: "最新评论已确认 Connectors 由宋云负责", events: [] as string[] };
  const listAssignableUsers = vi.fn(async (_project: string, query?: string) => state.users.filter((user) =>
    !query || [user.username, user.name, user.email].some((value) => value?.toLowerCase().includes(query.toLowerCase()))));
  const createIssue = vi.fn(async (_project: string, input: { assignee?: string }) => ({ id: "1", key: "TEST-1", summary: "问题", description: null,
    status: "待办", statusId: "1", statusCategory: "new", issueType: "缺陷", priority: "中", projectKey: "TEST", projectName: "Test",
    webUrl: "https://jira.invalid/TEST-1", createdAt: null, updatedAt: null, resolution: null, labels: [],
    assignee: state.users.find((user) => user.username === input.assignee) ?? null, reporter: null } satisfies JiraIssue));
  const getCreateIssueOptions = vi.fn(async () => ({ currentUser: { username: "operator", name: "当前操作人", avatarUrl: null },
    issueTypes: [{ id: "1", name: "缺陷" }], priorities: [{ id: "3", name: "中" }] }));
  const listRepositoryCommits = vi.fn(async () => [{ id: "pinned-sha" }]);
  const getRepositoryFileBlame = vi.fn(async () => [{ authorName: "chenglong.chen", authorEmail: chen.email!, lines: ['import { useWatch } from "react-hook-form";'] }]);
  const resolveInspectionOwners = vi.fn(async (input: import("../src/inspection-owner-tools.js").InspectionOwnershipInput) => {
    state.events.push(`owner:${input.findings.map((finding) => finding.issue).join(",")}`);
    return input.findings.map((finding) => ({
      findingId: finding.id, ownership: { status: state.owner ? "resolved" : "uncertain", assignee: state.owner, reason: state.owner ? state.reason : "归属证据不足或存在冲突",
        checkedAt: new Date().toISOString(), evidence: [{ id: "e1", source: "jira_issue", title: "TEST-OWNER 最新认领说明", url: "https://jira.invalid/TEST-OWNER", checkedAt: new Date().toISOString() }] } satisfies InspectionOwnership,
    }));
  });
  const service = new InspectionService({ store,
    gitlab: { listRepositoryCommits, getRepositoryFileBlame } as unknown as GitLabClientPort,
    jira: { createIssue, getCreateIssueOptions, listAssignableUsers } as unknown as JiraClientPort,
    runner: { resolveInspectionOwners, runInspection: async (_input, options) => {
      for (const finding of state.streamed) {
        state.events.push(`report:start:${finding.issue}`);
        await options?.onInspectionFinding?.("security", finding);
        state.events.push(`report:return:${finding.issue}`);
      }
      state.events.push("final-json");
      return JSON.stringify({ summary: "巡检完成", ruleResults: [{ ruleId: "security", ruleName: "安全", conclusion: "发现问题", findings: state.findings }], findings: [] });
    } },
    config: { rulesDir: config.inspectionRulesDir, profileConfigPath: config.inspectionProfileConfigPath, maintainerRootDir: path.join(dir, "inspection-maintainers") },
    jiraProjectKey: () => "TEST", schedulerIntervalMs: 60_000,
  });
  const configure = (jiraMode: "auto" | "manual" = "auto") => service.upsertProject({ projectId: "42", projectPath: "saas/saas-frontend", projectName: "SaaS", branch: "dev",
    enabled: true, scheduleEnabled: false, scheduleCron: "0 0 * * *", inspectionRuleIds: [], jiraMode,
    jiraComponent: "LLMOps-V3", jiraFixVersion: "LLM-3.4" });
  return { state, service, store, filename, configure, resolveInspectionOwners, createIssue, listAssignableUsers, getCreateIssueOptions, getRepositoryFileBlame, listRepositoryCommits,
    scan: async () => {
      const { run } = await service.enqueue("42");
      await vi.waitFor(() => expect(service.getRun(run.id)?.status).toBe("completed"), { interval: 5 });
      return service.getRun(run.id)!;
    },
    close: async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("inspection assignment ownership", () => {
  it("does not assign an unowned whole-file issue", async () => {
    const fixture = setup();
    try {
      await fixture.configure();
      const result = (await fixture.scan()).result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!;
      expect(result.author).toBeNull();
      expect(result.jira).toMatchObject({ status: "skipped", assignee: null, error: expect.stringContaining("证据不足") });
      expect(fixture.createIssue).not.toHaveBeenCalled();
      expect(fixture.getCreateIssueOptions).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it.each(["file", "line"] as const)("assigns a %s issue to the AI-confirmed owner", async (scope) => {
    const fixture = setup(song.username);
    try {
      fixture.state.findings = [{ ...studio, scope }];
      await fixture.configure();
      const result = (await fixture.scan()).result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!;
      expect(fixture.createIssue).toHaveBeenCalledWith("TEST", expect.objectContaining({ assignee: "yun.song-cn", description: expect.stringContaining("AI 查询判断") }));
      expect(result.jira).toMatchObject({ status: "created", assignee: "yun.song-cn", assigneeName: "SongYun 宋云", assignmentSource: "ai" });
      expect(result.author).toBeNull();
      expect(result.jira.ownership).toMatchObject({ status: "resolved", assignee: song.username });
      expect(fixture.listAssignableUsers).toHaveBeenCalledWith("TEST", "yun.song-cn");
    } finally { await fixture.close(); }
  });

  it("reuses the AI owner result from the run action", async () => {
    const fixture = setup(song.username);
    try {
      fixture.state.findings = [{ ...studio, scope: "file" }];
      await fixture.configure("manual");
      const run = await fixture.scan();
      const before = run.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!;
      before.jira = { ...before.jira, ownership: undefined, assignee: null, assigneeName: null, assignmentSource: undefined, status: "not_created" };
      expect(before.jira).toMatchObject({ status: "not_created", assignee: null });

      const refreshed = await fixture.service.resolveOwners(run.id);
      const after = refreshed.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!;
      expect(after.author).toBeNull();
      expect(after.jira).toMatchObject({ status: "not_created", assignmentSource: "ai", assignee: song.username });
      expect(fixture.resolveInspectionOwners).toHaveBeenCalledTimes(2);
      expect(fixture.createIssue).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it("keeps owner confirmation separate from Jira creation", async () => {
    const fixture = setup(song.username);
    try {
      await fixture.configure("manual");
      const run = await fixture.scan();
      const finding = run.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!;
      finding.jira = { ...finding.jira, ownership: undefined, assignee: null, assigneeName: null, assignmentSource: undefined, status: "not_created" };

      const created = await fixture.service.createJira(run.id, finding.id);
      const updated = created.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!;
      expect(fixture.resolveInspectionOwners).toHaveBeenCalledTimes(1);
      expect(fixture.createIssue).not.toHaveBeenCalled();
      expect(updated.jira).toMatchObject({ status: "skipped", assignee: null, error: expect.stringContaining("先确认负责人") });
    } finally { await fixture.close(); }
  });

  it("confirms one finding owner without creating Jira", async () => {
    const fixture = setup(song.username);
    try {
      await fixture.configure("manual");
      const run = await fixture.scan();
      const finding = run.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!;
      finding.jira = { ...finding.jira, ownership: undefined, assignee: null, assigneeName: null, assignmentSource: undefined, status: "not_created" };

      const refreshed = await fixture.service.resolveOwner(run.id, finding.id);
      const updated = refreshed.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!;
      expect(fixture.resolveInspectionOwners).toHaveBeenCalledTimes(2);
      expect(fixture.createIssue).not.toHaveBeenCalled();
      expect(updated.jira).toMatchObject({ status: "not_created", assignee: song.username, assignmentSource: "ai" });
    } finally { await fixture.close(); }
  });

  it("requires an explicitly verified account for a historical or unowned finding", async () => {
    const fixture = setup();
    try {
      fixture.state.findings = [{ ...studio, scope: undefined }];
      await fixture.configure();
      const run = await fixture.scan();
      const finding = run.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!;
      // A fuzzy singleton with another username must not be accepted.
      fixture.listAssignableUsers.mockResolvedValueOnce([song]);
      const rejected = await fixture.service.createJira(run.id, finding.id, "Song");
      expect(rejected.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!.jira.status).toBe("skipped");
      expect(fixture.createIssue).not.toHaveBeenCalled();
      const created = await fixture.service.createJira(run.id, finding.id, "yun.song-cn");
      expect(created.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!.jira).toMatchObject({ status: "created", assignee: "yun.song-cn", assignmentSource: "manual" });
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
      await fixture.service.createJira(run.id, finding.id, "chenglong.chen");
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); }
  });

  it("merges broader streamed and final scopes before any automatic creation", async () => {
    const fixture = setup();
    try {
      await fixture.configure();
      fixture.state.streamed = [{ ...studio, scope: "line" }];
      fixture.state.findings = [{ ...studio, scope: "cross_file", relatedPaths: ["src/models/api.ts"] }, { ...studio, scope: "line" }];
      const run = await fixture.scan();
      const finding = run.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!;
      expect(run.result!.findingCount).toBe(1);
      expect(finding).toMatchObject({ scope: "cross_file", relatedPaths: ["src/models/api.ts"], author: null });
      expect(finding.jira).toMatchObject({ status: "skipped", error: expect.stringContaining("冲突") });
      expect(fixture.resolveInspectionOwners).toHaveBeenCalledWith(expect.objectContaining({ findings: [expect.objectContaining({ scope: "cross_file", relatedPaths: ["src/models/api.ts"] })] }), expect.anything());
      expect(fixture.createIssue).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it("preserves invalid related paths for assignment review instead of normalizing away traversal", async () => {
    const fixture = setup(song.username);
    try {
      await fixture.configure();
      fixture.state.findings = [{ ...studio, scope: "cross_file", relatedPaths: ["src/pages/Connectors/../Connectors/api.ts"] }];
      const run = await fixture.scan();
      expect(run.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!.jira.error).toContain("路径无效");
      expect(fixture.createIssue).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it("revalidates AI candidates and preserves their evidence after reopening storage", async () => {
    const fixture = setup(song.username);
    try {
      await fixture.configure();
      fixture.state.users = [chen];
      const run = await fixture.scan();
      expect(run.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!.jira.error).toContain("无法确认 Jira 账号 yun.song-cn");
      expect(fixture.createIssue).not.toHaveBeenCalled();
      const reopened = new InspectionStore(fixture.filename);
      try { expect(reopened.loadRuns()[0]!.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!.jira.ownership?.reason).toContain("最新评论"); } finally { reopened.close(); }
    } finally { await fixture.close(); }
  });

  it("stops creation if inspection is canceled while validating the assignee", async () => {
    const fixture = setup(song.username);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    try {
      await fixture.configure();
      fixture.getCreateIssueOptions.mockImplementationOnce(async () => { await wait; return { currentUser: { ...song, avatarUrl: null }, issueTypes: [{ id: "1", name: "缺陷" }], priorities: [{ id: "3", name: "中" }] }; });
      const { run } = await fixture.service.enqueue("42");
      await vi.waitFor(() => expect(fixture.getCreateIssueOptions).toHaveBeenCalledTimes(1));
      await fixture.service.cancel(run.id);
      release();
      await vi.waitFor(() => expect(fixture.service.getRun(run.id)?.progress.some((event) => event.message === "巡检资源已清理")).toBe(true));
      expect(fixture.createIssue).not.toHaveBeenCalled();
      expect(fixture.service.getRun(run.id)?.status).toBe("canceled");
    } finally { release(); await fixture.close(); }
  });

  it("reuses the owner confirmed while finding the issue when creating Jira", async () => {
    const fixture = setup(song.username);
    try {
      await fixture.configure("manual");
      const run = await fixture.scan();
      const finding = run.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!;
      expect(finding.jira.assignee).toBe(song.username);
      fixture.state.owner = chen.username;
      fixture.state.reason = "最新交接说明变更了该功能的负责人";
      const refreshed = await fixture.service.createJira(run.id, finding.id);
      expect(fixture.resolveInspectionOwners).toHaveBeenCalledTimes(1);
      expect(fixture.createIssue).toHaveBeenCalledWith("TEST", expect.objectContaining({ assignee: song.username }));
      expect(refreshed.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!.jira.ownership?.reason).toContain("最新评论");
    } finally { await fixture.close(); }
  });

  it("keeps findings available without creating Jira when AI lookup fails", async () => {
    const fixture = setup(song.username);
    try {
      fixture.resolveInspectionOwners.mockRejectedValueOnce(new Error("相关记录查询暂时不可用"));
      await fixture.configure();
      const run = await fixture.scan();
      expect(run.result!.findingCount).toBe(1);
      expect(run.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!.jira).toMatchObject({ status: "skipped", assignee: null, error: "相关记录查询暂时不可用" });
      expect(fixture.createIssue).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it("discards a late AI decision when the inspection was canceled during lookup", async () => {
    const fixture = setup(song.username);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    try {
      fixture.resolveInspectionOwners.mockImplementationOnce(async () => { await pending; return []; });
      await fixture.configure();
      const { run } = await fixture.service.enqueue("42");
      await vi.waitFor(() => expect(fixture.resolveInspectionOwners).toHaveBeenCalledTimes(1));
      await fixture.service.cancel(run.id);
      release();
      await vi.waitFor(() => expect(fixture.service.getRun(run.id)?.progress.some((event) => event.message === "巡检资源已清理")).toBe(true));
      expect(fixture.service.getRun(run.id)?.status).toBe("canceled");
      expect(fixture.createIssue).not.toHaveBeenCalled();
    } finally { release(); await fixture.close(); }
  });

  it("resolves each finding owner before creating its own issue", async () => {
    const fixture = setup(song.username);
    try {
      fixture.state.findings = Array.from({ length: 10 }, (_, i) => ({ ...studio, path: `src/file-${i}.ts`, issue: `文件 ${i} 过大` }));
      await fixture.configure();
      await fixture.scan();
      expect(fixture.resolveInspectionOwners.mock.calls.map(([input]) => input.findings.length)).toEqual(Array.from({ length: 10 }, () => 1));
      expect(fixture.createIssue).toHaveBeenCalledTimes(10);
    } finally { await fixture.close(); }
  });

  it("confirms the owner before the real-time finding report returns", async () => {
    const fixture = setup(song.username);
    try {
      fixture.state.findings = [];
      fixture.state.streamed = [{ ...studio, issue: "实时上报的问题" }];
      await fixture.configure("manual");
      await fixture.scan();
      expect(fixture.state.events).toEqual([
        "report:start:实时上报的问题",
        "owner:实时上报的问题",
        "report:return:实时上报的问题",
        "final-json",
      ]);
    } finally { await fixture.close(); }
  });
});

describe("inspection author identity evidence", () => {
  it("rejects singleton fuzzy matches and display names, preferring the exact email across all results", () => {
    const author = { name: "Alex", email: "alex.wang@example.com", assignee: null };
    const wrong = { username: "alex.chen", name: "Alex", avatarUrl: null };
    const correct = { username: "AlexWang", name: "Alex", email: author.email, avatarUrl: null };
    expect(jiraIdentityForAuthor(author, [wrong])).toBeNull();
    expect(jiraIdentityForAuthor(author, [wrong, correct])).toEqual(correct);
    expect(jiraIdentityForAuthor(author, [wrong, correct, correct])).toEqual(correct);
    expect(jiraIdentityForAuthor(author, [correct, { ...correct, username: "another" }])).toBeNull();
    expect(jiraIdentityForAuthor(author, [{ ...wrong, username: "alex.wang", email: "other@example.com" }])).toBeNull();
  });
});

it("passes a validated manual assignee through the inspection route and retains maintainer checks", async () => {
  const app = Fastify();
  const createJira = vi.fn(async () => ({ id: "run" }));
  let maintainerId = "owner";
  const identity = () => ({ maintainerId, maintainerName: null, operatorId: "operator", operatorName: null });
  const context = { inspectionService: { getRun: () => ({ maintainerId: "owner" }), createJira },
    inspectionAccounts: { requireMaintainer: () => true, current: () => ({ id: maintainerId }), identity } } as unknown as AppRouteContext;
  registerInspectionRoutes(app, context);
  const url = "/api/v1/inspections/runs/run/findings/finding/jira";
  try {
    expect((await app.inject({ method: "POST", url, payload: { assignee: " yun.song-cn " } })).statusCode).toBe(201);
    expect(createJira).toHaveBeenLastCalledWith("run", "finding", "yun.song-cn", expect.objectContaining({ maintainerId: "owner" }));
    expect((await app.inject({ method: "POST", url, payload: { assignee: " " } })).statusCode).toBe(400);
    maintainerId = "different";
    expect((await app.inject({ method: "POST", url, payload: { assignee: "yun.song-cn" } })).statusCode).toBe(403);
    expect(createJira).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});

it("exposes a separate per-finding owner confirmation route", async () => {
  const app = Fastify();
  const resolveOwner = vi.fn(async () => ({ id: "run" }));
  let maintainerId = "owner";
  const identity = () => ({ maintainerId, maintainerName: null, operatorId: "operator", operatorName: null });
  const context = { inspectionService: { getRun: () => ({ maintainerId: "owner" }), resolveOwner },
    inspectionAccounts: { requireMaintainer: () => true, current: () => ({ id: maintainerId }), identity } } as unknown as AppRouteContext;
  registerInspectionRoutes(app, context);
  const url = "/api/v1/inspections/runs/run/findings/finding/owner";
  try {
    expect((await app.inject({ method: "POST", url })).statusCode).toBe(200);
    expect(resolveOwner).toHaveBeenLastCalledWith("run", "finding", expect.objectContaining({ maintainerId: "owner" }));
    maintainerId = "different";
    expect((await app.inject({ method: "POST", url })).statusCode).toBe(403);
    expect(resolveOwner).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});
