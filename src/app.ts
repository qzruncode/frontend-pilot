import { InspectionAccounts } from "./inspection-accounts.js";
import { registerInspectionAccountRoutes } from "./app-inspection-account-routes.js";
import fs from "node:fs";
import path from "node:path";
import { deleteSession as deleteClaudeSession } from "@anthropic-ai/claude-agent-sdk";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import {
  BROWSER_SESSION_COOKIE,
  cookieValue,
  headerValue,
  secureEqual,
  tokenHash,
} from "./auth.js";
import {
  ClaudeAgentSdkAssistantRunner,
  DryRunAssistantRunner,
  type AssistantRuntimeContext,
  type AssistantRunner,
} from "./assistant-runner.js";
import { AssistantExecutionManager } from "./assistant-execution.js";
import { AssistantStore } from "./assistant-store.js";
import { AssistantEditService } from "./assistant-edit-service.js";
import { AssistantEditStore } from "./assistant-edit-store.js";
import { GitAssistantEditWorkspaceProvider } from "./assistant-edit-workspace.js";
import { FeedbackStore, type FeedbackStorePort } from "./feedback-store.js";
import type { AppConfig } from "./config.js";
import { GitLabClient, type GitLabClientPort } from "./gitlab-client.js";
import { GitLabConnectionStore, type GitLabConnectionStorePort } from "./gitlab-connection.js";
import {
  DatabaseClaudeSettingsStore,
  claudeSettingsFromEnvironment,
  withoutClaudeSettingsEnvironment,
  type ClaudeSettingsStore,
} from "./model-config.js";
import { ClaudeAgentSdkReviewRunner, DryRunReviewRunner } from "./review-runner.js";
import { ReviewService, ReviewTerminalError } from "./review-service.js";
import { ReviewRulesStore, type ReviewRulesStorePort } from "./review-rules.js";
import { InspectionRulesStore, type InspectionRulesStorePort } from "./inspection-rules.js";
import {
  INSPECTION_JIRA_DESCRIPTION_PROMPT_ID,
  INSPECTION_JIRA_FIELDS_PROMPT_ID,
  INSPECTION_OWNER_PROMPT_ID,
  MERGE_REQUEST_DESCRIPTION_PROMPT_ID,
  InspectionPromptStore,
  type InspectionPromptStorePort,
} from "./inspection-prompts.js";
import { ReviewStore } from "./review-store.js";
import { GitReviewWorkspaceProvider } from "./review-workspace.js";
import { InspectionService } from "./inspection-service.js";
import { InspectionStore } from "./inspection-store.js";
import { InspectionAiStore } from "./inspection-ai-store.js";
import { InspectionAiService } from "./inspection-ai-service.js";
import { OrdinaryJiraAiService, type OrdinaryJiraAiIdentity } from "./ordinary-jira-ai-service.js";
import { OrdinaryJiraAiStore } from "./ordinary-jira-ai-store.js";
import { GitLabMrAiRepairService, type GitLabMrAiRepairIdentity } from "./gitlab-mr-ai-service.js";
import { GitLabMrAiRepairStore } from "./gitlab-mr-ai-store.js";
import { registerInspectionAiRoutes } from "./app-inspection-ai-routes.js";
import { registerOrdinaryJiraAiRoutes } from "./app-ordinary-jira-ai-routes.js";
import { registerGitLabMrAiRoutes } from "./app-gitlab-mr-ai-routes.js";
import { normalizeMergeRequestEvent, normalizeMergeRequestTerminalEvent } from "./webhook.js";
import { safeErrorMessage } from "./errors.js";
import { registerAssistantRoutes } from "./app-assistant-routes.js";
import { registerAssistantEditRoutes } from "./app-assistant-edit-routes.js";
import type { AppRouteContext } from "./app-route-context.js";
import {
  registerGitLabConnectionRoutes,
  registerModelConfigRoutes,
  registerReviewRulesRoutes,
} from "./app-settings-routes.js";
import { registerReviewRoutes } from "./app-review-routes.js";
import { registerInspectionRoutes } from "./app-inspection-routes.js";
import { registerGitLabRoutes } from "./app-gitlab-routes.js";
import { registerGitLabOAuthRoutes } from "./app-gitlab-oauth-routes.js";
import { registerFeedbackRoutes } from "./app-feedback-routes.js";
import { registerAuthRoutes } from "./app-auth-routes.js";
import { registerUserRoutes } from "./app-user-routes.js";
import { registerUserActivityRoutes } from "./app-user-activity-routes.js";
import { GitLabOAuthService, type GitLabOAuthServicePort } from "./gitlab-oauth.js";
import { GitLabOAuthSessionStore, type GitLabOAuthSessionStorePort } from "./gitlab-oauth-store.js";
import { JiraClient, type JiraClientPort } from "./jira-client.js";
import { JiraConnectionStore, type JiraConnectionStorePort } from "./jira-connection.js";
import { registerJiraRoutes } from "./app-jira-routes.js";
import { registerJiraOAuthRoutes } from "./app-jira-oauth-routes.js";
import { JiraUserCredentialStore, type JiraUserCredentialStorePort } from "./jira-user-credentials.js";
import { JiraOAuthService, type JiraOAuthServicePort } from "./jira-oauth.js";
import { JiraOAuthSessionStore, type JiraOAuthSessionStorePort } from "./jira-oauth-store.js";
import { DEFAULT_ADMIN_USERNAME, UserStore, type UserStorePort } from "./user-store.js";
import { classifyUserActivity, UserActivityStore, type UserActivityStorePort } from "./user-activity-store.js";
import { browserSessionUser } from "./app-route-utils.js";
import { FEEDBACK_MAX_ATTACHMENT_BYTES, FEEDBACK_MAX_ATTACHMENTS } from "./contracts.js";
import { BrowserSessionStore, setBrowserSessionRequestContext, type BrowserSessionStorePort } from "./browser-session-store.js";
import { ClaudeCliSessionManager } from "./claude-cli-session.js";
import { registerClaudeCliRoutes } from "./app-claude-cli-routes.js";

