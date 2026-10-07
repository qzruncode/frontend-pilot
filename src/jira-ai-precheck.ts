import { createHash } from "node:crypto";
import type { JiraIssueDetails } from "./api-contracts.js";
import {
  OrdinaryJiraAiCheckIdSchema,
  OrdinaryJiraAiCheckSchema,
  OrdinaryJiraAiImplementationBriefSchema,
  type OrdinaryJiraAiCheck,
  type OrdinaryJiraAiCheckId,
  type OrdinaryJiraAiImplementationBrief,
} from "./api-contracts.js";
import type { ReviewRunnerRunOptions } from "./contracts.js";
import { z } from "zod";

export const ORDINARY_JIRA_AI_CHECKS: ReadonlyArray<{ id: OrdinaryJiraAiCheckId; label: string; instruction: string }> = [
  { id: "problem", label: "问题现象", instruction: "能明确说明当前发生了什么错误、异常行为或需要解决的问题。" },
  { id: "expected", label: "期望结果", instruction: "能明确说明修复后应该达到的行为或结果。" },
  { id: "scope", label: "影响范围 / 模块 / 代码位置", instruction: "能定位影响的产品模块、功能、项目、文件、接口或用户范围。" },
  { id: "reproduction", label: "复现条件 / 环境 / 版本", instruction: "能说明触发步骤、输入条件、运行环境或相关版本；明确不适用时也要有依据。" },
  { id: "acceptance", label: "验收标准", instruction: "能据此判断改动是否完成，至少有可验证的验收条件。" },
  { id: "constraints", label: "兼容性 / 约束", instruction: "能说明兼容性、性能、安全、发布、接口或其他不能违反的约束；没有额外约束时要有明确说明。" },
];

export const JiraAiPrecheckModelOutputSchema = z.object({
  checks: z.array(OrdinaryJiraAiCheckSchema).length(6),
  summary: z.string().trim().max(4_000),
  implementationBrief: OrdinaryJiraAiImplementationBriefSchema,
}).strict();

export type JiraAiPrecheckModelOutput = z.infer<typeof JiraAiPrecheckModelOutputSchema>;

export const JiraAiPrecheckSupplementModelOutputSchema = z.object({
  status: z.enum(["resolvable", "needs_user"]),
  suggestion: z.string().trim().max(4_000),
  evidence: z.string().trim().max(2_000),
  reason: z.string().trim().max(2_000),
}).strict();

export type JiraAiPrecheckSupplementModelOutput = z.infer<typeof JiraAiPrecheckSupplementModelOutputSchema>;

export interface JiraAiPrecheckInput {
  issue: JiraIssueDetails;
  projectPath: string;
  targetBranch: string;
}

export interface JiraAiPrecheckSupplementInput extends JiraAiPrecheckInput {
  check: {
    id: OrdinaryJiraAiCheckId;
    label: string;
    instruction: string;
    detail: string;
  };
}

export interface JiraAiPrecheckResult extends JiraAiPrecheckModelOutput {
  status: "passed" | "needs_input";
}

export interface JiraAiPrecheckSupplementResult {
  status: "resolvable" | "needs_user";
  suggestion: string;
  evidence: string;
  reason: string;
}

export interface JiraAiPrecheckRunner {
  runJiraAiPrecheck(input: JiraAiPrecheckInput, options?: ReviewRunnerRunOptions): Promise<JiraAiPrecheckResult>;
  runJiraAiPrecheckSupplement?(input: JiraAiPrecheckSupplementInput, options?: ReviewRunnerRunOptions): Promise<JiraAiPrecheckSupplementResult>;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim();
}

function issueMaterial(issue: JiraIssueDetails): string {
  const comments = issue.comments
    .map((comment, index) => [
      `评论 ${index + 1}${comment.author?.name ? `（${comment.author.name}）` : ""}${comment.createdAt ? ` · ${comment.createdAt}` : ""}`,
      normalizeText(comment.body),
    ].join("\n"))
    .join("\n\n");
  const attachments = issue.attachments
    .map((attachment) => `${attachment.filename}${attachment.mimeType ? `（${attachment.mimeType}）` : ""}`)
    .join("、");
  return [
    `Jira：${issue.key}`,
    `标题：${normalizeText(issue.summary)}`,
    "描述：",
    normalizeText(issue.description) || "（无描述）",
    "评论：",
    comments || "（无评论）",
    "附件文件名（仅供线索，未读取附件内容）：",
    attachments || "（无附件）",
  ].join("\n");
}

export function buildJiraAiPrecheckPrompt(input: JiraAiPrecheckInput): string {
  const checkInstructions = ORDINARY_JIRA_AI_CHECKS
    .map((item) => `- ${item.id} / ${item.label}：${item.instruction}`)
    .join("\n");
  return [
    "你是普通 Jira 的 AI 处理预检查器，不是实现代码的助手。",
    "请使用中文，只根据 Jira 标题、描述和评论判断上下文是否足够支持安全修改代码。",
    "不要因为文字很长就判定通过，也不要用常识补齐 Jira 没有提供的要求。评论和描述都属于输入材料。",
    "每个检查项都必须返回 present 或 missing。present 必须给出来自 Jira 原文的简短证据；missing 必须说明缺少什么。",
    "如果 Jira 明确写了‘不适用/无额外约束’，可以把对应项判为 present，并在证据中说明原文依据；没有明确说明不能自行推断。",
    "只有六个检查项全部 present 时才算通过。implementationBrief 只能整理 Jira 已经写明的内容，不能提出未经确认的新需求。",
    `目标 GitLab 项目：${input.projectPath}`,
    `目标分支：${input.targetBranch}`,
    "必须检查的项目：",
    checkInstructions,
    "Jira 真实内容：",
    issueMaterial(input.issue),
    "只返回 JSON schema 规定的 checks、summary、implementationBrief，不要返回代码围栏或其他字段。",
  ].join("\n\n");
}

