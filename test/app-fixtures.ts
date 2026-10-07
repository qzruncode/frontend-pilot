import type { AppConfig } from "../src/config.js";
import type { GitLabConnection } from "../src/gitlab-connection.js";
import type { ReviewRunner } from "../src/contracts.js";
import { ReviewService } from "../src/review-service.js";

export const config: AppConfig = {
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
  claudeModel: "claude-sonnet-4-6",
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
  rulesDir: "config/skills",
  profileConfigPath: "config/review-profiles.json",
  inspectionRulesDir: "config/skills/inspection",
  inspectionProfileConfigPath: "config/inspection-profiles.json",
  dryRun: true,
};

export function service(options: { runner?: ReviewRunner } = {}): ReviewService {
  const gitlab = {
    async getReviewSnapshot() {
      return { mergeRequest: { diff_refs: { head_sha: "head-1" } }, changes: [] };
    },
    async getMergeRequest() { return { diff_refs: { head_sha: "head-1" } }; },
    async findNoteByMarker() { return null; },
    async createNote() { return { id: 1 }; },
    async updateNote() { return { id: 1 }; },
  };
  const runner = options.runner ?? { async run() { return JSON.stringify({ summary: "ok", findings: [] }); } };
  return new ReviewService({
    gitlab,
    runner,
    config,
    profileLoader: async () => ({
      name: "default",
      displayName: "默认 profile",
      rules: [{ id: "high-value", name: "高价值问题审查", description: "", enabled: true, order: 0, file: "audit.md", sharedBy: ["default"], content: "audit" }],
    }),
  });
}

export function gitlabConnectionStore() {
  let current: GitLabConnection = {
    baseUrl: "http://gitlab.invalid",
    apiBaseUrl: "http://gitlab.invalid/api/v4",
    token: "gitlab-token",
  };
  return {
    async read() { return current; },
    async write(next: GitLabConnection) {
      current = next;
      return current;
    },
  };
}
