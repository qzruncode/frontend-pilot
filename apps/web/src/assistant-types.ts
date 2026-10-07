import type { AssistantRunResponse } from "./api";
import type { AssistantReviewTaskReference } from "@contracts";
import type { AssistantCard } from "@contracts";
import type { AssistantEditOperation } from "@contracts";

export type ChatRole = "assistant" | "user";

export type AssistantActivityKind = "thinking" | "tool" | "system" | "warning";
export type AssistantActivityPhase = "start" | "running" | "complete" | "error";

export type AgentActivity = {
  id: string;
  kind: AssistantActivityKind;
  title: string;
  detail: string;
  progressDetail?: string;
  phase: AssistantActivityPhase;
  toolName?: string;
  toolInput?: unknown;
  result?: string;
  resultError?: boolean;
  reviewTask?: AssistantReviewTaskReference;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  status?: "streaming" | "error" | "stopped";
  runId?: string;
  activities?: AgentActivity[];
  cards?: AssistantCard[];
  editOperations?: AssistantEditOperation[];
};

export type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  activeRun?: AssistantRunResponse;
  latestRun?: AssistantRunResponse;
};

export function createId(prefix: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

export function createEmptyConversation(): Conversation {
  return {
    id: createId("conversation"),
    title: "新对话",
    updatedAt: Date.now(),
    messages: [],
  };
}
