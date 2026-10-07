import { z } from "zod";
import { InspectionFindingScopeSchema, type InspectionFinding, type InspectionRunnerInput, type PreSubmitReviewInput, type ReviewGateStatus, type ReviewProfile, type ReviewRule, type ReviewRunnerInput, type ReviewResultSummary } from "./contracts.js";
import { reviewReportNoteMarker } from "./review-note.js";

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const BLOCKING_SEVERITIES = new Set(["critical", "high"]);

export interface ReviewFinding {
  severity: string;
  category: string;
  path: string;
  line: number | null;
  issue: string;
  suggestion: string;
  scope?: InspectionFinding["scope"];
  relatedPaths?: string[];
}

function findingKey(finding: ReviewFinding): string {
  return [finding.path, finding.line ?? "", finding.category, finding.issue].join("\u0000");
}

function uniqueFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const unique = new Map<string, ReviewFinding>();
  for (const finding of findings) unique.set(findingKey(finding), finding);
  return [...unique.values()];
}

export interface ReviewRuleResult {
  ruleId: string;
  ruleName: string;
  conclusion: string;
  findings: ReviewFinding[];
}

export const ReviewFindingSchema = z.object({
  severity: z.string(),
  category: z.string(),
  path: z.string(),
  line: z.number().int().positive().nullable(),
  issue: z.string(),
  suggestion: z.string(),
});

export const ReviewRuleResultSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  conclusion: z.string(),
  findings: z.array(ReviewFindingSchema),
});

export const ReviewOutputSchema = z.object({
  summary: z.string(),
  ruleResults: z.array(ReviewRuleResultSchema).default([]),
  findings: z.array(ReviewFindingSchema),
});

const PreSubmitRequirementCheckSchema = z.object({
  requirement: z.string().trim().min(1).max(4_000),
  status: z.enum(["satisfied", "missing", "unclear"]),
  evidence: z.string().trim().max(4_000),
}).strict();

export const PreSubmitReviewOutputSchema = ReviewOutputSchema.extend({
  requirementChecks: z.array(PreSubmitRequirementCheckSchema).min(1).max(50),
});

export type PreSubmitRequirementCheck = z.infer<typeof PreSubmitRequirementCheckSchema>;

export interface ParsedReviewResult extends ReviewResultSummary {
  ruleResults: ReviewRuleResult[];
  findings: ReviewFinding[];
  raw: string;
}

export interface ReviewGateSummary {
  gate: ReviewGateStatus;
  blockingFindingCount: number;
  blockingSeverities: string[];
}

export function reviewGateSummary(result: ParsedReviewResult): ReviewGateSummary {
  const findings = uniqueFindings([
    ...result.ruleResults.flatMap((rule) => rule.findings),
    ...result.findings,
  ]);
  const blocking = result.format === "structured"
    ? findings.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity))
    : [];
  return {
    gate: result.format === "structured" && blocking.length === 0 ? "passed" : "failed",
    blockingFindingCount: blocking.length,
    blockingSeverities: [...new Set(blocking.map((finding) => finding.severity))],
  };
}

export type PromptRule = Pick<ReviewRule, "id" | "name" | "description" | "enabled" | "content">;

function enabledRules<T extends PromptRule>(profile: { rules: T[] }): T[] {
  return profile.rules.filter((rule) => rule.enabled);
}

