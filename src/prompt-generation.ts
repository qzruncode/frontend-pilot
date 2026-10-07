import { z } from "zod";
import type {
  InspectionFinding,
  InspectionOwnership,
  ReviewRunnerRunOptions,
} from "./contracts.js";
import {
  DEFAULT_INSPECTION_JIRA_DESCRIPTION_PROMPT,
  DEFAULT_INSPECTION_JIRA_FIELDS_PROMPT,
  DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT,
} from "./inspection-prompts.js";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RELEASE_LABEL_PATTERN = /^release-(\d{8})$/;
const JIRA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}-\d+$/;

const InspectionJiraFindingSchema = z.object({
  severity: z.string().trim().min(1).max(64),
  category: z.string().trim().min(1).max(128),
  path: z.string().trim().min(1).max(1_000),
  line: z.number().int().positive().nullable(),
  issue: z.string().trim().min(1).max(8_000),
  suggestion: z.string().trim().max(8_000),
  scope: z.string().trim().max(64).optional(),
  relatedPaths: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
});

export interface InspectionJiraCreatePromptInput {
  projectPath: string;
  branch: string;
  headSha: string;
  createdAt: string;
  finding: Pick<InspectionFinding, "severity" | "category" | "path" | "line" | "issue" | "suggestion" | "scope" | "relatedPaths">;
  owner: {
    username: string;
    name: string | null;
    reason: string;
    evidence: InspectionOwnership["evidence"];
    source?: "ai" | "manual";
  };
}

const InspectionJiraCreatePlanSchema = z.object({
  description: z.string().trim().min(1).max(50_000),
  labels: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
  dueDate: z.string().regex(DATE_ONLY_PATTERN).nullable().optional().default(null),
}).strict();

export { InspectionJiraCreatePlanSchema };
export type InspectionJiraCreatePlan = z.output<typeof InspectionJiraCreatePlanSchema>;

export interface MergeRequestDescriptionPromptInput {
  projectPath: string;
  jiraKey: string;
  jiraUrl?: string | null;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  commitTitle?: string | null;
  commitMessage?: string | null;
  jiraDescription?: string | null;
}

export const MergeRequestDescriptionOutputSchema = z.object({
  description: z.string().trim().min(1).max(100_000),
}).strict();

export interface ManagedPromptRunner {
  generateInspectionJiraCreatePlan(
    input: InspectionJiraCreatePromptInput,
    options?: PromptGenerationRunOptions,
  ): Promise<InspectionJiraCreatePlan>;
  generateMergeRequestDescription(
    input: MergeRequestDescriptionPromptInput,
    options?: PromptGenerationRunOptions,
  ): Promise<string>;
}

export type PromptGenerationRunOptions = Pick<ReviewRunnerRunOptions, "signal" | "ownerId" | "onProgress">;

