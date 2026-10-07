import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewRulesStore } from "../src/review-rules.js";

describe("ReviewRulesStore", () => {
  it("matches profiles by repository and supports profile/rule lifecycle", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-rules-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "review-profiles.json");
    const auditPath = path.join(rulesDir, "audit.md");
    const rulesPath = path.join(rulesDir, "rules.md");
    try {
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: {
          displayName: "默认 profile",
          rules: [{ id: "high-value", name: "高价值问题审查", description: "通用问题", enabled: true, file: "audit.md" }],
        },
        "saas/frontend": {
          displayName: "saas 前端",
          rules: [{ id: "frontend", name: "前端规范", description: "项目规范", enabled: true, order: 1, file: "rules.md" }, { id: "high-value", name: "高价值问题审查", description: "通用问题", enabled: true, order: 0, file: "audit.md" }],
        },
      }));
      writeFileSync(auditPath, "原始高价值规则");
      writeFileSync(rulesPath, "原始项目规范");

      const store = new ReviewRulesStore({ rulesDir, profileConfigPath });
      const profiles = await store.list();
      expect(profiles).toHaveLength(2);
      expect(profiles[0]?.rules[0]?.content).toBe("原始高价值规则");

      const matched = await store.readForProject("saas/frontend");
      expect(matched).toMatchObject({ name: "saas/frontend", displayName: "saas 前端" });
      expect(matched.rules.map((rule) => rule.name)).toEqual(["高价值问题审查", "前端规范"]);
      expect((await store.readForProject("unknown/project")).isDefault).toBe(true);

      const createdProfile = await store.createProfile({ profile: "aip/ui/so-chart", displayName: "so-chart" });
      expect(createdProfile.rules).toHaveLength(0);
      const createdRule = await store.createRule({
        profile: "aip/ui/so-chart",
        name: "图表契约",
        description: "检查 API",
        enabled: true,
        content: "只报告明确问题",
      });
      expect(createdRule.rules).toHaveLength(1);
      const ruleId = createdRule.rules[0]?.id ?? "";
      const secondRuleProfile = await store.createRule({
        profile: "aip/ui/so-chart",
        name: "图表交付",
        description: "检查交付",
        enabled: true,
        content: "检查示例和文档",
      });
      const secondRuleId = secondRuleProfile.rules.find((rule) => rule.id !== ruleId)?.id ?? "";
      const reordered = await store.reorderRules({ profile: "aip/ui/so-chart", ruleIds: [secondRuleId, ruleId] });
      expect(reordered.rules.map((rule) => rule.id)).toEqual([secondRuleId, ruleId]);
      expect(reordered.rules.map((rule) => rule.order)).toEqual([0, 1]);

      const updated = await store.updateRule({
        profile: "aip/ui/so-chart",
        ruleId,
        name: "图表契约更新",
        description: "检查 API 和渲染",
        enabled: false,
        content: "更新后的规则",
      });
      expect(updated.rules.find((rule) => rule.id === ruleId)).toMatchObject({ name: "图表契约更新", enabled: false, content: "更新后的规则" });

      const deletedRule = await store.deleteRule({ profile: "aip/ui/so-chart", ruleId });
      expect(deletedRule.rules).toHaveLength(1);
      expect(deletedRule.rules[0]?.order).toBe(0);
      const deletedSecondRule = await store.deleteRule({ profile: "aip/ui/so-chart", ruleId: secondRuleId });
      expect(deletedSecondRule.rules).toHaveLength(0);
      await store.deleteProfile({ profile: "aip/ui/so-chart" });
      expect((await store.list()).some((profile) => profile.name === "aip/ui/so-chart")).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("migrates the previous two-file profile shape when reading", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-rules-legacy-"));
    const rulesDir = path.join(tempDir, "skills");
    const profileConfigPath = path.join(tempDir, "review-profiles.json");
    try {
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(profileConfigPath, JSON.stringify({
        default: { auditFile: "audit.md", rulesEnabled: false },
        "saas/frontend": { auditFile: "audit.md", rulesFile: "rules.md", rulesEnabled: true },
      }));
      writeFileSync(path.join(rulesDir, "audit.md"), "审查规则");
      writeFileSync(path.join(rulesDir, "rules.md"), "规范规则");

      const store = new ReviewRulesStore({ rulesDir, profileConfigPath });
      const profile = await store.readForProject("saas/frontend");
      expect(profile.rules.map((rule) => rule.name)).toEqual(["高价值问题审查", "项目规范规则"]);
      expect(profile.rules[1]?.enabled).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a profile file path outside the configured rules directory", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-rules-path-"));
    try {
      const rulesDir = path.join(tempDir, "skills");
      mkdirSync(rulesDir, { recursive: true });
      const profileConfigPath = path.join(tempDir, "review-profiles.json");
      writeFileSync(profileConfigPath, JSON.stringify({ default: { auditFile: "../secret.md" } }));
      const store = new ReviewRulesStore({ rulesDir, profileConfigPath });
      await expect(store.list()).rejects.toThrow("不在 rulesDir 内");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects an unbounded profile configuration", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-rules-count-"));
    try {
      const rulesDir = path.join(tempDir, "skills");
      mkdirSync(rulesDir, { recursive: true });
      const profileConfigPath = path.join(tempDir, "review-profiles.json");
      const profiles = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
        `project-${index}`,
        { rules: [] },
      ]));
      writeFileSync(profileConfigPath, JSON.stringify(profiles));
      const store = new ReviewRulesStore({ rulesDir, profileConfigPath });
      await expect(store.list()).rejects.toThrow("最多支持 100 个");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
