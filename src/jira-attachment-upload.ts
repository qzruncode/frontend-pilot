import type {} from "@fastify/multipart";
import type { FastifyRequest } from "fastify";
import { JIRA_MAX_ISSUE_ATTACHMENT_BYTES, JIRA_MAX_ISSUE_ATTACHMENTS } from "./contracts.js";

export interface JiraIssueAttachmentInput {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export class JiraAttachmentUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraAttachmentUploadError";
  }
}

export type JiraAttachmentUploadFailure = { status: 400 | 413; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function jiraAttachmentUploadFailure(error: unknown): JiraAttachmentUploadFailure | null {
  if (error instanceof JiraAttachmentUploadError) return { status: 400, message: error.message };
  if (!isRecord(error) || typeof error.code !== "string") return null;
  if (error.code === "FST_REQ_FILE_TOO_LARGE") return { status: 413, message: `单个附件不能超过 ${JIRA_MAX_ISSUE_ATTACHMENT_BYTES / (1024 * 1024)} MB。` };
  if (error.code === "FST_FILES_LIMIT") return { status: 400, message: `最多上传 ${JIRA_MAX_ISSUE_ATTACHMENTS} 个附件。` };
  return null;
}

function normalizeFilename(filename: string): string {
  const basename = filename.replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  const safe = basename.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180).trim();
  return safe || "附件";
}

export async function parseJiraAttachmentUpload(request: FastifyRequest): Promise<JiraIssueAttachmentInput[]> {
  if (!request.isMultipart()) throw new JiraAttachmentUploadError("请使用 multipart/form-data 上传 Jira 附件。");

  const attachments: JiraIssueAttachmentInput[] = [];
  for await (const part of request.parts()) {
    if (part.type === "field") continue;
    if (attachments.length >= JIRA_MAX_ISSUE_ATTACHMENTS) throw new JiraAttachmentUploadError(`最多上传 ${JIRA_MAX_ISSUE_ATTACHMENTS} 个附件。`);
    const data = await part.toBuffer();
    if (data.byteLength > JIRA_MAX_ISSUE_ATTACHMENT_BYTES) throw new JiraAttachmentUploadError(`单个附件不能超过 ${JIRA_MAX_ISSUE_ATTACHMENT_BYTES / (1024 * 1024)} MB。`);
    attachments.push({ filename: normalizeFilename(part.filename), mimeType: part.mimetype || "application/octet-stream", data });
  }
  if (attachments.length === 0) throw new JiraAttachmentUploadError("请选择至少一个附件。");
  return attachments;
}
