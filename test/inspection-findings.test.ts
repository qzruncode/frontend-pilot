import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InspectionService, type InspectionExecutionIdentity } from "../src/inspection-service.js";
import { InspectionStore } from "../src/inspection-store.js";
import { findingFingerprint, sourceFingerprint } from "../src/inspection-findings.js";
import { InspectionRunSchema, type InspectionFinding, type InspectionFindingReportInput, type InspectionRun, type JiraIssue } from "../src/contracts.js";
import type { GitLabClientPort } from "../src/gitlab-client.js";
import type { JiraClientPort } from "../src/jira-client.js";
import type { InspectionDuplicateInput, InspectionDuplicateDecision } from "../src/inspection-duplicates.js";
import { config } from "./app-fixtures.js";

const alice = { maintainerId: "alice", operatorId: "admin" };
const base: InspectionFindingReportInput = { severity: "high", category: "安全", path: "src/demo.ts", line: 2, scope: "line",
  issue: "请求参数未校验，可能注入", suggestion: "校验请求参数" };
const source = ["function execute(input) {", "  return db.query(input);", "}"];
const initialTime = Date.parse("2026-09-05T10:00:00Z");

function jiraIssue(key: string, statusCategory = "new"): JiraIssue {
  return { id: key, key, summary: key, description: null, status: statusCategory === "done" ? "已完成" : "待办", statusId: "1",
    statusCategory, issueType: "缺陷", priority: null, projectKey: "TEST", projectName: "Test", webUrl: `https://jira.invalid/browse/${key}`,
    createdAt: null, updatedAt: null, resolution: null, labels: [], assignee: null, reporter: null };
}

function historicalRun(): InspectionRun {
  const finding: InspectionFinding = { ...base, id: "legacy-finding", fingerprint: findingFingerprint(base), author: null,
    jira: { status: "created", key: "TEST-OLD", url: "https://jira.invalid/TEST-OLD", assignee: null, error: null } };
  return { id: "legacy-run", projectId: "42", projectPath: "group/project", projectName: "Project", branch: "main", source: "manual",
    status: "completed", createdAt: new Date(initialTime - 86_400_000).toISOString(), startedAt: null, finishedAt: null,
    headSha: "sha-1", error: null, progress: [], result: { format: "structured", summary: "发现风险", ruleFindingCount: 1,
      findingCount: 1, headSha: "sha-1", findings: [finding], ruleResults: [{ ruleId: "security", ruleName: "安全", conclusion: "发现风险", findings: [structuredClone(finding)] }] } };
}

