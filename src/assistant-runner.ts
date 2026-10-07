import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  query as claudeQuery,
  resolveSettings,
  type Options as ClaudeAgentOptions,
  type HookInput,
  type HookJSONOutput,
  type SDKMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { asRecord, valueText } from "./agent-sdk-utils.js";
import {
  ASSISTANT_READ_ONLY_TOOL_NAMES,
  ASSISTANT_TOOL_SERVER_NAME,
  type AssistantToolContext,
} from "./assistant-tools.js";
import type { AssistantEditRunnerContext } from "./assistant-edit-service.js";
import { planAssistantTask, type AssistantTaskPlan } from "./assistant-intent.js";
import { createAssistantToolServer } from "./assistant-tool-server.js";
import { emitAssistantSdkProgress, type AssistantSdkProgressState } from "./assistant-sdk-progress.js";
import { prepareClaudeGatewayCompatibility, type ClaudeGatewayCompatibilityHandle } from "./claude-gateway-compat.js";
import { safeErrorMessage } from "./errors.js";
import type { ClaudeSettingsProvider } from "./model-config.js";
import type { AssistantCard, AssistantFocusContext } from "./contracts.js";
import type { GitLabClientPort } from "./gitlab-client.js";
import type { JiraClientPort } from "./jira-client.js";

export type AssistantMessageRole = "user" | "assistant";

export interface AssistantMessage {
  role: AssistantMessageRole;
  content: string;
}

export interface AssistantReviewContext {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  recentReviews: Array<{
    id: string;
    projectPath: string | null;
    mrIid: string;
    status: string;
    summary: string | null;
    findingCount: number | null;
    createdAt: string;
  }>;
}

export interface AssistantChatInput {
  messages: AssistantMessage[];
  reviewContext?: AssistantReviewContext;
  focusContext?: AssistantFocusContext;
  editSession?: AssistantEditRunnerContext;
  runtimeContext?: AssistantRuntimeContext;
}

export interface AssistantRuntimeContext {
  validateWrite?: () => void;
  getGitLabClient?: () => Promise<GitLabClientPort | null>;
  getJiraClient?: () => Promise<JiraClientPort | null>;
  productUsername?: string | null;
  editSession?: AssistantEditRunnerContext;
}

export type AssistantProgressKind =
  | "status"
  | "assistant"
  | "thinking"
  | "tool"
  | "tool_result"
  | "system"
  | "warning";

export type AssistantProgressPhase = "start" | "running" | "complete" | "error";

export type AssistantProgressMeta = Record<string, string | number | boolean | null>;

export interface AssistantProgressEvent {
  kind: AssistantProgressKind;
  message: string;
  detail?: string | null;
  activityId?: string | null;
  toolName?: string | null;
  toolInput?: unknown;
  phase?: AssistantProgressPhase;
  meta?: AssistantProgressMeta;
  reviewTask?: import("./contracts.js").AssistantReviewTaskReference;
  card?: AssistantCard;
  editOperation?: import("./contracts.js").AssistantEditOperation;
}

export interface AssistantRunOptions {
  signal?: AbortSignal;
  onProgress?: (event: AssistantProgressEvent) => void;
}

export interface AssistantRunner {
  run(input: AssistantChatInput, options?: AssistantRunOptions): Promise<string>;
  close?: () => Promise<void> | void;
}

type AgentQuery = (params: { prompt: string; options?: ClaudeAgentOptions }) => AsyncIterable<SDKMessage>;
type AssistantQueryStream = AsyncIterable<SDKMessage> & {
  interrupt?: () => Promise<unknown>;
};

