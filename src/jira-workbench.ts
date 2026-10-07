import { z } from "zod";

const JiraIdSchema = z.union([z.string().trim().min(1), z.number().int()]);

const RawJiraUserSchema = z.object({
  name: z.string().nullable().optional(),
  key: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  emailAddress: z.string().nullable().optional(),
  active: z.boolean().optional(),
  avatarUrls: z.record(z.string(), z.string()).optional(),
}).passthrough();

const RawJiraStatusSchema = z.object({
  id: JiraIdSchema.nullable().optional(),
  name: z.string().nullable().optional(),
  statusCategory: z.object({ key: z.string().nullable().optional() }).passthrough().nullable().optional(),
}).passthrough();

export const RawJiraTransitionSchema = z.object({
  id: JiraIdSchema,
  name: z.string().nullable().optional(),
  to: RawJiraStatusSchema.nullable().optional(),
}).passthrough();

const RawJiraIssueTypeSchema = z.object({ name: z.string().nullable().optional() }).passthrough();
const RawJiraPrioritySchema = z.object({ name: z.string().nullable().optional() }).passthrough();
const RawJiraProjectSchema = z.object({
  key: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
}).passthrough();

export const RawJiraCommentSchema = z.object({
  id: JiraIdSchema,
  body: z.unknown().optional(),
  author: RawJiraUserSchema.nullable().optional(),
  created: z.string().nullable().optional(),
  updated: z.string().nullable().optional(),
}).passthrough();

export const RawJiraAttachmentSchema = z.object({
  id: JiraIdSchema,
  filename: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  created: z.string().nullable().optional(),
  author: RawJiraUserSchema.nullable().optional(),
}).passthrough();

const RawJiraFieldsSchema = z.object({
  summary: z.string().optional(),
  description: z.unknown().optional(),
  status: RawJiraStatusSchema.nullable().optional(),
  issuetype: RawJiraIssueTypeSchema.nullable().optional(),
  priority: RawJiraPrioritySchema.nullable().optional(),
  project: RawJiraProjectSchema.nullable().optional(),
  assignee: RawJiraUserSchema.nullable().optional(),
  reporter: RawJiraUserSchema.nullable().optional(),
  labels: z.array(z.string()).optional(),
  created: z.string().nullable().optional(),
  updated: z.string().nullable().optional(),
  resolution: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  comment: z.object({ comments: z.array(RawJiraCommentSchema).optional() }).passthrough().nullable().optional(),
  attachment: z.array(RawJiraAttachmentSchema).optional(),
}).passthrough();

export const RawJiraIssueSchema = z.object({
  id: JiraIdSchema,
  key: z.string().trim().min(1),
  self: z.string().nullable().optional(),
  fields: RawJiraFieldsSchema,
}).passthrough();

export const RawJiraUserResponseSchema = RawJiraUserSchema;
export const RawJiraSearchResponseSchema = z.object({
  issues: z.array(RawJiraIssueSchema),
  startAt: z.number().int().nonnegative().optional(),
  maxResults: z.number().int().positive().optional(),
  total: z.number().int().nonnegative().optional(),
}).passthrough();
export const RawJiraIssueResponseSchema = RawJiraIssueSchema;
export const RawJiraTransitionsResponseSchema = z.object({
  transitions: z.array(RawJiraTransitionSchema),
}).passthrough();

export type RawJiraComment = z.infer<typeof RawJiraCommentSchema>;
export type RawJiraAttachment = z.infer<typeof RawJiraAttachmentSchema>;
export type RawJiraIssue = z.infer<typeof RawJiraIssueSchema>;
export type RawJiraTransition = z.infer<typeof RawJiraTransitionSchema>;
export type RawJiraUser = z.infer<typeof RawJiraUserSchema>;

export type JiraIssueScope = "assigned_to_me" | "reported_by_me" | "all";
export type JiraIssueState = "review" | "todo" | "in_progress" | "acceptance" | "done" | "all";

export interface JiraIssueListQuery {
  scope: JiraIssueScope;
  state: JiraIssueState;
  search?: string;
  issueKeys?: readonly string[];
  projectKey?: string;
  assignee?: string;
  reporter?: string;
  page: number;
  perPage: number;
}

export interface JiraIdentity {
  username: string;
  name: string;
  avatarUrl: string | null;
  email?: string | null;
}

