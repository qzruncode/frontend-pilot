import { describe, expect, it } from "vitest";
import {
  buildDefaultInspectionJiraDescription,
  buildDefaultMergeRequestDescription,
  buildInspectionJiraCreatePrompt,
  buildMergeRequestDescriptionPrompt,
  ensureMergeRequestTitleJiraKey,
  nextThursdayDate,
  normalizeInspectionJiraCreatePlan,
  normalizeMergeRequestDescription,
  type InspectionJiraCreatePromptInput,
  type MergeRequestDescriptionPromptInput,
} from "../src/prompt-generation.js";
import {
  DEFAULT_INSPECTION_JIRA_FIELDS_PROMPT,
  DEFAULT_INSPECTION_OWNER_PROMPT,
  DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT,
} from "../src/inspection-prompts.js";

const jiraInput: InspectionJiraCreatePromptInput = {
  projectPath: "group/frontend",
  branch: "main",
  headSha: "abc123",
  createdAt: "2026-09-09T10:00:00.000Z",
  finding: {
    severity: "high",
    category: "正确性",
    path: "src/demo.ts",
    line: 42,
    issue: "默认值不正确",
    suggestion: "使用配置中的默认值",
    scope: "运行时",
    relatedPaths: ["src/config.ts"],
  },
  owner: {
    username: "alice",
    name: "Alice",
    reason: "最近修改了相关逻辑",
    evidence: [],
    source: "ai",
  },
};

const mrInput: MergeRequestDescriptionPromptInput = {
  projectPath: "group/frontend",
  jiraKey: "AIP-114739",
  jiraUrl: "https://jira.example/browse/AIP-114739",
  sourceBranch: "feature/aip-114739",
  targetBranch: "main",
  title: "fix(config): 修复默认值 (#AIP-114739)",
  commitTitle: "fix(config): 修复默认值 (#AIP-114739)",
  commitMessage: "已修复默认值，并完成类型检查。",
  jiraDescription: "问题描述：默认值不正确。",
};

describe("prompt generation", () => {
  it("calculates the same-week or following-week Thursday", () => {
    expect(nextThursdayDate("2026-09-07T00:00:00.000Z")).toBe("2026-09-10");
    expect(nextThursdayDate("2026-09-10T00:00:00.000Z")).toBe("2026-09-10");
    expect(nextThursdayDate("2026-09-11T00:00:00.000Z")).toBe("2026-09-17");
  });

  it("normalizes a Jira plan to the release label and due date contract", () => {
    const fallback = normalizeInspectionJiraCreatePlan({ description: "不完整" }, jiraInput);
    expect(fallback.labels).toContain("release-20260910");
    expect(fallback.dueDate).toBe("2026-09-10");

    const explicit = normalizeInspectionJiraCreatePlan({
      description: buildDefaultInspectionJiraDescription(jiraInput),
      labels: ["release-20260915", "frontend", "frontend"],
      dueDate: null,
    }, jiraInput);
    expect(explicit.labels).toEqual(["frontend", "release-20260915"]);
    expect(explicit.dueDate).toBe("2026-09-15");

    const exception = normalizeInspectionJiraCreatePlan({
      description: buildDefaultInspectionJiraDescription(jiraInput),
      labels: ["release-TBD"],
      dueDate: "2026-09-15",
    }, jiraInput);
    expect(exception.labels).toEqual(["release-TBD"]);
    expect(exception.dueDate).toBeNull();
  });

  it("builds concise prompts with the required Jira and MR sections", () => {
    const jiraPrompt = buildInspectionJiraCreatePrompt(jiraInput, "描述规则", "字段规则");
    expect(jiraPrompt).toContain("描述规则");
    expect(jiraPrompt).toContain("字段规则");
    expect(jiraPrompt).toContain("不要输出解释");

    const mrPrompt = buildMergeRequestDescriptionPrompt(mrInput, "MR 规则");
    expect(mrPrompt).toContain("MR 规则");
    expect(mrPrompt).toContain("AIP-114739");
    expect(mrPrompt).toContain("只输出 Markdown 正文");
  });

  it("keeps every managed default prompt aligned with the shared workflow rules", () => {
    expect(DEFAULT_INSPECTION_OWNER_PROMPT).toContain("负责人和代码作者在本流程中是同一个归属");
    expect(DEFAULT_INSPECTION_OWNER_PROMPT).toContain("返回真实可分派的 Jira username");
    expect(DEFAULT_INSPECTION_OWNER_PROMPT).toContain("无法确认时返回 uncertain");

    expect(DEFAULT_INSPECTION_JIRA_FIELDS_PROMPT).toContain("release-YYYYMMDD");
    expect(DEFAULT_INSPECTION_JIRA_FIELDS_PROMPT).toContain("周一至周四取本周四，周五至周日取下周四");
    expect(DEFAULT_INSPECTION_JIRA_FIELDS_PROMPT).toContain("release-TBD");
    expect(DEFAULT_INSPECTION_JIRA_FIELDS_PROMPT).toContain("release-<已发版本>-回滚");

    expect(DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT).toContain("标题必须使用 <type>(<scope>): <一句话描述> (#JIRA-KEY)");
    expect(DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT).toContain("## Background");
    expect(DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT).toContain("## 改动");
    expect(DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT).toContain("## 验证");
    expect(DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT).toContain("## 关联");
    expect(DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT).toContain("没有 Jira key 时不要创建 MR");
  });

  it("keeps Jira keys in titles and falls back to a valid MR description", () => {
    expect(ensureMergeRequestTitleJiraKey("修复默认值", "aip-114739")).toBe("修复默认值 (#AIP-114739)");
    expect(ensureMergeRequestTitleJiraKey("修复默认值 (#AIP-114739)", "AIP-114739")).toBe("修复默认值 (#AIP-114739)");
    const description = buildDefaultMergeRequestDescription(mrInput);
    expect(description).toContain("## Background");
    expect(description).toContain("## 改动");
    expect(description).toContain("## 验证");
    expect(description).toContain("## 关联");
    expect(normalizeMergeRequestDescription("不符合规范", mrInput)).toBe(description);
    expect(normalizeMergeRequestDescription("## 关联\nAIP-114739\n\n## Background\n背景\n\n## 改动\n改动\n\n## 验证\n验证", mrInput)).toBe(description);
  });
});
