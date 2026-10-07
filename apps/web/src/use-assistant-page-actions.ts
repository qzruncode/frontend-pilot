import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { ApiError, cancelAssistantRun, deleteAssistantConversation, deleteAssistantMessage, rewindAssistantConversation } from "./api";
import { mapWithConcurrency } from "./async-utils";
import { createEmptyConversation, createId, type Conversation, type ChatMessage } from "./assistant-types";
import type { useAssistantConversationRuntime } from "./use-assistant-conversation-runtime";

type Runtime = ReturnType<typeof useAssistantConversationRuntime>;
type MessageAction = "edit" | "retry" | "delete";
type PendingDeletion =
  | { kind: "conversations"; ids: string[]; count: number; title: string }
  | { kind: "message"; conversationId: string; messageId: string; deletedIds: string[] };

type UseAssistantPageActionsOptions = {
  conversations: Conversation[];
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  activeConversation?: Conversation;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  sessionReady: boolean;
  sessionLoading: boolean;
  runtime: Pick<Runtime, "connectToRun" | "requestController" | "sending" | "setAssistantStatus" | "setSending" | "setStreamingMessageId" | "streamingMessageId" | "updateConversation">;
  setActiveConversationId: Dispatch<SetStateAction<string>>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setShowScrollToLatest: Dispatch<SetStateAction<boolean>>;
  shouldFollowChatRef: MutableRefObject<boolean>;
};

function messageIdsForDeletion(messages: ChatMessage[], messageId: string): Set<string> {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return new Set();
  const ids = new Set([messageId]);
  if (messages[index]?.role === "user" && messages[index + 1]?.role === "assistant") ids.add(messages[index + 1].id);
  return ids;
}

