import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Cron } from "croner";
import type { GitLabClientPort } from "../src/gitlab-client.js";
import type { JiraClientPort } from "../src/jira-client.js";
import { InspectionRulesStore } from "../src/inspection-rules.js";
import { InspectionService, resolveInspectionJiraPriority } from "../src/inspection-service.js";
import { InspectionStore } from "../src/inspection-store.js";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for inspection state");
}

describe("InspectionService", () => {
  it("maps inspection severity only to explicit Jira priority names", () => {
    const priorities = [
      { id: "10000", name: "Top" },
      { id: "10001", name: "重要" },
      { id: "10002", name: "次要" },
      { id: "10003", name: "重要" },
      { id: "10004", name: "轻微" },
    ];

    expect(resolveInspectionJiraPriority("critical", priorities)).toBe("10000");
    expect(resolveInspectionJiraPriority("high", priorities)).toBe("10001");
    expect(resolveInspectionJiraPriority("medium", priorities)).toBe("10002");
    expect(resolveInspectionJiraPriority("low", priorities)).toBe("10004");
    expect(resolveInspectionJiraPriority("high", [{ id: "docx", name: "重要" }])).toBeUndefined();
    expect(resolveInspectionJiraPriority("medium", [{ id: "1", name: "Top" }, { id: "2", name: "docx" }])).toBeUndefined();
    expect(resolveInspectionJiraPriority("unknown", priorities)).toBeUndefined();
  });

  it("uses Cron expressions for the next scheduled run and scheduled triggers", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-cron-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    const scheduleCron = "30 10 * * *";
    let nowMs = Date.parse("2026-09-04T10:15:00Z");
    let service: InspectionService | undefined;
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({ default: { displayName: "默认 profile", rules: [{ id: "security", name: "安全", description: "安全风险", enabled: true, order: 0, file: "inspection/security.md" }] } }));
      writeFileSync(path.join(rulesDir, "inspection", "security.md"), "检查安全风险");
      const store = new InspectionStore(":memory:");
      service = new InspectionService({
        gitlab: { listRepositoryCommits: async () => [{ id: "sha-1" }] } as GitLabClientPort,
        runner: { runInspection: async () => JSON.stringify({ summary: "已完成", findings: [] }) },
        store,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        now: () => new Date(nowMs),
        schedulerIntervalMs: 5,
      });
      const input = {
        projectId: "1",
        projectPath: "group/project",
        projectName: "项目",
        branch: "main",
        enabled: true,
        scheduleEnabled: true,
        scheduleCron,
        jiraMode: "manual" as const,
        jiraComponent: null,
        jiraFixVersion: null,
        jiraIssueType: "缺陷",
        inspectionRuleIds: ["security"],
      };
      const project = await service.upsertProject(input);
      expect(project.scheduleCron).toBe(scheduleCron);
      expect(project.nextRunAt).toBe(new Cron(scheduleCron).nextRun(new Date(nowMs))?.toISOString());
      await expect(service.upsertProject({ ...input, scheduleCron: "not a cron" })).rejects.toThrow("Cron 表达式无效");

      nowMs = Date.parse(project.nextRunAt!);
      await waitFor(() => service?.listRuns().some((run) => run.source === "schedule") === true);
      await service.close();
      store.close();
    } finally {
      await service?.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the matching inspection profile instead of persisted inspection rule selections", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-service-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    const projectPath = "group/project";
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(path.join(rulesDir, "inspection", "project.md"), "只检查项目提示词");
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [{ id: "default-prompt", name: "默认提示词", description: "默认说明", enabled: true, order: 0, file: "inspection/project.md" }],
        },
        [projectPath]: {
          displayName: "项目 profile",
          rules: [{ id: "project-prompt", name: "项目提示词", description: "项目说明", enabled: true, order: 0, file: "inspection/project.md" }],
        },
      }));

      const store = new InspectionStore(":memory:");
      const service = new InspectionService({
        gitlab: {} as GitLabClientPort,
        runner: { runInspection: async () => "{}" },
        store,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        schedulerIntervalMs: 60_000,
      });

      const project = await service.upsertProject({
        projectId: "1",
        projectPath,
        projectName: "项目",
        branch: "main",
        enabled: true,
        scheduleEnabled: false,
        scheduleCron: "0 0 * * *",
        jiraMode: "manual",
        jiraComponent: null,
        jiraFixVersion: null,
        jiraIssueType: "缺陷",
        inspectionRuleIds: ["legacy-selection-that-must-be-ignored"],
      });

      expect(project.ruleSetName).toBe(projectPath);
      expect(project.ruleCount).toBe(1);
      expect(project.inspectionRuleIds).toEqual(["project-prompt"]);

      await service.close();
      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated rule and top-level findings in the inspection summary", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-service-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    const finding = { severity: "high", category: "文件规模", path: "src/app.ts", line: 1, issue: "文件过大", suggestion: "拆分文件" };
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [{ id: "file-line-limit", name: "文件大小", description: "文件规模", enabled: true, order: 0, file: "inspection/file-line-limit.md" }],
        },
      }));
      writeFileSync(path.join(rulesDir, "inspection", "file-line-limit.md"), "检查文件大小");

      const store = new InspectionStore(":memory:");
      const service = new InspectionService({
        gitlab: { listRepositoryCommits: async () => [{ id: "sha-1" }] } as GitLabClientPort,
        runner: {
          runInspection: async () => JSON.stringify({
            summary: "重复问题",
            ruleResults: [{ ruleId: "file-line-limit", ruleName: "文件大小", conclusion: "发现问题", findings: [finding] }],
            findings: [finding],
          }),
        },
        store,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        schedulerIntervalMs: 60_000,
      });

      await service.upsertProject({
        projectId: "1",
        projectPath: "group/project",
        projectName: "项目",
        branch: "main",
        enabled: true,
        scheduleEnabled: false,
        scheduleCron: "0 0 * * *",
        jiraMode: "manual",
        jiraComponent: null,
        jiraFixVersion: null,
        jiraIssueType: "缺陷",
        inspectionRuleIds: ["file-line-limit"],
      });

      const accepted = await service.enqueue("1");
      await waitFor(() => service.getRun(accepted.run.id)?.status === "completed");
      expect(service.getRun(accepted.run.id)?.result).toMatchObject({ findingCount: 1, ruleFindingCount: 1, blockingFindingCount: 1 });

      await service.close();
      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stops after the configured finding limit and keeps the discovered findings", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-limit-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    const firstFinding = { severity: "high", category: "安全", path: "src/first.ts", line: 1, issue: "第一个问题", suggestion: "修复第一个问题" };
    const secondFinding = { severity: "medium", category: "正确性", path: "src/second.ts", line: 2, issue: "第二个问题", suggestion: "修复第二个问题" };
    let aborted = false;
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [{ id: "security", name: "安全", description: "安全风险", enabled: true, order: 0, file: "inspection/security.md" }],
        },
      }));
      writeFileSync(path.join(rulesDir, "inspection", "security.md"), "检查安全风险");

      const store = new InspectionStore(":memory:");
      const service = new InspectionService({
        gitlab: { listRepositoryCommits: async () => [{ id: "sha-1" }] } as GitLabClientPort,
        runner: {
          runInspection: async (_input, options) => {
            options?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
            await options?.onInspectionFinding?.("security", firstFinding);
            await options?.onInspectionFinding?.("security", secondFinding);
            return JSON.stringify({ summary: "发现两个问题", findings: [firstFinding, secondFinding] });
          },
        },
        store,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        schedulerIntervalMs: 60_000,
      });

      const project = await service.upsertProject({
        projectId: "1",
        projectPath: "group/project",
        projectName: "项目",
        branch: "main",
        findingLimit: 2,
        enabled: true,
        scheduleEnabled: false,
        scheduleCron: "0 0 * * *",
        jiraMode: "off",
        jiraComponent: null,
        jiraFixVersion: null,
        jiraIssueType: "缺陷",
        inspectionRuleIds: ["security"],
      });
      expect(project.findingLimit).toBe(2);

      const accepted = await service.enqueue("1", "manual", undefined, { findingLimit: 1 });
      await waitFor(() => service.getRun(accepted.run.id)?.status === "completed");
      const run = service.getRun(accepted.run.id);
      expect(run?.result).toMatchObject({ findingCount: 1, ruleFindingCount: 1 });
      expect(run?.result?.ruleResults.flatMap((rule) => rule.findings)).toHaveLength(1);
      expect(run?.result?.summary).toContain("达到上限 1 个");
      expect(run?.progress.some((event) => event.message.includes("自动终止巡检"))).toBe(true);
      expect(aborted).toBe(true);
      expect(service.getProject("1")?.findingLimit).toBe(2);

      await service.close();
      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("maps inspection severity to the Jira priority when creating an issue", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-service-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    const createdInputs: unknown[] = [];
    const assigneeQueries: string[] = [];
    const jiraOptionRequests: Array<string | undefined> = [];
    const finding = { severity: "high", category: "安全", path: "src/auth.ts", line: 20, issue: "缺少输入校验", suggestion: "补充参数校验" } as const;
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [{ id: "security", name: "安全", description: "安全风险", enabled: true, order: 0, file: "inspection/security.md" }],
        },
      }));
      writeFileSync(path.join(rulesDir, "inspection", "security.md"), "检查安全风险");

      const jira = {
        async getCreateIssueOptions(_projectKey: string, issueTypeId?: string) {
          jiraOptionRequests.push(issueTypeId);
          return {
            issueTypes: [{ id: "10001", name: "缺陷" }],
            priorities: issueTypeId ? [{ id: "2", name: "高" }] : [{ id: "docx", name: "高" }],
            priorityRequired: true,
            assignees: [],
            reporters: [],
            currentUser: { username: "jira-user", name: "Jira User", avatarUrl: null },
            components: [],
            fixVersions: [],
            customers: [],
            epics: [],
            sprints: [],
            linkableIssues: [],
            customFieldIds: { customerName: null, epicLink: null, sprint: null },
            labels: [],
          };
        },
        async listAssignableUsers(_projectKey: string, query?: string) {
          assigneeQueries.push(query ?? "");
          return ["alex.developer", "alexdeveloper"].includes(query?.trim().toLowerCase() ?? "")
            ? [{ username: "AlexDeveloper", name: "示例开发者", email: "alex.developer@example.com", avatarUrl: null }]
            : [];
        },
        async createIssue(_projectKey: string, input: unknown) {
          createdInputs.push(input);
          return {
            id: "1",
            key: "JIRA-1",
            summary: "巡检问题",
            description: null,
            status: "待办",
            statusId: "1",
            statusCategory: "new",
            issueType: "缺陷",
            priority: "高",
            projectKey: "JIRA",
            projectName: "Jira",
            webUrl: "https://jira.example/JIRA-1",
            createdAt: null,
            updatedAt: null,
            resolution: null,
            labels: [],
            assignee: { username: "AlexDeveloper", name: "示例开发者", avatarUrl: null },
            reporter: null,
          };
        },
      } as JiraClientPort;
      const store = new InspectionStore(":memory:");
      const service = new InspectionService({
        gitlab: {
          listRepositoryCommits: async () => [{ id: "sha-1" }],
          getRepositoryFileBlame: async () => [{ authorName: "alex.developer", authorEmail: "alex.developer@example.com", lines: ["const finding = true;"] }],
        } as GitLabClientPort,
        runner: {
          runInspection: async () => JSON.stringify({
            summary: "发现问题",
            ruleResults: [{ ruleId: "security", ruleName: "安全", conclusion: "发现问题", findings: [finding] }],
            findings: [],
          }),
        },
        store,
        jira,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        schedulerIntervalMs: 60_000,
      });

      await service.upsertProject({
        projectId: "1",
        projectPath: "group/project",
        projectName: "项目",
        branch: "main",
        enabled: true,
        scheduleEnabled: false,
        scheduleCron: "0 0 * * *",
        jiraMode: "manual",
        jiraComponent: "前端",
        jiraFixVersion: "待规划",
        jiraIssueType: "任务",
        inspectionRuleIds: ["security"],
      });

      const accepted = await service.enqueue("1");
      await waitFor(() => service.getRun(accepted.run.id)?.status === "completed");
      const completed = service.getRun(accepted.run.id);
      const findingId = completed?.result?.ruleResults[0]?.findings[0]?.id;
      expect(findingId).toBeTruthy();

      await service.createJira(accepted.run.id, findingId!, "AlexDeveloper");

      expect(createdInputs).toHaveLength(1);
      expect(jiraOptionRequests).toEqual([undefined, "10001"]);
      expect(createdInputs[0]).toMatchObject({
        summary: "[巡检][high] 缺少输入校验",
        issueType: "10001",
        priority: "2",
        assignee: "AlexDeveloper",
        labels: [expect.stringMatching(/^release-\d{8}$/)],
        dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      });
      expect((createdInputs[0] as { description?: string }).description).toContain("问题：缺少输入校验");
      expect(assigneeQueries).toContain("alex.developer");
      expect(service.getRun(accepted.run.id)?.result?.ruleResults[0]?.findings[0]).toMatchObject({
        author: { name: "alex.developer", assignee: "AlexDeveloper" },
        jira: { status: "created", assignee: "AlexDeveloper" },
      });
      expect(service.findJiraSource("jira-1", { maintainerId: null, maintainerName: null, operatorId: null, operatorName: null })).toEqual({ runId: accepted.run.id, findingId: findingId! });
      expect(service.findJiraSource("OTHER-1", { maintainerId: null, maintainerName: null, operatorId: null, operatorName: null })).toBeNull();
      await service.close();
      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps unowned findings pending instead of assigning the current Jira user", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-service-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    const createdInputs: unknown[] = [];
    const finding = { severity: "high", category: "安全 / 存储型 XSS", path: "src/app.ts", line: 20, issue: "存在安全风险", suggestion: "补充安全处理" } as const;
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [{ id: "security", name: "安全", description: "安全风险", enabled: true, order: 0, file: "inspection/security.md" }],
        },
      }));
      writeFileSync(path.join(rulesDir, "inspection", "security.md"), "检查安全风险");

      const jira = {
        async getCreateIssueOptions() {
          return {
            issueTypes: [{ id: "10001", name: "缺陷" }],
            priorities: [{ id: "2", name: "高" }],
            priorityRequired: true,
            assignees: [],
            reporters: [],
            currentUser: { username: "operator.01", name: "当前操作人", avatarUrl: null },
            components: [],
            fixVersions: [],
            customers: [],
            epics: [],
            sprints: [],
            linkableIssues: [],
            customFieldIds: { customerName: null, epicLink: null, sprint: null },
            labels: [],
          };
        },
        async createIssue(_projectKey: string, input: unknown) {
          createdInputs.push(input);
          return {
            id: "1",
            key: "JIRA-1",
            summary: "巡检问题",
            description: null,
            status: "待办",
            statusId: "1",
            statusCategory: "new",
            issueType: "缺陷",
            priority: "高",
            projectKey: "JIRA",
            projectName: "Jira",
            webUrl: "https://jira.example/JIRA-1",
            createdAt: null,
            updatedAt: null,
            resolution: null,
            labels: [],
            assignee: null,
            reporter: null,
          };
        },
      } as JiraClientPort;
      const store = new InspectionStore(":memory:");
      const service = new InspectionService({
        gitlab: {
          getRepositoryFileBlame: async () => [],
          listRepositoryCommits: async (_projectId: string, query: { path?: string }) => query.path ? [] : [{ id: "sha-1" }],
        } as GitLabClientPort,
        runner: {
          runInspection: async () => JSON.stringify({
            summary: "发现问题",
            ruleResults: [{ ruleId: "security", ruleName: "安全", conclusion: "发现问题", findings: [finding] }],
            findings: [],
          }),
        },
        store,
        jira,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        schedulerIntervalMs: 60_000,
      });

      await service.upsertProject({
        projectId: "1",
        projectPath: "group/project",
        projectName: "项目",
        branch: "main",
        enabled: true,
        scheduleEnabled: false,
        scheduleCron: "0 0 * * *",
        jiraMode: "manual",
        jiraComponent: "前端",
        jiraFixVersion: "待规划",
        jiraIssueType: "任务",
        inspectionRuleIds: ["security"],
      });

      const accepted = await service.enqueue("1");
      await waitFor(() => service.getRun(accepted.run.id)?.status === "completed");
      const completed = service.getRun(accepted.run.id);
      const findingId = completed?.result?.ruleResults[0]?.findings[0]?.id;
      expect(findingId).toBeTruthy();
      expect(completed?.result?.ruleResults[0]?.findings[0]?.author).toBeNull();

      await service.createJira(accepted.run.id, findingId!);

      expect(createdInputs).toHaveLength(0);
      expect(service.getRun(accepted.run.id)?.result?.ruleResults[0]?.findings[0]).toMatchObject({
        author: null,
        jira: { status: "skipped", assignee: null, error: expect.stringContaining("负责人") },
      });
      await service.close();
      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("retries a terminal run in place without creating another history record", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-service-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    let executionCount = 0;
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [{ id: "file-line-limit", name: "文件大小", description: "文件规模", enabled: true, order: 0, file: "inspection/file-line-limit.md" }],
        },
      }));
      writeFileSync(path.join(rulesDir, "inspection", "file-line-limit.md"), "检查文件大小");

      const store = new InspectionStore(":memory:");
      const service = new InspectionService({
        gitlab: { listRepositoryCommits: async () => [{ id: `sha-${executionCount + 1}` }] } as GitLabClientPort,
        runner: {
          runInspection: async () => {
            executionCount += 1;
            return JSON.stringify({ summary: `第${executionCount}次巡检`, findings: [] });
          },
        },
        store,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        schedulerIntervalMs: 60_000,
      });

      await service.upsertProject({
        projectId: "1",
        projectPath: "group/project",
        projectName: "项目",
        branch: "main",
        enabled: true,
        scheduleEnabled: false,
        scheduleCron: "0 0 * * *",
        jiraMode: "manual",
        jiraComponent: null,
        jiraFixVersion: null,
        jiraIssueType: "缺陷",
        inspectionRuleIds: ["file-line-limit"],
      });

      const accepted = await service.enqueue("1");
      await waitFor(() => service.getRun(accepted.run.id)?.status === "completed");
      const retried = await service.retry(accepted.run.id);

      expect(retried.id).toBe(accepted.run.id);
      expect(service.listRuns()).toHaveLength(1);
      await waitFor(() => service.getRun(accepted.run.id)?.status === "completed" && executionCount === 2);
      expect(service.listRuns()).toHaveLength(1);
      expect(service.getRun(accepted.run.id)).toMatchObject({
        headSha: "sha-2",
        result: { summary: "第2次巡检" },
      });
      expect(service.getProgressEvents(accepted.run.id)?.some((event) => event.message === "巡检记录已重新进入队列")).toBe(true);

      await service.close();
      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("cancels queued and running runs without starting the queued run", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-service-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    let resolveFirstStarted: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    let abortObserved = false;
    const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
    const runnerCalls: string[] = [];
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [{ id: "file-line-limit", name: "文件大小", description: "文件规模", enabled: true, order: 0, file: "inspection/file-line-limit.md" }],
        },
      }));
      writeFileSync(path.join(rulesDir, "inspection", "file-line-limit.md"), "检查文件大小");

      const store = new InspectionStore(":memory:");
      const service = new InspectionService({
        gitlab: { listRepositoryCommits: async () => [{ id: "sha-1" }] } as GitLabClientPort,
        runner: {
          runInspection: async (input, options) => {
            runnerCalls.push(input.projectPath);
            if (input.projectPath === "group/first") {
              resolveFirstStarted?.();
              await new Promise<void>((resolve) => {
                releaseFirst = resolve;
                if (options?.signal?.aborted) {
                  abortObserved = true;
                  resolve();
                  return;
                }
                options?.signal?.addEventListener("abort", () => {
                  abortObserved = true;
                  resolve();
                }, { once: true });
              });
            }
            return JSON.stringify({ summary: "已完成", findings: [] });
          },
        },
        store,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        schedulerIntervalMs: 60_000,
      });
      const projectInput = (projectId: string, projectPath: string) => ({
        projectId,
        projectPath,
        projectName: projectPath,
        branch: "main",
        enabled: true,
        scheduleEnabled: false,
        scheduleCron: "0 0 * * *",
        jiraMode: "manual" as const,
        jiraComponent: null,
        jiraFixVersion: null,
        jiraIssueType: "缺陷",
        inspectionRuleIds: ["file-line-limit"],
      });
      await service.upsertProject(projectInput("1", "group/first"));
      await service.upsertProject(projectInput("2", "group/second"));

      const first = await service.enqueue("1");
      await firstStarted;
      const queued = await service.enqueue("2");
      expect(queued.run.status).toBe("queued");

      const canceledQueued = await service.cancel(queued.run.id);
      expect(canceledQueued).toMatchObject({ id: queued.run.id, status: "canceled" });
      expect(runnerCalls).toEqual(["group/first"]);

      const canceledRunning = await service.cancel(first.run.id);
      expect(canceledRunning).toMatchObject({ id: first.run.id, status: "canceled" });
      releaseFirst?.();
      await waitFor(() => service.getRun(first.run.id)?.progress.some((event) => event.message === "巡检资源已清理") === true);
      expect(abortObserved).toBe(true);
      expect(service.getRun(first.run.id)?.status).toBe("canceled");
      expect(service.getRun(queued.run.id)?.status).toBe("canceled");
      expect(runnerCalls).toEqual(["group/first"]);

      await service.close();
      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists each reported finding before the inspection runner finishes", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-service-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    const findingOne = { severity: "high", category: "文件规模", path: "src/app.ts", line: 1, issue: "文件过大", suggestion: "拆分文件" } as const;
    const findingTwo = { severity: "medium", category: "安全", path: "src/auth.ts", line: 20, issue: "缺少输入校验", suggestion: "补充参数校验" } as const;
    let release: (() => void) | undefined;
    let reportResolved: (() => void) | undefined;
    const runnerStarted = new Promise<void>((resolve) => { reportResolved = resolve; });
    const runnerRelease = new Promise<void>((resolve) => { release = resolve; });
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [
            { id: "file-line-limit", name: "文件大小", description: "文件规模", enabled: true, order: 0, file: "inspection/file-line-limit.md" },
            { id: "security", name: "安全", description: "安全风险", enabled: true, order: 1, file: "inspection/security.md" },
          ],
        },
      }));
      writeFileSync(path.join(rulesDir, "inspection", "file-line-limit.md"), "检查文件大小");
      writeFileSync(path.join(rulesDir, "inspection", "security.md"), "检查安全风险");

      const store = new InspectionStore(":memory:");
      const service = new InspectionService({
        gitlab: { listRepositoryCommits: async () => [{ id: "sha-1" }] } as GitLabClientPort,
        runner: {
          runInspection: async (_input, options) => {
            await options?.onInspectionFinding?.("file-line-limit", findingOne);
            await options?.onInspectionFinding?.("security", findingTwo);
            await options?.onInspectionFinding?.("security", findingTwo);
            reportResolved?.();
            await runnerRelease;
            return JSON.stringify({
              summary: "已完成",
              ruleResults: [
                { ruleId: "file-line-limit", ruleName: "文件大小", conclusion: "发现问题", findings: [findingOne] },
                { ruleId: "security", ruleName: "安全", conclusion: "发现问题", findings: [findingTwo] },
              ],
              findings: [],
            });
          },
        },
        store,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        schedulerIntervalMs: 60_000,
      });

      await service.upsertProject({
        projectId: "1",
        projectPath: "group/project",
        projectName: "项目",
        branch: "main",
        enabled: true,
        scheduleEnabled: false,
        scheduleCron: "0 0 * * *",
        jiraMode: "manual",
        jiraComponent: null,
        jiraFixVersion: null,
        jiraIssueType: "缺陷",
        inspectionRuleIds: ["file-line-limit", "security"],
      });

      const accepted = await service.enqueue("1");
      await runnerStarted;
      const partial = service.getRun(accepted.run.id);
      expect(partial?.status).toBe("running");
      expect(partial?.result).toMatchObject({ findingCount: 2, ruleFindingCount: 2 });
      expect(partial?.progress.filter((event) => event.kind === "finding")).toHaveLength(3);
      expect(store.loadRuns()[0]?.result).toMatchObject({ findingCount: 2 });

      release?.();
      await waitFor(() => service.getRun(accepted.run.id)?.status === "completed");
      expect(service.getRun(accepted.run.id)?.result).toMatchObject({ findingCount: 2, blockingFindingCount: 1 });
      expect(service.getRun(accepted.run.id)?.result?.ruleResults.map((rule) => [rule.ruleId, rule.findings.length])).toEqual([
        ["file-line-limit", 1],
        ["security", 1],
      ]);

      await service.close();
      store.close();
    } finally {
      release?.();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses line blame only as an author reference without file-commit fallback", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-service-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    const makeCommit = (id: string, authorName: string, authorEmail: string) => ({
      id,
      shortId: id,
      title: "触及问题文件",
      message: "触及问题文件",
      authorName,
      authorEmail,
      authoredAt: null,
      committedAt: null,
      webUrl: null,
    });
    const findings = [
      { severity: "high", category: "安全", path: "src/line.ts", line: 12, issue: "行级问题", suggestion: "修复" },
      { severity: "medium", category: "性能", path: "src/fallback.ts", line: 7, issue: "blame 不可用时的问题", suggestion: "修复" },
      { severity: "low", category: "代码抽象", path: "src/file.ts", line: null, issue: "文件级问题", suggestion: "修复" },
    ] as const;
    const commitQueries: Array<{ path?: string; ref?: string }> = [];
    const blameQueries: Array<{ path: string; line?: number }> = [];
    const jiraAssigneeQueries: string[] = [];
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [{ id: "security", name: "安全", description: "安全风险", enabled: true, order: 0, file: "inspection/security.md" }],
        },
      }));
      writeFileSync(path.join(rulesDir, "inspection", "security.md"), "检查安全风险");

      const store = new InspectionStore(":memory:");
      const service = new InspectionService({
        gitlab: {
          listRepositoryCommits: async (_projectId: string, query: { path?: string; ref?: string; page: number; perPage: number }) => {
            commitQueries.push(query);
            return [query.path ? makeCommit(`file-${query.path}`, "文件提交作者", "file@example.com") : makeCommit("sha-1", "提交作者", "commit@example.com")];
          },
          getRepositoryFileBlame: async (_projectId: string, filePath: string, _ref: string, line?: number) => {
            blameQueries.push({ path: filePath, line });
            if (filePath === "src/fallback.ts") throw new Error("GitLab blame 暂不可用");
            return [{ authorName: "行级作者", authorEmail: "line@example.com", lines: ["const line = 1;"] }];
          },
        } as GitLabClientPort,
        runner: {
          runInspection: async () => JSON.stringify({
            summary: "已完成",
            ruleResults: [{ ruleId: "security", ruleName: "安全", conclusion: "发现问题", findings }],
            findings: [],
          }),
        },
        store,
        jira: {
          listAssignableUsers: async (_projectKey: string, query?: string) => {
            const normalizedQuery = query?.trim() ?? "";
            jiraAssigneeQueries.push(normalizedQuery);
            if (normalizedQuery === "行级作者") return [{ username: "line", name: "Jira Line", avatarUrl: null }];
            if (normalizedQuery === "文件提交作者") return [{ username: "jira.file", name: "文件提交作者", avatarUrl: null }];
            return [];
          },
        } as JiraClientPort,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        schedulerIntervalMs: 60_000,
      });

      await service.upsertProject({
        projectId: "1",
        projectPath: "group/project",
        projectName: "项目",
        branch: "main",
        enabled: true,
        scheduleEnabled: false,
        scheduleCron: "0 0 * * *",
        jiraMode: "manual",
        jiraComponent: null,
        jiraFixVersion: null,
        jiraIssueType: "缺陷",
        inspectionRuleIds: ["security"],
      });

      const accepted = await service.enqueue("1");
      await waitFor(() => service.getRun(accepted.run.id)?.status === "completed");
      const result = service.getRun(accepted.run.id)?.result;
      const resolved = new Map(result?.ruleResults.flatMap((rule) => rule.findings).map((finding) => [finding.path, finding.author]));
      expect(resolved.get("src/line.ts")).toMatchObject({ name: "行级作者", email: "line@example.com", assignee: "line" });
      expect(resolved.get("src/fallback.ts")).toBeNull();
      expect(resolved.get("src/file.ts")).toBeNull();
      expect(jiraAssigneeQueries).toEqual(expect.arrayContaining(["行级作者", "line@example.com", "line"]));
      expect(jiraAssigneeQueries).toHaveLength(3);
      expect(blameQueries).toEqual(expect.arrayContaining([{ path: "src/line.ts", line: 12 }, { path: "src/fallback.ts", line: 7 }]));
      expect(blameQueries.filter((query) => query.line !== undefined)).toHaveLength(2);
      expect(blameQueries.filter((query) => query.line === undefined)).toHaveLength(2);
      expect(commitQueries.filter((query) => query.path)).toHaveLength(0);

      await service.close();
      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("backfills authors on the existing terminal run without creating history", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-service-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    let authorAvailable = false;
    const commitQueries: Array<{ path?: string }> = [];
    const finding = { severity: "high", category: "安全", path: "src/auth.ts", line: null, scope: "file" as const, issue: "缺少输入校验", suggestion: "补充参数校验" } as const;
    const authorCommit = {
      id: "author-commit",
      shortId: "author-commit",
      title: "修复输入校验",
      message: "修复输入校验",
      authorName: "历史提交作者",
      authorEmail: "author@example.com",
      authoredAt: null,
      committedAt: null,
      webUrl: null,
    };
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [{ id: "security", name: "安全", description: "安全风险", enabled: true, order: 0, file: "inspection/security.md" }],
        },
      }));
      writeFileSync(path.join(rulesDir, "inspection", "security.md"), "检查安全风险");

      const store = new InspectionStore(":memory:");
      const service = new InspectionService({
        gitlab: {
          listRepositoryCommits: async (_projectId: string, query: { path?: string }) => {
            commitQueries.push(query);
            return query.path && authorAvailable ? [authorCommit] : query.path ? [] : [{ id: "sha-1" }];
          },
          getRepositoryFileBlame: async () => authorAvailable ? [{ authorName: "历史提交作者", authorEmail: "author@example.com", lines: ["return validate(input);"] }] : [],
        } as GitLabClientPort,
        runner: {
          runInspection: async () => JSON.stringify({
            summary: "已完成",
            ruleResults: [{ ruleId: "security", ruleName: "安全", conclusion: "发现问题", findings: [finding] }],
            findings: [],
          }),
        },
        store,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        schedulerIntervalMs: 60_000,
      });

      await service.upsertProject({
        projectId: "1",
        projectPath: "group/project",
        projectName: "项目",
        branch: "main",
        enabled: true,
        scheduleEnabled: false,
        scheduleCron: "0 0 * * *",
        jiraMode: "manual",
        jiraComponent: null,
        jiraFixVersion: null,
        jiraIssueType: "缺陷",
        inspectionRuleIds: ["security"],
      });

      const accepted = await service.enqueue("1");
      await waitFor(() => service.getRun(accepted.run.id)?.status === "completed");
      expect(service.getRun(accepted.run.id)?.result?.ruleResults[0]?.findings[0]?.author).toBeNull();
      expect(store.loadRuns()[0]?.id).toBe(accepted.run.id);

      authorAvailable = true;
      const refreshed = await service.resolveAuthors(accepted.run.id);
      expect(refreshed.id).toBe(accepted.run.id);
      expect(service.listRuns()).toHaveLength(1);
      expect(refreshed.result?.ruleResults[0]?.findings[0]?.author).toMatchObject({ name: "历史提交作者", email: "author@example.com" });
      expect(store.loadRuns()[0]?.result?.ruleResults[0]?.findings[0]?.author).toMatchObject({ name: "历史提交作者", email: "author@example.com" });
      const fileCommitQueries = commitQueries.filter((query) => query.path);
      expect(fileCommitQueries).toHaveLength(1);
      expect(fileCommitQueries[0]).toMatchObject({ path: "src/auth.ts", ref: "sha-1", page: 1, perPage: 1 });

      await service.close();
      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deletes terminal runs and cascades their persisted progress", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-inspection-service-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "inspection-profiles.json");
    try {
      mkdirSync(path.join(rulesDir, "inspection"), { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [{ id: "file-line-limit", name: "文件大小", description: "文件规模", enabled: true, order: 0, file: "inspection/file-line-limit.md" }],
        },
      }));
      writeFileSync(path.join(rulesDir, "inspection", "file-line-limit.md"), "检查文件大小");

      const store = new InspectionStore(":memory:");
      const service = new InspectionService({
        gitlab: { listRepositoryCommits: async () => [{ id: "sha-1" }] } as GitLabClientPort,
        runner: { runInspection: async () => JSON.stringify({ summary: "已完成", findings: [] }) },
        store,
        inspectionRulesStore: new InspectionRulesStore({ rulesDir, profileConfigPath }),
        jiraProjectKey: () => "JIRA",
        config: { rulesDir, profileConfigPath },
        schedulerIntervalMs: 60_000,
      });

      await service.upsertProject({
        projectId: "1",
        projectPath: "group/project",
        projectName: "项目",
        branch: "main",
        enabled: true,
        scheduleEnabled: false,
        scheduleCron: "0 0 * * *",
        jiraMode: "manual",
        jiraComponent: null,
        jiraFixVersion: null,
        jiraIssueType: "缺陷",
        inspectionRuleIds: ["file-line-limit"],
      });

      const accepted = await service.enqueue("1");
      await expect(service.delete(accepted.run.id)).rejects.toThrow("进行中的巡检任务不能删除");
      await waitFor(() => service.getRun(accepted.run.id)?.status === "completed");
      expect(await service.delete(accepted.run.id)).toBe(true);
      expect(service.getRun(accepted.run.id)).toBeNull();
      expect(service.listRuns()).toHaveLength(0);
      expect(store.loadRuns()).toHaveLength(0);
      expect(await service.delete(accepted.run.id)).toBeNull();

      await service.close();
      store.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
