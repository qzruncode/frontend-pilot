import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssistantStore } from "../src/assistant-store.js";

describe("AssistantStore", () => {
  it("lists all recent runs for a task conversation without returning an unbounded event history", () => {
    const store = new AssistantStore(":memory:");
    try {
      store.appendMessage("conversation-history", { id: "history-user-1", role: "user", content: "第一轮", createdAt: "2026-08-13T12:00:00.000Z" }, "第一轮", "jira-ai:user-1");
      store.appendMessage("conversation-history", { id: "history-assistant-1", role: "assistant", content: "第一轮完成", createdAt: "2026-08-13T12:00:01.000Z" }, undefined, "jira-ai:user-1");
      const first = store.createRun({ id: "history-run-1", conversationId: "conversation-history", userMessageId: "history-user-1", assistantMessageId: "history-assistant-1" }).run;
      store.appendRunEvent(first.id, "tool", { activityId: "first-tool", message: "第一轮工具" });
      store.finishRun(first.id, "failed", "第一轮失败");

      store.appendMessage("conversation-history", { id: "history-user-2", role: "user", content: "继续处理", createdAt: "2026-08-13T12:00:02.000Z" }, undefined, "jira-ai:user-1");
      store.appendMessage("conversation-history", { id: "history-assistant-2", role: "assistant", content: "第二轮完成", createdAt: "2026-08-13T12:00:03.000Z" }, undefined, "jira-ai:user-1");
      const second = store.createRun({ id: "history-run-2", conversationId: "conversation-history", userMessageId: "history-user-2", assistantMessageId: "history-assistant-2" }).run;
      store.appendRunEvent(second.id, "done", { message: "第二轮完成" });
      store.finishRun(second.id, "completed");

      expect(store.listRuns("conversation-history", "jira-ai:user-1").map((run) => run.id)).toEqual(["history-run-2", "history-run-1"]);
      expect(store.listRuns("conversation-history", "jira-ai:other")).toEqual([]);
      expect(store.listRuns("conversation-history", "jira-ai:user-1", 1).map((run) => run.id)).toEqual(["history-run-2"]);
      expect(store.listRuns("conversation-history", "jira-ai:user-1")[1]).toMatchObject({ status: "failed", error: "第一轮失败", events: [expect.objectContaining({ event: "tool" })] });
    } finally {
      store.close();
    }
  });

  it("restores conversations and cascades message deletion across database reopen", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-assistant-store-"));
    const databasePath = path.join(tempDir, "assistant.sqlite");
    try {
      const first = new AssistantStore(databasePath);
      first.appendMessage("conversation-1", {
        id: "message-1",
        role: "user",
        content: "你好",
        createdAt: "2026-08-13T12:00:00.000Z",
      }, "你好");
      first.appendMessage("conversation-1", {
        id: "message-2",
        role: "assistant",
        content: "你好，我是 Frontend Pilot。",
        createdAt: "2026-08-13T12:00:01.000Z",
      });
      const { run } = first.createRun({
        id: "run-1",
        conversationId: "conversation-1",
        userMessageId: "message-1",
        assistantMessageId: "message-2",
      });
      first.appendRunEvent(run.id, "thinking", {
        message: "思考摘要",
        detail: "先检查会话上下文",
        activityId: "thinking-1",
        phase: "running",
      });
      first.finishRun(run.id, "completed");
      first.close();

      const reopened = new AssistantStore(databasePath);
      expect(reopened.listConversations()).toEqual([
        expect.objectContaining({ id: "conversation-1", title: "你好", messageCount: 2 }),
      ]);
      expect(reopened.getConversation("conversation-1")?.messages.map((message) => message.content)).toEqual([
        "你好",
        "你好，我是 Frontend Pilot。",
      ]);
      expect(reopened.getConversation("conversation-1")?.latestRun).toMatchObject({
        id: "run-1",
        status: "completed",
        events: [expect.objectContaining({ event: "thinking" })],
      });
      expect(reopened.deleteMessage("conversation-1", "message-2")).toBe(true);
      expect(reopened.getConversation("conversation-1")?.messages.map((message) => message.id)).toEqual(["message-1"]);
      expect(reopened.getConversation("conversation-1")?.latestRun).toBeUndefined();

      reopened.appendMessage("conversation-1", {
        id: "message-3",
        role: "user",
        content: "继续提问",
        createdAt: "2026-08-13T12:00:02.000Z",
      });
      reopened.appendMessage("conversation-1", {
        id: "message-4",
        role: "assistant",
        content: "继续回答",
        createdAt: "2026-08-13T12:00:03.000Z",
      });
      expect(reopened.deleteMessagesFrom("conversation-1", "message-3")).toBe(true);
      expect(reopened.getConversation("conversation-1")?.messages.map((message) => message.id)).toEqual(["message-1"]);
      reopened.appendMessage("conversation-1", {
        id: "message-5",
        role: "user",
        content: "删除这一轮",
        createdAt: "2026-08-13T12:00:04.000Z",
      });
      reopened.appendMessage("conversation-1", {
        id: "message-6",
        role: "assistant",
        content: "这一轮回答",
        createdAt: "2026-08-13T12:00:05.000Z",
      });
      expect(reopened.deleteMessage("conversation-1", "message-5")).toBe(true);
      expect(reopened.getConversation("conversation-1")?.messages.map((message) => message.id)).toEqual(["message-1"]);
      expect(reopened.deleteConversation("conversation-1")).toBe(true);
      expect(reopened.getConversation("conversation-1")).toBeNull();
      reopened.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