export interface ClaudeAgentSdkAssistantRunnerOptions {
  environment?: Record<string, string | undefined>;
  apiKey?: string;
  authToken?: string;
  model?: string;
  thinkingMode?: "adaptive" | "enabled" | "disabled";
  thinkingBudgetTokens?: number;
  cwd?: string;
  settingsCwd?: string;
  settingSources?: SettingSource[];
  settingsProvider?: ClaudeSettingsProvider;
  idleTimeoutMs?: number;
  assistantToolContext?: AssistantToolContext;
  assistantToolContextFactory?: (runtimeContext?: AssistantRuntimeContext) => AssistantToolContext | Promise<AssistantToolContext>;
  query?: AgentQuery;
}

const MAX_HISTORY_MESSAGES = 40;
const MAX_MESSAGE_LENGTH = 12_000;
const MAX_PROMPT_LENGTH = 80_000;
const ASSISTANT_IDLE_TIMEOUT_MS = 180_000;
const NATIVE_EDIT_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write"] as const;
const NATIVE_EDIT_TOOL_MATCHER = "^(Read|Grep|Glob|Edit|Write)$";
const THINKING_BUDGET_MIN = 1_024;
const THINKING_BUDGET_MAX = 200_000;
type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…（上下文过长，已截断）` : value;
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function nativePathField(toolName: string): "file_path" | "path" | null {
  if (toolName === "Read" || toolName === "Edit" || toolName === "Write") return "file_path";
  if (toolName === "Grep" || toolName === "Glob") return "path";
  return null;
}

function protectedNativePath(relativePath: string): boolean {
  const segments = relativePath.split(path.sep).filter(Boolean);
  return segments[0] === ".git"
    || relativePath === ".gitlab-askpass.sh"
    || segments[0]?.startsWith(".frontend-pilot-") === true;
}

async function normalizeNativePath(workspacePath: string, rawPath: string, allowRoot: boolean): Promise<string> {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error("文件路径不能为空");
  const root = path.resolve(workspacePath);
  const target = path.resolve(root, trimmed);
  const relativePath = path.relative(root, target);
  if ((!allowRoot && !relativePath)
    || path.isAbsolute(relativePath)
    || relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error("文件路径必须位于当前项目工作区内");
  }
  if (protectedNativePath(relativePath)) throw new Error("不允许访问 Git 元数据或编辑工作区内部文件");

  let current = root;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("不允许通过符号链接访问工作区外的文件");
    } catch (error) {
      if (isMissingPath(error)) break;
      throw error;
    }
  }
  return target;
}

function nativePathHookResult(
  permissionDecision: "allow" | "deny",
  permissionDecisionReason: string,
  updatedInput?: Record<string, unknown>,
): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
      ...(updatedInput ? { updatedInput } : {}),
    },
  };
}

async function guardNativeFileTool(input: HookInput, workspacePath: string, validateWrite?: () => void): Promise<HookJSONOutput> {
  if (input.hook_event_name !== "PreToolUse") return { continue: true };
  try {
    validateWrite?.();
  } catch {
    return nativePathHookResult("deny", "当前任务授权已失效");
  }
  const field = nativePathField(input.tool_name);
  if (!field) return { continue: true };
  const toolInput = asRecord(input.tool_input) ?? {};
  const rawPath = toolInput[field];
  if (rawPath === undefined && (input.tool_name === "Grep" || input.tool_name === "Glob")) {
    return nativePathHookResult("allow", "默认使用隔离编辑工作区");
  }
  if (typeof rawPath !== "string") {
    return nativePathHookResult("deny", `${input.tool_name} 的路径参数无效`);
  }
  try {
    const normalizedPath = await normalizeNativePath(workspacePath, rawPath, input.tool_name === "Grep" || input.tool_name === "Glob");
    const updatedInput = normalizedPath === rawPath ? undefined : { ...toolInput, [field]: normalizedPath };
    return nativePathHookResult("allow", "路径位于隔离编辑工作区内", updatedInput);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "路径校验失败";
    return nativePathHookResult("deny", reason);
  }
}

function nativeEditHooks(workspacePath: string, validateWrite?: () => void): NonNullable<ClaudeAgentOptions["hooks"]> {
  return {
    PreToolUse: [{
      matcher: NATIVE_EDIT_TOOL_MATCHER,
      hooks: [async (input) => guardNativeFileTool(input, workspacePath, validateWrite)],
    }],
  };
}

function thinkingConfigForModel(
  mode: "adaptive" | "enabled" | "disabled",
  budgetTokens: number,
): NonNullable<ClaudeAgentOptions["thinking"]> {
  if (mode === "disabled") return { type: "disabled" };
  return mode === "enabled"
    ? { type: "enabled", budgetTokens, display: "summarized" }
    : { type: "adaptive", display: "summarized" };
}

function configuredThinkingMode(
  environment: Record<string, string | undefined>,
  fallback: "adaptive" | "enabled" | "disabled",
): "adaptive" | "enabled" | "disabled" {
  const value = environment.CLAUDE_THINKING_MODE?.trim().toLowerCase();
  if (value === "adaptive" || value === "enabled" || value === "disabled") return value;
  // MAX_THINKING_TOKENS is the SDK-compatible spelling exposed by older
  // project configurations. Treating it as an explicit budget keeps those
  // settings effective without inspecting or special-casing model names.
  return environment.MAX_THINKING_TOKENS?.trim() ? "enabled" : fallback;
}

function configuredThinkingBudget(
  environment: Record<string, string | undefined>,
  fallback: number,
): number {
  const raw = environment.CLAUDE_THINKING_BUDGET_TOKENS ?? environment.MAX_THINKING_TOKENS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= THINKING_BUDGET_MIN && parsed <= THINKING_BUDGET_MAX
    ? parsed
    : fallback;
}

function configuredEffort(environment: Record<string, string | undefined>): ClaudeEffort {
  const value = environment.CLAUDE_CODE_EFFORT_LEVEL?.trim().toLowerCase();
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : "high";
}

function extractTextBlocks(value: unknown): string {
  const record = asRecord(value);
  const message = asRecord(record?.message);
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const blockRecord = asRecord(block);
      return blockRecord?.type === "text" ? valueText(blockRecord.text) : "";
    })
    .filter(Boolean)
    .join("");
}

function buildPrompt(input: AssistantChatInput, taskPlan: AssistantTaskPlan): string {
  const history = input.messages
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${truncate(message.content.trim(), MAX_MESSAGE_LENGTH)}`)
    .join("\n\n");
  const context = taskPlan.includeReviewContext && input.reviewContext
    ? JSON.stringify(input.reviewContext, null, 2)
    : "本轮任务不需要 Review 快照。";
  const taskInstructions = taskPlan.instructions.map((instruction) => `- ${instruction}`).join("\n");
  const editInstructions = input.editSession
    ? [
        `当前会话已开启代码编辑模式，项目 ${input.editSession.projectPath} 基于 ${input.editSession.baseRef}（${input.editSession.baseSha}）创建了隔离工作区。`,
        `工作目录为 ${input.editSession.workspacePath}。Claude 原生文件工具使用此目录下的绝对路径；项目标识 ${input.editSession.projectPath} 不是本地目录前缀。`,
        "你可以先用 Read、Grep、Glob 检查代码；确实需要修改时，直接调用 Claude 原生 Edit 或 Write 工具，不要只声称文件已经修改。",
        "每次修改前重新读取目标文件，以当前工作区内容为准；Edit 必须提供准确的 old_string 和 new_string，Write 只用于创建文件或确有必要的整体重写。",
        "可以一次任务修改多个相关文件，保持改动最小；不需要生成 unified diff，也不要调用自定义补丁工具。工具成功返回后，文件已经修改，直接说明实际修改和未能验证的内容，不要要求审批。",
      ].join("\n")
    : "";
  const toolInstructions = input.editSession
    ? "当前会话可以使用 Claude 原生 Read、Grep、Glob、Edit、Write 工具；Edit 和 Write 会直接写入隔离工作区。"
    : "你可以使用 Claude Code 的只读工具 Read、Grep、Glob 查看当前工作目录中的代码和配置；如果当前会话提供 Frontend Pilot 的 Review 查询工具，询问实时任务状态、MR 元数据或审查规则时优先使用它们；需要查证时先调用工具，不要凭空猜测。";
  const writeInstructions = input.editSession
    ? "本轮已授权在隔离编辑工作区中直接修改代码。可以使用原生 Edit 和 Write，不要调用 Bash、Task 或其他执行/外部写入工具，不要提交、推送或创建 MR。"
    : "你没有写文件或执行命令的权限。Review、Jira 创建以及 GitLab MR 创建/编辑/评论/合并和 Pipeline 重试/取消都是外部写操作，只能在本轮任务协议允许且用户明确要求时使用；必须先读取真实详情和选项、补齐并确认必要字段，不要从查询、建议、分析或教程问题中推断写入意图；不要调用 Bash、Edit、Write 或其他写入工具。";
  const prompt = [
    "你是 Frontend Pilot，一个面向研发团队的成熟软件交付助手。",
    "请使用中文回答，除非用户明确要求其他语言。回答要直接、具体、可执行；不确定时明确说明，不要编造已执行的操作。",
    `当前日期（UTC）：${new Date().toISOString().slice(0, 10)}。涉及上周、最近两周等相对日期时，先换算为明确的 since/until 日期范围。`,
    toolInstructions,
    editInstructions,
    input.focusContext ? `当前工作台上下文：${JSON.stringify(input.focusContext)}` : "当前没有指定的工作台上下文。",
    "当用户询问 Jira 待办、GitLab 个人 MR、上周工作或提交简报时，优先调用对应的 Frontend Pilot 工作台只读工具；用户明确要求新建 Jira 问题时，先读取创建选项并补齐必填项；如果工具返回 authRequired，直接说明需要连接，并保留界面提供的登录卡片，不要假装已读取数据。",
    `本轮任务类型：${taskPlan.label}`,
    "本轮任务协议（优先级高于通用回答习惯）：",
    taskInstructions,
    "事实约束：工具未返回的字段、详情、时间范围和执行结果都不能写成已知事实；如果工具失败、返回空数据或要求登录，必须把限制说清楚，不要用模板化内容填充。不要先承诺‘已经查看详情’，调用成功后再总结。",
    "历史助手消息只能帮助理解上下文，不能当作本轮已验证的数据；本轮应重新遵守任务协议并以本轮工具结果为准。",
    writeInstructions,
    "SDK 会把模型返回的可展示思考摘要单独流式传给界面；不要输出逐字的私有思维链，最终回答只保留简短、面向用户的判断依据、下一步和工具结果。",
    "当用户询问任务状态时，优先使用 Review 任务快照；状态含义：queued=排队中，running=审查中，completed=已完成，failed=失败。",
    "Review 任务快照：",
    context,
    "当前会话：",
    history || "暂无历史消息。",
  ].join("\n\n");
  return truncate(prompt, MAX_PROMPT_LENGTH);
}

