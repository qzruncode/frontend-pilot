import { describe, expect, it, vi } from "vitest";
import { InspectionService, type InspectionExecutionIdentity } from "../src/inspection-service.js";
import { InspectionStore } from "../src/inspection-store.js";
import { InspectionRunSchema, type InspectionFinding, type InspectionRun, type JiraIssue } from "../src/contracts.js";
import type { GitLabClientPort } from "../src/gitlab-client.js";
import type { JiraClientPort } from "../src/jira-client.js";
import { config } from "./app-fixtures.js";

const alice = { maintainerId: "alice", operatorId: "admin" };
const bob = { maintainerId: "bob", operatorId: "admin" };
const initialTime = Date.parse("2026-09-05T10:00:00Z");

function finding(id: string, key: string | null): InspectionFinding {
  return { id, fingerprint: id, severity: "high", category: "安全", path: "src/demo.ts", line: 1,
    issue: `问题 ${id}`, suggestion: "修复风险", author: null,
    jira: { status: key ? "created" : "not_created", key, url: key ? `https://jira.example/browse/${key}` : null, assignee: null, error: null } };
}

function run(id: string, identity: InspectionExecutionIdentity, findings: InspectionFinding[]): InspectionRun {
  return { id, ...identity, projectId: "42", projectPath: "group/project", projectName: "Project", branch: "main", source: "manual",
    status: "completed", createdAt: new Date(initialTime).toISOString(), startedAt: null, finishedAt: new Date(initialTime).toISOString(),
    headSha: "sha", error: null, progress: [], result: { format: "structured", summary: "发现风险", ruleFindingCount: findings.length,
      findingCount: findings.length, headSha: "sha", findings, ruleResults: [] } };
}

function issue(key: string, statusCategory = "done"): JiraIssue {
  return { id: key, key, summary: key, description: null, status: statusCategory === "done" ? "已关闭" : "重新打开", statusId: "5",
    statusCategory, issueType: "缺陷", priority: null, projectKey: "TEST", projectName: "Test", webUrl: `https://jira.example/browse/${key}`,
    createdAt: null, updatedAt: null, resolution: null, labels: [], assignee: null, reporter: null };
}

function setup(runs: InspectionRun[], resolveJiraClient: (identity: InspectionExecutionIdentity) => JiraClientPort | null, interval = 60_000) {
  const store = new InspectionStore(":memory:");
  runs.forEach((entry) => store.saveRun(entry, 0));
  let nowMs = initialTime;
  let allowed = true;
  const service = new InspectionService({
    gitlab: {} as GitLabClientPort,
    jira: { listIssues: async () => { throw new Error("global Jira must not be used"); } } as JiraClientPort,
    resolveJiraClient,
    validateIdentity: () => { if (!allowed) throw new Error("维护人员已停用"); },
    runner: { runInspection: async () => "{}" }, store,
    config: { rulesDir: config.inspectionRulesDir, profileConfigPath: config.inspectionProfileConfigPath },
    now: () => new Date(nowMs), schedulerIntervalMs: interval,
  });
  return { service, store, advance: () => { nowMs += 60_001; }, revoke: () => { allowed = false; },
    close: async () => { await service.close(); store.close(); } };
}