export function buildJiraAiPrecheckSupplementPrompt(input: JiraAiPrecheckSupplementInput): string {
  return [
    "你是普通 Jira AI 预检查的缺失项补充判断器，不是实现代码的助手。",
    "请使用中文，只根据 Jira 标题、描述和评论，判断能否为指定缺失项整理出一条可靠、可直接写回 Jira 的补充内容。",
    "不要读取代码，不要使用项目名、分支名或常识猜测 Jira 没有提供的需求；目标项目和分支只能作为上下文，不能作为证据。",
    "只有 Jira 原文明确给出，或多处 Jira 原文可以无歧义地合并出答案时，status 才能返回 resolvable。",
    "如果需要用户选择、确认业务规则、补充环境或猜测验收标准，必须返回 needs_user，不要为了给出答案而编造内容。",
    "resolvable 时 suggestion 必须是一条具体的补充说明，evidence 必须指出 Jira 中支持它的原文；needs_user 时 suggestion 必须为空，并在 reason 中说明用户还需要补充什么。",
    `目标 GitLab 项目：${input.projectPath}`,
    `目标分支：${input.targetBranch}`,
    `待补充检查项：${input.check.id} / ${input.check.label}`,
    `检查项要求：${input.check.instruction}`,
    `第一次预检查提示：${input.check.detail}`,
    "Jira 真实内容：",
    issueMaterial(input.issue),
    "只返回 JSON schema 规定的 status、suggestion、evidence、reason，不要返回代码围栏或其他字段。",
  ].join("\n\n");
}

function fallbackBrief(checks: OrdinaryJiraAiCheck[]): OrdinaryJiraAiImplementationBrief {
  const byId = new Map(checks.map((check) => [check.id, check.evidence || check.detail]));
  return OrdinaryJiraAiImplementationBriefSchema.parse(Object.fromEntries(
    ORDINARY_JIRA_AI_CHECKS.map(({ id }) => [id, byId.get(id) ?? ""]),
  ));
}

export function normalizeJiraAiPrecheckOutput(value: unknown): JiraAiPrecheckResult {
  const parsed = JiraAiPrecheckModelOutputSchema.parse(value);
  const byId = new Map(parsed.checks.map((check) => [check.id, check]));
  const checks = ORDINARY_JIRA_AI_CHECKS.map(({ id, label }) => {
    const check = byId.get(id);
    return OrdinaryJiraAiCheckSchema.parse({
      id,
      label,
      status: check?.status ?? "missing",
      evidence: check?.evidence ?? "",
      detail: check?.detail ?? (check?.status === "present" ? "已在 Jira 内容中找到相关信息" : "Jira 中没有找到足够信息"),
    });
  });
  const complete = checks.every((check) => check.status === "present");
  return {
    status: complete ? "passed" : "needs_input",
    checks,
    summary: parsed.summary || (complete ? "Jira 上下文已满足 AI 处理的最低要求。" : "Jira 描述或评论缺少实现所需的关键信息。"),
    implementationBrief: complete ? parsed.implementationBrief : fallbackBrief(checks),
  };
}

export function normalizeJiraAiPrecheckSupplementOutput(value: unknown): JiraAiPrecheckSupplementResult {
  const parsed = JiraAiPrecheckSupplementModelOutputSchema.parse(value);
  const suggestion = parsed.suggestion.trim();
  const evidence = parsed.evidence.trim();
  const resolvable = parsed.status === "resolvable" && suggestion.length > 0 && evidence.length > 0;
  return {
    status: resolvable ? "resolvable" : "needs_user",
    suggestion: resolvable ? suggestion : "",
    evidence: resolvable ? evidence : "",
    reason: parsed.reason.trim() || (resolvable ? "已从 Jira 原文整理出可核对的补充内容。" : "Jira 当前内容不足以可靠判断该项。"),
  };
}

export function jiraAiContentHash(input: JiraAiPrecheckInput): string {
  return createHash("sha256").update(JSON.stringify({
    issue: {
      key: input.issue.key,
      summary: input.issue.summary,
      description: input.issue.description,
      updatedAt: input.issue.updatedAt,
      comments: input.issue.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        author: comment.author?.username ?? comment.author?.name ?? null,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })),
      attachments: input.issue.attachments.map((attachment) => ({ id: attachment.id, filename: attachment.filename, createdAt: attachment.createdAt })),
    },
    projectPath: input.projectPath.trim(),
    targetBranch: input.targetBranch.trim(),
  }, null, 2), "utf8").digest("hex");
}

export function jiraAiIssueMaterial(issue: JiraIssueDetails): string {
  return issueMaterial(issue);
}