function dateFromCreatedAt(value: string): Date {
  const dateOnly = value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  const date = new Date(`${dateOnly ?? ""}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function nextThursdayDate(createdAt: string): string {
  const date = dateFromCreatedAt(createdAt);
  const daysAhead = (4 - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

function isValidDateOnly(value: string | null | undefined): value is string {
  if (!value || !DATE_ONLY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function releaseLabel(date: string): string {
  return `release-${date.replaceAll("-", "")}`;
}

function labelsForPlan(labels: string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
}

function findingForPrompt(input: InspectionJiraCreatePromptInput): z.output<typeof InspectionJiraFindingSchema> {
  return InspectionJiraFindingSchema.parse(input.finding);
}

function hasOrderedHeadings(content: string, headings: RegExp[]): boolean {
  let previousIndex = -1;
  for (const heading of headings) {
    const match = heading.exec(content);
    if (!match || match.index <= previousIndex) return false;
    previousIndex = match.index;
  }
  return true;
}

export function buildDefaultInspectionJiraDescription(input: InspectionJiraCreatePromptInput): string {
  const finding = findingForPrompt(input);
  const location = `${input.projectPath} · ${input.branch} · ${input.headSha} · ${finding.path}${finding.line ? `:${finding.line}` : ""}`;
  const related = finding.relatedPaths?.length ? `\n相关文件：${finding.relatedPaths.join("、")}` : "";
  const evidence = input.owner.evidence.length
    ? `\n负责人判断依据：${input.owner.evidence.map((item) => item.title).join("；")}`
    : "";
  return [
    "h2. 背景",
    `巡检在 ${location} 发现该问题。负责人：${input.owner.username}${input.owner.name ? `（${input.owner.name}）` : ""}。${evidence}`,
    "",
    "h2. 问题描述 / 目标",
    `问题：${finding.issue}${related}`,
    `建议：${finding.suggestion || "请结合巡检证据修复。"}`,
    `${input.owner.source === "manual" ? "人工确认" : "AI 查询判断"}：${input.owner.reason}`,
    "",
    "h2. 验收标准",
    `* [ ] ${finding.suggestion || "问题已修复，并覆盖巡检指出的场景。"}`,
    `* [ ] 在 ${input.projectPath} 的 ${input.branch} 分支上完成必要验证。`,
  ].join("\n");
}

function normalizeJiraDescription(value: string, input: InspectionJiraCreatePromptInput): string {
  const content = value.trim()
    .replace(/^```(?:jira|text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^##\s+背景\s*$/gm, "h2. 背景")
    .replace(/^##\s+问题描述\s*\/\s*目标\s*$/gm, "h2. 问题描述 / 目标")
    .replace(/^##\s+验收标准\s*$/gm, "h2. 验收标准")
    .trim();
  const valid = hasOrderedHeadings(content, [
    /^h2\.\s+背景\s*$/m,
    /^h2\.\s+问题描述\s*\/\s*目标\s*$/m,
    /^h2\.\s+验收标准\s*$/m,
  ])
    && /^\*\s+\[[ xX]\]/m.test(content)
    && !/(out\s+of\s+scope|不在.*范围|不处理|范围外)/i.test(content);
  return valid ? content : buildDefaultInspectionJiraDescription(input);
}

export function normalizeInspectionJiraCreatePlan(
  value: unknown,
  input: InspectionJiraCreatePromptInput,
): InspectionJiraCreatePlan {
  const parsed = InspectionJiraCreatePlanSchema.safeParse(value);
  const raw = parsed.success ? parsed.data : { description: "", labels: [], dueDate: null };
  const labels = labelsForPlan(raw.labels);
  const releaseCandidates = labels.filter((label) => label.toLowerCase().startsWith("release-"));
  const exception = releaseCandidates.find((label) => /^(release-(?:tbd|multi|na)|release-.+-(?:回滚|rollback))$/i.test(label));
  const nonReleaseLabels = labels.filter((label) => !releaseCandidates.includes(label));

  let normalizedRelease: string | null = null;
  let dueDate: string | null = null;
  if (exception && /^release-(?:tbd|multi|na)$/i.test(exception)) {
    normalizedRelease = exception;
  } else if (exception && /-(?:回滚|rollback)$/i.test(exception)) {
    if (isValidDateOnly(raw.dueDate)) {
      normalizedRelease = exception;
      dueDate = raw.dueDate;
    }
  } else {
    const longRelease = releaseCandidates.find((label) => RELEASE_LABEL_PATTERN.test(label));
    const releaseMatch = longRelease?.match(RELEASE_LABEL_PATTERN)?.[1];
    const releaseDate = releaseMatch ? `${releaseMatch.slice(0, 4)}-${releaseMatch.slice(4, 6)}-${releaseMatch.slice(6, 8)}` : null;
    if (releaseDate && isValidDateOnly(releaseDate)) {
      normalizedRelease = longRelease!;
      dueDate = releaseDate;
    }
  }
  if (!normalizedRelease) {
    dueDate = nextThursdayDate(input.createdAt);
    normalizedRelease = releaseLabel(dueDate);
  }

  return {
    description: normalizeJiraDescription(raw.description, input),
    labels: [...nonReleaseLabels, normalizedRelease],
    dueDate: /^(release-(?:tbd|multi|na))$/i.test(normalizedRelease) ? null : dueDate,
  };
}

export function buildInspectionJiraCreatePrompt(
  input: InspectionJiraCreatePromptInput,
  descriptionPrompt = DEFAULT_INSPECTION_JIRA_DESCRIPTION_PROMPT,
  fieldsPrompt = DEFAULT_INSPECTION_JIRA_FIELDS_PROMPT,
): string {
  return `为一个已经确认负责人的巡检问题生成 Jira 创建计划。只使用事实材料，不重新判断负责人，不创建 Jira。

事实材料：
${JSON.stringify({ ...input, finding: findingForPrompt(input) }, null, 2)}

描述提示词：
${descriptionPrompt.trim() || DEFAULT_INSPECTION_JIRA_DESCRIPTION_PROMPT}

字段提示词：
${fieldsPrompt.trim() || DEFAULT_INSPECTION_JIRA_FIELDS_PROMPT}

返回 JSON schema 中的 description、labels、dueDate。description 只放 Jira 正文；labels 只放需要写入 Jira 的标签；dueDate 使用 YYYY-MM-DD 或 null。不要输出解释、Markdown 代码围栏或额外字段。`;
}

function jiraKey(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!JIRA_KEY_PATTERN.test(normalized)) throw new Error("Jira key 格式不正确");
  return normalized;
}

export function ensureMergeRequestTitleJiraKey(title: string, key: string): string {
  const normalizedKey = jiraKey(key);
  const base = title.trim()
    .replace(new RegExp(`\\s*\\(#${normalizedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)$`, "i"), "")
    .replace(new RegExp(`\\s+#${normalizedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), "")
    .trim();
  const suffix = ` (#${normalizedKey})`;
  return `${base.slice(0, Math.max(1, 255 - suffix.length)).trimEnd()}${suffix}`;
}

export function buildDefaultMergeRequestDescription(input: MergeRequestDescriptionPromptInput): string {
  const key = jiraKey(input.jiraKey);
  const jiraLine = input.jiraUrl ? `- Jira: ${key} (${input.jiraUrl})` : `- Jira: ${key}`;
  const changeContext = input.commitMessage?.trim();
  return [
    "## Background",
    input.jiraDescription?.trim() || `关联 Jira ${key}，请根据工单目标审阅本次改动。`,
    "",
    "## 改动",
    `- 项目：${input.projectPath}`,
    `- 分支：${input.sourceBranch} → ${input.targetBranch}`,
    `- 标题：${input.title.trim()}`,
    ...(changeContext ? ["", changeContext] : []),
    "",
    "## 验证",
    "- [ ] 待补充本次实际执行的测试或验证结果。",
    "",
    "## 关联",
    jiraLine,
  ].join("\n");
}

export function buildMergeRequestDescriptionPrompt(
  input: MergeRequestDescriptionPromptInput,
  configuredPrompt = DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT,
): string {
  const key = jiraKey(input.jiraKey);
  return `为关联 Jira ${key} 的 Merge Request 生成描述。只使用事实材料，不虚构测试结果，不修改代码或 GitLab。

事实材料：
${JSON.stringify({ ...input, jiraKey: key }, null, 2)}

提示词：
${configuredPrompt.trim() || DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT}

返回 JSON schema 中的 description 字段，只输出 Markdown 正文，不要代码围栏或额外字段。`;
}

export function normalizeMergeRequestDescription(value: unknown, input: MergeRequestDescriptionPromptInput): string {
  const content = typeof value === "string"
    ? value.trim().replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/i, "").trim()
    : "";
  const valid = hasOrderedHeadings(content, [
    /^##\s+Background\s*$/m,
    /^##\s+改动\s*$/m,
    /^##\s+验证\s*$/m,
    /^##\s+关联\s*$/m,
  ])
    && content.toUpperCase().includes(jiraKey(input.jiraKey));
  return valid ? content : buildDefaultMergeRequestDescription(input);
}
