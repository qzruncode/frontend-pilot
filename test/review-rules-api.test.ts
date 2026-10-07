import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { ReviewRuleProfile } from "../src/contracts.js";
import type { ReviewRulesStorePort } from "../src/review-rules.js";

const config: AppConfig = {
  port: 0,
  host: "127.0.0.1",
  webOrigin: "http://localhost:5173",
  webDistDir: "/tmp/frontend-pilot-no-web",
  loginUsername: "pilot-user",
  loginPassword: "pilot-password",
  gitlabApiBaseUrl: "http://gitlab.invalid/api/v4",
  gitlabToken: "gitlab-token",
  jiraBaseUrl: "https://jira.invalid",
  jiraApiBaseUrl: "https://jira.invalid/rest/api/2",
  jiraUsername: "jira-user",
  jiraToken: "jira-token",
  jiraProjectKey: "AIP",
  gitlabOAuthClientId: "",
  gitlabOAuthClientSecret: "",
  gitlabOAuthRedirectUri: "http://localhost:5173/api/v1/gitlab/oauth/callback",
  gitlabOAuthScope: "api",
  webhookSecret: "webhook-secret",
  triggerToken: "trigger-token",
  allowInsecureWebhooks: false,
  anthropicApiKey: "anthropic-test-key",
  anthropicAuthToken: "",
  claudeModel: "claude-test",
  claudeThinkingMode: "adaptive",
  claudeThinkingBudgetTokens: 4_096,
  claudeMaxTokens: 2_048,
  claudeMaxRetries: 0,
  assistantIdleTimeoutMs: 180_000,
  claudeCliPath: "claude",
  claudeCliWorkspaceDir: "/tmp/frontend-pilot-claude-cli-workspaces",
  reviewConcurrency: 1,
  inspectionAiConcurrency: 1,
  maxDiffBytes: 10_000,
  reviewWorkspaceDir: "/tmp/frontend-pilot-review-workspaces",
  assistantWorkspaceDir: "/tmp/frontend-pilot-assistant-workspaces",
  reviewDatabasePath: ":memory:",
  gitFetchDepth: 50,
  rulesDir: "/tmp/frontend-pilot-rules",
  profileConfigPath: "/tmp/frontend-pilot-profiles.json",
  dryRun: true,
};

function profile(): ReviewRuleProfile {
  return {
    name: "default",
    displayName: "默认 profile",
    isDefault: true,
    rules: [{
      id: "high-value",
      name: "高价值问题审查",
      description: "",
      enabled: true,
      order: 0,
      file: "audit.md",
      sharedBy: ["default"],
      content: "只报告明确问题",
    }],
  };
}

describe("review rules API", () => {
  it("requires auth and manages repository profiles and rules", async () => {
    let current = profile();
    const received: unknown[] = [];
    const reviewRulesStore: ReviewRulesStorePort = {
      async list() { return [current]; },
      async readForProject() { return current; },
      async createProfile(input) {
        received.push({ operation: "createProfile", input });
        current = { ...current, name: input.profile, displayName: input.displayName ?? input.profile, isDefault: false, rules: [] };
        return current;
      },
      async deleteProfile(input) {
        received.push({ operation: "deleteProfile", input });
      },
      async createRule(input) {
        received.push({ operation: "createRule", input });
        return current;
      },
      async updateRule(input) {
        received.push({ operation: "updateRule", input });
        return current;
      },
      async deleteRule(input) {
        received.push({ operation: "deleteRule", input });
        return current;
      },
      async reorderRules(input) {
        received.push({ operation: "reorderRules", input });
        return current;
      },
    };
    const app = await buildApp({ config, reviewRulesStore });
    try {
      const unauthorized = await app.inject({ method: "GET", url: "/api/v1/review-rules" });
      expect(unauthorized.statusCode).toBe(401);

      const read = await app.inject({
        method: "GET",
        url: "/api/v1/review-rules",
        headers: { authorization: "Bearer trigger-token" },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().profiles[0]).toMatchObject({ name: "default", displayName: "默认 profile" });

      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/review-rules",
        headers: { authorization: "Bearer trigger-token" },
        payload: { profile: "default", name: "规则", content: "" },
      });
      expect(invalid.statusCode).toBe(400);

      const createProfile = await app.inject({
        method: "POST",
        url: "/api/v1/review-profiles",
        headers: { authorization: "Bearer trigger-token" },
        payload: { profile: "group/project", displayName: "项目" },
      });
      expect(createProfile.statusCode).toBe(201);

      const updateRule = await app.inject({
        method: "PUT",
        url: "/api/v1/review-rules",
        headers: { authorization: "Bearer trigger-token" },
        payload: { profile: "default", ruleId: "high-value", name: "更新规则", description: "说明", enabled: true, content: "更新后的规则" },
      });
      expect(updateRule.statusCode).toBe(200);
      expect(received).toContainEqual({ operation: "updateRule", input: { profile: "default", ruleId: "high-value", name: "更新规则", description: "说明", enabled: true, content: "更新后的规则" } });

      const reorder = await app.inject({
        method: "PATCH",
        url: "/api/v1/review-rules/order",
        headers: { authorization: "Bearer trigger-token" },
        payload: { profile: "default", ruleIds: ["high-value"] },
      });
      expect(reorder.statusCode).toBe(200);
      expect(received).toContainEqual({ operation: "reorderRules", input: { profile: "default", ruleIds: ["high-value"] } });

      const invalidOrder = await app.inject({
        method: "PATCH",
        url: "/api/v1/review-rules/order",
        headers: { authorization: "Bearer trigger-token" },
        payload: { profile: "default", ruleIds: ["high-value", "high-value"] },
      });
      expect(invalidOrder.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