export interface AppDependencies {
  config: AppConfig;
  reviewService?: ReviewService;
  inspectionService?: InspectionService;
  gitlab?: GitLabClientPort;
  assistantRunner?: AssistantRunner;
  assistantStore?: AssistantStore;
  assistantEditStore?: AssistantEditStore;
  assistantEditService?: AssistantEditService;
  modelConfigStore?: ClaudeSettingsStore;
  gitlabConnectionStore?: GitLabConnectionStorePort;
  gitlabOAuthService?: GitLabOAuthServicePort;
  gitlabOAuthSessionStore?: GitLabOAuthSessionStorePort;
  jira?: JiraClientPort;
  jiraConnectionStore?: JiraConnectionStorePort;
  jiraUserCredentialStore?: JiraUserCredentialStorePort;
  jiraOAuthService?: JiraOAuthServicePort;
  jiraOAuthSessionStore?: JiraOAuthSessionStorePort;
  jiraClientForUser?: (productUsername: string) => JiraClientPort | null;
  reviewRulesStore?: ReviewRulesStorePort;
  inspectionRulesStore?: InspectionRulesStorePort;
  inspectionPromptStore?: InspectionPromptStorePort;
  feedbackStore?: FeedbackStorePort;
  userStore?: UserStorePort;
  userActivityStore?: UserActivityStorePort;
  browserSessionStore?: BrowserSessionStorePort;
  ordinaryJiraAiService?: OrdinaryJiraAiService;
  gitlabMrAiRepairService?: GitLabMrAiRepairService;
  claudeCli?: ClaudeCliSessionManager;
}

const REVIEW_SUBPROCESS_SECRET_KEY = /(?:^|_)(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY|API_KEY|ACCESS_KEY|CLIENT_SECRET|CREDENTIALS?|COOKIE|SESSION|AUTHORIZATION)(?:$|_)/i;
let claudeSessionMutationQueue = Promise.resolve();

function deleteClaudeReviewSession(configDir: string, sessionId: string): Promise<void> {
  const next = claudeSessionMutationQueue.then(async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      await deleteClaudeSession(sessionId);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
      if (code !== "ENOENT" && !/not found|no such file/i.test(safeErrorMessage(error, ""))) throw error;
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
  });
  claudeSessionMutationQueue = next.then(() => undefined, () => undefined);
  return next;
}

function reviewRunnerEnvironment(environment: NodeJS.ProcessEnv, databasePath: string): Record<string, string | undefined> {
  const inherited = Object.fromEntries(
    Object.entries(withoutClaudeSettingsEnvironment(environment))
      .filter(([key]) => !REVIEW_SUBPROCESS_SECRET_KEY.test(key)),
  );
  const normalizeSystemMessages = environment.CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES?.trim();
  return {
    ...inherited,
    ...(normalizeSystemMessages ? { CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES: normalizeSystemMessages } : {}),
    CLAUDE_CONFIG_DIR: environment.CLAUDE_CONFIG_DIR?.trim()
      || path.join(path.dirname(path.resolve(databasePath)), "claude"),
  };
}

