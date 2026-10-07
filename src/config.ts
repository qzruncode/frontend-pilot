import path from "node:path";
import {
  INSPECTION_AI_CONCURRENCY_DEFAULT,
  INSPECTION_AI_CONCURRENCY_MAX,
  REVIEW_CONCURRENCY_MAX,
  REVIEW_CONCURRENCY_MIN,
} from "./api-contracts.js";
import {
  DEFAULT_INSPECTION_AI_REVIEW_JOB_NAMES,
  INSPECTION_AI_MAX_PRE_SUBMIT_REPAIR_ATTEMPTS,
  INSPECTION_AI_VERIFICATION_POLL_INTERVAL_MS,
  INSPECTION_AI_VERIFICATION_TIMEOUT_MS,
} from "./inspection-ai-verification.js";

export interface AppConfig {
  environment?: NodeJS.ProcessEnv;
  port: number;
  host: string;
  webOrigin: string;
  webDistDir: string;
  loginUsername: string;
  loginPassword: string;
  gitlabApiBaseUrl: string;
  gitlabToken: string;
  jiraBaseUrl: string;
  jiraApiBaseUrl: string;
  jiraUsername: string;
  jiraToken: string;
  jiraProjectKey: string;
  jiraOAuthConsumerKey?: string;
  jiraOAuthPrivateKey?: string;
  jiraOAuthRedirectUri?: string;
  gitlabOAuthClientId: string;
  gitlabOAuthClientSecret: string;
  gitlabOAuthRedirectUri: string;
  gitlabOAuthScope: string;
  webhookSecret: string;
  triggerToken: string;
  allowInsecureWebhooks: boolean;
  anthropicApiKey: string;
  anthropicAuthToken: string;
  claudeModel: string;
  claudeThinkingMode: "adaptive" | "enabled" | "disabled";
  claudeThinkingBudgetTokens: number;
  claudeMaxTokens: number;
  claudeMaxRetries: number;
  assistantIdleTimeoutMs: number;
  claudeCliPath: string;
  claudeCliWorkspaceDir: string;
  reviewConcurrency: number;
  inspectionAiConcurrency: number;
  inspectionAiVerificationPollIntervalMs?: number;
  inspectionAiVerificationTimeoutMs?: number;
  inspectionAiMaxPreSubmitRepairAttempts?: number;
  inspectionAiReviewJobNames?: string[];
  maxDiffBytes: number;
  reviewWorkspaceDir: string;
  assistantWorkspaceDir: string;
  reviewDatabasePath: string;
  gitFetchDepth: number;
  rulesDir: string;
  profileConfigPath: string;
  inspectionRulesDir: string;
  inspectionProfileConfigPath: string;
  inspectionPromptsDir?: string;
  inspectionOwnerPromptPath?: string;
  authSessionSecret?: string;
  authSessionIdleTtlSeconds?: number;
  authSessionAbsoluteTtlSeconds?: number;
  authSessionRefreshWindowSeconds?: number;
  inspectionSessionIdleTtlSeconds?: number;
  inspectionSessionAbsoluteTtlSeconds?: number;
  dryRun: boolean;
}