function renderRuleInstructions(rules: PromptRule[], taskLabel = "审查"): string {
  if (rules.length === 0) return `【${taskLabel}规则】\n当前 profile 没有启用规则，请只根据已获得的代码证据输出结论。`;
  return [
    `【本次启用的${taskLabel}规则与执行顺序】`,
    "必须严格按照下面的顺序逐条分析：完成前一条规则后，再进入下一条；最终 ruleResults 数组也必须保持这个顺序。",
    ...rules.map((rule, index) => [
      `### ${index + 1}. ${rule.id} · ${rule.name}`,
      rule.description ? `说明：${rule.description}` : "",
      rule.content,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function ruleOutputExample(rules: PromptRule[]): Record<string, unknown> {
  return {
    summary: "一句话总结",
    ruleResults: rules.map((rule) => ({
      ruleId: rule.id,
      ruleName: rule.name,
      conclusion: "该规则下的结论；没有问题时明确写未发现问题。",
      findings: [],
    })),
    findings: [],
  };
}

export function buildReviewPrompt({
  projectPath,
  mrIid,
  profile,
  workspacePath,
}: ReviewRunnerInput): string {
  const rules = enabledRules(profile);
  const repositorySection = workspacePath
    ? [
      "【完整仓库上下文】",
      "当前工作目录是服务端准备好的本次 MR head 隔离工作区，不要等待服务端附加 diff、文件列表或提交摘要。",
      "请像用户在本地 Claude Code 中发起 review 一样，自主查看 Git 状态、远端 refs、提交历史和当前代码，判断这个 MR 的提交范围、目标基线与实际变更，再决定需要审查哪些文件。",
      "可以使用 Read、Grep、Glob 阅读仓库内容；必要时使用 Bash 执行 git status、log、show、diff、branch、remote、fetch 等只读 Git 取证命令，以获得完整证据。确有必要时可以使用 Task/Agent 并行静态阅读，但须向子任务传递本提示词的静态审查约束。服务端只负责提供工作区和会话，不替你决定审查输入。",
      "不要修改源码、提交代码或修改依赖。Git 取证和远程 refs 同步可以自主决定。",
      "只审查本次 MR 改动及其必要上下文，不评论与本次改动无关的历史问题。",
    ].join("\n")
    : [
      "【仓库上下文】",
      "当前运行环境没有 MR 完整工作区；不要声称已经读取未提供的文件，也不要假设服务端提供了 diff。",
    ].join("\n");

  return [
    "你是严格的代码审查机器人。全程使用简体中文，只报告有明确证据的问题。",
    "本次只做静态代码审查；不要运行验证步骤，不要修改文件、提交代码或输出审查过程。",
    `审查 profile：${profile.displayName}`,
    `项目：${projectPath}`,
    `MR：!${mrIid}`,
    "",
    repositorySection,
    renderRuleInstructions(rules),
    "",
    "【静态审查边界：优先于以上审查规则】",
    "只阅读 MR 改动和必要的仓库上下文；测试、构建脚本及配置可以作为文本阅读，但绝不能执行。",
    "禁止安装、下载或更新依赖；禁止运行项目代码或任何项目脚本/验证命令，包括测试、构建、lint、类型检查、格式化和覆盖率命令，也不得通过 npm exec、npx 等方式间接启动。",
    "可以使用 Task/Agent 并行静态阅读，但必须向每个子任务传递本节完整约束；子任务同样只能只读审查代码，不得修改文件、安装/下载/更新依赖或运行项目代码、脚本及验证命令。不要访问外网搜索或下载资料。若静态代码不足以确认行为，在审查结论中说明不确定性，不要运行命令验证。",
    "",
    "【输出协议】",
    "必须只输出 JSON，不要输出 Markdown 代码围栏。",
    "ruleResults 必须按照审查规则的执行顺序，为每个启用规则各输出一个独立分块，ruleId 必须使用上面给出的 ID；即使没有问题也要输出 conclusion 和空 findings。",
    "规则分块中的 findings 只放该规则发现的问题；跨规则但确实重要的问题才放到顶层 findings。",
    JSON.stringify(ruleOutputExample(rules), null, 2),
    "每条 finding 必须具体到代码行为或潜在 bug；没有明确影响的问题不要输出。",
  ].join("\n");
}

export function buildPreSubmitReviewPrompt({
  projectPath,
  jiraKey,
  jiraTitle,
  jiraDescription,
  targetBranch,
  baseSha,
  diff,
  profile,
  workspacePath,
  externalFeedback,
}: PreSubmitReviewInput): string {
  const rules = enabledRules(profile);
  const repositorySection = workspacePath
    ? [
      "【完整仓库上下文】",
      "当前工作目录是 AI 修改代码使用的隔离工作区，包含目标分支基线和当前待提交改动。",
      "这是提交前只读审查任务，不要修改文件，不要执行项目脚本或测试命令。",
      "必须使用 Read、Grep、Glob 查看变更文件的完整内容、类型定义、调用方/被调用方、配置和现有测试；不要只凭 diff 猜测。",
    ].join("\n")
    : [
      "【仓库上下文】",
      "当前没有完整工作区，只能根据提供的 diff 和 Jira 内容判断；不要声称已经读取未提供的文件。",
    ].join("\n");
  const externalFeedbackSection = externalFeedback?.trim()
    ? ["", "【此前的远端验证反馈】", "下面是本次修改需要解决的 Pipeline 或 Pipeline Review 反馈，必须核对当前候选代码是否真正解决：", externalFeedback.trim()].join("\n")
    : "";
  return [
    "你是提交前代码验收机器人。全程使用简体中文，只报告有明确代码证据和实际影响的问题。",
    "你的职责是独立审查候选代码，不要修改文件，不要执行项目脚本，不要输出审查过程。",
    "Jira 描述是本次修改的需求来源；代码、注释或 MR 描述中的额外目标不能替代 Jira 需求。",
    `项目：${projectPath}`,
    `Jira：${jiraKey}`,
    `Jira 标题：${jiraTitle}`,
    `目标分支：${targetBranch}`,
    `代码基线：${baseSha}`,
    "",
    repositorySection,
    "",
    "【Jira 需求】",
    jiraDescription.trim() || "Jira 未提供描述，请至少根据标题判断问题目标，并将无法确认的需求标记为 unclear。",
    externalFeedbackSection,
    "",
    "【必须完成的验收】",
    "1. 从 Jira 的背景、问题描述/目标和验收标准中逐条提取 requirementChecks；每条都必须给出 satisfied、missing 或 unclear。",
    "2. 只有找到实际文件和代码行为证据时才能标记 satisfied；缺少证据必须标记 missing 或 unclear。",
    "3. 核对 AI 改动是否解决 Jira 描述的根因，而不是绕过问题或只改变表面现象。",
    "4. 检查改动范围是否超出 Jira；检查类型、边界、异常、并发、状态、兼容性和安全风险。",
    "5. 检查是否缺少必要的测试或验证，但不要把没有执行的命令写成已通过；本次任务不执行脚本。若代码行为已有明确证据、只是无法通过静态审查确认运行时结果，应标记为 unclear，不要误报为 missing。",
    "6. 如果此前有远端 Pipeline 或 Pipeline Review 反馈，必须确认当前改动已经针对性解决；不能只复述反馈。",
    "7. requirementChecks 中只有明确缺失的 missing 或 critical/high 的明确代码问题会阻断提交；仅因运行时/测试无法由静态代码完全确认的 unclear 属于待 Pipeline 验证项，不应触发自动改码，系统会先创建 Draft MR 交给 Pipeline 验收。",
    renderRuleInstructions(rules),
    "",
    "【输出协议】",
    "必须只输出 JSON，不要输出 Markdown 代码围栏。",
    "requirementChecks 必须覆盖 Jira 中所有可识别的目标和验收条件；evidence 必须具体到文件路径、代码行为和行号，无法证明时写明原因。",
    "ruleResults 必须按照审查规则的执行顺序，为每个启用规则各输出一个独立分块，ruleId 必须使用上面给出的 ID；即使没有问题也要输出 conclusion 和空 findings。",
    "findings 只报告明确的问题；每条都要具体到代码行为、实际影响和修复建议。严重级别只能使用 critical、high、medium、low。",
    JSON.stringify({
      summary: "一句话总结 Jira 需求与候选代码的一致性",
      requirementChecks: [{ requirement: "Jira 中的一条可验证要求", status: "satisfied", evidence: "src/example.ts:12 的具体代码行为" }],
      ruleResults: rules.map((rule) => ({
        ruleId: rule.id,
        ruleName: rule.name,
        conclusion: "该规则下的结论；没有问题时明确写未发现问题。",
        findings: [],
      })),
      findings: [],
    }, null, 2),
    "",
    "【当前待提交代码 diff】",
    diff,
  ].join("\n");
}

export function buildInspectionPrompt({
  projectPath,
  branch,
  headSha,
  profile,
  findingLimit,
  workspacePath,
}: InspectionRunnerInput): string {
  const rules = enabledRules(profile);
  const repositorySection = workspacePath
    ? [
      "【完整仓库上下文】",
      "当前工作目录是项目目标分支最新 commit 的完整只读工作区，请基于实际文件进行巡检，不要凭空猜测。",
      "使用 Read、Grep、Glob 查看关键文件、调用链、配置、测试和构建脚本；不要执行项目脚本、不要修改文件。",
    ].join("\n")
    : [
      "【仓库上下文】",
      "当前运行环境没有完整代码工作区，因此只能输出已获得证据支持的问题；不要声称已经读取未提供的文件。",
    ].join("\n");

  return [
    "你是严格的代码巡检机器人。全程使用简体中文，只报告有明确证据和实际影响的问题。",
    "本次任务是对项目当前版本做全仓库巡检，不是 Merge Request 审查；只输出最终 JSON，不要输出巡检过程。",
    `巡检 profile：${profile.displayName}`,
    `项目：${projectPath}`,
    `分支：${branch}`,
    `巡检 commit：${headSha}`,
    ...(findingLimit === undefined || findingLimit === null ? [] : [`问题发现上限：${findingLimit} 个去重问题，达到上限后立即停止继续取证并返回已记录结果。`]),
    "",
    repositorySection,
    renderRuleInstructions(rules, "巡检"),
    "",
    "【输出协议】",
    "必须只输出 JSON，不要输出 Markdown 代码围栏。",
    "每条规则都是独立审计任务，必须先使用 Read、Grep、Glob 做该规则的针对性取证；不得用其他规则的结论代替本规则，也不得因为前一条规则已经发现问题就跳过本规则。",
    "空 findings 不是默认结论：只有在结论中说明已核查的具体文件、调用链或数据流并排除实际风险后才允许为空；发现有明确触发条件、代码证据和实际影响的中低风险也必须报告，不要只报告高危问题。",
    "所有面向用户的描述必须使用简体中文，包括 summary、ruleResults 的 ruleName/conclusion，以及 findings 的 category/issue/suggestion；文件路径、分支名、commit、ruleId 和严重级别枚举可以保留原值。",
    "ruleResults 必须按照巡检规则的执行顺序，为每个启用规则各输出一个独立分块；即使没有问题也要输出 conclusion 和空 findings。",
    "如果当前工具列表中提供 report_inspection_finding：每确认一个有明确证据的问题，必须立即单独调用一次该工具；不要等整条规则结束后批量上报。工具调用成功才算实时记录，最终 JSON 仍需完整列出 findings 供后端做一致性校验。",
    "最终 JSON 中已上报问题沿用上报时的描述，不要翻译或改写成第二条问题。规则分块已有的问题不要再次放到顶层 findings；顶层仅列出尚未归入任何规则的问题。",
    "每条 finding 必须具体到文件路径和代码行为；line 尽量填写问题所在的实际行号；没有明确影响的问题不要输出。",
    "每条巡检 finding 都要标明 scope：具体行问题为 line，文件规模等整文件问题为 file（line 填 null），跨文件问题为 cross_file 并在 relatedPaths 列出其余全部相关文件路径。负责人按问题本身判断；跨文件问题要结合全部相关文件判断同一负责人。",
    JSON.stringify(ruleOutputExample(rules), null, 2),
  ].join("\n");
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeFinding(finding: unknown): ReviewFinding | null {
  if (!finding || typeof finding !== "object") return null;
  const value = finding as Record<string, unknown>;
  const severity = typeof value.severity === "string" && SEVERITIES.has(value.severity) ? value.severity : "medium";
  const line = Number.isInteger(value.line) && Number(value.line) > 0 ? Number(value.line) : null;
  const scope = InspectionFindingScopeSchema.safeParse(value.scope);
  if (!value.path || !value.issue) return null;
  return {
    severity,
    category: String(value.category ?? "logic"),
    path: String(value.path),
    line,
    issue: String(value.issue),
    suggestion: String(value.suggestion ?? ""),
    ...(scope.success ? { scope: scope.data } : {}),
    ...(Array.isArray(value.relatedPaths) ? { relatedPaths: value.relatedPaths.filter((item): item is string => typeof item === "string") } : {}),
  };
}

function normalizeFindings(value: unknown): ReviewFinding[] {
  return Array.isArray(value) ? value.map(normalizeFinding).filter((item): item is ReviewFinding => item !== null) : [];
}

function normalizeRuleResult(value: unknown): ReviewRuleResult | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const ruleId = String(record.ruleId ?? "").trim();
  const ruleName = String(record.ruleName ?? "").trim();
  if (!ruleId || !ruleName) return null;
  return {
    ruleId,
    ruleName,
    conclusion: String(record.conclusion ?? "未提供该规则结论。"),
    findings: normalizeFindings(record.findings),
  };
}

function normalizeRuleResults(value: unknown): ReviewRuleResult[] {
  return Array.isArray(value) ? value.map(normalizeRuleResult).filter((item): item is ReviewRuleResult => item !== null) : [];
}

function completeRuleResults(
  results: ReviewRuleResult[],
  legacyFindings: ReviewFinding[],
  rules: PromptRule[] = [],
  taskLabel = "审查",
): ReviewRuleResult[] {
  if (rules.length === 0) {
    if (results.length > 0) return results;
    return legacyFindings.length > 0
      ? [{
        ruleId: "legacy-rule",
        ruleName: taskLabel === "审查" ? "规则审查" : `${taskLabel}规则`,
        conclusion: taskLabel === "审查" ? "检测到规则问题。" : `检测到${taskLabel}规则问题。`,
        findings: legacyFindings,
      }]
      : [];
  }
  const resultById = new Map(results.map((result) => [result.ruleId, result]));
  const resultByName = new Map(results.map((result) => [result.ruleName, result]));
  let legacyAssigned = false;
  return rules.map((rule) => {
    const existing = resultById.get(rule.id) ?? resultByName.get(rule.name);
    if (existing) return { ...existing, ruleId: rule.id, ruleName: rule.name };
    if (!legacyAssigned && legacyFindings.length > 0) {
      legacyAssigned = true;
      return { ruleId: rule.id, ruleName: rule.name, conclusion: taskLabel === "审查" ? "检测到规则问题。" : `检测到${taskLabel}规则问题。`, findings: legacyFindings };
    }
    return { ruleId: rule.id, ruleName: rule.name, conclusion: taskLabel === "审查" ? "未返回该规则的独立问题。" : `未返回该${taskLabel}规则的独立问题。`, findings: [] };
  });
}

function structuredResult(parsed: Record<string, unknown>, raw: string, rules: PromptRule[] = [], taskLabel = "审查"): ParsedReviewResult {
  const legacyFindings = normalizeFindings(parsed.ruleFindings);
  const findings = normalizeFindings(parsed.findings);
  const ruleResults = completeRuleResults(normalizeRuleResults(parsed.ruleResults), legacyFindings, rules.filter((rule) => rule.enabled), taskLabel);
  return {
    format: "structured",
    summary: String(parsed.summary ?? ""),
    ruleResults,
    findings,
    raw,
    ruleFindingCount: ruleResults.reduce((total, result) => total + result.findings.length, 0),
    findingCount: findings.length,
    headSha: null,
  };
}

function parseStructuredCandidate(candidate: string, raw: string, rules: PromptRule[], taskLabel: string): ParsedReviewResult | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return isRecord(parsed) ? structuredResult(parsed, raw, rules, taskLabel) : null;
  } catch {
    return null;
  }
}

export interface ParsedPreSubmitReviewResult extends ParsedReviewResult {
  requirementChecks: PreSubmitRequirementCheck[];
}

function preSubmitCandidate(value: string): z.infer<typeof PreSubmitReviewOutputSchema> | null {
  try {
    const parsed = PreSubmitReviewOutputSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parsePreSubmitReviewOutput(raw: string, rules: PromptRule[] = []): ParsedPreSubmitReviewResult {
  const text = String(raw ?? "").trim();
  const candidate = stripCodeFence(text);
  const candidates = [candidate];
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(candidate.slice(start, end + 1));
  for (const item of candidates) {
    const parsed = preSubmitCandidate(item);
    if (!parsed) continue;
    const review = parseReviewOutput(JSON.stringify(parsed), rules, "提交前 Review");
    return { ...review, requirementChecks: parsed.requirementChecks };
  }
  throw new Error("提交前 Review 返回了无效的结构化结果，未允许发布代码");
}

export interface PreSubmitReviewGateSummary extends ReviewGateSummary {
  unmetRequirementCount: number;
  missingRequirementCount: number;
  unclearRequirementCount: number;
}

export function preSubmitReviewGate(result: ParsedPreSubmitReviewResult): PreSubmitReviewGateSummary {
  const reviewGate = reviewGateSummary(result);
  const unmetRequirementCount = result.requirementChecks.filter((item) => item.status !== "satisfied").length;
  const missingRequirementCount = result.requirementChecks.filter((item) => item.status === "missing").length;
  const unclearRequirementCount = result.requirementChecks.filter((item) => item.status === "unclear").length;
  return {
    ...reviewGate,
    gate: missingRequirementCount === 0 && reviewGate.gate === "passed" ? "passed" : "failed",
    unmetRequirementCount,
    missingRequirementCount,
    unclearRequirementCount,
  };
}

export function parseReviewOutput(raw: string, rules: PromptRule[] = [], taskLabel = "审查"): ParsedReviewResult {
  const text = String(raw ?? "").trim();
  const candidate = stripCodeFence(text);
  const structured = parseStructuredCandidate(candidate, text, rules, taskLabel);
  if (structured) return structured;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const embedded = parseStructuredCandidate(candidate.slice(start, end + 1), text, rules, taskLabel);
    if (embedded) return embedded;
  }
  const isInspection = taskLabel === "巡检";
  return {
    format: "raw",
    summary: isInspection ? "Claude 返回了非结构化巡检结果，以下保留原始巡检内容。" : "Claude 返回了非结构化结果，以下保留原始审查内容。",
    ruleResults: [],
    findings: [],
    raw: text || (isInspection ? "[巡检返回了空结果]" : "[Claude returned an empty review]"),
    ruleFindingCount: 0,
    findingCount: 0,
    headSha: null,
  };
}

function markdownCell(value: unknown): string {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderReviewComment({ projectId, mrIid, headSha, result }: {
  projectId: string;
  mrIid: string;
  headSha: string | null;
  result: ParsedReviewResult;
}): string {
  const gate = reviewGateSummary(result);
  const header = [
    reviewReportNoteMarker(projectId, mrIid, headSha),
    "## Frontend Pilot 代码审查报告",
    "",
    `审查 commit：\`${String(headSha ?? "unknown").slice(0, 12)}\``,
    `合并门禁：${gate.gate === "passed" ? "✅ 通过" : "❌ 阻断"}`,
    `阻断问题：${gate.blockingFindingCount} 个${gate.blockingSeverities.length ? `（${gate.blockingSeverities.join("/")}）` : ""}`,
  ];
  if (result.format === "raw") return [...header, "", result.raw].join("\n");

  const body = ["", result.summary || "未提供总结。", "", "### 按规则审查结论"];
  if (result.ruleResults.length === 0) {
    body.push("当前没有返回规则分块。", "");
  } else {
    result.ruleResults.forEach((rule) => {
      body.push(`#### ${rule.ruleName}`, rule.conclusion || "未提供该规则结论。", "");
      if (rule.findings.length === 0) body.push("✅ 未发现明确问题", "");
      else body.push(...renderFindingsTable(rule.findings), "");
    });
  }
  body.push("### 跨规则高价值问题");
  if (result.findings.length === 0) body.push("✅ 未发现高价值问题");
  else body.push(...renderFindingsTable(result.findings));
  return [...header, ...body, ""].join("\n");
}

export function renderPreSubmitReviewReport({ jiraKey, diffSha, result }: {
  jiraKey: string;
  diffSha: string;
  result: ParsedPreSubmitReviewResult;
}): string {
  const gate = preSubmitReviewGate(result);
  const lines = [
    "## 提交前 AI Review",
    "",
    `Jira：${jiraKey}`,
    `审查 diff：\`${diffSha.slice(0, 12)}\``,
    `提交门禁：${gate.gate === "passed" ? "✅ 通过" : "❌ 阻断"}`,
    `阻断代码问题：${gate.blockingFindingCount} 个${gate.blockingSeverities.length ? `（${gate.blockingSeverities.join("/")}）` : ""}`,
    `未满足 Jira 要求：${gate.missingRequirementCount} 个`,
    `待 Pipeline 验证：${gate.unclearRequirementCount} 个`,
    "",
    "### Jira 需求核对",
    "",
    "| 状态 | 需求 | 代码证据 |",
    "| --- | --- | --- |",
    ...result.requirementChecks.map((item) => [item.status, item.requirement, item.evidence || "未提供证据"].map(markdownCell).join(" | ").replace(/^/, "| ").concat(" |")),
    "",
    "### 按规则审查结论",
  ];
  if (result.ruleResults.length === 0) {
    lines.push("当前没有返回规则分块。", "");
  } else {
    result.ruleResults.forEach((rule) => {
      lines.push(`#### ${rule.ruleName}`, rule.conclusion || "未提供该规则结论。", "");
      if (rule.findings.length === 0) lines.push("✅ 未发现明确问题", "");
      else lines.push(...renderFindingsTable(rule.findings), "");
    });
  }
  if (gate.gate === "passed" && gate.unclearRequirementCount > 0) {
    lines.push("", "> 存在静态代码无法完全确认的要求，已保留为待验证项；Draft MR 创建后由目标仓库 Pipeline 继续验收。", "");
  }
  lines.push("### 跨规则高价值问题");
  if (result.findings.length === 0) lines.push("✅ 未发现高价值问题");
  else lines.push(...renderFindingsTable(result.findings));
  return `${lines.join("\n")}\n`;
}

export function renderPreSubmitReviewFeedback(result: ParsedPreSubmitReviewResult): string {
  const gate = preSubmitReviewGate(result);
  const unmetRequirements = result.requirementChecks.filter((item) => item.status !== "satisfied");
  const findings = [
    ...result.ruleResults.flatMap((rule) => rule.findings),
    ...result.findings,
  ];
  const lines = [
    `提交前 Review 门禁：${gate.gate === "passed" ? "通过" : "阻断"}`,
    "",
    unmetRequirements.length ? "【未满足或无法证明的 Jira 要求】" : "",
    ...unmetRequirements.map((item) => `- [${item.status}] ${item.requirement}\n  证据：${item.evidence || "未提供"}`),
    findings.length ? "【代码问题】" : "",
    ...findings.map((finding) => `- [${finding.severity}] ${finding.path}${finding.line ? `:${finding.line}` : ""}：${finding.issue}\n  建议：${finding.suggestion || "请根据问题根因修复"}`),
  ].filter(Boolean);
  return lines.join("\n").trim() || "提交前 Review 未返回可修复反馈。";
}

function renderFindingsTable(findings: ReviewFinding[]): string[] {
  return [
    "| 严重度 | 类型 | 位置 | 问题 | 建议 |",
    "| --- | --- | --- | --- | --- |",
    ...findings.map((finding) => [
      finding.severity,
      finding.category,
      `${finding.path}${finding.line ? `:${finding.line}` : ""}`,
      finding.issue,
      finding.suggestion,
    ].map(markdownCell).join(" | ").replace(/^/, "| ").concat(" |")),
  ];
}
