import {
  query as claudeQuery,
  resolveSettings,
  type Options as ClaudeAgentOptions,
  type SDKMessage,
  type SettingSource,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  buildInspectionPrompt,
  buildPreSubmitReviewPrompt,
  buildReviewPrompt,
  PreSubmitReviewOutputSchema,
  ReviewFindingSchema,
  ReviewOutputSchema,
  ReviewRuleResultSchema,
} from "./review-prompt.js";
import type {
  InspectionRunner,
  InspectionRunnerInput,
  PreSubmitReviewRunner,
  ReviewRunner,
  ReviewRunnerInput,
  ReviewRunnerRunOptions,
} from "./contracts.js";
import { safeErrorMessage } from "./errors.js";
import { prepareClaudeGatewayCompatibility, type ClaudeGatewayCompatibilityHandle } from "./claude-gateway-compat.js";
import { closeAssistantText, type SdkProgressState } from "./review-progress-utils.js";
import { emitSdkProgress } from "./review-sdk-progress.js";
import {
  createInspectionFindingToolServer,
  INSPECTION_REPORT_FINDING_TOOL_NAME,
  INSPECTION_TOOL_SERVER_NAME,
  type InspectionFindingToolReporter,
} from "./inspection-tool-server.js";
import type { ClaudeSettingsProvider } from "./model-config.js";
import { InspectionFindingScopeSchema } from "./api-contracts.js";
import { buildInspectionOwnershipPrompt, createInspectionOwnerToolServer, InspectionOwnerOutputSchema, type InspectionOwnershipInput, type InspectionOwnershipResult } from "./inspection-owner-tools.js";
import { buildInspectionDuplicatePrompt, InspectionDuplicateDecisionSchema, type InspectionDuplicateInput, type InspectionDuplicateDecision } from "./inspection-duplicates.js";
import {
  buildInspectionJiraCreatePrompt,
  buildMergeRequestDescriptionPrompt,
  MergeRequestDescriptionOutputSchema,
  normalizeInspectionJiraCreatePlan,
  normalizeMergeRequestDescription,
  InspectionJiraCreatePlanSchema,
  type InspectionJiraCreatePlan,
  type InspectionJiraCreatePromptInput,
  type ManagedPromptRunner,
  type MergeRequestDescriptionPromptInput,
} from "./prompt-generation.js";
import {
  buildJiraAiPrecheckPrompt,
  buildJiraAiPrecheckSupplementPrompt,
  JiraAiPrecheckModelOutputSchema,
  JiraAiPrecheckSupplementModelOutputSchema,
  normalizeJiraAiPrecheckOutput,
  normalizeJiraAiPrecheckSupplementOutput,
  ORDINARY_JIRA_AI_CHECKS,
  type JiraAiPrecheckInput,
  type JiraAiPrecheckResult,
  type JiraAiPrecheckSupplementInput,
  type JiraAiPrecheckSupplementResult,
} from "./jira-ai-precheck.js";
import {
  buildGitLabReviewDecisionPrompt,
  GitLabReviewDecisionSchema,
  type GitLabReviewDecision,
  type GitLabReviewDecisionInput,
  type GitLabReviewDecisionRunner,
} from "./gitlab-review-decision.js";

export class ReviewRunnerError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ReviewRunnerError";
  }
}

const InspectionFindingSchema = ReviewFindingSchema.extend({
  scope: InspectionFindingScopeSchema.optional(),
  relatedPaths: z.array(z.string()).optional(),
});
const InspectionRuleResultSchema = ReviewRuleResultSchema.extend({ findings: z.array(InspectionFindingSchema) });
const InspectionOutputSchema = ReviewOutputSchema.extend({
  ruleResults: z.array(InspectionRuleResultSchema).default([]),
  findings: z.array(InspectionFindingSchema),
});

const SDK_EVENT_LOOP_YIELD_INTERVAL = 16;

type AgentQuery = (params: { prompt: string; options?: ClaudeAgentOptions }) => AsyncIterable<SDKMessage>;

