import { asRecord } from "./agent-sdk-utils.js";
import type {
  AssistantRunEvent,
  AssistantStoredMessage,
  AssistantStoredMessageRole,
} from "./assistant-store.js";

export interface AssistantSqlRow {
  [key: string]: unknown;
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function rowToMessage(row: AssistantSqlRow): AssistantStoredMessage {
  return {
    id: String(row.id),
    role: String(row.role) as AssistantStoredMessageRole,
    content: String(row.content),
    createdAt: String(row.created_at),
  };
}

export function rowToRunEvent(row: AssistantSqlRow): AssistantRunEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.payload));
    const record = asRecord(parsed);
    if (record) payload = record;
  } catch {
    payload = { message: "无法恢复此事件" };
  }
  return {
    sequence: Number(row.sequence),
    event: String(row.event),
    payload,
    createdAt: String(row.created_at),
  };
}