function setup({ mode = "auto", history = [], interval = 60_000 }: {
  mode?: "auto" | "manual"; history?: InspectionRun[]; interval?: number;
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "inspection-tracking-"));
  const databasePath = path.join(dir, "pilot.sqlite");
  const state = { findings: [{ ...base }], head: "sha-1", now: initialTime, status: "new", rule: "security", readable: true,
    files: new Map([["sha-1:src/demo.ts", source]]), streaming: false,
    finalFindings: null as InspectionFindingReportInput[] | null, topFindings: null as InspectionFindingReportInput[] | null,
    equivalentIssues: [[base.issue, "缺少输入校验，存在注入风险", "同一风险的另一种描述", "输入未经验证，可能触发注入"]] };
  let store = new InspectionStore(databasePath);
  history.forEach((run) => store.saveRun(run, 0));
  const createIssue = vi.fn(async () => jiraIssue(`TEST-${createIssue.mock.calls.length}`, state.status));
  const getIssue = vi.fn(async (key: string) => {
    if (!state.readable) throw new Error("403");
    return { ...jiraIssue(key, state.status), comments: [], attachments: [] };
  });
  const jira = { createIssue, getIssue, listAssignableUsers: async () => [{ username: "maintenance", name: "维护人", avatarUrl: null }],
    listIssues: async (query: { issueKeys: string[] }) => ({ issues: query.issueKeys.map((key) => jiraIssue(key, state.status)), total: query.issueKeys.length, page: 1, perPage: 50 }),
    getCreateIssueOptions: async () => ({ currentUser: { username: "maintenance", name: "维护人", avatarUrl: null },
      issueTypes: [{ id: "1", name: "缺陷" }], priorities: [{ id: "2", name: "高" }] }),
  } as unknown as JiraClientPort;
  const commitLookup = vi.fn(async () => [{ id: state.head }]);
  const resolveDuplicates = vi.fn(async (input: InspectionDuplicateInput): Promise<InspectionDuplicateDecision> => {
    const duplicateIds = input.candidates.filter(({ finding }) => finding.issue === input.finding.issue
      || state.equivalentIssues.some((group) => group.includes(finding.issue) && group.includes(input.finding.issue))).map(({ id }) => id);
    return { status: duplicateIds.length ? "matched" : "distinct", duplicateIds, reason: "测试中的已确认问题对应关系" };
  });
  const gitlab = { listRepositoryCommits: commitLookup,
    getRepositoryFileBlame: async (_projectId: string, filePath: string, ref: string, line?: number) => {
      const lines = state.files.get(`${ref}:${filePath}`);
      if (!lines) throw new Error("source unavailable");
      return [{ authorName: "维护人", authorEmail: "maintainer@example.com", lines: line ? lines.slice(line - 1, line) : lines }];
    },
  } as unknown as GitLabClientPort;
  const makeService = () => new InspectionService({ gitlab, jira, resolveJiraClient: () => jira,
    runner: { resolveInspectionDuplicates: resolveDuplicates, resolveInspectionOwners: async (input) => input.findings.map((finding) => ({ findingId: finding.id, ownership: {
      status: "resolved", assignee: "maintenance", reason: "当前功能维护记录", checkedAt: new Date(state.now).toISOString(), evidence: [],
    } })), runInspection: async (_input, options) => {
      if (state.streaming) await Promise.all(state.findings.map((finding) => options?.onInspectionFinding?.(state.rule, finding)));
      return JSON.stringify({ summary: "巡检完成", findings: state.topFindings ?? state.finalFindings ?? state.findings,
        ruleResults: [{ ruleId: state.rule, ruleName: state.rule, conclusion: "发现风险", findings: state.finalFindings ?? state.findings }] });
    } },
    store, jiraProjectKey: () => "TEST", now: () => new Date(state.now), schedulerIntervalMs: interval,
    config: { rulesDir: config.inspectionRulesDir, profileConfigPath: config.inspectionProfileConfigPath, maintainerRootDir: path.join(dir, "inspection-maintainers") },
  });
  let service = makeService();
  const configure = (identity: InspectionExecutionIdentity = alice, branch = "main", projectId = "42") => service.upsertProject({
    ...identity, projectId, projectPath: "group/project", projectName: "Project", branch, enabled: true,
    scheduleEnabled: true, scheduleCron: "* * * * *", jiraMode: mode, jiraComponent: "component", jiraFixVersion: "version", inspectionRuleIds: [],
  });
  const waitForRun = async (id: string) => {
    await vi.waitFor(() => expect(service.getRun(id)?.status).toBe("completed"), { interval: 5, timeout: 3_000 });
    return InspectionRunSchema.parse(service.getRun(id));
  };
  return { state, configure, createIssue, getIssue, resolveDuplicates, commitLookup,
    get service() { return service; }, get store() { return store; }, waitForRun,
    scan: async (projectId = "42", identity: InspectionExecutionIdentity = alice) => {
      state.now += 1_000;
      return waitForRun((await service.enqueue(projectId, "manual", identity)).run.id);
    },
    restart: async () => { await service.close(); store.close(); store = new InspectionStore(databasePath); service = makeService(); },
    close: async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function findings(run: InspectionRun): InspectionFinding[] {
  return [...new Map([...run.result!.findings, ...run.result!.ruleResults.flatMap((rule) => rule.findings)].map((finding) => [finding.id, finding])).values()];
}

describe("inspection finding tracking", () => {
  it("reconciles streamed English, Chinese rule output and a reworded top-level summary before creating Jira", async () => {
    const fixture = setup();
    const issues = [
      'In BalanceCard, pct is not clamped while leftPct is; NaN or out-of-range usage is displayed inconsistently.',
      'BalanceCard 只对 leftPct 做范围收敛，pct 未 clamp，超范围或 NaN 输入导致展示不一致。',
      '余额使用百分比直接渲染未收敛的 pct，可能显示 NaN% 或 150% / 0% left。',
    ];
    try {
      await fixture.configure();
      fixture.state.streaming = true;
      fixture.state.equivalentIssues.push(issues);
      fixture.state.findings = [{ ...base, issue: issues[0]! }];
      fixture.state.finalFindings = [{ ...base, issue: issues[1]! }];
      fixture.state.topFindings = [{ ...base, issue: issues[2]! }];
      const run = await fixture.scan();
      expect(run.result!.findingCount).toBe(1);
      expect(findings(run)).toHaveLength(1);
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
      expect(fixture.store.loadTrackedFindings()).toHaveLength(1);
      expect(fixture.resolveDuplicates).toHaveBeenCalledTimes(2);
    } finally { await fixture.close(); }
  });

  it("reuses file-scope findings across punctuation changes, later rounds and restart", async () => {
    const fixture = setup();
    const issues = [
      '生产代码组件实际 795 行，超过 600 行上限，数据源详情组件内联了大量区块，超出上限约 195 行。',
      '生产代码组件实际 795 行，超过 600 行上限。数据源详情组件内联了大量区块，超出上限约 195 行。',
      'DataSourceDetail contains 810 lines and exceeds the 600-line component limit.',
    ];
    try {
      await fixture.configure();
      fixture.state.rule = "security";
      fixture.state.streaming = true;
      fixture.state.equivalentIssues.push(issues);
      fixture.state.findings = [{ ...base, scope: "file", line: null, issue: issues[0]! }];
      fixture.state.finalFindings = [{ ...fixture.state.findings[0]!, issue: issues[1]! }];
      const first = findings(await fixture.scan())[0]!;
      await fixture.restart();
      fixture.state.head = "sha-2";
      fixture.state.findings = [{ ...fixture.state.findings[0]!, issue: issues[2]! }];
      fixture.state.finalFindings = null;
      const second = findings(await fixture.scan())[0]!;
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
      expect(second.tracking).toMatchObject({ id: first.tracking!.id, occurrenceCount: 2 });
      expect(second.jira.key).toBe(first.jira.key);
    } finally { await fixture.close(); }
  });

  it.each([false, true])("prefers the currently open Jira among confirmed historical duplicates (owned: %s)", async (owned) => {
    const original = historicalRun();
    if (owned) Object.assign(original, alice);
    const closed = original.result!.findings[0]!;
    closed.jira.issueStatusCategory = "done";
    const open = { ...structuredClone(closed), id: "legacy-duplicate", issue: "输入未经验证，可能触发注入" };
    open.fingerprint = findingFingerprint(open);
    open.jira = { ...open.jira, key: "TEST-KEEP", issueStatusCategory: "new" };
    if (owned) {
      closed.jira.issueStatusCategory = "new";
      open.jira.issueStatusCategory = "done";
    }
    original.result!.findings = [];
    original.result!.ruleResults[0]!.findings = [closed, open];
    const fixture = setup({ history: [original] });
    fixture.getIssue.mockImplementation(async (key) => ({ ...jiraIssue(key, key === "TEST-KEEP" ? "new" : "done"), comments: [], attachments: [] }));
    try {
      await fixture.configure();
      fixture.state.findings = [{ ...base, issue: "缺少输入校验，存在注入风险" }];
      const current = findings(await fixture.scan())[0]!;
      expect(current.jira.key).toBe(owned ? "TEST-KEEP" : "TEST-1");
      expect(fixture.createIssue).toHaveBeenCalledTimes(owned ? 0 : 1);
      expect(fixture.service.getRun(original.id)!.result!.ruleResults[0]!.findings.map((f) => f.jira.key)).toEqual(["TEST-OLD", "TEST-KEEP"]);
    } finally { await fixture.close(); }
  });

  it("stops new Jira creation when duplicate checking is unavailable", async () => {
    const fixture = setup();
    try {
      await fixture.configure();
      await fixture.scan();
      fixture.state.findings = [{ ...base, issue: "另一种描述" }];
      fixture.resolveDuplicates.mockImplementation(async () => {
        throw new Error("去重服务暂不可用");
      });
      const { run } = await fixture.service.enqueue("42");
      await vi.waitFor(() => expect(fixture.service.getRun(run.id)?.status).toBe("failed"));
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
      expect(fixture.store.loadTrackedFindings()).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  it("isolates an invalid duplicate association and continues valid Jira creation", async () => {
    const fixture = setup();
    try {
      await fixture.configure();
      await fixture.scan();
      fixture.state.findings = [
        { ...base, issue: "异常关联候选" },
        { ...base, issue: "另一个明确的新问题" },
      ];
      fixture.resolveDuplicates.mockImplementation(async (input) => {
        if (input.finding.issue === "异常关联候选") {
          return { status: "matched", duplicateIds: ["invented-id"], reason: "返回了候选范围之外的 ID" };
        }
        return { status: "distinct", duplicateIds: [], reason: "已确认是不同问题" };
      });
      const { run } = await fixture.service.enqueue("42");
      await vi.waitFor(() => expect(fixture.service.getRun(run.id)?.status).toBe("completed"));
      const completed = InspectionRunSchema.parse(fixture.service.getRun(run.id));
      expect(completed.error).toBeNull();
      expect(completed.result?.findingCount).toBe(1);
      expect(findings(completed)[0]?.issue).toBe("另一个明确的新问题");
      expect(fixture.createIssue).toHaveBeenCalledTimes(2);
      expect(fixture.store.loadTrackedFindings()).toHaveLength(2);
      expect(completed.progress.some((event) => event.message === "异常问题候选已隔离，继续处理其他问题"
        && event.meta?.duplicateCheck === "invalid")).toBe(true);
    } finally { await fixture.close(); }
  });

  it("isolates an uncertain duplicate candidate and continues valid Jira creation", async () => {
    const fixture = setup();
    try {
      await fixture.configure();
      await fixture.scan();
      fixture.state.findings = [
        { ...base, issue: "异常候选：本条针对 en/file-assets.ts 不上报" },
        { ...base, issue: "另一个明确的新问题" },
      ];
      fixture.resolveDuplicates.mockImplementation(async (input) => {
        if (input.finding.issue.includes("异常候选")) {
          return { status: "uncertain", duplicateIds: [], reason: "候选描述自相矛盾" };
        }
        return { status: "distinct", duplicateIds: [], reason: "已确认是不同问题" };
      });
      const { run } = await fixture.service.enqueue("42");
      await vi.waitFor(() => expect(fixture.service.getRun(run.id)?.status).toBe("completed"));
      const completed = InspectionRunSchema.parse(fixture.service.getRun(run.id));
      expect(completed.error).toBeNull();
      expect(completed.result?.findingCount).toBe(1);
      expect(findings(completed)[0]?.issue).toBe("另一个明确的新问题");
      expect(fixture.createIssue).toHaveBeenCalledTimes(2);
      expect(fixture.store.loadTrackedFindings()).toHaveLength(2);
      expect(completed.progress.some((event) => event.message === "异常问题候选已隔离，继续处理其他问题")).toBe(true);
    } finally { await fixture.close(); }
  });

  it("deduplicates concurrent manual and scheduled enqueue requests after fetching the commit", async () => {
    const fixture = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    fixture.commitLookup.mockImplementation(async () => { await pending; return [{ id: "sha-1" }]; });
    try {
      await fixture.configure();
      const requests = [fixture.service.enqueue("42"), fixture.service.enqueue("42", "schedule")];
      await vi.waitFor(() => expect(fixture.commitLookup).toHaveBeenCalledTimes(2));
      release();
      const results = await Promise.all(requests);
      expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
      expect(results.map((result) => result.deduplicated).sort()).toEqual([false, true]);
      await fixture.waitForRun(results[0]!.run.id);
      expect(fixture.service.listRuns()).toHaveLength(1);
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
    } finally { release(); await fixture.close(); }
  });

  it("discards a late duplicate decision after the inspection is canceled", async () => {
    const fixture = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    try {
      await fixture.configure();
      await fixture.scan();
      fixture.state.findings = [{ ...base, issue: "等待去重的新描述" }];
      fixture.resolveDuplicates.mockImplementation(async () => {
        await pending;
        return { status: "distinct", duplicateIds: [], reason: "不同问题" };
      });
      const { run } = await fixture.service.enqueue("42");
      await vi.waitFor(() => expect(fixture.resolveDuplicates).toHaveBeenCalledTimes(1));
      await fixture.service.cancel(run.id);
      release();
      await fixture.service.close();
      expect(fixture.service.getRun(run.id)?.status).toBe("canceled");
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
      expect(fixture.store.loadTrackedFindings()).toHaveLength(1);
    } finally { release(); await fixture.close(); }
  });

  it("reuses one Jira across real scheduled rounds, line movement and rewritten descriptions", async () => {
    const fixture = setup({ interval: 5 });
    try {
      await fixture.configure();
      const captured: InspectionFinding[] = [];
      for (let round = 0; round < 3; round += 1) {
        if (round > 0) {
          fixture.state.head = "sha-2";
          fixture.state.files.set("sha-2:src/demo.ts", ["// new header", ...source]);
          fixture.state.findings = [{ ...base, line: 3, issue: round === 2 ? "缺少输入校验，存在注入风险" : base.issue }];
        }
        fixture.state.now = Date.parse(fixture.service.getProject("42")!.nextRunAt!);
        await vi.waitFor(() => expect(fixture.service.listRuns().length).toBe(round + 1), { interval: 5 });
        const run = await fixture.waitForRun(fixture.service.listRuns()[0]!.id);
        expect(run.source).toBe("schedule");
        captured.push(findings(run)[0]!);
      }
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
      expect(new Set(captured.map((finding) => finding.tracking?.id)).size).toBe(1);
      expect(captured.map((finding) => finding.tracking?.occurrenceCount)).toEqual([1, 2, 3]);
      expect(captured.map((finding) => finding.jira.key)).toEqual(["TEST-1", "TEST-1", "TEST-1"]);
      expect(captured[2]!.tracking!.firstSeenAt).toBe(captured[0]!.tracking!.firstSeenAt);
      expect(captured[2]!.tracking!.lastSeenAt).not.toBe(captured[0]!.tracking!.lastSeenAt);
    } finally { await fixture.close(); }
  });

  it("inherits manual Jira links and completion through deletion, restart, retry and reopening", async () => {
    const fixture = setup({ mode: "manual" });
    try {
      await fixture.configure();
      const first = await fixture.scan();
      await fixture.service.createJira(first.id, findings(first)[0]!.id);
      fixture.state.status = "done";
      await fixture.service.syncJiraStatuses(alice);
      const second = await fixture.scan();
      expect(findings(second)[0]!.jira).toMatchObject({ key: "TEST-1", issueStatusCategory: "done" });
      for (const run of fixture.service.listRuns()) await fixture.service.delete(run.id);
      await fixture.restart();
      const third = await fixture.scan();
      expect(findings(third)[0]).toMatchObject({ tracking: { occurrenceCount: 3 }, jira: { key: "TEST-1", issueStatusCategory: "done" } });
      fixture.state.now += 1_000;
      fixture.state.head = "sha-2";
      fixture.state.files.set("sha-2:src/demo.ts", ["// added", ...source]);
      fixture.state.findings = [{ ...base, line: 3, issue: "同一风险的另一种描述" }];
      await fixture.service.retry(third.id);
      const retried = await fixture.waitForRun(third.id);
      expect(findings(retried)[0]).toMatchObject({ tracking: { occurrenceCount: 3 }, jira: { key: "TEST-1", issueStatusCategory: "done" } });
      fixture.service.updateJiraIssueStatus(alice, jiraIssue("TEST-1", "new"));
      const fourth = await fixture.scan();
      expect(findings(fourth)[0]!.jira.issueStatusCategory).toBe("new");
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); }
  });

  it("serializes concurrent manual creates across historical copies and updates every copy", async () => {
    const fixture = setup({ mode: "manual" });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    fixture.createIssue.mockImplementation(async () => { await pending; return jiraIssue("TEST-ONE"); });
    try {
      await fixture.configure();
      fixture.state.streaming = true;
      const first = await fixture.scan();
      const second = await fixture.scan();
      const requests = [first, second, second].map((run) => fixture.service.createJira(run.id, findings(run)[0]!.id));
      await vi.waitFor(() => expect(fixture.createIssue).toHaveBeenCalledTimes(1));
      release();
      await Promise.all(requests);
      for (const run of fixture.store.loadRuns()) {
        expect(findings(run)).toHaveLength(1);
        expect(findings(run)[0]!.jira.key).toBe("TEST-ONE");
        expect(run.result!.ruleResults.find((rule) => rule.ruleId === "security")!.findings[0]!.jira.key).toBe("TEST-ONE");
      }
    } finally { release(); await fixture.close(); }
  });

  it("continues syncing the retained Jira link after every historical run is deleted", async () => {
    const fixture = setup();
    try {
      await fixture.configure();
      const original = await fixture.scan();
      await fixture.service.delete(original.id);
      await fixture.restart();
      fixture.state.status = "done";
      await fixture.service.syncJiraStatuses(alice);
      expect(fixture.store.loadTrackedFindings()[0]!.finding.jira.issueStatusCategory).toBe("done");
      const repeated = findings(await fixture.scan())[0]!;
      expect(repeated.jira).toMatchObject({ key: "TEST-1", issueStatusCategory: "done" });
      expect(repeated.tracking!.occurrenceCount).toBe(2);
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); }
  });

  it("keeps projects, branches, maintainers, rules and distinct code locations separate", async () => {
    const fixture = setup();
    try {
      await fixture.configure();
      const first = await fixture.scan();
      await fixture.configure({ maintainerId: "bob", operatorId: "admin" });
      const bob = await fixture.scan("42", { maintainerId: "bob", operatorId: "admin" });
      await fixture.configure(alice, "release");
      const release = await fixture.scan("42", alice);
      await fixture.configure(alice, "main", "43");
      const anotherProject = await fixture.scan("43", alice);
      await fixture.configure();
      fixture.state.rule = "performance";
      const anotherRule = await fixture.scan();
      fixture.state.rule = "security";
      fixture.state.head = "sha-2";
      fixture.state.files.set("sha-2:src/demo.ts", [...source, ...source]);
      fixture.state.findings = [base, { ...base, line: 5 }];
      const locations = findings(await fixture.scan());
      expect(locations).toHaveLength(2);
      expect(locations.map((finding) => finding.jira.key)).toEqual(["TEST-1", "TEST-6"]);
      expect(new Set([first, bob, release, anotherProject, anotherRule].map((run) => findings(run)[0]!.tracking!.id)).size).toBe(5);
      expect(fixture.createIssue).toHaveBeenCalledTimes(6);
    } finally { await fixture.close(); }
  });

  it("retains distinct findings sharing a code anchor and does not merge changed code", async () => {
    const fixture = setup();
    try {
      await fixture.configure();
      fixture.state.findings = [base, { ...base, issue: "缺少租户隔离，可能读取其他租户数据" }];
      expect(findings(await fixture.scan())).toHaveLength(2);
      expect(findings(await fixture.scan())).toHaveLength(2);
      expect(fixture.createIssue).toHaveBeenCalledTimes(2);
      fixture.state.head = "sha-2";
      fixture.state.files.set("sha-2:src/demo.ts", [source[0]!, "  return process.exec(input);", source[2]!]);
      fixture.state.findings = [base];
      expect(findings(await fixture.scan())[0]!.tracking!.occurrenceCount).toBe(1);
      expect(fixture.createIssue).toHaveBeenCalledTimes(3);
    } finally { await fixture.close(); }
  });

  it.each([true, false])("backfills legacy history and checks the current Jira permission before inheritance (%s)", async (readable) => {
    const fixture = setup({ history: [historicalRun()] });
    try {
      await fixture.configure();
      fixture.state.readable = readable;
      fixture.state.status = "done";
      fixture.state.head = "sha-2";
      fixture.state.files.set("sha-2:src/demo.ts", ["// moved", ...source]);
      fixture.state.findings = [{ ...base, line: 3, issue: "输入未经验证，可能触发注入" }];
      const current = findings(await fixture.scan())[0]!;
      expect(fixture.getIssue).not.toHaveBeenCalled();
      expect(current.jira.key).toBe("TEST-1");
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
      expect(current.tracking!.occurrenceCount).toBe(1);
      expect(fixture.service.getRun("legacy-run")!.result!.findingCount).toBe(1);
      if (readable) expect(current.jira.issueStatusCategory).toBe("done");
      await fixture.restart();
      expect(findings(await fixture.scan())[0]!.jira.key).toBe(current.jira.key);
    } finally { await fixture.close(); }
  });

  it("keeps exact-match fallback when evidence is unavailable and excludes blank/comment anchors", async () => {
    const fixture = setup();
    try {
      await fixture.configure();
      fixture.state.files.clear();
      await fixture.scan();
      expect(findings(await fixture.scan())[0]!.tracking!.occurrenceCount).toBe(2);
      expect(fixture.createIssue).toHaveBeenCalledTimes(1);
      expect(sourceFingerprint(["", "}", "// comment"], 1)).toBeNull();
      expect(sourceFingerprint(["", "}", "// comment"], 2)).toBeNull();
      expect(sourceFingerprint(["", "}", "// comment"], 3)).toBeNull();
      expect(sourceFingerprint(source, 2)).toBe(sourceFingerprint(["", ...source], 3));
    } finally { await fixture.close(); }
  });
});
