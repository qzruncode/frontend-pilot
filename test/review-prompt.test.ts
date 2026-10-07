import { describe, expect, it } from "vitest";
import {
  buildInspectionPrompt,
  buildPreSubmitReviewPrompt,
  buildReviewPrompt,
  parsePreSubmitReviewOutput,
  parseReviewOutput,
  preSubmitReviewGate,
  renderReviewComment,
  renderPreSubmitReviewReport,
  reviewGateSummary,
} from "../src/review-prompt.js";

describe("review prompt output", () => {
  it("requires inspection narrative fields to use simplified Chinese", () => {
    const prompt = buildInspectionPrompt({
      projectPath: "demo/project",
      branch: "main",
      headSha: "head-1",
      workspacePath: "/tmp/inspection-workspace",
      profile: {
        name: "default",
        displayName: "默认巡检 Profile",
        rules: [{ id: "security", name: "安全", description: "检查安全风险", enabled: true, order: 0, file: "security.md", sharedBy: ["default"], content: "检查安全" }],
      },
    });

    expect(prompt).toContain("全程使用简体中文");
    expect(prompt).toContain("所有面向用户的描述必须使用简体中文");
    expect(prompt).toContain("findings 的 category/issue/suggestion");
    expect(prompt).toContain("ruleResults 必须按照巡检规则的执行顺序");
  });

  it("uses inspection wording for generated fallback records", () => {
    const result = parseReviewOutput("", [], "巡检");

    expect(result.summary).toContain("非结构化巡检结果");
    expect(result.summary).not.toContain("审查");
    expect(result.raw).toBe("[巡检返回了空结果]");
  });

  it("asks the Agent SDK to inspect the complete workspace before reviewing", () => {
    const prompt = buildReviewPrompt({
      projectPath: "demo/project",
      mrIid: "4",
      workspacePath: "/tmp/review-workspace",
      profile: {
        name: "default",
        displayName: "默认 profile",
        rules: [{ id: "high-value", name: "高价值问题审查", description: "", enabled: true, order: 0, file: "audit.md", sharedBy: ["default"], content: "为了确认问题，请运行 npm test" }],
      },
    });

    expect(prompt).toContain("自主查看 Git 状态、远端 refs、提交历史");
    expect(prompt).toContain("服务端只负责提供工作区和会话，不替你决定审查输入");
    expect(prompt).toContain("Read、Grep、Glob");
    expect(prompt).toContain("本次只做静态代码审查");
    expect(prompt).toContain("禁止安装、下载或更新依赖");
    expect(prompt).toContain("禁止运行项目代码或任何项目脚本/验证命令");
    expect(prompt).toContain("可以使用 Task/Agent 并行静态阅读");
    expect(prompt).toContain("必须向每个子任务传递本节完整约束");
    expect(prompt).not.toContain("不要委派 Task/Agent 子任务");
    expect(prompt.indexOf("【静态审查边界")).toBeGreaterThan(prompt.indexOf("为了确认问题，请运行 npm test"));
    expect(prompt).not.toContain("可以自主决定需要哪些取证和验证步骤");
    expect(prompt).not.toContain(".claude/skills/review/SKILL.md");
    expect(prompt).not.toContain("GitLab snapshot");
    expect(prompt).not.toContain("should not be pasted");
  });

  it("includes Jira requirements and the external feedback in the read-only pre-submit review", () => {
    const prompt = buildPreSubmitReviewPrompt({
      projectPath: "demo/project",
      jiraKey: "TEST-42",
      jiraTitle: "修复默认值",
      jiraDescription: "h2. 问题描述 / 目标\n默认值必须为 new。\n\nh2. 验收标准\n* [ ] 默认值为 new。",
      targetBranch: "main",
      baseSha: "base-1",
      diff: "diff --git a/demo.ts b/demo.ts",
      workspacePath: "/tmp/edit-workspace",
      profile: {
        name: "default",
        displayName: "默认 profile",
        rules: [{ id: "high-value", name: "高价值问题审查", description: "", enabled: true, order: 0, file: "audit.md", sharedBy: ["default"], content: "检查实际影响" }],
      },
      externalFeedback: "Pipeline Review 要求补充默认值校验。",
    });

    expect(prompt).toContain("TEST-42");
    expect(prompt).toContain("默认值必须为 new");
    expect(prompt).toContain("Pipeline Review 要求补充默认值校验");
    expect(prompt).toContain("requirementChecks");
    expect(prompt).toContain("不要修改文件，不要执行项目脚本或测试命令");
    expect(prompt).toContain("Read、Grep、Glob");
  });

  it("blocks pre-submit review when a Jira requirement is missing", () => {
    const result = parsePreSubmitReviewOutput(JSON.stringify({
      summary: "验收标准没有全部实现。",
      requirementChecks: [{ requirement: "默认值必须为 new", status: "missing", evidence: "当前代码仍返回 old" }],
      ruleResults: [],
      findings: [],
    }));

    expect(preSubmitReviewGate(result)).toMatchObject({ gate: "failed", blockingFindingCount: 0, unmetRequirementCount: 1 });
    expect(renderPreSubmitReviewReport({ jiraKey: "TEST-42", diffSha: "abcdef1234567890", result })).toContain("未满足 Jira 要求：1 个");
  });

  it("passes static uncertainty to the Draft MR and leaves it for Pipeline verification", () => {
    const result = parsePreSubmitReviewOutput(JSON.stringify({
      summary: "代码行为已覆盖，但运行时结果需要目标仓库验证。",
      requirementChecks: [{ requirement: "刷新后数据仍然存在", status: "unclear", evidence: "静态代码已保留状态，但无法证明真实浏览器刷新结果" }],
      ruleResults: [],
      findings: [],
    }));

    expect(preSubmitReviewGate(result)).toMatchObject({ gate: "passed", blockingFindingCount: 0, unmetRequirementCount: 1, missingRequirementCount: 0, unclearRequirementCount: 1 });
    const report = renderPreSubmitReviewReport({ jiraKey: "TEST-42", diffSha: "abcdef1234567890", result });
    expect(report).toContain("未满足 Jira 要求：0 个");
    expect(report).toContain("待 Pipeline 验证：1 个");
    expect(report).toContain("Draft MR 创建后由目标仓库 Pipeline 继续验收");
  });

  it("parses structured Claude output and renders a stable MR comment", () => {
    const result = parseReviewOutput(JSON.stringify({
      summary: "发现一个逻辑问题。",
      ruleResults: [{
        ruleId: "project-rule",
        ruleName: "项目规则",
        conclusion: "发现一个项目规则问题。",
        findings: [],
      }],
      findings: [{
        severity: "high",
        category: "logic",
        path: "src/example.ts",
        line: 12,
        issue: "条件判断会漏掉空值。",
        suggestion: "显式处理空值分支。",
      }],
    }));

    const comment = renderReviewComment({
      projectId: "10",
      mrIid: "4",
      headSha: "abcdef1234567890",
      result,
    });

    expect(result.ruleResults).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(comment).toContain("mr-review-service:report:10:4:abcdef1234567890");
    expect(comment).toContain("## Frontend Pilot 代码审查报告");
    expect(comment).toContain("src/example.ts:12");
    expect(comment).toContain("发现一个逻辑问题");
  });

  it("keeps each enabled rule as an independent result block", () => {
    const result = parseReviewOutput(JSON.stringify({
      summary: "发现逻辑问题。",
      ruleResults: [{ ruleId: "delivery-rule", ruleName: "交付规则", conclusion: "交付问题", findings: [] }, {
        ruleId: "project-rule", ruleName: "项目规则", conclusion: "项目问题", findings: [],
      }],
      findings: [],
    }), [{
      id: "project-rule",
      name: "项目规则",
      description: "",
      enabled: true,
      order: 0,
      file: "rules.md",
      sharedBy: ["demo/project"],
      content: "检查项目规则",
    }, {
      id: "delivery-rule",
      name: "交付规则",
      description: "",
      enabled: true,
      order: 1,
      file: "delivery.md",
      sharedBy: ["demo/project"],
      content: "检查交付内容",
    }]);
    const comment = renderReviewComment({
      projectId: "10",
      mrIid: "4",
      headSha: "abcdef1234567890",
      result,
    });
    expect(result.ruleResults.map((rule) => rule.ruleId)).toEqual(["project-rule", "delivery-rule"]);
    expect(comment).toContain("项目规则");
    expect(comment).toContain("交付规则");
    expect(comment.indexOf("项目规则")).toBeLessThan(comment.indexOf("交付规则"));
    expect(comment).toContain("项目问题");
  });

  it("puts the configured rule order in the execution instructions", () => {
    const prompt = buildReviewPrompt({
      projectPath: "demo/project",
      mrIid: "4",
      profile: {
        name: "demo/project",
        displayName: "demo/project",
        rules: [{ id: "first", name: "第一规则", description: "", enabled: true, order: 0, file: "first.md", sharedBy: ["demo/project"], content: "先检查 API" }, {
          id: "second", name: "第二规则", description: "", enabled: true, order: 1, file: "second.md", sharedBy: ["demo/project"], content: "再检查交付",
        }],
      },
    });

    expect(prompt).toContain("严格按照下面的顺序逐条分析");
    expect(prompt.indexOf("### 1. first · 第一规则")).toBeLessThan(prompt.indexOf("### 2. second · 第二规则"));
  });

  it("keeps non-JSON output visible instead of silently passing", () => {
    const result = parseReviewOutput("## Claude 代码审查报告\n\n✅ 未发现高价值问题");
    expect(result.format).toBe("raw");
    expect(result.raw).toContain("未发现高价值问题");
  });

  it("blocks on critical/high findings from both rule and top-level results", () => {
    const result = parseReviewOutput(JSON.stringify({
      summary: "发现阻断问题。",
      ruleResults: [{
        ruleId: "rule",
        ruleName: "规则",
        conclusion: "阻断",
        findings: [{ severity: "critical", path: "src/rule.ts", issue: "规则问题" }],
      }],
      findings: [{ severity: "high", path: "src/top-level.ts", issue: "跨规则问题" }],
    }));

    expect(reviewGateSummary(result)).toEqual({
      gate: "failed",
      blockingFindingCount: 2,
      blockingSeverities: ["critical", "high"],
    });
  });

  it("counts a finding once when the model repeats it in a rule and top-level results", () => {
    const result = parseReviewOutput(JSON.stringify({
      summary: "重复问题",
      ruleResults: [{
        ruleId: "file-line-limit",
        ruleName: "文件大小",
        conclusion: "发现问题",
        findings: [{ severity: "high", category: "文件规模", path: "src/app.ts", line: 1, issue: "文件过大", suggestion: "拆分文件" }],
      }],
      findings: [{ severity: "high", category: "文件规模", path: "src/app.ts", line: 1, issue: "文件过大", suggestion: "拆分文件" }],
    }));

    expect(reviewGateSummary(result)).toMatchObject({ gate: "failed", blockingFindingCount: 1, blockingSeverities: ["high"] });
  });
});
