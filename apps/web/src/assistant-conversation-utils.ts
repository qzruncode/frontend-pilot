import type { AssistantConversationResponse, AssistantRunResponse, AssistantStreamEvent } from "./api";
import { mergeAssistantActivity, userFacingError } from "./assistant-activity";
import { createEmptyConversation, type AgentActivity, type ChatMessage, type Conversation } from "./assistant-types";
import { AssistantCardSchema, AssistantEditOperationSchema, type AssistantReviewTaskReference, type AssistantCard, type AssistantEditOperation } from "@contracts";

export const STORAGE_KEY = "frontend-pilot.assistant.conversations.v3";

const starterConversations: Conversation[] = [
  {
    id: "new-conversation",
    title: "新对话",
    updatedAt: Date.now(),
    messages: [{
      id: "welcome",
      role: "assistant",
      text: "你好，我是 Frontend Pilot。\n我可以帮你理解问题、梳理任务进度，并把下一步整理清楚。",
    }],
  },
];

const MAX_LOCAL_CONVERSATIONS = 200;
const MAX_LOCAL_MESSAGE_LENGTH = 60_000;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cappedText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.length > MAX_LOCAL_MESSAGE_LENGTH ? value.slice(0, MAX_LOCAL_MESSAGE_LENGTH) : value;
}

function normalizeReviewTask(value: unknown): AssistantReviewTaskReference | undefined {
  const raw = recordValue(value);
  if (!raw || typeof raw.id !== "string" || typeof raw.projectId !== "string" || typeof raw.mrIid !== "string") return undefined;
  if (!(typeof raw.status === "string" && ["queued", "running", "completed", "failed", "superseded", "canceled"].includes(raw.status))) return undefined;
  if (raw.action !== "started" && raw.action !== "canceled") return undefined;
  return {
    id: raw.id,
    projectId: raw.projectId,
    projectPath: typeof raw.projectPath === "string" ? raw.projectPath : null,
    mrIid: raw.mrIid,
    headSha: typeof raw.headSha === "string" ? raw.headSha : null,
    targetBranch: typeof raw.targetBranch === "string" ? raw.targetBranch : null,
    status: raw.status as AssistantReviewTaskReference["status"],
    error: typeof raw.error === "string" ? raw.error : null,
    action: raw.action,
    deduplicated: raw.deduplicated === true,
  };
}

function normalizeActivity(value: unknown): AgentActivity | null {
  const raw = recordValue(value);
  if (!raw || typeof raw.id !== "string" || typeof raw.title !== "string" || typeof raw.detail !== "string") return null;
  const kind = raw.kind;
  const phase = raw.phase;
  if (!(["thinking", "tool", "system", "warning"] as const).includes(kind as AgentActivity["kind"]) || !(["start", "running", "complete", "error"] as const).includes(phase as AgentActivity["phase"])) return null;
  const reviewTask = normalizeReviewTask(raw.reviewTask);
  return {
    id: raw.id,
    kind: kind as AgentActivity["kind"],
    title: cappedText(raw.title, "处理过程"),
    detail: cappedText(raw.detail),
    ...(typeof raw.progressDetail === "string" ? { progressDetail: cappedText(raw.progressDetail) } : {}),
    phase: phase as AgentActivity["phase"],
    ...(typeof raw.toolName === "string" ? { toolName: cappedText(raw.toolName) } : {}),
    toolInput: raw.toolInput,
    ...(typeof raw.result === "string" ? { result: cappedText(raw.result) } : {}),
    ...(typeof raw.resultError === "boolean" ? { resultError: raw.resultError } : {}),
    ...(reviewTask ? { reviewTask } : {}),
  };
}