export interface JiraIssueSummary {
  id: string;
  key: string;
  summary: string;
  description: string | null;
  status: string;
  statusId: string | null;
  statusCategory: string;
  issueType: string;
  priority: string | null;
  projectKey: string;
  projectName: string;
  webUrl: string;
  createdAt: string | null;
  updatedAt: string | null;
  resolution: string | null;
  labels: string[];
  assignee: JiraIdentity | null;
  reporter: JiraIdentity | null;
}

export interface JiraIssueComment {
  id: string;
  body: string;
  author: JiraIdentity | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface JiraIssueAttachment {
  id: string;
  filename: string;
  url: string | null;
  mimeType: string | null;
  size: number | null;
  createdAt: string | null;
  author: JiraIdentity | null;
}

export interface JiraIssueDetails extends JiraIssueSummary {
  comments: JiraIssueComment[];
  attachments: JiraIssueAttachment[];
}

export interface JiraIssueTransition {
  id: string;
  name: string;
  toStatus: string;
  toStatusId: string | null;
}

export interface JiraIssuePage {
  issues: JiraIssueSummary[];
  page: number;
  perPage: number;
  total: number;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("");
  const record = objectValue(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (record.content !== undefined) return textValue(record.content);
  if (record.body !== undefined) return textValue(record.body);
  return "";
}

function stringValue(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function identity(value: RawJiraUser | null | undefined): JiraIdentity | null {
  if (!value) return null;
  return {
    username: value.name?.trim() || value.key?.trim() || "",
    name: value.displayName?.trim() || value.name?.trim() || value.key?.trim() || "未知用户",
    avatarUrl: value.avatarUrls?.["48x48"] ?? value.avatarUrls?.["24x24"] ?? null,
    ...(value.emailAddress?.trim() ? { email: value.emailAddress.trim() } : {}),
  };
}

export function normalizeJiraUser(value: RawJiraUser): JiraIdentity {
  return identity(value) ?? { username: "", name: "未知用户", avatarUrl: null };
}

export function normalizeJiraIssue(value: RawJiraIssue, baseUrl: string): JiraIssueSummary {
  const fields = value.fields;
  const base = baseUrl.replace(/\/+$/, "");
  return {
    id: String(value.id),
    key: value.key,
    summary: fields.summary?.trim() || "未命名 Jira 问题",
    description: fields.description === undefined || fields.description === null ? null : textValue(fields.description).trim() || null,
    status: fields.status?.name?.trim() || "未知状态",
    statusId: stringValue(fields.status?.id),
    statusCategory: fields.status?.statusCategory?.key?.trim() || "undefined",
    issueType: fields.issuetype?.name?.trim() || "未知类型",
    priority: fields.priority?.name?.trim() || null,
    projectKey: fields.project?.key?.trim() || "",
    projectName: fields.project?.name?.trim() || fields.project?.key?.trim() || "未知项目",
    webUrl: `${base}/browse/${encodeURIComponent(value.key)}`,
    createdAt: fields.created ?? null,
    updatedAt: fields.updated ?? null,
    resolution: fields.resolution?.name?.trim() || null,
    labels: fields.labels ?? [],
    assignee: identity(fields.assignee),
    reporter: identity(fields.reporter),
  };
}

export function normalizeJiraComment(value: RawJiraComment): JiraIssueComment {
  return {
    id: String(value.id),
    body: textValue(value.body).trim(),
    author: identity(value.author),
    createdAt: value.created ?? null,
    updatedAt: value.updated ?? null,
  };
}

function attachmentUrl(value: string | null | undefined, baseUrl: string): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value, `${baseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return null;
  }
}

export function normalizeJiraAttachment(value: RawJiraAttachment, baseUrl: string): JiraIssueAttachment {
  return {
    id: String(value.id),
    filename: value.filename?.trim() || "未命名附件",
    url: attachmentUrl(value.content, baseUrl),
    mimeType: value.mimeType?.trim() || null,
    size: value.size ?? null,
    createdAt: value.created ?? null,
    author: identity(value.author),
  };
}

export function normalizeJiraTransition(value: RawJiraTransition): JiraIssueTransition {
  const name = value.name?.trim() || "切换状态";
  return {
    id: String(value.id),
    name,
    toStatus: value.to?.name?.trim() || name,
    toStatusId: stringValue(value.to?.id),
  };
}