async function hasClaudeConfiguration(config: AppConfig, modelConfigStore: ClaudeSettingsStore): Promise<boolean> {
  try {
    const env = (await modelConfigStore.read()).env;
    if (Boolean(
      env.ANTHROPIC_API_KEY
      || env.ANTHROPIC_AUTH_TOKEN
      || env.CLAUDE_CODE_USE_BEDROCK
      || env.CLAUDE_CODE_USE_VERTEX
      || env.CLAUDE_CODE_USE_FOUNDRY,
    )) return true;
  } catch {
    // Fall back to runtime credentials if the optional database store cannot be read.
  }
  return Boolean(config.anthropicApiKey || config.anthropicAuthToken);
}

export async function buildApp({
  config,
  reviewService,
  inspectionService: providedInspectionService,
  gitlab,
  assistantRunner: providedAssistantRunner,
  assistantStore: providedAssistantStore,
  assistantEditStore: providedAssistantEditStore,
  assistantEditService: providedAssistantEditService,
  modelConfigStore: providedModelConfigStore,
  gitlabConnectionStore: providedGitLabConnectionStore,
  gitlabOAuthService: providedGitLabOAuthService,
  gitlabOAuthSessionStore: providedGitLabOAuthSessionStore,
  jira: providedJira,
  jiraConnectionStore: providedJiraConnectionStore,
  jiraUserCredentialStore: providedJiraUserCredentialStore,
  jiraOAuthService: providedJiraOAuthService,
  jiraOAuthSessionStore: providedJiraOAuthSessionStore,
  jiraClientForUser: providedJiraClientForUser,
  reviewRulesStore: providedReviewRulesStore,
  inspectionRulesStore: providedInspectionRulesStore,
  inspectionPromptStore: providedInspectionPromptStore,
  feedbackStore: providedFeedbackStore,
  userStore: providedUserStore,
  userActivityStore: providedUserActivityStore,
  browserSessionStore: providedBrowserSessionStore,
  ordinaryJiraAiService: providedOrdinaryJiraAiService,
  gitlabMrAiRepairService: providedGitLabMrAiRepairService,
  claudeCli: providedClaudeCli,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 1_000_000,
  });
  await app.register(fastifyWebsocket);
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/") && !reply.getHeader("cache-control")) {
      reply.header("cache-control", "private, no-store");
    }
    return payload;
  });
  await app.register(multipart, {
    limits: {
      files: FEEDBACK_MAX_ATTACHMENTS,
      fileSize: FEEDBACK_MAX_ATTACHMENT_BYTES,
      fields: 8,
      parts: 12,
    },
    throwFileSizeLimit: true,
  });
  const gitlabConnectionStore = providedGitLabConnectionStore ?? new GitLabConnectionStore(process.cwd());
  const reviewRulesStore = providedReviewRulesStore ?? new ReviewRulesStore(config);
  const inspectionRulesStore = providedInspectionRulesStore ?? new InspectionRulesStore({
    rulesDir: config.inspectionRulesDir,
    profileConfigPath: config.inspectionProfileConfigPath,
  });
  const inspectionPromptStore = providedInspectionPromptStore ?? new InspectionPromptStore({
    promptDir: config.inspectionPromptsDir ?? path.resolve(process.cwd(), "var/inspection-prompts"),
    legacyOwnerPromptPath: config.inspectionOwnerPromptPath,
  });
  const fallbackGitLabConnection = {
    apiBaseUrl: config.gitlabApiBaseUrl,
    token: config.gitlabToken,
  };
  const initialGitLabConnection = await gitlabConnectionStore.read(fallbackGitLabConnection);
  const gitlabClient = gitlab ?? new GitLabClient({
    baseUrl: initialGitLabConnection.apiBaseUrl,
    token: initialGitLabConnection.token,
  });
  const gitlabOAuthSessionStore = providedGitLabOAuthSessionStore
    ?? (!providedGitLabOAuthService ? new GitLabOAuthSessionStore(config.reviewDatabasePath, config.triggerToken) : undefined);
  const ownsGitLabOAuthSessionStore = !providedGitLabOAuthSessionStore && Boolean(gitlabOAuthSessionStore);
  const ownsAssistantEditStore = !providedAssistantEditStore;
  const assistantEditStore = providedAssistantEditStore ?? new AssistantEditStore(config.reviewDatabasePath);
  const assistantEditService = providedAssistantEditService ?? new AssistantEditService(
    assistantEditStore,
    new GitAssistantEditWorkspaceProvider({
      environment: config.environment,
      rootDir: config.assistantWorkspaceDir,
      fetchDepth: config.gitFetchDepth,
    }),
  );
  const gitlabOAuth = providedGitLabOAuthService ?? new GitLabOAuthService({
    baseUrl: initialGitLabConnection.baseUrl,
    apiBaseUrl: initialGitLabConnection.apiBaseUrl,
    clientId: config.gitlabOAuthClientId,
    clientSecret: config.gitlabOAuthClientSecret,
    redirectUri: config.gitlabOAuthRedirectUri,
    scope: config.gitlabOAuthScope,
  }, fetch, gitlabOAuthSessionStore);
  const jiraConnectionStore = providedJiraConnectionStore ?? new JiraConnectionStore(process.cwd());
  const fallbackJiraConnection = {
    baseUrl: config.jiraBaseUrl,
    apiBaseUrl: config.jiraApiBaseUrl,
    projectKey: config.jiraProjectKey,
    username: config.jiraUsername,
    token: config.jiraToken,
  };
  const initialJiraConnection = await jiraConnectionStore.read(fallbackJiraConnection);
  const jiraClient = providedJira ?? new JiraClient(initialJiraConnection);
  const jiraUserCredentialStore = providedJiraUserCredentialStore ?? new JiraUserCredentialStore(config.reviewDatabasePath, config.triggerToken);
  const jiraOAuthSessionStore = providedJiraOAuthSessionStore
    ?? (!providedJiraOAuthService ? new JiraOAuthSessionStore(config.reviewDatabasePath, config.triggerToken) : undefined);
  const ownsJiraOAuthSessionStore = !providedJiraOAuthSessionStore && Boolean(jiraOAuthSessionStore);
  const jiraOAuth = providedJiraOAuthService ?? new JiraOAuthService({
    baseUrl: initialJiraConnection.baseUrl,
    apiBaseUrl: initialJiraConnection.apiBaseUrl,
    consumerKey: config.jiraOAuthConsumerKey ?? "",
    privateKey: config.jiraOAuthPrivateKey ?? "",
    redirectUri: config.jiraOAuthRedirectUri ?? `${config.webOrigin}/api/v1/jira/oauth/callback`,
  }, fetch, jiraOAuthSessionStore);
  const jiraUserClients = new Map<string, { cacheKey: string; client: JiraClientPort }>();
  const resolveJiraClientForUser = (productUsername: string): JiraClientPort | null => {
    const credential = jiraUserCredentialStore.read(productUsername);
    const normalizedUsername = productUsername.trim().toLowerCase();
    if (!credential || !normalizedUsername) {
      jiraUserClients.delete(normalizedUsername);
      return null;
    }
    const cacheKey = [
      initialJiraConnection.baseUrl,
      initialJiraConnection.apiBaseUrl,
      initialJiraConnection.projectKey,
      credential.jiraUsername,
      credential.updatedAt,
    ].join("\u0000");
    const cached = jiraUserClients.get(normalizedUsername);
    if (cached?.cacheKey === cacheKey) return cached.client;
    const client = new JiraClient({
      ...initialJiraConnection,
      username: credential.jiraUsername,
      token: credential.token,
    });
    jiraUserClients.set(normalizedUsername, { cacheKey, client });
    return client;
  };
  const jiraClientForUser = providedJiraClientForUser ?? resolveJiraClientForUser;
  const ownsReviewService = !reviewService;
  const reviewStore = ownsReviewService ? new ReviewStore(config.reviewDatabasePath) : undefined;
  const workspaceProvider = config.dryRun ? undefined : new GitReviewWorkspaceProvider({
    environment: config.environment,
    rootDir: config.reviewWorkspaceDir,
    gitlabApiBaseUrl: initialGitLabConnection.apiBaseUrl,
    gitlabToken: initialGitLabConnection.token,
    fullHistory: true,
  });
  const ownsModelConfigStore = !providedModelConfigStore;
  const modelConfigStore = providedModelConfigStore ?? new DatabaseClaudeSettingsStore(
    config.reviewDatabasePath,
    claudeSettingsFromEnvironment({
      ...(config.environment ?? {}),
      ANTHROPIC_API_KEY: config.anthropicApiKey,
      ANTHROPIC_AUTH_TOKEN: config.anthropicAuthToken,
      CLAUDE_MODEL: config.claudeModel,
      CLAUDE_THINKING_MODE: config.claudeThinkingMode,
      CLAUDE_THINKING_BUDGET_TOKENS: String(config.claudeThinkingBudgetTokens),
      CLAUDE_MAX_TOKENS: String(config.claudeMaxTokens),
      CLAUDE_MAX_RETRIES: String(config.claudeMaxRetries),
    }),
  );
  const modelSettingsProvider = async () => {
    const settings = await modelConfigStore.read();
    const model = settings.model?.trim();
    return model ? { ...settings.env, ANTHROPIC_MODEL: model } : settings.env;
  };
  const ownsClaudeCli = !providedClaudeCli;
  const claudeCli = providedClaudeCli ?? new ClaudeCliSessionManager({
    command: config.claudeCliPath,
    fetchDepth: config.gitFetchDepth,
    previewHost: config.host,
    rootDir: config.claudeCliWorkspaceDir,
    environment: withoutClaudeSettingsEnvironment(config.environment ?? {}),
    settingsProvider: modelSettingsProvider,
  });
  const runnerEnvironment = withoutClaudeSettingsEnvironment(config.environment ?? {});
  const reviewEnvironment = reviewRunnerEnvironment(config.environment ?? {}, config.reviewDatabasePath);
  const reviewClaudeConfigDir = reviewEnvironment.CLAUDE_CONFIG_DIR?.trim();
  const reviewRunner = config.dryRun
    ? new DryRunReviewRunner()
    : new ClaudeAgentSdkReviewRunner({
      environment: reviewEnvironment,
      cwd: process.cwd(),
      settingsProvider: modelSettingsProvider,
      inspectionOwnershipPrompt: async (ownerId) => (await inspectionPromptStore.read(INSPECTION_OWNER_PROMPT_ID, ownerId)).content,
      inspectionJiraDescriptionPrompt: async (ownerId) => (await inspectionPromptStore.read(INSPECTION_JIRA_DESCRIPTION_PROMPT_ID, ownerId)).content,
      inspectionJiraFieldsPrompt: async (ownerId) => (await inspectionPromptStore.read(INSPECTION_JIRA_FIELDS_PROMPT_ID, ownerId)).content,
      mergeRequestDescriptionPrompt: async (ownerId) => (await inspectionPromptStore.read(MERGE_REQUEST_DESCRIPTION_PROMPT_ID, ownerId)).content,
    });
  const service = reviewService ?? new ReviewService({
    gitlab: gitlabClient,
    store: reviewStore,
    runner: reviewRunner,
    workspaceProvider,
    config,
    deleteReviewSession: reviewClaudeConfigDir
      ? (sessionId) => deleteClaudeReviewSession(reviewClaudeConfigDir, sessionId)
      : undefined,
  });
  const ownsUserStore = !providedUserStore;
  const adminPassword = config.environment?.FRONTEND_PILOT_ADMIN_PASSWORD ?? config.loginPassword;
  const passwordDisplayKey = config.environment?.FRONTEND_PILOT_PASSWORD_DISPLAY_KEY ?? config.triggerToken;
  const userStore = providedUserStore ?? new UserStore(config.reviewDatabasePath, [
    { username: DEFAULT_ADMIN_USERNAME, password: adminPassword, role: "admin" },
    { username: config.loginUsername, password: config.loginPassword, role: "user" },
  ], passwordDisplayKey);
  const browserSessionStore = providedBrowserSessionStore
    ?? new BrowserSessionStore(config.reviewDatabasePath, config.authSessionSecret || config.triggerToken);
  const ownsBrowserSessionStore = !providedBrowserSessionStore;
  const inspectionAccounts = new InspectionAccounts(config, userStore, initialGitLabConnection, initialJiraConnection);
  const ownsInspectionService = !providedInspectionService;
  const inspectionStore = ownsInspectionService ? new InspectionStore(config.reviewDatabasePath) : undefined;
  const inspectionService = providedInspectionService ?? new InspectionService({
    resolveDependencies: (identity) => inspectionAccounts.dependencies(identity),
    resolveJiraClient: (identity) => inspectionAccounts.jiraClient(identity.maintainerId!),
    validateIdentity: (identity) => inspectionAccounts.assertIdentity(identity),
    runner: reviewRunner,
    promptRunner: reviewRunner,
    store: inspectionStore,
    inspectionRulesStore,
    config: {
      rulesDir: config.inspectionRulesDir,
      profileConfigPath: config.inspectionProfileConfigPath,
    },
  });
  const assistantRunner = providedAssistantRunner
    ?? (config.dryRun
      ? new DryRunAssistantRunner()
      : new ClaudeAgentSdkAssistantRunner({
        environment: runnerEnvironment,
        thinkingMode: config.claudeThinkingMode,
        thinkingBudgetTokens: config.claudeThinkingBudgetTokens,
        idleTimeoutMs: config.assistantIdleTimeoutMs,
        cwd: process.cwd(),
        settingsProvider: modelSettingsProvider,
        assistantToolContext: {
          reviewService: service,
          gitlab: gitlabClient,
          reviewRules: reviewRulesStore,
          jira: jiraClient,
          jiraConfigured: () => Boolean(initialJiraConnection.token),
          jiraProjectKey: () => initialJiraConnection.projectKey,
        },
        assistantToolContextFactory: async (runtimeContext: AssistantRuntimeContext | undefined) => {
          const oauthJiraClient = runtimeContext?.getJiraClient ? await runtimeContext.getJiraClient() : null;
          const personalJiraClient = oauthJiraClient ?? (runtimeContext?.productUsername ? jiraClientForUser(runtimeContext.productUsername) : null);
          const jiraAvailable = runtimeContext?.productUsername ? Boolean(personalJiraClient) : Boolean(initialJiraConnection.token);
          return {
            reviewService: service,
            gitlab: gitlabClient,
            reviewRules: reviewRulesStore,
            jira: personalJiraClient ?? jiraClient,
            jiraConfigured: () => jiraAvailable,
            jiraProjectKey: () => initialJiraConnection.projectKey,
            gitlabWorkbench: runtimeContext?.getGitLabClient,
          };
        },
      }));
  const ownsAssistantStore = !providedAssistantStore;
  const assistantStore = providedAssistantStore ?? new AssistantStore(config.reviewDatabasePath);
  const ownsFeedbackStore = !providedFeedbackStore;
  const feedbackStore = providedFeedbackStore ?? new FeedbackStore(config.reviewDatabasePath);
  const ownsUserActivityStore = !providedUserActivityStore;
  const userActivityStore = providedUserActivityStore ?? new UserActivityStore(config.reviewDatabasePath);
  const assistantExecution = new AssistantExecutionManager(assistantRunner, assistantStore);
  const inspectionAiStore = new InspectionAiStore(config.reviewDatabasePath);
  const inspectionAi = new InspectionAiService({ store: inspectionAiStore, inspection: inspectionService,
    edits: assistantEditService, assistant: assistantStore, execution: assistantExecution,
    concurrency: config.inspectionAiConcurrency,
    verificationPollIntervalMs: config.inspectionAiVerificationPollIntervalMs,
    verificationTimeoutMs: config.inspectionAiVerificationTimeoutMs,
    maxPreSubmitRepairAttempts: config.inspectionAiMaxPreSubmitRepairAttempts,
    reviewJobNames: config.inspectionAiReviewJobNames,
    promptRunner: reviewRunner,
    preSubmitReview: reviewRunner,
    reviewDecisionRunner: reviewRunner,
    reviewProfile: async (projectPath) => {
      const profile = await reviewRulesStore.readForProject(projectPath);
      return { name: profile.name, displayName: profile.displayName, rules: profile.rules };
    },
    validateIdentity: (identity) => inspectionAccounts.assertIdentity(identity),
    dependencies: async (identity) => {
      inspectionAccounts.assertIdentity(identity);
      const gitlab = await inspectionAccounts.gitlab.getClient(identity.maintainerId!);
      const connection = await inspectionAccounts.gitlab.getConnection(identity.maintainerId!);
      const jira = inspectionAccounts.jiraClient(identity.maintainerId!);
      if (!gitlab || !connection) throw new Error("请先连接维护人员的 GitLab 账号");
      return { gitlab, connection, jira };
    },
  });
  const ownsOrdinaryJiraAiService = !providedOrdinaryJiraAiService;
  const ownsOrdinaryJiraAiStore = ownsOrdinaryJiraAiService;
  const ordinaryJiraAiStore = ownsOrdinaryJiraAiStore ? new OrdinaryJiraAiStore(config.reviewDatabasePath) : undefined;
  const ordinaryJiraAi = providedOrdinaryJiraAiService ?? new OrdinaryJiraAiService({
    store: ordinaryJiraAiStore!,
    edits: assistantEditService,
    assistant: assistantStore,
    execution: assistantExecution,
    precheckRunner: reviewRunner,
    preSubmitReview: reviewRunner,
    promptRunner: reviewRunner,
    reviewDecisionRunner: reviewRunner,
    reviewProfile: async (projectPath) => {
      const profile = await reviewRulesStore.readForProject(projectPath);
      return { name: profile.name, displayName: profile.displayName, rules: profile.rules };
    },
    concurrency: config.inspectionAiConcurrency,
    verificationPollIntervalMs: config.inspectionAiVerificationPollIntervalMs,
    verificationTimeoutMs: config.inspectionAiVerificationTimeoutMs,
    maxPreSubmitRepairAttempts: config.inspectionAiMaxPreSubmitRepairAttempts,
    reviewJobNames: config.inspectionAiReviewJobNames,
    dependencies: async (identity: OrdinaryJiraAiIdentity) => {
      const sessionKey = `product:${identity.userId}`;
      const gitlab = await gitlabOAuth.getClient(sessionKey);
      const connection = await gitlabOAuth.getConnection?.(sessionKey);
      const jira = await jiraOAuth.getClient(sessionKey) ?? jiraClientForUser(identity.username);
      if (!gitlab || !connection) throw new Error("请先连接你的 GitLab 账号");
      if (!jira) throw new Error("请先连接你的 Jira 账号");
      return { gitlab, connection, jira };
    },
  });
  const ownsGitLabMrAiRepairService = !providedGitLabMrAiRepairService;
  const ownsGitLabMrAiRepairStore = ownsGitLabMrAiRepairService;
  const gitlabMrAiRepairStore = ownsGitLabMrAiRepairStore ? new GitLabMrAiRepairStore(config.reviewDatabasePath) : undefined;
  const gitlabMrAiRepair = providedGitLabMrAiRepairService ?? new GitLabMrAiRepairService({
    store: gitlabMrAiRepairStore!,
    edits: assistantEditService,
    assistant: assistantStore,
    execution: assistantExecution,
    concurrency: config.inspectionAiConcurrency,
    verificationPollIntervalMs: config.inspectionAiVerificationPollIntervalMs,
    verificationTimeoutMs: config.inspectionAiVerificationTimeoutMs,
    reviewJobNames: config.inspectionAiReviewJobNames,
    reviewDecisionRunner: reviewRunner,
    dependencies: async (identity: GitLabMrAiRepairIdentity) => {
      const sessionKey = `product:${identity.userId}`;
      const gitlab = await gitlabOAuth.getClient(sessionKey);
      const connection = await gitlabOAuth.getConnection?.(sessionKey);
      if (!gitlab || !connection) throw new Error("请先连接你的 GitLab 账号");
      return { gitlab, connection };
    },
  });
  app.addHook("onClose", async () => {
    await inspectionAi.close();
    inspectionAiStore.close();
    if (ownsOrdinaryJiraAiService) await ordinaryJiraAi.close();
    if (ownsOrdinaryJiraAiStore) ordinaryJiraAiStore!.close();
    if (ownsGitLabMrAiRepairService) await gitlabMrAiRepair.close();
    if (ownsGitLabMrAiRepairStore) gitlabMrAiRepairStore!.close();
    if (ownsReviewService) await service.close();
    if (ownsInspectionService) await inspectionService.close();
    inspectionAccounts.close();
    await assistantExecution.close();
    await assistantRunner.close?.();
    if (ownsClaudeCli) await claudeCli.close();
    if (ownsAssistantStore) assistantStore.close();
    if (ownsAssistantEditStore) assistantEditStore.close();
    if (ownsFeedbackStore) feedbackStore.close();
    if (ownsInspectionService) inspectionStore?.close();
    if (ownsModelConfigStore) await modelConfigStore.close?.();
    if (ownsGitLabOAuthSessionStore) gitlabOAuthSessionStore?.close();
    if (ownsJiraOAuthSessionStore) jiraOAuthSessionStore?.close();
    if (!providedJiraUserCredentialStore) jiraUserCredentialStore.close();
    if (ownsUserStore) userStore.close();
    if (ownsUserActivityStore) userActivityStore.close();
    if (ownsBrowserSessionStore) browserSessionStore.close();
  });
  const claudeState = { configured: await hasClaudeConfiguration(config, modelConfigStore) };

  app.addHook("preHandler", async (request) => {
    const rawSession = cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
    if (!rawSession) return;
    const session = browserSessionStore.read(rawSession);
    if (session) {
      setBrowserSessionRequestContext(request, {
        sessionKey: session.sessionKey,
        userId: session.id,
        username: session.username,
      });
      return;
    }
    // Promote a still-valid legacy browser session's GitLab credential to the
    // stable product-user owner key during the first request after upgrade.
    const legacyUser = browserSessionUser(request, config, userStore);
    if (legacyUser) {
      const legacyKey = tokenHash(rawSession);
      const productKey = `product:${legacyUser.id}`;
      gitlabOAuth.adoptSession?.(legacyKey, productKey);
      jiraOAuth.adoptSession?.(legacyKey, productKey);
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const action = classifyUserActivity(request.method, request.url);
    if (!action || reply.statusCode >= 400) return;
    const user = browserSessionUser(request, config, userStore);
    if (!user) return;
    const routePath = typeof request.routeOptions.url === "string"
      ? request.routeOptions.url
      : request.url.split("?", 1)[0];
    try {
      userActivityStore.record({ username: user.username, action, path: routePath });
    } catch (error) {
      request.log.warn({ err: error }, "failed to record user activity");
    }
  });

  await app.register(cors, {
    origin: config.webOrigin === "*" ? true : config.webOrigin,
    credentials: true,
  });

  const indexPath = path.join(config.webDistDir, "index.html");
  const hasWebBuild = fs.existsSync(indexPath);
  if (hasWebBuild) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: "/",
      decorateReply: false,
    });
  }

  app.get("/healthz", async (_request, reply) => reply.send({
    status: "ok",
    dryRun: config.dryRun,
    gitlabConfigured: Boolean(initialGitLabConnection.token),
    claudeConfigured: claudeState.configured,
    ...service.stats(),
  }));

  app.post("/webhooks/gitlab", async (request, reply) => {
    if (!config.webhookSecret && !config.allowInsecureWebhooks) {
      return reply.code(503).send({ error: "webhook_secret_not_configured" });
    }
    const token = headerValue(request.headers["x-gitlab-token"]);
    if (config.webhookSecret && !secureEqual(token, config.webhookSecret)) {
      return reply.code(401).send({ error: "invalid_webhook_token" });
    }
    const terminalEvent = normalizeMergeRequestTerminalEvent(request.body);
    if (terminalEvent) {
      await service.cleanupMergeRequest(terminalEvent.projectId, terminalEvent.mrIid, terminalEvent.action);
      return reply.code(202).send({ accepted: true, cleaned: true, action: terminalEvent.action });
    }
    const event = normalizeMergeRequestEvent(request.body);
    if (!event) return reply.code(202).send({ accepted: false, reason: "unsupported_event" });
    try {
      const result = await service.enqueue(event);
      return reply.code(202).send({ accepted: true, ...result });
    } catch (error) {
      if (error instanceof ReviewTerminalError) {
        return reply.code(202).send({ accepted: false, reason: "merge_request_terminal", state: error.state });
      }
      throw error;
    }
  });

  const routeContext: AppRouteContext = {
    config,
    service,
    inspectionService,
    inspectionAccounts,
    inspectionAi,
    ordinaryJiraAi,
    gitlabMrAiRepair,
    gitlabClient,
    gitlabOAuth,
    jiraClient,
    jiraClientForUser,
    jiraConnectionStore,
    jiraUserCredentialStore,
    jiraOAuth,
    fallbackJiraConnection,
    initialJiraConnection,
    reviewRulesStore,
    inspectionRulesStore,
    inspectionPromptStore,
    promptRunner: reviewRunner,
    gitlabConnectionStore,
    fallbackGitLabConnection,
    initialGitLabConnection,
    workspaceProvider,
    assistantEditService,
    assistantStore,
    assistantExecution,
    modelConfigStore,
    feedbackStore,
    userStore,
    userActivityStore,
    browserSessionStore,
    claudeState,
    claudeCli,
  };
  registerAuthRoutes(app, routeContext);
  registerModelConfigRoutes(app, routeContext);
  registerReviewRulesRoutes(app, routeContext);
  registerGitLabConnectionRoutes(app, routeContext);
  registerGitLabOAuthRoutes(app, routeContext);
  registerGitLabRoutes(app, routeContext);
  registerJiraRoutes(app, routeContext);
  registerJiraOAuthRoutes(app, routeContext);
  registerAssistantRoutes(app, routeContext);
  registerAssistantEditRoutes(app, routeContext);
  registerClaudeCliRoutes(app, routeContext);
  registerFeedbackRoutes(app, routeContext);
  registerUserRoutes(app, routeContext);
  registerUserActivityRoutes(app, routeContext);
  registerReviewRoutes(app, routeContext);
  registerInspectionAccountRoutes(app, routeContext);
  registerInspectionRoutes(app, routeContext);
  registerInspectionAiRoutes(app, routeContext);
  registerOrdinaryJiraAiRoutes(app, routeContext);
  registerGitLabMrAiRoutes(app, routeContext);

  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept?.includes("text/html");
    if (hasWebBuild && request.method === "GET" && acceptsHtml && !request.url.startsWith("/api/")) {
      return reply.type("text/html").send(fs.readFileSync(indexPath));
    }
    return reply.code(404).send({ error: "not_found" });
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ message: safeErrorMessage(error, "internal server error") }, "request failed");
    return reply.code(500).send({ error: "internal_server_error" });
  });

  return app;
}