function boundedInt(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function positiveInt(value: string | undefined, fallback: number, maximum: number): number {
  return boundedInt(value, fallback, REVIEW_CONCURRENCY_MIN, maximum);
}

function nonNegativeInt(value: string | undefined, fallback: number, maximum: number): number {
  return boundedInt(value, fallback, 0, maximum);
}

function booleanValue(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizeWebOrigin(value: string | undefined): string {
  const configured = value?.trim() || "http://localhost:5173";
  if (configured === "*") return configured;
  try {
    return new URL(configured).origin;
  } catch {
    return configured.replace(/\/+$/, "");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const gitlabBaseUrl = String(env.GITLAB_BASE_URL ?? "https://gitlab.example.com").replace(/\/+$/, "");
  const apiBaseUrl = String(env.GITLAB_API_BASE_URL ?? env.GITLAB_API_URL ?? `${gitlabBaseUrl}/api/v4`).replace(/\/+$/, "");
  const jiraBaseUrl = String(env.JIRA_BASE_URL ?? env.JIRA_URL ?? "https://jira.example.com").replace(/\/+$/, "");
  const jiraApiBaseUrl = String(env.JIRA_API_BASE_URL ?? `${jiraBaseUrl}/rest/api/2`).replace(/\/+$/, "");
  const webOrigin = normalizeWebOrigin(env.WEB_ORIGIN);

  return {
    environment: env,
    port: positiveInt(env.PORT, 8080, 65_535),
    host: env.HOST ?? "0.0.0.0",
    webOrigin,
    webDistDir: path.resolve(cwd, env.WEB_DIST_DIR ?? "apps/web/dist"),
    loginUsername: env.FRONTEND_PILOT_LOGIN_USERNAME?.trim() ?? "",
    loginPassword: env.FRONTEND_PILOT_LOGIN_PASSWORD ?? "",
    gitlabApiBaseUrl: apiBaseUrl,
    gitlabToken: env.GITLAB_TOKEN ?? env.GITLAB_PERSONAL_ACCESS_TOKEN ?? env.GITLAB__PERSONAL_ACCESS_TOKEN ?? "",
    jiraBaseUrl,
    jiraApiBaseUrl,
    jiraUsername: env.JIRA_USERNAME ?? env.JIRA_USER ?? "",
    jiraToken: env.JIRA_TOKEN ?? env.JIRA_PASSWORD ?? env.JIRA_API_TOKEN ?? "",
    jiraProjectKey: (env.JIRA_PROJECT_KEY ?? "DEMO").trim().toUpperCase(),
    jiraOAuthConsumerKey: env.JIRA_OAUTH_CONSUMER_KEY?.trim() ?? "",
    jiraOAuthPrivateKey: env.JIRA_OAUTH_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "",
    jiraOAuthRedirectUri: env.JIRA_OAUTH_REDIRECT_URI?.trim() || `${webOrigin}/api/v1/jira/oauth/callback`,
    gitlabOAuthClientId: env.GITLAB_OAUTH_CLIENT_ID ?? "",
    gitlabOAuthClientSecret: env.GITLAB_OAUTH_CLIENT_SECRET ?? "",
    gitlabOAuthRedirectUri: env.GITLAB_OAUTH_REDIRECT_URI?.trim() || `${webOrigin}/api/v1/gitlab/oauth/callback`,
    gitlabOAuthScope: env.GITLAB_OAUTH_SCOPE?.trim() || "api",
    webhookSecret: env.GITLAB_WEBHOOK_SECRET ?? "",
    triggerToken: env.REVIEW_SERVICE_TOKEN ?? "",
    allowInsecureWebhooks: booleanValue(env.ALLOW_INSECURE_WEBHOOKS),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    anthropicAuthToken: env.ANTHROPIC_AUTH_TOKEN ?? "",
    claudeModel: env.CLAUDE_MODEL || "",
    claudeThinkingMode: env.CLAUDE_THINKING_MODE === "enabled"
      ? "enabled"
      : env.CLAUDE_THINKING_MODE === "disabled" ? "disabled" : "adaptive",
    claudeThinkingBudgetTokens: boundedInt(env.CLAUDE_THINKING_BUDGET_TOKENS, 4_096, 1_024, 200_000),
    claudeMaxTokens: positiveInt(env.CLAUDE_MAX_TOKENS, 4_096, 200_000),
    claudeMaxRetries: nonNegativeInt(env.CLAUDE_MAX_RETRIES, 2, 10),
    assistantIdleTimeoutMs: boundedInt(env.ASSISTANT_IDLE_TIMEOUT_MS, 180_000, 30_000, 900_000),
    claudeCliPath: env.CLAUDE_CLI_PATH?.trim() || "claude",
    claudeCliWorkspaceDir: path.resolve(cwd, env.CLAUDE_CLI_WORKSPACE_DIR ?? "var/claude-cli-workspaces"),
    reviewConcurrency: positiveInt(env.REVIEW_CONCURRENCY, 2, REVIEW_CONCURRENCY_MAX),
    inspectionAiConcurrency: positiveInt(env.INSPECTION_AI_CONCURRENCY, INSPECTION_AI_CONCURRENCY_DEFAULT, INSPECTION_AI_CONCURRENCY_MAX),
    inspectionAiVerificationPollIntervalMs: boundedInt(env.INSPECTION_AI_VERIFICATION_POLL_INTERVAL_MS, INSPECTION_AI_VERIFICATION_POLL_INTERVAL_MS, 1_000, 60_000),
    inspectionAiVerificationTimeoutMs: boundedInt(env.INSPECTION_AI_VERIFICATION_TIMEOUT_MS, INSPECTION_AI_VERIFICATION_TIMEOUT_MS, 60_000, 2 * 60 * 60 * 1_000),
    inspectionAiMaxPreSubmitRepairAttempts: nonNegativeInt(env.INSPECTION_AI_MAX_PRE_SUBMIT_REPAIR_ATTEMPTS, INSPECTION_AI_MAX_PRE_SUBMIT_REPAIR_ATTEMPTS, 10),
    inspectionAiReviewJobNames: (env.INSPECTION_AI_REVIEW_JOB_NAMES?.split(",").map((item) => item.trim()).filter(Boolean) ?? [...DEFAULT_INSPECTION_AI_REVIEW_JOB_NAMES]),
    maxDiffBytes: positiveInt(env.REVIEW_MAX_DIFF_BYTES, 300_000, 5_000_000),
    reviewWorkspaceDir: path.resolve(cwd, env.REVIEW_WORKSPACE_DIR ?? "var/review-workspaces"),
    assistantWorkspaceDir: path.resolve(cwd, env.ASSISTANT_WORKSPACE_DIR ?? "var/assistant-workspaces"),
    reviewDatabasePath: path.resolve(cwd, env.REVIEW_DATABASE_PATH ?? "var/frontend-pilot.sqlite"),
    gitFetchDepth: positiveInt(env.GIT_FETCH_DEPTH, 50, 1_000),
    rulesDir: path.resolve(cwd, env.REVIEW_RULES_DIR ?? "config/skills"),
    profileConfigPath: path.resolve(cwd, env.REVIEW_PROFILE_CONFIG ?? "config/review-profiles.json"),
    inspectionRulesDir: path.resolve(cwd, env.INSPECTION_RULES_DIR ?? "config/skills/inspection"),
    inspectionProfileConfigPath: path.resolve(cwd, env.INSPECTION_PROFILE_CONFIG ?? "config/inspection-profiles.json"),
    inspectionPromptsDir: path.resolve(cwd, env.INSPECTION_PROMPTS_DIR ?? "var/inspection-prompts"),
    inspectionOwnerPromptPath: path.resolve(cwd, env.INSPECTION_OWNER_PROMPT_PATH ?? "var/inspection-owner-prompt.md"),
    authSessionSecret: env.AUTH_SESSION_SECRET?.trim() || env.REVIEW_SERVICE_TOKEN?.trim() || "",
    authSessionIdleTtlSeconds: boundedInt(env.AUTH_SESSION_IDLE_TTL_SECONDS, 7 * 24 * 60 * 60, 5 * 60, 30 * 24 * 60 * 60),
    authSessionAbsoluteTtlSeconds: boundedInt(env.AUTH_SESSION_ABSOLUTE_TTL_SECONDS, 30 * 24 * 60 * 60, 60 * 60, 90 * 24 * 60 * 60),
    authSessionRefreshWindowSeconds: boundedInt(env.AUTH_SESSION_REFRESH_WINDOW_SECONDS, 24 * 60 * 60, 60, 7 * 24 * 60 * 60),
    inspectionSessionIdleTtlSeconds: boundedInt(env.INSPECTION_SESSION_IDLE_TTL_SECONDS, 7 * 24 * 60 * 60, 5 * 60, 30 * 24 * 60 * 60),
    inspectionSessionAbsoluteTtlSeconds: boundedInt(env.INSPECTION_SESSION_ABSOLUTE_TTL_SECONDS, 30 * 24 * 60 * 60, 60 * 60, 90 * 24 * 60 * 60),
    dryRun: booleanValue(env.REVIEW_DRY_RUN),
  };
}
