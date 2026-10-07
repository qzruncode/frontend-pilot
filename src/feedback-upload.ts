import type {} from "@fastify/multipart";
import type { FastifyRequest } from "fastify";
import {
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_ATTACHMENTS,
  FeedbackImageMimeTypeSchema,
  type FeedbackImageMimeType,
} from "./contracts.js";

export function isFeedbackImageMimeType(value: unknown): value is FeedbackImageMimeType {
  return FeedbackImageMimeTypeSchema.safeParse(value).success;
}

export interface FeedbackAttachmentInput {
  filename: string;
  mimeType: FeedbackImageMimeType;
  data: Buffer;
}

export class FeedbackUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackUploadError";
  }
}

export type FeedbackUploadFailure = { status: 400 | 413; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeFilename(filename: string): string {
  const basename = filename.replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  const safe = basename.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180).trim();
  return safe || "图片";
}

function detectImageMime(data: Buffer): FeedbackImageMimeType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function uploadLimitError(error: unknown): string | null {
  if (!isRecord(error) || typeof error.code !== "string") return null;
  if (error.code === "FST_REQ_FILE_TOO_LARGE") return "单张图片不能超过 5 MB。";
  if (error.code === "FST_FILES_LIMIT") return "最多上传 3 张图片。";
  if (error.code === "FST_PARTS_LIMIT") return "反馈表单内容过多，请减少附件后重试。";
  return null;
}

export function feedbackUploadErrorMessage(error: unknown): string | null {
  return error instanceof FeedbackUploadError ? error.message : uploadLimitError(error);
}

export function feedbackUploadFailure(error: unknown): FeedbackUploadFailure | null {
  const message = feedbackUploadErrorMessage(error);
  if (!message) return null;
  if (isRecord(error) && error.code === "FST_REQ_FILE_TOO_LARGE") return { status: 413, message };
  return { status: 400, message };
}

export async function parseFeedbackSubmission(request: FastifyRequest): Promise<{ body: Record<string, unknown>; attachments: FeedbackAttachmentInput[] }> {
  if (!request.isMultipart()) {
    return { body: isRecord(request.body) ? request.body : {}, attachments: [] };
  }

  const body: Record<string, unknown> = {};
  const attachments: FeedbackAttachmentInput[] = [];
  for await (const part of request.parts()) {
    if (part.type === "field") {
      body[part.fieldname] = part.value;
      continue;
    }
    const data = await part.toBuffer();
    if (data.byteLength > FEEDBACK_MAX_ATTACHMENT_BYTES) throw new FeedbackUploadError("单张图片不能超过 5 MB。");
    if (attachments.length >= FEEDBACK_MAX_ATTACHMENTS) throw new FeedbackUploadError("最多上传 3 张图片。");
    const mimeType = detectImageMime(data);
    if (!mimeType) throw new FeedbackUploadError("仅支持 JPG、PNG、GIF 或 WebP 图片。");
    attachments.push({ filename: normalizeFilename(part.filename), mimeType, data });
  }
  if (typeof body.rating === "string") body.rating = Number(body.rating);
  return { body, attachments };
}
