import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  getAssistantConversation,
  listAssistantConversations,
  streamAssistantMessage,
  type AssistantStreamEvent,
} from "./api";
import { mapWithConcurrency } from "./async-utils";
import { assistantErrorMessage, mergeAssistantActivity, userFacingError, userFacingStatus } from "./assistant-activity";
import { mergeAssistantEditOperations, STORAGE_KEY, toLocalConversation } from "./assistant-conversation-utils";
import type { ChatRole, Conversation } from "./assistant-types";
import type { AssistantFocusContext } from "@contracts";

type UseAssistantConversationRuntimeOptions = {
  conversations: Conversation[];
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  activeConversationId: string;
  sessionReady: boolean;
  focusContext?: AssistantFocusContext;
  editSessionId?: string;
  onEditOperationProposed?: (operation: NonNullable<AssistantStreamEvent["editOperation"]>) => void;
  onReviewTaskChanged?: () => void | Promise<void>;
  setNotice: (message: string) => void;
};

function mergeMessageSignature(conversation?: Conversation): string {
  return conversation?.messages
    .map((message) => `${message.id}:${message.text.length}:${message.status ?? ""}:${message.cards?.length ?? 0}:${message.editOperations?.map((operation) => `${operation.id}:${operation.status}`).join(",") ?? ""}:${message.activities?.map((activity) => `${activity.id}:${activity.phase}:${activity.detail.length}:${activity.progressDetail?.length ?? 0}:${activity.result?.length ?? 0}`).join(",") ?? ""}`)
    .join("|") ?? "";
}

function mergeHydratedConversations(current: Conversation[], restored: Conversation[]): Conversation[] {
  const currentById = new Map(current.map((conversation) => [conversation.id, conversation]));
  const merged = restored.map((remote) => {
    const local = currentById.get(remote.id);
    if (local && (local.activeRun || local.latestRun || local.updatedAt > remote.updatedAt)) return local;
    return remote;
  });
  const mergedIds = new Set(merged.map((conversation) => conversation.id));
  const localOnly = current.filter((conversation) => !mergedIds.has(conversation.id) && (conversation.messages.length > 0 || conversation.activeRun || conversation.latestRun));
  return [...localOnly, ...merged];
}

