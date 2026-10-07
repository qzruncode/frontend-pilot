import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AssistantRunner } from "../src/assistant-runner.js";
import { AssistantStore } from "../src/assistant-store.js";
import { config, service } from "./app-fixtures.js";

describe("assistant HTTP API", () => {
  it("streams an authenticated assistant response", async () => {
    let receivedMessage = "";
    let receivedProductUsername: string | null | undefined;
    const assistantRunner = {
      async run(input: { messages: Array<{ role: string; content: string }>; runtimeContext?: { productUsername?: string | null } }, options?: { onProgress?: (event: { kind: "status" | "assistant"; message: string }) => void }) {
        receivedMessage = input.messages.at(-1)?.content ?? "";
        receivedProductUsername = input.runtimeContext?.productUsername;
        options?.onProgress?.({ kind: "status", message: "测试助手已连接" });
        options?.onProgress?.({ kind: "assistant", message: "这是来自助手的流式回复。" });
        return "这是来自助手的流式回复。";
      },
    };
    const app = await buildApp({ config, reviewService: service(), assistantRunner });
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: config.webOrigin },
      payload: { username: config.loginUsername, password: config.loginPassword },
    });
    const setCookie = session.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0] ?? "";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assistant/stream",
      headers: { cookie },
      payload: { conversationId: "conversation-test", message: "请给我一条测试回复", history: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(receivedMessage).toBe("请给我一条测试回复");
    expect(receivedProductUsername).toBe(config.loginUsername);
    expect(response.payload).toContain("event: assistant");
    expect(response.payload).toContain("这是来自助手的流式回复");
    expect(response.payload).toContain("event: done");
    await app.close();
  });

  it("passes the current browser session's Jira client resolver to the assistant", async () => {
    const requestedSessionKeys: string[] = [];
    const assistantRunner = {
      async run(input: { runtimeContext?: { getJiraClient?: () => Promise<unknown> } }) {
        await input.runtimeContext?.getJiraClient?.();
        return "已读取 Jira";
      },
    };
    const jiraOAuthService = {
      status: () => ({ configured: true, connected: true, identity: { username: "jira-user", name: "Jira User", avatarUrl: null } }),
      async authorizationUrl() { return null; },
      async complete() { return { username: "jira-user", name: "Jira User", avatarUrl: null }; },
      disconnect() {},
      async getClient(sessionKey: string) {
        requestedSessionKeys.push(sessionKey);
        return null;
      },
    };
    const app = await buildApp({ config, reviewService: service(), assistantRunner, jiraOAuthService });
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: config.webOrigin },
      payload: { username: config.loginUsername, password: config.loginPassword },
    });
    const setCookie = session.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0] ?? "";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assistant/stream",
      headers: { cookie },
      payload: { conversationId: "conversation-jira-oauth", message: "读取我的 Jira 待办", history: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(requestedSessionKeys).toHaveLength(1);
    expect(requestedSessionKeys[0]).toBeTruthy();
    await app.close();
  });

  it("streams structured Review task references for assistant action results", async () => {
    const reviewService = service();
    const assistantRunner: AssistantRunner = {
      async run(_input, options = {}) {
        const queued = await reviewService.enqueue({
          projectId: "7",
          projectPath: "group/project",
          mrIid: "17",
          headSha: "head-17",
          targetBranch: "main",
          source: "assistant",
        });
        options.onProgress?.({
          kind: "tool_result",
          message: "Review 返回结果",
          detail: "{\"accepted\":true}",
          toolName: "mcp__frontend_pilot__start_review",
          activityId: "review-tool-1",
          phase: "complete",
          reviewTask: {
            id: queued.job.id,
            projectId: queued.job.projectId,
            projectPath: queued.job.projectPath,
            mrIid: queued.job.mrIid,
            headSha: queued.job.headSha,
            targetBranch: queued.job.targetBranch,
            status: queued.job.status,
            error: queued.job.error,
            action: "started",
            deduplicated: queued.deduplicated,
          },
        });
        options.onProgress?.({ kind: "assistant", message: "已启动 Review" });
        return "已启动 Review";
      },
    };
    const app = await buildApp({ config, reviewService, assistantRunner });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/assistant/stream",
      headers: { authorization: "Bearer trigger-token" },
      payload: { conversationId: "conversation-review-task", message: "启动 Review", history: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain('"reviewTask"');
    const reviews = await app.inject({ method: "GET", url: "/api/v1/reviews", headers: { authorization: "Bearer trigger-token" } });
    expect(reviews.statusCode).toBe(200);
    expect(reviews.json().jobs).toEqual(expect.arrayContaining([expect.objectContaining({ projectPath: "group/project", mrIid: "17", source: "assistant" })]));
    await app.close();
  });

  it("persists assistant conversation history and supports recovery and deletion", async () => {
    const receivedHistories: Array<Array<{ role: string; content: string }>> = [];
    const assistantRunner = {
      async run(input: { messages: Array<{ role: string; content: string }> }) {
        receivedHistories.push(input.messages);
        return `回复 ${receivedHistories.length}`;
      },
    };
    const app = await buildApp({ config, reviewService: service(), assistantRunner });
    const headers = { authorization: "Bearer trigger-token" };
    const first = await app.inject({ method: "POST", url: "/api/v1/assistant/stream", headers, payload: { conversationId: "conversation-persisted", messageId: "message-1", message: "第一条消息", history: [] } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/api/v1/assistant/stream", headers, payload: { conversationId: "conversation-persisted", messageId: "message-2", message: "第二条消息", history: [] } });
    expect(second.statusCode).toBe(200);
    expect(receivedHistories[1]).toEqual([
      { role: "user", content: "第一条消息" },
      { role: "assistant", content: "回复 1" },
      { role: "user", content: "第二条消息" },
    ]);

    const list = await app.inject({ method: "GET", url: "/api/v1/assistant/conversations", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().conversations[0]).toMatchObject({ id: "conversation-persisted", messageCount: 4 });
    const detail = await app.inject({ method: "GET", url: "/api/v1/assistant/conversations/conversation-persisted", headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages.map((message: { content: string }) => message.content)).toEqual(["第一条消息", "回复 1", "第二条消息", "回复 2"]);
    const persistedMessages = detail.json().messages as Array<{ id: string; role: string }>;
    const firstReplyId = persistedMessages.find((message) => message.role === "assistant")?.id;
    const secondReplyId = persistedMessages.filter((message) => message.role === "assistant").at(-1)?.id;
    expect(firstReplyId).toBeTruthy();
    expect(secondReplyId).toBeTruthy();
    const deletedReply = await app.inject({ method: "DELETE", url: `/api/v1/assistant/conversations/conversation-persisted/messages/${secondReplyId}`, headers });
    expect(deletedReply.statusCode).toBe(200);
    expect(deletedReply.json()).toEqual({ deleted: true });
    const rewound = await app.inject({ method: "POST", url: `/api/v1/assistant/conversations/conversation-persisted/messages/${firstReplyId}/rewind`, headers });
    expect(rewound.statusCode).toBe(200);
    expect(rewound.json()).toEqual({ deleted: true });
    expect((await app.inject({ method: "GET", url: "/api/v1/assistant/conversations/conversation-persisted", headers })).json().messages.map((message: { content: string }) => message.content)).toEqual(["第一条消息"]);
    const deleted = await app.inject({ method: "DELETE", url: "/api/v1/assistant/conversations/conversation-persisted", headers });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    expect((await app.inject({ method: "GET", url: "/api/v1/assistant/conversations/conversation-persisted", headers })).statusCode).toBe(404);
    await app.close();
  });

  it("reconnects to an assistant run while it is still processing", async () => {
    let release!: () => void;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const assistantRunner: AssistantRunner = {
      async run(_input, options = {}) {
        options.onProgress?.({ kind: "thinking", message: "思考摘要", detail: "先检查相关文件", activityId: "thinking-1", phase: "running" });
        resolveStarted();
        await new Promise<void>((resolve) => { release = resolve; });
        options.onProgress?.({ kind: "assistant", message: "检查完成" });
        return "检查完成";
      },
    };
    const assistantStore = new AssistantStore(":memory:");
    const app = await buildApp({ config, reviewService: service(), assistantRunner, assistantStore });
    const headers = { authorization: "Bearer trigger-token" };
    const payload = { conversationId: "conversation-reconnect", messageId: "message-reconnect", message: "请检查项目", history: [] };
    const firstRequest = app.inject({ method: "POST", url: "/api/v1/assistant/stream", headers, payload });
    await started;
    const runningRun = assistantStore.getRunByUserMessage("conversation-reconnect", "message-reconnect");
    expect(runningRun?.status).toBe("running");
    const secondRequest = app.inject({ method: "POST", url: "/api/v1/assistant/stream", headers, payload: { ...payload, runId: runningRun?.id, afterSequence: 0 } });
    release();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.payload).toContain("event: thinking");
    expect(second.payload).toContain("event: thinking");
    expect(first.payload).toContain("event: done");
    expect(second.payload).toContain("event: done");
    expect(assistantStore.getConversation("conversation-reconnect")?.messages.at(-1)?.content).toBe("检查完成");
    await app.close();
    assistantStore.close();
  });

  it("keeps browser assistant conversations scoped to the logged-in product user", async () => {
    const app = await buildApp({
      config,
      reviewService: service(),
      assistantRunner: { async run() { return "已完成"; } },
    });
    const login = async (username: string, password: string): Promise<string> => {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: config.webOrigin }, payload: { username, password } });
      const setCookie = response.headers["set-cookie"];
      return (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0] ?? "";
    };
    const pilotCookie = await login(config.loginUsername, config.loginPassword);
    await app.inject({ method: "POST", url: "/api/v1/assistant/stream", headers: { cookie: pilotCookie }, payload: { conversationId: "pilot-only", message: "我的个人上下文", history: [] } });
    const adminCookie = await login("pilot-admin", config.loginPassword);
    const adminList = await app.inject({ method: "GET", url: "/api/v1/assistant/conversations", headers: { cookie: adminCookie } });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().conversations).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "pilot-only" })]));
    await app.close();
  });
});