function allowedToolsForTask(taskPlan: AssistantTaskPlan, hasAssistantToolServer: boolean, editing: boolean): string[] {
  if (editing) return [...NATIVE_EDIT_TOOLS];
  if (!hasAssistantToolServer) return ["Read", "Grep", "Glob"];
  const customTools = taskPlan.allowedToolNames.length > 0
    ? taskPlan.allowedToolNames.map((name) => `mcp__${ASSISTANT_TOOL_SERVER_NAME}__${name}`)
    : [...ASSISTANT_READ_ONLY_TOOL_NAMES];
  return ["Read", "Grep", "Glob", ...customTools];
}

function errorMessage(error: unknown): string {
  return safeErrorMessage(error, "未知错误");
}

function authRequiredResponse(card: AssistantCard): string {
  return `${card.description}\n\n连接完成后，请重新提交刚才的问题。`;
}

export class ClaudeAgentSdkAssistantRunner implements AssistantRunner {
  private readonly apiKey: string | undefined;
  private readonly authToken: string | undefined;
  private readonly environment: Record<string, string | undefined>;
  private readonly model: string | undefined;
  private readonly thinkingMode: "adaptive" | "enabled" | "disabled";
  private readonly thinkingBudgetTokens: number;
  private readonly cwd: string;
  private readonly settingsCwd: string;
  private readonly settingSources: SettingSource[];
  private readonly settingsProvider: ClaudeSettingsProvider | undefined;
  private readonly idleTimeoutMs: number;
  private readonly assistantToolContext: AssistantToolContext | undefined;
  private readonly assistantToolContextFactory: ClaudeAgentSdkAssistantRunnerOptions["assistantToolContextFactory"];
  private readonly query: AgentQuery;
  private readonly activeQueries = new Set<AssistantQueryStream>();
  private closing = false;