describe("inspection Jira status synchronization", () => {
  it("syncs reassignment and unassignment to every persisted copy while preserving the author reference", async () => {
    const original = finding("studio", "AIP-114661");
    original.author = { name: "chenglong.chen", email: "chenglong.chen@example.com", assignee: "chenglong.chen" };
    original.jira.assignee = "chenglong.chen";
    let assignee: JiraIssue["assignee"] = { username: "yun.song-cn", name: "SongYun 宋云", avatarUrl: null };
    const current = run("studio", alice, [original]);
    current.result!.ruleResults = [{ ruleId: "file-line-limit", ruleName: "文件规模", conclusion: "超限", findings: [structuredClone(original)] }];
    const listIssues = vi.fn(async () => ({ issues: [{ ...issue("AIP-114661", "new"), assignee }], page: 1, perPage: 50, total: 1 }));
    const fixture = setup([current], () => ({ listIssues }) as unknown as JiraClientPort);
    try {
      await fixture.service.syncJiraStatuses(alice);
      const saved = fixture.store.loadRuns()[0]!.result!;
      for (const copy of [...saved.findings, ...saved.ruleResults.flatMap((rule) => rule.findings)]) {
        expect(copy.jira).toMatchObject({ assignee: "yun.song-cn", assigneeName: "SongYun 宋云" });
        expect(copy.author?.assignee).toBe("chenglong.chen");
      }
      expect(fixture.store.loadTrackedFindings()[0]!.finding.jira.assignee).toBe("yun.song-cn");
      assignee = null;
      fixture.advance();
      await fixture.service.syncJiraStatuses(alice);
      expect(fixture.store.loadRuns()[0]!.result!.findings[0]!.jira).toMatchObject({ assignee: null, assigneeName: null });
      expect(fixture.store.loadTrackedFindings()[0]!.finding.jira.assignee).toBeNull();
    } finally { await fixture.close(); }
  });

  it("updates every linked copy, preserves historical counts, persists completion and handles reopening", async () => {
    const old = run("old", {}, [finding("one", "TEST-1"), finding("unlinked", null)]);
    old.result!.ruleResults = [{ ruleId: "security", ruleName: "安全", conclusion: "发现问题", findings: [structuredClone(old.result!.findings[0]!)] }];
    expect(InspectionRunSchema.parse(old).result?.findings[0]?.jira.issueStatusCategory).toBeUndefined();
    let statusCategory = "done";
    const listIssues = vi.fn(async () => ({ issues: [issue("TEST-1", statusCategory)], page: 1, perPage: 50, total: 1 }));
    const fixture = setup([old, run("new", alice, [finding("two", "TEST-1")])], () => ({ listIssues }) as unknown as JiraClientPort);
    try {
      await fixture.service.syncJiraStatuses(alice);
      expect(listIssues.mock.calls).toHaveLength(1);
      const persisted = fixture.store.loadRuns();
      expect(persisted.find((entry) => entry.id === "new")?.result?.findings[0]?.jira).toMatchObject({ status: "created", issueStatusCategory: "done", issueStatus: "已关闭", syncError: null });
      expect(persisted.find((entry) => entry.id === "old")?.result?.findings[0]?.jira).toMatchObject({ status: "created" });
      expect(persisted.find((entry) => entry.id === "old")?.result?.findings[0]?.jira.issueStatusCategory).toBeUndefined();
      expect(fixture.service.getRun("old")?.result).toMatchObject({ findingCount: 2, ruleResults: [{ findings: [{ jira: {} }] }] });
      expect(fixture.service.getRun("old")?.result?.findings[1]?.jira.status).toBe("not_created");
      statusCategory = "new";
      fixture.advance();
      await fixture.service.syncJiraStatuses(alice);
      expect(fixture.store.loadRuns().find((entry) => entry.id === "new")?.result?.findings[0]?.jira.issueStatusCategory).toBe("new");
      expect(fixture.store.loadRuns().find((entry) => entry.id === "old")?.result?.findings[0]?.jira.issueStatusCategory).toBeUndefined();
    } finally { await fixture.close(); }
  });

  it("persists AI MR completion to every linked copy without changing Jira workflow state", async () => {
    const original = finding("ai", "TEST-42");
    const current = run("ai-current", alice, [original]);
    current.result!.ruleResults = [{ ruleId: "security", ruleName: "安全", conclusion: "发现问题", findings: [structuredClone(original)] }];
    const fixture = setup([current], () => null);
    try {
      fixture.service.markFindingAiMerged(alice, "TEST-42");
      const persisted = fixture.store.loadRuns()[0]!.result!;
      for (const copy of [...persisted.findings, ...persisted.ruleResults.flatMap((rule) => rule.findings)]) {
        expect(copy.jira).toMatchObject({ status: "created", aiResolutionStatus: "merged" });
        expect(copy.jira.issueStatusCategory).toBeUndefined();
      }
      expect(fixture.store.loadTrackedFindings()[0]!.finding.jira.aiResolutionStatus).toBe("merged");
    } finally { await fixture.close(); }
  });

  it("uses each maintainer's Jira independently and stops reading after access is revoked", async () => {
    const aliceList = vi.fn(async () => ({ issues: [issue("TEST-1")], page: 1, perPage: 50, total: 1 }));
    const bobList = vi.fn(async () => ({ issues: [issue("TEST-1", "new")], page: 1, perPage: 50, total: 1 }));
    const fixture = setup([run("a", alice, [finding("a", "TEST-1")]), run("b", bob, [finding("b", "TEST-1")])],
      identity => ({ listIssues: identity.maintainerId === "alice" ? aliceList : bobList }) as unknown as JiraClientPort);
    try {
      await fixture.service.syncJiraStatuses(alice);
      expect(fixture.service.getRun("b")?.result?.findings[0]?.jira.issueStatusCategory).toBeUndefined();
      expect(bobList).not.toHaveBeenCalled();
      await fixture.service.syncJiraStatuses(bob);
      expect(fixture.service.getRun("a")?.result?.findings[0]?.jira.issueStatusCategory).toBe("done");
      expect(fixture.service.getRun("b")?.result?.findings[0]?.jira.issueStatusCategory).toBe("new");
      fixture.revoke(); fixture.advance();
      await fixture.service.syncJiraStatuses(alice);
      expect(aliceList).toHaveBeenCalledTimes(1);
      expect(fixture.service.getRun("a")?.result?.findings[0]?.jira).toMatchObject({ issueStatusCategory: "done", syncError: "维护人员已停用" });
    } finally { await fixture.close(); }
  });

  it("batches known keys, retains last good states on missing issues or failures, and retries", async () => {
    const findings = Array.from({ length: 51 }, (_, index) => finding(String(index), `TEST-${index + 1}`));
    findings[0]!.jira.issueStatusCategory = "done";
    let fail = true;
    const listIssues = vi.fn(async (query: Parameters<JiraClientPort["listIssues"]>[0]) => {
      if (fail && query.issueKeys?.includes("TEST-51")) throw new Error("network unavailable");
      const keys = query.issueKeys!.filter(key => !fail || key !== "TEST-1");
      return { issues: keys.map(key => issue(key)), page: 1, perPage: 50, total: keys.length };
    });
    const fixture = setup([run("batch", alice, findings)], () => ({ listIssues }) as unknown as JiraClientPort);
    try {
      await fixture.service.syncJiraStatuses(alice);
      expect(listIssues.mock.calls.map(([query]) => query.issueKeys?.length)).toEqual([50, 1]);
      const result = fixture.service.getRun("batch")!.result!.findings;
      expect(result[0]?.jira).toMatchObject({ issueStatusCategory: "done", syncError: expect.stringContaining("无法读取") });
      expect(result[50]?.jira.syncError).toContain("同步失败");
      expect(result[50]?.jira.issueStatusCategory).toBeUndefined();
      await fixture.service.syncJiraStatuses(alice);
      expect(listIssues).toHaveBeenCalledTimes(2);
      fail = false; fixture.advance();
      await fixture.service.syncJiraStatuses(alice);
      expect(fixture.service.getRun("batch")!.result!.findings.every(entry => entry.jira.issueStatusCategory === "done" && !entry.jira.syncError)).toBe(true);
    } finally { await fixture.close(); }
  });

  it("shares concurrent refreshes and does not overwrite a newer status transition", async () => {
    let finish!: (value: Awaited<ReturnType<JiraClientPort["listIssues"]>>) => void;
    const listIssues = vi.fn(() => new Promise<Awaited<ReturnType<JiraClientPort["listIssues"]>>>(resolve => { finish = resolve; }));
    const fixture = setup([run("race", alice, [finding("one", "TEST-1")])], () => ({ listIssues }) as unknown as JiraClientPort);
    try {
      const first = fixture.service.syncJiraStatuses(alice);
      const second = fixture.service.syncJiraStatuses(alice);
      expect(listIssues).toHaveBeenCalledTimes(1);
      fixture.service.updateJiraIssueStatus(alice, issue("TEST-1"));
      finish({ issues: [issue("TEST-1", "new")], page: 1, perPage: 50, total: 1 });
      await Promise.all([first, second]);
      expect(fixture.service.getRun("race")?.result?.findings[0]?.jira.issueStatusCategory).toBe("done");
    } finally { await fixture.close(); }
  });

  it("refreshes persisted maintainer links in the background without an open page", async () => {
    const listIssues = vi.fn(async () => ({ issues: [issue("TEST-1")], page: 1, perPage: 50, total: 1 }));
    const fixture = setup([run("background", alice, [finding("one", "TEST-1")])], () => ({ listIssues }) as unknown as JiraClientPort, 5);
    try {
      await vi.waitFor(() => expect(fixture.service.getRun("background")?.result?.findings[0]?.jira.issueStatusCategory).toBe("done"));
      expect(listIssues).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); }
  });
});