export function useAssistantConversationRuntime({
  conversations,
  setConversations,
  activeConversationId,
  sessionReady,
  focusContext,
  editSessionId,
  onEditOperationProposed,
  onReviewTaskChanged,
  setNotice,
}: UseAssistantConversationRuntimeOptions) {
  const [sending, setSending] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [assistantStatus, setAssistantStatus] = useState<string | null>(null);
  const [conversationSyncing, setConversationSyncing] = useState(false);
  const [conversationsHydrated, setConversationsHydrated] = useState(false);
  const requestController = useRef<AbortController | null>(null);
  const resumedRunIds = useRef(new Set<string>());
  const syncedReviewTaskKeys = useRef(new Set<string>());
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0];
  const activeMessageSignature = useMemo(() => mergeMessageSignature(activeConversation), [activeConversation]);

  const updateConversation = useCallback((conversationId: string, updater: (conversation: Conversation) => Conversation) => {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? updater(conversation) : conversation));
  }, [setConversations]);

  const applyStreamEvent = useCallback((conversationId: string, userMessageId: string, replyId: string, event: string, payload: AssistantStreamEvent) => {
    if (payload.reviewTask) {
      const syncKey = `${payload.reviewTask.action}:${payload.reviewTask.id}`;
      if (!syncedReviewTaskKeys.current.has(syncKey)) {
        syncedReviewTaskKeys.current.add(syncKey);
        void onReviewTaskChanged?.();
      }
    }
    if (event === "status" && payload.message) setAssistantStatus(userFacingStatus(payload.message));
    if (payload.editOperation) onEditOperationProposed?.(payload.editOperation);
    if (event === "assistant" && payload.message) {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: Date.now(),
        messages: conversation.messages.map((message) => message.id === replyId ? { ...message, runId: payload.runId ?? message.runId, text: `${message.text}${payload.message}` } : message),
      }));
    }
    if (["thinking", "tool", "tool_result", "system", "warning"].includes(event)) {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: Date.now(),
        activeRun: payload.runId && !conversation.activeRun ? {
          id: payload.runId,
          conversationId,
          userMessageId,
          assistantMessageId: replyId,
          status: "running",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          finishedAt: null,
          error: null,
          lastSequence: 0,
          events: [],
        } : conversation.activeRun,
        messages: conversation.messages.map((message) => message.id === replyId ? {
          ...message,
          runId: payload.runId ?? message.runId,
          activities: mergeAssistantActivity(message.activities ?? [], event, payload),
          ...(payload.card && !message.cards?.some((card) => card.kind === payload.card?.kind && card.provider === payload.card?.provider)
            ? { cards: [...(message.cards ?? []), payload.card].slice(-20) }
            : {}),
          ...(payload.editOperation
            ? { editOperations: mergeAssistantEditOperations(message.editOperations ?? [], payload.editOperation) }
            : {}),
        } : message),
      }));
      if (["thinking", "tool", "tool_result"].includes(event) && payload.message) setAssistantStatus(userFacingStatus(payload.message));
    }
    if (event === "done" && payload.message) {
      setAssistantStatus("回复已完成");
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        activeRun: undefined,
        messages: conversation.messages.map((message) => message.id === replyId ? { ...message, runId: payload.runId ?? message.runId, text: payload.message ?? message.text, status: undefined } : message),
      }));
    }
    if (event === "error") {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        activeRun: undefined,
        messages: conversation.messages.map((message) => message.id === replyId ? { ...message, runId: payload.runId ?? message.runId, text: message.text || (payload.message ? userFacingError(payload.message) : "助手回复失败"), status: "error" } : message),
      }));
    }
  }, [onEditOperationProposed, onReviewTaskChanged, updateConversation]);

  const connectToRun = useCallback(async ({
    conversationId,
    userMessageId,
    replyId,
    message,
    history,
    runId,
    afterSequence = 0,
    controller,
  }: {
    conversationId: string;
    userMessageId: string;
    replyId: string;
    message: string;
    history: Array<{ role: ChatRole; content: string }>;
    runId?: string;
    afterSequence?: number;
    controller: AbortController;
  }) => {
    try {
      await streamAssistantMessage({ conversationId, messageId: userMessageId, runId, afterSequence, message, history, focusContext, editSessionId }, (event, payload) => {
        applyStreamEvent(conversationId, userMessageId, replyId, event, payload);
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        const messageText = assistantErrorMessage(error);
        updateConversation(conversationId, (conversation) => ({ ...conversation, activeRun: undefined, messages: conversation.messages.map((item) => item.id === replyId ? { ...item, text: item.text || messageText, status: "error" } : item) }));
        setNotice(messageText);
      }
    } finally {
      if (requestController.current === controller) requestController.current = null;
      setSending(false);
      setStreamingMessageId(null);
      setAssistantStatus(null);
    }
  }, [applyStreamEvent, editSessionId, focusContext, setNotice, updateConversation]);

  useEffect(() => {
    if (conversationsHydrated) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations, conversationsHydrated]);

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    if (!sessionReady || conversationsHydrated) return;
    let active = true;
    setConversationSyncing(true);
    void listAssistantConversations()
      .then(async ({ conversations: summaries }) => {
        if (!summaries.length) return;
        const restored = await mapWithConcurrency(summaries, async (summary) => {
          try {
            return toLocalConversation(await getAssistantConversation(summary.id));
          } catch {
            return null;
          }
        });
        if (!active) return;
        const nextConversations = restored.filter((conversation): conversation is Conversation => conversation !== null);
        if (nextConversations.length > 0) {
          setConversations((current) => mergeHydratedConversations(current, nextConversations));
        }
      })
      .catch(() => {
        if (active) setNotice("服务端会话暂时无法恢复，当前继续使用本地草稿。");
      })
      .finally(() => {
        if (active) {
          setConversationSyncing(false);
          setConversationsHydrated(true);
        }
      });
    return () => {
      active = false;
    };
  }, [conversationsHydrated, sessionReady, setConversations, setNotice]);

  useEffect(() => {
    if (!conversationsHydrated || sending) return;
    const conversation = conversations.find((item) => item.activeRun?.status === "running");
    const run = conversation?.activeRun;
    const userMessage = conversation?.messages.find((message) => message.id === run?.userMessageId);
    const reply = conversation?.messages.find((message) => message.id === run?.assistantMessageId);
    if (!conversation || !run || !userMessage || userMessage.role !== "user" || !reply || resumedRunIds.current.has(run.id)) return;
    resumedRunIds.current.add(run.id);
    const controller = new AbortController();
    requestController.current = controller;
    setSending(true);
    setStreamingMessageId(reply.id);
    setAssistantStatus("正在恢复助手流程");
    void connectToRun({ conversationId: conversation.id, userMessageId: run.userMessageId, replyId: reply.id, message: userMessage.text, history: [], runId: run.id, afterSequence: run.lastSequence, controller });
  }, [connectToRun, conversations, conversationsHydrated, sending]);

  return {
    activeConversation,
    activeMessageSignature,
    assistantStatus,
    connectToRun,
    conversationSyncing,
    conversationsHydrated,
    requestController,
    sending,
    setAssistantStatus,
    setSending,
    setStreamingMessageId,
    streamingMessageId,
    updateConversation,
  };
}