export interface ClaudeAgentSdkReviewRunnerOptions {
  environment?: Record<string, string | undefined>;
  apiKey?: string;
  authToken?: string;
  model?: string;
  cwd?: string;
  settingsCwd?: string;
  settingSources?: SettingSource[];
  settingsProvider?: ClaudeSettingsProvider;
  inspectionOwnershipPrompt?: (ownerId?: string) => Promise<string>;
  inspectionJiraDescriptionPrompt?: (ownerId?: string) => Promise<string>;
  inspectionJiraFieldsPrompt?: (ownerId?: string) => Promise<string>;
  mergeRequestDescriptionPrompt?: (ownerId?: string) => Promise<string>;
  query?: AgentQuery;
}

function errorMessage(error: unknown): string {
  return safeErrorMessage(error, "未知错误");
}

function decodeRawResult(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ReviewRunnerError(
      `Claude Agent SDK returned invalid review JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export class ClaudeAgentSdkReviewRunner implements ReviewRunner, PreSubmitReviewRunner, InspectionRunner, ManagedPromptRunner, GitLabReviewDecisionRunner {
  private readonly apiKey: string | undefined;
  private readonly authToken: string | undefined;
  private readonly environment: Record<string, string | undefined>;
  private readonly model: string | undefined;
  private readonly cwd: string;
  private readonly settingsCwd: string;
  private readonly settingSources: SettingSource[];
  private readonly settingsProvider: ClaudeSettingsProvider | undefined;
  private readonly inspectionOwnershipPrompt: ((ownerId?: string) => Promise<string>) | undefined;
  private readonly inspectionJiraDescriptionPrompt: ((ownerId?: string) => Promise<string>) | undefined;
  private readonly inspectionJiraFieldsPrompt: ((ownerId?: string) => Promise<string>) | undefined;
  private readonly mergeRequestDescriptionPrompt: ((ownerId?: string) => Promise<string>) | undefined;
  private readonly query: AgentQuery;

  constructor({
    environment = {},
    apiKey,
    authToken,
    model,
    cwd = process.cwd(),
    settingsCwd = process.cwd(),
    settingSources = ["user", "project"],
    settingsProvider,
    inspectionOwnershipPrompt,
    inspectionJiraDescriptionPrompt,
    inspectionJiraFieldsPrompt,
    mergeRequestDescriptionPrompt,
    query = claudeQuery,
  }: ClaudeAgentSdkReviewRunnerOptions = {}) {
    this.apiKey = apiKey?.trim() || undefined;
    this.authToken = authToken?.trim() || undefined;
    this.environment = environment;
    this.model = model?.trim() || undefined;
    this.cwd = cwd;
    this.settingsCwd = settingsCwd;
    this.settingSources = settingSources;
    this.settingsProvider = settingsProvider;
    this.inspectionOwnershipPrompt = inspectionOwnershipPrompt;
    this.inspectionJiraDescriptionPrompt = inspectionJiraDescriptionPrompt;
    this.inspectionJiraFieldsPrompt = inspectionJiraFieldsPrompt;
    this.mergeRequestDescriptionPrompt = mergeRequestDescriptionPrompt;
    this.query = query;
  }

  async run(input: ReviewRunnerInput, options: ReviewRunnerRunOptions = {}): Promise<string> {
    const prompt = options.resumeSessionId
      ? [
        "继续同一个 MR 的审查会话。当前工作区已经更新，请先自主检查当前 Git 状态、提交历史和实际变更，识别本轮新增提交后再复核上一轮结论。",
        "不要机械重复已经修复的问题，只报告当前仍然存在或新产生的明确问题。",
        buildReviewPrompt(input),
      ].join("\n")
      : buildReviewPrompt(input);
    return this.runPrompt(prompt, input.workspacePath, options, "审查", undefined, ReviewOutputSchema, undefined, false, undefined, "claude-code");
  }

  async runPreSubmitReview(input: Parameters<PreSubmitReviewRunner["runPreSubmitReview"]>[0], options: ReviewRunnerRunOptions = {}): Promise<string> {
    return this.runPrompt(buildPreSubmitReviewPrompt(input), input.workspacePath, options, "提交前 Review", undefined, PreSubmitReviewOutputSchema, undefined, true);
  }

  async resolveInspectionOwners(input: InspectionOwnershipInput, options: ReviewRunnerRunOptions = {}): Promise<InspectionOwnershipResult[]> {
    const lookup = createInspectionOwnerToolServer(input);
    const configuredPrompt = await this.inspectionOwnershipPrompt?.(options.ownerId);
    const raw = await this.runPrompt(buildInspectionOwnershipPrompt(input, configuredPrompt), null, options, "负责人判断", undefined, InspectionOwnerOutputSchema, lookup);
    input.validate();
    return lookup.results(InspectionOwnerOutputSchema.parse(JSON.parse(raw)));
  }

  async generateInspectionJiraCreatePlan(input: InspectionJiraCreatePromptInput, options: ReviewRunnerRunOptions = {}): Promise<InspectionJiraCreatePlan> {
    const [descriptionPrompt, fieldsPrompt] = await Promise.all([
      this.inspectionJiraDescriptionPrompt?.(options.ownerId),
      this.inspectionJiraFieldsPrompt?.(options.ownerId),
    ]);
    const raw = await this.runPrompt(
      buildInspectionJiraCreatePrompt(input, descriptionPrompt, fieldsPrompt),
      null,
      options,
      "Jira 创建内容",
      undefined,
      InspectionJiraCreatePlanSchema,
      null,
    );
    return normalizeInspectionJiraCreatePlan(JSON.parse(raw), input);
  }

  async generateMergeRequestDescription(input: MergeRequestDescriptionPromptInput, options: ReviewRunnerRunOptions = {}): Promise<string> {
    const configuredPrompt = await this.mergeRequestDescriptionPrompt?.(options.ownerId);
    const raw = await this.runPrompt(
      buildMergeRequestDescriptionPrompt(input, configuredPrompt),
      null,
      options,
      "MR 描述",
      undefined,
      MergeRequestDescriptionOutputSchema,
      null,
    );
    const output = MergeRequestDescriptionOutputSchema.parse(JSON.parse(raw));
    return normalizeMergeRequestDescription(output.description, input);
  }

  async runJiraAiPrecheck(input: JiraAiPrecheckInput, options: ReviewRunnerRunOptions = {}): Promise<JiraAiPrecheckResult> {
    const raw = await this.runPrompt(
      buildJiraAiPrecheckPrompt(input),
      null,
      options,
      "Jira AI 预检查",
      undefined,
      JiraAiPrecheckModelOutputSchema,
      null,
      true,
    );
    return normalizeJiraAiPrecheckOutput(JSON.parse(raw));
  }

  async runJiraAiPrecheckSupplement(input: JiraAiPrecheckSupplementInput, options: ReviewRunnerRunOptions = {}): Promise<JiraAiPrecheckSupplementResult> {
    const raw = await this.runPrompt(
      buildJiraAiPrecheckSupplementPrompt(input),
      null,
      options,
      "Jira AI 缺失项补充判断",
      undefined,
      JiraAiPrecheckSupplementModelOutputSchema,
      null,
      true,
    );
    return normalizeJiraAiPrecheckSupplementOutput(JSON.parse(raw));
  }

  async resolveInspectionDuplicates(input: InspectionDuplicateInput, options: ReviewRunnerRunOptions = {}): Promise<InspectionDuplicateDecision> {
    const raw = await this.runPrompt(buildInspectionDuplicatePrompt(input), null, options, "问题去重", undefined, InspectionDuplicateDecisionSchema, null);
    return InspectionDuplicateDecisionSchema.parse(JSON.parse(raw));
  }

  async judgeGitLabReview(input: GitLabReviewDecisionInput, options: ReviewRunnerRunOptions = {}): Promise<GitLabReviewDecision> {
    const raw = await this.runPrompt(
      buildGitLabReviewDecisionPrompt(input),
      null,
      options,
      "Pipeline Review 判断",
      undefined,
      GitLabReviewDecisionSchema,
      null,
      true,
      1,
    );
    return GitLabReviewDecisionSchema.parse(JSON.parse(raw));
  }

  async runInspection(input: InspectionRunnerInput, options: ReviewRunnerRunOptions = {}): Promise<string> {
    const rules = input.profile.rules.filter((rule) => rule.enabled);
    if (rules.length <= 1) {
      const reporter = rules[0] && options.onInspectionFinding
        ? (finding: Parameters<InspectionFindingToolReporter>[0]) => options.onInspectionFinding!(rules[0].id, finding)
        : undefined;
      return this.runPrompt(buildInspectionPrompt(input), input.workspacePath, options, "巡检", reporter, InspectionOutputSchema);
    }

    const ruleResults: Array<z.infer<typeof InspectionRuleResultSchema>> = [];
    const findings: Array<z.infer<typeof InspectionFindingSchema>> = [];
    const summaries: string[] = [];
    for (const rule of rules) {
      options.onProgress?.({
        kind: "stage",
        message: `开始独立巡检：${rule.name}`,
        detail: rule.description || "按该规则提示词进行独立取证",
        meta: { inspectionRuleId: rule.id, inspectionRuleName: rule.name },
      });
      const raw = await this.runPrompt(
        buildInspectionPrompt({ ...input, profile: { ...input.profile, rules: [rule] } }),
        input.workspacePath,
        {
          ...options,
          onProgress: options.onProgress
            ? (event) => options.onProgress?.({
              ...event,
              detail: event.detail ? `${rule.name} · ${event.detail}` : rule.name,
              meta: { ...(event.meta ?? {}), inspectionRuleId: rule.id, inspectionRuleName: rule.name },
            })
            : undefined,
        },
        "巡检",
        options.onInspectionFinding
          ? (finding) => options.onInspectionFinding!(rule.id, finding)
          : undefined,
        InspectionOutputSchema,
      );
      const parsed = InspectionOutputSchema.parse(JSON.parse(raw));
      const candidate = parsed.ruleResults.find((result) => result.ruleId === rule.id || result.ruleName === rule.name)
        ?? (parsed.ruleResults.length === 1 ? parsed.ruleResults[0] : undefined);
      ruleResults.push(candidate
        ? { ...candidate, ruleId: rule.id, ruleName: rule.name }
        : { ruleId: rule.id, ruleName: rule.name, conclusion: "模型未返回该规则的独立结论。", findings: [] });
      findings.push(...parsed.findings);
      if (parsed.summary.trim()) summaries.push(`${rule.name}：${parsed.summary.trim()}`);
    }

    return JSON.stringify({
      summary: [`本次巡检已独立执行 ${rules.length} 条规则。`, ...summaries].join("\n"),
      ruleResults,
      findings,
    });
  }

  private async runPrompt(
    prompt: string,
    workspacePath: string | null | undefined,
    { signal, gitEnvironment, onProgress, resumeSessionId, onSessionId }: ReviewRunnerRunOptions = {},
    taskLabel = "审查",
    inspectionFindingReporter?: InspectionFindingToolReporter,
    outputSchema: z.ZodType = ReviewOutputSchema,
    extraTools?: { name: string; server: McpSdkServerConfigWithInstance; allowedTools: string[] } | null,
    strictReadOnly = false,
    maxTurns?: number,
    executionMode: "default" | "claude-code" = "default",
  ): Promise<string> {
    if (signal?.aborted) throw new ReviewRunnerError("Claude Agent SDK request was aborted before start");

    const abortController = new AbortController();
    const abortFromCaller = (): void => abortController.abort(signal?.reason);
    if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
    const progressState: SdkProgressState = {
      textStreamId: 0,
      lastTextFlushAt: 0,
      pendingAssistantText: "",
      assistantTextSeen: false,
      assistantTextClosed: false,
    };
    let gatewayCompatibility: ClaudeGatewayCompatibilityHandle | undefined;

    try {
      const baseEnvironment = {
        ...this.environment,
        ...(await this.loadSettingsEnvironment()),
        ...(gitEnvironment ?? {}),
        CI: "true",
        ...(this.apiKey ? { ANTHROPIC_API_KEY: this.apiKey } : {}),
        ...(this.authToken ? { ANTHROPIC_AUTH_TOKEN: this.authToken } : {}),
      };
      gatewayCompatibility = await prepareClaudeGatewayCompatibility(baseEnvironment);
      const environment = gatewayCompatibility.environment;
      let structuredOutput: unknown;
      let rawResult = "";
      const toolNames = new Map<string, string>();
      const inspectionToolServer = inspectionFindingReporter
        ? createInspectionFindingToolServer(inspectionFindingReporter)
        : undefined;
      const jsonSchema = z.toJSONSchema(outputSchema);
      delete (jsonSchema as { $schema?: unknown }).$schema;
      const restrictedTools = extraTools !== undefined;
      const useClaudeCodePreset = executionMode === "claude-code";
      const builtInTools = restrictedTools ? [] : ["Read", "Grep", "Glob"];

      let messageCount = 0;
      let lastSessionId = "";
      for await (const message of this.query({
        prompt,
        options: {
          ...(this.model ? { model: this.model } : {}),
          cwd: workspacePath || this.cwd,
          settingSources: useClaudeCodePreset || !this.settingsProvider ? this.settingSources : [],
          outputFormat: { type: "json_schema", schema: jsonSchema },
          tools: useClaudeCodePreset ? { type: "preset", preset: "claude_code" } : builtInTools,
          ...(useClaudeCodePreset ? {
            // CI runs the review container as root, so bypassPermissions is rejected by Claude Code.
            // Keep the full Claude Code tool surface, but auto-approve only the read/inspection tools
            // that a review may use; direct file mutations remain denied below.
            allowedTools: ["Read", "Grep", "Glob", "Bash", "Task", "Agent"],
          } : {
            allowedTools: [
              ...builtInTools,
              ...(inspectionToolServer ? [INSPECTION_REPORT_FINDING_TOOL_NAME] : []),
              ...(extraTools?.allowedTools ?? []),
            ],
          }),
          disallowedTools: ["Edit", "Write", "NotebookEdit", ...(
            useClaudeCodePreset || !(restrictedTools || strictReadOnly) ? [] : ["Bash", "Task", "Agent"]
          )],
          permissionMode: "dontAsk",
          ...(useClaudeCodePreset ? {
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append: "当前工作目录是隔离的 Merge Request 工作区。本次是纯静态代码审查：Bash 仅用于只读 Git 取证及远程 refs 同步；禁止安装、下载或更新依赖，禁止运行项目代码、测试、构建、lint、类型检查及其他项目脚本；Task/Agent 如用于静态分工，必须向子任务传递相同的静态审查约束。不要修改源码或提交代码。Git 认证已由工作区提供，完成后严格按用户提示中的 JSON 协议返回审查结果。",
            },
            ...(resumeSessionId?.trim() ? { resume: resumeSessionId.trim() } : {}),
          } : {}),
          persistSession: useClaudeCodePreset,
          includePartialMessages: true,
          abortController,
          env: environment,
          ...(inspectionToolServer ? { mcpServers: { [INSPECTION_TOOL_SERVER_NAME]: inspectionToolServer } } : {}),
          ...(extraTools ? { mcpServers: { [extraTools.name]: extraTools.server }, maxTurns: 64 } : {}),
          ...(extraTools === null ? { maxTurns: 4 } : {}),
          ...(maxTurns !== undefined ? { maxTurns } : {}),
        },
      })) {
        messageCount += 1;
        if (messageCount % SDK_EVENT_LOOP_YIELD_INTERVAL === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const sessionId = typeof message.session_id === "string" ? message.session_id.trim() : "";
        if (sessionId && sessionId !== lastSessionId) {
          lastSessionId = sessionId;
          onSessionId?.(sessionId);
        }
        emitSdkProgress(message, onProgress, toolNames, progressState, taskLabel);
        if (message.type !== "result") continue;
        if (message.subtype !== "success") {
          const resultError = message.errors.join("; ") || message.subtype;
          throw new ReviewRunnerError(`Claude Agent SDK request failed: ${resultError}`);
        }
        rawResult = message.result.trim();
        if (message.structured_output !== undefined && message.structured_output !== null) {
          structuredOutput = message.structured_output;
        }
      }

      const decoded = structuredOutput ?? decodeRawResult(rawResult);
      const parsed = outputSchema.safeParse(decoded);
      if (!parsed.success) {
        throw new ReviewRunnerError(`Claude Agent SDK returned invalid review JSON: ${parsed.error.message}`);
      }
      return JSON.stringify(parsed.data);
    } catch (error) {
      if (error instanceof ReviewRunnerError) throw error;
      if (signal?.aborted) {
        throw new ReviewRunnerError("Claude Agent SDK request was aborted", { cause: error });
      }
      throw new ReviewRunnerError(`Claude Agent SDK request failed: ${errorMessage(error)}`, { cause: error });
    } finally {
      closeAssistantText(onProgress, progressState);
      await gatewayCompatibility?.close().catch(() => undefined);
      if (signal) signal.removeEventListener("abort", abortFromCaller);
    }
  }

  private async loadSettingsEnvironment(): Promise<Record<string, string | undefined>> {
    if (this.settingsProvider) return this.settingsProvider();
    try {
      const resolved = await resolveSettings({ cwd: this.settingsCwd, settingSources: this.settingSources });
      return resolved.effective.env ?? {};
    } catch {
      // Project settings are optional; explicit runner credentials remain
      // available when no settings file can be resolved.
      return {};
    }
  }
}

// Keep the old export name temporarily for consumers that imported the first MVP runner.
export { ClaudeAgentSdkReviewRunner as AnthropicSdkReviewRunner };

export class DryRunReviewRunner implements ReviewRunner, PreSubmitReviewRunner, InspectionRunner, ManagedPromptRunner, GitLabReviewDecisionRunner {
  async run(): Promise<string> {
    return JSON.stringify({ summary: "Dry-run review completed.", findings: [] });
  }

  async runPreSubmitReview(): Promise<string> {
    return JSON.stringify({
      summary: "演示提交前 Review 已完成。",
      requirementChecks: [{ requirement: "演示 Jira 需求", status: "satisfied", evidence: "dry-run" }],
      ruleResults: [],
      findings: [],
    });
  }

  async runInspection(): Promise<string> {
    return JSON.stringify({ summary: "演示巡检已完成。", findings: [] });
  }

  async judgeGitLabReview(): Promise<GitLabReviewDecision> {
    return { needsRepair: false, reason: "Dry-run Review 判断未发现需要修复的代码问题。" };
  }

  async generateInspectionJiraCreatePlan(input: InspectionJiraCreatePromptInput): Promise<InspectionJiraCreatePlan> {
    return normalizeInspectionJiraCreatePlan({ description: "", labels: [], dueDate: null }, input);
  }

  async generateMergeRequestDescription(input: MergeRequestDescriptionPromptInput): Promise<string> {
    return normalizeMergeRequestDescription("", input);
  }

  async runJiraAiPrecheck(): Promise<JiraAiPrecheckResult> {
    const checks = ORDINARY_JIRA_AI_CHECKS.map(({ id, label }) => ({ id, label, status: "present" as const, evidence: "dry-run", detail: "演示预检查已通过" }));
    return normalizeJiraAiPrecheckOutput({
      checks,
      summary: "演示 Jira 上下文预检查已通过。",
      implementationBrief: Object.fromEntries(ORDINARY_JIRA_AI_CHECKS.map(({ id }) => [id, "dry-run"])),
    });
  }

  async runJiraAiPrecheckSupplement(): Promise<JiraAiPrecheckSupplementResult> {
    return { status: "needs_user", suggestion: "", evidence: "", reason: "演示模式不自动补充 Jira 内容。" };
  }
}