  constructor({
    environment = {},
    apiKey,
    authToken,
    model,
    thinkingMode = "adaptive",
    thinkingBudgetTokens = 4_096,
    cwd = process.cwd(),
    settingsCwd = process.cwd(),
    settingSources = ["user", "project"],
    settingsProvider,
    idleTimeoutMs = ASSISTANT_IDLE_TIMEOUT_MS,
    assistantToolContext,
    assistantToolContextFactory,
    query = claudeQuery,
  }: ClaudeAgentSdkAssistantRunnerOptions = {}) {
    this.apiKey = apiKey?.trim() || undefined;
    this.authToken = authToken?.trim() || undefined;
    this.environment = environment;
    this.model = model?.trim() || undefined;
    this.thinkingMode = thinkingMode;
    this.thinkingBudgetTokens = Math.max(1_024, Math.floor(thinkingBudgetTokens));
    this.cwd = cwd;
    this.settingsCwd = settingsCwd;
    this.settingSources = settingSources;
    this.settingsProvider = settingsProvider;
    this.idleTimeoutMs = Number.isFinite(idleTimeoutMs) ? Math.max(1, Math.floor(idleTimeoutMs)) : ASSISTANT_IDLE_TIMEOUT_MS;
    this.assistantToolContext = assistantToolContext;
    this.assistantToolContextFactory = assistantToolContextFactory;
    this.query = query;
  }