function normalizeCard(value: unknown): AssistantCard | null {
  const parsed = AssistantCardSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function normalizeEditOperation(value: unknown): AssistantEditOperation | null {
  const parsed = AssistantEditOperationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function mergeAssistantEditOperations(
  operations: AssistantEditOperation[],
  incoming: AssistantEditOperation,
): AssistantEditOperation[] {
  const index = operations.findIndex((operation) => operation.id === incoming.id);
  if (index < 0) return [...operations, incoming].slice(-100);
  return operations.map((operation, operationIndex) => operationIndex === index ? incoming : operation).slice(-100);
}

function normalizeMessage(value: unknown): ChatMessage | null {
  const raw = recordValue(value);
  if (!raw || typeof raw.id !== "string" || !(["user", "assistant"] as const).includes(raw.role as ChatMessage["role"]) || typeof raw.text !== "string") return null;
  const status = raw.status;
  if (status !== undefined && !(["streaming", "error", "stopped"] as const).includes(status as "streaming" | "error" | "stopped")) return null;
  const activities = Array.isArray(raw.activities)
    ? raw.activities.map(normalizeActivity).filter((activity): activity is AgentActivity => activity !== null).slice(-500)
    : undefined;
  const cards = Array.isArray(raw.cards)
    ? raw.cards.map(normalizeCard).filter((card): card is AssistantCard => card !== null).slice(-20)
    : undefined;
  const editOperations = Array.isArray(raw.editOperations)
    ? raw.editOperations.map(normalizeEditOperation).filter((operation): operation is AssistantEditOperation => operation !== null).slice(-100)
    : undefined;
  return {
    id: raw.id,
    role: raw.role as ChatMessage["role"],
    text: cappedText(raw.text),
    ...(status ? { status: status as ChatMessage["status"] } : {}),
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    ...(activities && activities.length > 0 ? { activities } : {}),
    ...(cards && cards.length > 0 ? { cards } : {}),
    ...(editOperations && editOperations.length > 0 ? { editOperations } : {}),
  };
}

function normalizeRun(value: unknown): AssistantRunResponse | undefined {
  const raw = recordValue(value);
  if (!raw || typeof raw.id !== "string" || typeof raw.conversationId !== "string" || typeof raw.userMessageId !== "string" || typeof raw.assistantMessageId !== "string") return undefined;
  if (!(["running", "completed", "failed", "canceled"] as const).includes(raw.status as AssistantRunResponse["status"]) || !Array.isArray(raw.events)) return undefined;
  return { ...raw, events: raw.events.slice(-5_000) } as unknown as AssistantRunResponse;
}

function normalizeConversation(value: unknown): Conversation | null {
  const raw = recordValue(value);
  if (!raw || typeof raw.id !== "string" || typeof raw.title !== "string" || !Array.isArray(raw.messages)) return null;
  const messages = raw.messages.map(normalizeMessage).filter((message): message is ChatMessage => message !== null).slice(-500);
  const activeRun = normalizeRun(raw.activeRun);
  const latestRun = normalizeRun(raw.latestRun);
  return {
    id: raw.id,
    title: cappedText(raw.title, "新对话"),
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    messages,
    ...(activeRun ? { activeRun } : {}),
    ...(latestRun ? { latestRun } : {}),
  };
}

export function loadConversations(): Conversation[] {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (!value) return starterConversations;
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return starterConversations;
    const conversations = parsed
      .slice(0, MAX_LOCAL_CONVERSATIONS)
      .map(normalizeConversation)
      .filter((conversation): conversation is Conversation => conversation !== null);
    return conversations.length > 0 ? conversations : starterConversations;
  } catch {
    // Local drafts are an optional cache; a malformed entry should not block
    // the assistant from starting a fresh conversation.
    return starterConversations;
  }
}

export function formatConversationTime(value: number): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function replayRunEvents(run: AssistantRunResponse): { text: string; activities: Conversation["messages"][number]["activities"]; cards: AssistantCard[]; editOperations: AssistantEditOperation[] } {
  let text = "";
  let activities: NonNullable<ChatMessage["activities"]> = [];
  let cards: AssistantCard[] = [];
  let editOperations: AssistantEditOperation[] = [];
  for (const storedEvent of run.events) {
    const payload = storedEvent.payload as AssistantStreamEvent;
    if (storedEvent.event === "assistant" && payload.message) text = cappedText(`${text}${payload.message}`);
    if (["thinking", "tool", "tool_result", "system", "warning"].includes(storedEvent.event)) {
      activities = mergeAssistantActivity(activities, storedEvent.event, payload);
    }
    if (payload.card && !cards.some((card) => card.kind === payload.card?.kind && card.provider === payload.card.provider)) cards = [...cards, payload.card];
    if (payload.editOperation) editOperations = mergeAssistantEditOperations(editOperations, payload.editOperation);
    if (storedEvent.event === "done" && payload.message) text = cappedText(payload.message);
    if (storedEvent.event === "error" && !text) text = userFacingError(payload.message ?? run.error ?? "助手回复失败");
  }
  return { text, activities, cards, editOperations };
}

export function toLocalConversation(conversation: AssistantConversationResponse): Conversation {
  const messages: ChatMessage[] = conversation.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: cappedText(message.content),
  }));
  const activeRun = conversation.activeRun;
  const latestRun = conversation.latestRun ?? activeRun;
  if (latestRun) {
    const restored = replayRunEvents(latestRun);
    const assistantIndex = messages.findIndex((message) => message.id === latestRun.assistantMessageId);
    if (assistantIndex >= 0) {
      const existing = messages[assistantIndex];
      messages[assistantIndex] = {
        ...existing,
        text: existing.text || restored.text,
        status: latestRun.status === "failed" ? "error" : latestRun.status === "canceled" ? "stopped" : undefined,
        runId: latestRun.id,
        activities: restored.activities,
        cards: restored.cards,
        editOperations: restored.editOperations,
      };
    } else if (activeRun && messages.at(-1)?.id === activeRun.userMessageId && messages.at(-1)?.role === "user") {
      messages.push({
        id: activeRun.assistantMessageId,
        role: "assistant",
        text: activeRun.status === "failed" || activeRun.status === "canceled"
          ? restored.text || activeRun.error || (activeRun.status === "canceled" ? "已停止生成" : "助手回复失败")
          : restored.text,
        status: activeRun.status === "failed" ? "error" : activeRun.status === "canceled" ? "stopped" : "streaming",
        runId: activeRun.id,
        activities: restored.activities,
        cards: restored.cards,
        editOperations: restored.editOperations,
      });
    }
  }
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: Date.parse(conversation.updatedAt) || Date.now(),
    messages,
    activeRun,
    latestRun,
  };
}

export { createEmptyConversation };