function messageActionError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 409) return "助手正在生成，请稍后再试。";
  if (error instanceof ApiError && error.status === 404) return "这条消息已不存在，可能已在其他窗口被删除。";
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useAssistantPageActions({
  conversations,
  setConversations,
  activeConversation,
  draft,
  setDraft,
  sessionReady,
  sessionLoading,
  runtime,
  setActiveConversationId,
  setSidebarOpen,
  setNotice,
  setShowScrollToLatest,
  shouldFollowChatRef,
}: UseAssistantPageActionsOptions) {
  const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(() => new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [conversationDeleteBusy, setConversationDeleteBusy] = useState(false);
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null);
  const [messageAction, setMessageAction] = useState<MessageAction | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const beginTurn = useCallback((conversationId: string, previousMessages: ChatMessage[], text: string) => {
    const userMessage: ChatMessage = { id: createId("user"), role: "user", text };
    const reply: ChatMessage = { id: createId("assistant"), role: "assistant", text: "", status: "streaming" };
    const history = previousMessages.map((message) => ({ role: message.role, content: message.text })).filter((message) => message.content.trim());
    shouldFollowChatRef.current = true;
    setShowScrollToLatest(false);
    runtime.updateConversation(conversationId, (conversation) => ({ ...conversation, title: previousMessages.length === 0 ? text.slice(0, 28) : conversation.title, updatedAt: Date.now(), activeRun: undefined, latestRun: undefined, messages: [...previousMessages, userMessage, reply] }));
    setDraft("");
    runtime.setSending(true);
    runtime.setStreamingMessageId(reply.id);
    runtime.setAssistantStatus("正在连接助手");
    const controller = new AbortController();
    runtime.requestController.current = controller;
    void runtime.connectToRun({ conversationId, userMessageId: userMessage.id, replyId: reply.id, message: text, history, controller });
  }, [runtime, setDraft, setShowScrollToLatest, shouldFollowChatRef]);

  const startNewConversation = useCallback(() => {
    if (messageAction || conversationDeleteBusy) return;
    const activeRunId = activeConversation?.activeRun?.id ?? activeConversation?.messages.find((message) => message.status === "streaming")?.runId;
    if (activeRunId) void cancelAssistantRun(activeRunId).catch(() => setNotice("停止旧会话失败，后台任务可能仍在运行。"));
    runtime.requestController.current?.abort();
    runtime.requestController.current = null;
    runtime.setSending(false);
    runtime.setStreamingMessageId(null);
    runtime.setAssistantStatus(null);
    shouldFollowChatRef.current = true;
    setShowScrollToLatest(false);
    setSelectionMode(false);
    setSelectedConversationIds(new Set());
    setEditingMessageId(null);
    const conversation = createEmptyConversation();
    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    setDraft("");
    setSidebarOpen(false);
  }, [activeConversation, conversationDeleteBusy, messageAction, runtime, setActiveConversationId, setConversations, setDraft, setNotice, setShowScrollToLatest, setSidebarOpen, shouldFollowChatRef]);

  const sendMessage = useCallback((value = draft) => {
    const text = value.trim();
    if (!text || !activeConversation || runtime.sending || messageAction) return;
    if (!sessionReady) {
      setNotice(sessionLoading ? "正在建立页面会话，请稍候。" : "页面会话未建立，请刷新页面重试。");
      return;
    }
    const conversationId = activeConversation.id;
    if (editingMessageId) {
      const messageIndex = activeConversation.messages.findIndex((message) => message.id === editingMessageId && message.role === "user");
      if (messageIndex < 0) return;
      const originalMessages = activeConversation.messages;
      const originalActiveRun = activeConversation.activeRun;
      const originalLatestRun = activeConversation.latestRun;
      const previousMessages = activeConversation.messages.slice(0, messageIndex);
      setMessageAction("edit");
      runtime.updateConversation(conversationId, (conversation) => ({ ...conversation, activeRun: undefined, latestRun: undefined, messages: previousMessages }));
      setEditingMessageId(null);
      setDraft("");
      void rewindAssistantConversation(conversationId, editingMessageId)
        .then((result) => {
          if (!result.deleted) throw new Error("这条消息已不存在");
          beginTurn(conversationId, previousMessages, text);
        })
        .catch((error) => {
          runtime.updateConversation(conversationId, (conversation) => ({ ...conversation, activeRun: originalActiveRun, latestRun: originalLatestRun, messages: originalMessages }));
          setEditingMessageId(editingMessageId);
          setDraft(text);
          setNotice(messageActionError(error, "修改消息失败，请稍后重试。"));
        })
        .finally(() => setMessageAction(null));
      return;
    }
    beginTurn(conversationId, activeConversation.messages, text);
  }, [activeConversation, beginTurn, draft, editingMessageId, messageAction, runtime, sessionLoading, sessionReady, setDraft, setNotice]);

  const stopGeneration = useCallback(() => {
    const controller = runtime.requestController.current;
    if (!controller) return;
    const activeMessage = activeConversation?.messages.find((message) => message.id === runtime.streamingMessageId);
    const runId = activeMessage?.runId ?? activeConversation?.activeRun?.id;
    if (runId) void cancelAssistantRun(runId).catch(() => setNotice("停止请求未送达，助手可能仍在后台运行。"));
    controller.abort();
    runtime.requestController.current = null;
    if (runtime.streamingMessageId && activeConversation) {
      runtime.updateConversation(activeConversation.id, (conversation) => ({ ...conversation, activeRun: undefined, messages: conversation.messages.map((message) => message.id === runtime.streamingMessageId ? { ...message, text: message.text || "已停止生成。", status: "stopped" } : message) }));
    }
    runtime.setSending(false);
    runtime.setStreamingMessageId(null);
    runtime.setAssistantStatus(null);
    setNotice("已停止生成");
  }, [activeConversation, runtime, setNotice]);

  const toggleConversationSelection = useCallback((conversationId: string, checked: boolean) => {
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      if (checked) next.add(conversationId);
      else next.delete(conversationId);
      return next;
    });
  }, []);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((current) => {
      if (current) setSelectedConversationIds(new Set());
      return !current;
    });
  }, []);

  const runConversationDeletion = useCallback((requestedIds: readonly string[]) => {
    if (conversationDeleteBusy || conversations.length === 0) return;
    const selectedIds = new Set(requestedIds.filter((id) => conversations.some((conversation) => conversation.id === id)));
    const conversationsToDelete = conversations.filter((conversation) => selectedIds.has(conversation.id));
    if (conversationsToDelete.length === 0) {
      setNotice("会话已不存在，列表已刷新");
      return;
    }
    setConversationDeleteBusy(true);
    const deletedIds = new Set(conversationsToDelete.map((conversation) => conversation.id));
    const deletingActiveConversation = activeConversation ? deletedIds.has(activeConversation.id) : false;
    const cancelTask = mapWithConcurrency(conversationsToDelete, async (conversation) => {
      const activeRunId = conversation.activeRun?.id ?? conversation.messages.find((message) => message.status === "streaming")?.runId;
      if (!activeRunId) return true;
      try {
        await cancelAssistantRun(activeRunId);
        return true;
      } catch {
        return false;
      }
    }).then((results) => {
      if (results.some((result) => !result)) setNotice("部分会话的后台请求未能停止，服务端会继续清理。");
    });
    if (deletingActiveConversation) {
      runtime.requestController.current?.abort();
      runtime.requestController.current = null;
      runtime.setSending(false);
      runtime.setStreamingMessageId(null);
      runtime.setAssistantStatus(null);
      setDraft("");
    }
    const remoteConversations = conversationsToDelete.filter((conversation) => conversation.messages.some((message) => message.role === "user") || Boolean(conversation.activeRun || conversation.latestRun));
    const remoteTask = remoteConversations.length > 0
      ? mapWithConcurrency(remoteConversations, (conversation) => deleteAssistantConversation(conversation.id)).catch((error) => {
        if (!(error instanceof ApiError && error.status === 404)) setNotice("部分服务端会话删除失败，请稍后重试。");
      })
      : Promise.resolve();
    const remaining = conversations.filter((conversation) => !deletedIds.has(conversation.id));
    const nextConversation = remaining[0] ?? createEmptyConversation();
    setConversations(remaining.length > 0 ? remaining : [nextConversation]);
    setActiveConversationId(deletingActiveConversation ? nextConversation.id : activeConversation?.id ?? nextConversation.id);
    setSelectedConversationIds(new Set());
    setNotice(conversationsToDelete.length === 1 ? "会话已删除" : `已删除 ${conversationsToDelete.length} 个会话`);
    void Promise.all([cancelTask, remoteTask]).finally(() => setConversationDeleteBusy(false));
  }, [activeConversation, conversationDeleteBusy, conversations, runtime, selectedConversationIds, setActiveConversationId, setConversations, setDraft, setNotice]);

  const deleteConversations = useCallback((requestedIds?: ReadonlySet<string>) => {
    if (conversationDeleteBusy || conversations.length === 0) return;
    const candidateIds = requestedIds ?? selectedConversationIds;
    const selectedIds = new Set([...candidateIds].filter((id) => conversations.some((conversation) => conversation.id === id)));
    const conversationsToDelete = conversations.filter((conversation) => selectedIds.has(conversation.id));
    if (conversationsToDelete.length === 0) {
      setNotice("请先选择要删除的会话");
      return;
    }
    const count = conversationsToDelete.length;
    setPendingDeletion({
      kind: "conversations",
      ids: conversationsToDelete.map((conversation) => conversation.id),
      count,
      title: count === 1 ? `删除会话“${conversationsToDelete[0]?.title ?? "未命名会话"}”` : `删除已选的 ${count} 个会话`,
    });
  }, [conversationDeleteBusy, conversations, selectedConversationIds, setNotice]);

  const deleteConversation = useCallback((conversationId: string) => {
    deleteConversations(new Set([conversationId]));
  }, [deleteConversations]);

  const editMessage = useCallback((messageId: string) => {
    if (!activeConversation || runtime.sending || messageAction) return;
    const message = activeConversation.messages.find((item) => item.id === messageId && item.role === "user");
    if (!message) return;
    setEditingMessageId(message.id);
    setDraft(message.text);
    setNotice("已进入修改模式，修改后点击发送");
  }, [activeConversation, messageAction, runtime.sending, setDraft, setNotice]);

  const cancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setDraft("");
  }, [setDraft]);

  const retryMessage = useCallback((messageId: string) => {
    if (!activeConversation || runtime.sending || messageAction) return;
    const messageIndex = activeConversation.messages.findIndex((message) => message.id === messageId);
    const previous = messageIndex > 0 ? activeConversation.messages[messageIndex - 1] : undefined;
    if (!previous || previous.role !== "user") return;
    const previousMessages = activeConversation.messages.slice(0, messageIndex - 1);
    setMessageAction("retry");
    void rewindAssistantConversation(activeConversation.id, previous.id)
      .then((result) => {
        if (!result.deleted) throw new Error("这轮消息已不存在");
        runtime.updateConversation(activeConversation.id, (conversation) => ({ ...conversation, activeRun: undefined, latestRun: undefined, messages: previousMessages }));
        setEditingMessageId(null);
        beginTurn(activeConversation.id, previousMessages, previous.text);
      })
      .catch((error) => setNotice(messageActionError(error, "重试失败，请稍后重试。")))
      .finally(() => setMessageAction(null));
  }, [activeConversation, beginTurn, messageAction, runtime, setNotice]);

  const runMessageDeletion = useCallback((request: Extract<PendingDeletion, { kind: "message" }>) => {
    if (runtime.sending || messageAction) return;
    const ids = new Set(request.deletedIds);
    setMessageAction("delete");
    void deleteAssistantMessage(request.conversationId, request.messageId)
      .then((result) => {
        if (!result.deleted) throw new Error("这条消息已不存在");
        runtime.updateConversation(request.conversationId, (conversation) => {
          const latestRunDeleted = conversation.latestRun
            ? ids.has(conversation.latestRun.userMessageId) || ids.has(conversation.latestRun.assistantMessageId)
            : false;
          return { ...conversation, latestRun: latestRunDeleted ? undefined : conversation.latestRun, messages: conversation.messages.filter((message) => !ids.has(message.id)) };
        });
        if (ids.has(editingMessageId ?? "")) {
          setEditingMessageId(null);
          setDraft("");
        }
        setNotice("消息已删除");
      })
      .catch((error) => setNotice(messageActionError(error, "删除消息失败，请稍后重试。")))
      .finally(() => setMessageAction(null));
  }, [editingMessageId, messageAction, runtime, setDraft, setNotice]);

  const deleteMessage = useCallback((messageId: string) => {
    if (!activeConversation || runtime.sending || messageAction) return;
    const ids = messageIdsForDeletion(activeConversation.messages, messageId);
    if (ids.size === 0) return;
    setPendingDeletion({ kind: "message", conversationId: activeConversation.id, messageId, deletedIds: [...ids] });
  }, [activeConversation, messageAction, runtime.sending]);

  const cancelDeletion = useCallback(() => setPendingDeletion(null), []);

  const confirmDeletion = useCallback(() => {
    const pending = pendingDeletion;
    if (!pending) return;
    setPendingDeletion(null);
    if (pending.kind === "conversations") runConversationDeletion(pending.ids);
    else runMessageDeletion(pending);
  }, [pendingDeletion, runConversationDeletion, runMessageDeletion]);

  const messageActionStatus = messageAction === "edit" ? "正在更新消息…" : messageAction === "retry" ? "正在重新生成…" : messageAction === "delete" ? "正在删除消息…" : null;

  return {
    cancelDeletion,
    cancelEdit,
    confirmDeletion,
    conversationDeleteBusy,
    deleteConversation,
    deleteConversations,
    deleteMessage,
    editMessage,
    editingMessageId,
    messageActionBusy: Boolean(messageAction),
    messageActionStatus,
    pendingDeletion,
    selectedConversationIds,
    selectionMode,
    retryMessage,
    sendMessage,
    startNewConversation,
    stopGeneration,
    toggleConversationSelection,
    toggleSelectionMode,
  };
}