  async run(input: AssistantChatInput, { signal, onProgress }: AssistantRunOptions = {}): Promise<string> {
    if (this.closing) throw new Error("Claude 助手正在关闭");
    if (signal?.aborted) throw new Error("助手请求已取消");
    const abortController = new AbortController();
    let activeQuery: AssistantQueryStream | null = null;
    const interruptActiveQuery = (): void => {
      const interrupt = activeQuery?.interrupt;
      if (interrupt && activeQuery) void interrupt.call(activeQuery).catch(() => undefined);
    };
    const abortFromCaller = (): void => {
      abortController.abort(signal?.reason);
      interruptActiveQuery();
    };
    if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimeout = (): void => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error("Claude 助手请求超时"));
        interruptActiveQuery();
      }, this.idleTimeoutMs);
    };
    armIdleTimeout();

    let streamedText = "";
    let finalText = "";
    const progressState: AssistantSdkProgressState = {
      turnId: 0,
      streamTextSeen: false,
      assistantTextEmitted: false,
      thinkingBlockSeen: false,
      thinkingOutputSeen: false,
      thinkingActivityIds: new Map(),
      thinkingDeltaSeen: new Set(),
      toolInputProgress: new Map(),
    };
    const toolNames = new Map<string, string>();
    let authRequiredCard: AssistantCard | null = null;
    let gatewayCompatibility: ClaudeGatewayCompatibilityHandle | undefined;
    const reportProgress = (event: AssistantProgressEvent): void => {
      if (event.card?.kind === "auth_required") authRequiredCard = event.card;
      onProgress?.(event);
    };
    onProgress?.({ kind: "status", message: "Claude 正在准备上下文" });

    try {
      const baseEnvironment: Record<string, string | undefined> = {
        // Keep interactive failures bounded using the SDK's native retry policy.
        CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES ?? "2",
        ...this.environment,
        ...(await this.loadSettingsEnvironment()),
        CI: "true",
        CLAUDE_AGENT_SDK_CLIENT_APP: "frontend-pilot/assistant",
        ...(this.apiKey ? { ANTHROPIC_API_KEY: this.apiKey } : {}),
        ...(this.authToken ? { ANTHROPIC_AUTH_TOKEN: this.authToken } : {}),
      };
      gatewayCompatibility = await prepareClaudeGatewayCompatibility(baseEnvironment);
      const environment = gatewayCompatibility.environment;

      const taskPlan = planAssistantTask(input.messages, input.focusContext, Boolean(input.editSession));
      const prompt = buildPrompt(input, taskPlan);
      const resolvedModel = this.model
        ?? environment.ANTHROPIC_MODEL
        ?? environment.CLAUDE_MODEL;
      const thinkingMode = configuredThinkingMode(environment, this.thinkingMode);
      const thinkingBudgetTokens = configuredThinkingBudget(environment, this.thinkingBudgetTokens);
      const thinking = thinkingConfigForModel(thinkingMode, thinkingBudgetTokens);
      const effort = configuredEffort(environment);
      const thinkingDescription = thinking.type === "adaptive"
        ? "模型自主决定思考深度"
        : thinking.type === "enabled"
          ? `固定预算 ${thinkingBudgetTokens} tokens`
          : "未启用扩展思考";
      const assistantToolContext = input.editSession
        ? undefined
        : this.assistantToolContextFactory
          ? await this.assistantToolContextFactory(input.runtimeContext)
          : this.assistantToolContext;
      const assistantToolServer = assistantToolContext && !input.editSession
        ? createAssistantToolServer(assistantToolContext)
        : undefined;
      onProgress?.({
        kind: "system",
        message: thinking.type === "adaptive"
          ? "已开启自适应思考摘要"
          : thinking.type === "enabled" ? "已开启固定预算思考摘要" : "已关闭扩展思考",
        detail: `${resolvedModel ?? "当前模型"} · ${thinkingDescription} · effort=${effort}`,
        activityId: `thinking-mode-${Date.now()}`,
        phase: "complete",
        meta: { thinkingType: thinking.type, thinkingDisplay: thinking.type === "disabled" ? "omitted" : "summarized", model: resolvedModel ?? null },
      });
      const options: ClaudeAgentOptions = {
        ...(this.model ? { model: this.model } : {}),
        cwd: input.editSession?.workspacePath ?? this.cwd,
        settingSources: input.editSession || this.settingsProvider ? [] : this.settingSources,
        tools: input.editSession ? [...NATIVE_EDIT_TOOLS] : ["Read", "Grep", "Glob"],
        allowedTools: allowedToolsForTask(taskPlan, Boolean(assistantToolServer), Boolean(input.editSession)),
        disallowedTools: input.editSession ? ["Bash", "NotebookEdit", "Task", "Agent"] : ["Bash", "Edit", "Write", "NotebookEdit", "Task"],
        permissionMode: input.editSession ? "acceptEdits" : "dontAsk",
        persistSession: false,
        maxTurns: taskPlan.maxTurns,
        thinking,
        effort,
        includePartialMessages: true,
        env: environment,
        ...(input.editSession ? { hooks: nativeEditHooks(input.editSession.workspacePath, input.runtimeContext?.validateWrite) } : {}),
        ...(assistantToolServer ? { mcpServers: { [ASSISTANT_TOOL_SERVER_NAME]: assistantToolServer } } : {}),
      };
      if (abortController.signal.aborted || signal?.aborted) throw new Error("助手请求已取消");
      const stream = this.query({ prompt, options: { ...options, abortController } });
      activeQuery = stream as AssistantQueryStream;
      this.activeQueries.add(activeQuery);
      if (signal?.aborted) interruptActiveQuery();

      for await (const message of stream) {
        armIdleTimeout();
        if (abortController.signal.aborted || signal?.aborted) throw new Error("助手请求已取消");

        const delta = emitAssistantSdkProgress(message, reportProgress, progressState, toolNames);
        if (delta) streamedText += delta;

        const fullAssistantText = extractTextBlocks(message);
        if (fullAssistantText) finalText = fullAssistantText;

        if (authRequiredCard) {
          const interrupt = activeQuery?.interrupt;
          if (interrupt && activeQuery) await interrupt.call(activeQuery).catch(() => undefined);
          break;
        }

        const record = asRecord(message);
        if (record?.type !== "result") continue;
        if (record.subtype !== "success") {
          const errors = Array.isArray(record.errors) ? record.errors.map(valueText).filter(Boolean).join("; ") : "";
          throw new Error(errors || `Claude 请求结束：${String(record.subtype ?? "未知错误")}`);
        }
        if (typeof record.result === "string") finalText = record.result.trim();
      }

      const result = authRequiredCard
        ? authRequiredResponse(authRequiredCard)
        : (streamedText || finalText).trim();
      if (!result) throw new Error("Claude 返回了空消息");
      if (thinking.type !== "disabled" && !progressState.thinkingOutputSeen) {
        onProgress?.({
          kind: "system",
          message: progressState.thinkingBlockSeen ? "模型思考已完成，但本轮未返回可展示摘要" : "本轮未产生可展示的思考摘要",
          detail: "模型可能跳过了思考，或当前兼容模型只返回思考 token 进度。",
          activityId: `thinking-summary-${Date.now()}`,
          phase: "complete",
        });
      }
      if (!progressState.assistantTextEmitted) onProgress?.({ kind: "assistant", message: result });
      onProgress?.({ kind: "status", message: "Claude 已完成回复" });
      return result;
    } catch (error) {
      if (progressState.retryActivityId) {
        onProgress?.({ kind: "system", activityId: progressState.retryActivityId,
          message: "模型连接未恢复", phase: "error" });
      }
      if (timedOut) throw new Error("Claude 助手请求超时", { cause: error });
      if (signal?.aborted) throw new Error("助手请求已取消", { cause: error });
      throw new Error(`Claude 助手请求失败：${errorMessage(error)}`, { cause: error });
    } finally {
      if (timeout) clearTimeout(timeout);
      await gatewayCompatibility?.close().catch(() => undefined);
      if (activeQuery) this.activeQueries.delete(activeQuery);
      if (signal) signal.removeEventListener("abort", abortFromCaller);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const query of this.activeQueries) {
      const interrupt = query.interrupt;
      if (!interrupt) continue;
      try {
        await interrupt.call(query);
      } catch {
        // Shutdown is already in progress; a failed interrupt must not block
        // the remaining resources from being released.
      }
    }
  }

  private async loadSettingsEnvironment(): Promise<Record<string, string | undefined>> {
    if (this.settingsProvider) return this.settingsProvider();
    try {
      const resolved = await resolveSettings({ cwd: this.settingsCwd, settingSources: this.settingSources });
      return resolved.effective.env ?? {};
    } catch {
      // Settings are optional; the SDK can still use the explicitly injected
      // credentials and model configuration.
      return {};
    }
  }
}

export class DryRunAssistantRunner implements AssistantRunner {
  async run(_input: AssistantChatInput, { onProgress }: AssistantRunOptions = {}): Promise<string> {
    const message = "当前服务处于 dry-run 模式，未调用 Claude。请关闭 REVIEW_DRY_RUN 后再使用真实助手。";
    onProgress?.({ kind: "status", message: "dry-run 模式" });
    onProgress?.({ kind: "assistant", message });
    return message;
  }

  close(): void {
    // Dry-run has no child process to release.
  }
}
