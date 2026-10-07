import { describe, expect, it } from "vitest";
import type { AssistantRunner } from "../src/assistant-runner.js";
import { AssistantExecutionManager } from "../src/assistant-execution.js";
import { AssistantStore } from "../src/assistant-store.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待助手流程完成超时");
}

describe("AssistantExecutionManager", () => {
  it("keeps a run alive and replays persisted events to a reconnecting subscriber", async () => {
    const store = new AssistantStore(":memory:");
    store.appendMessage("conversation-1", {
      id: "user-1",
      role: "user",
      content: "请检查项目",
      createdAt: "2026-08-13T12:00:00.000Z",
    }, "请检查项目");

    let release!: () => void;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const runner: AssistantRunner = {
      async run(_input, options = {}) {
        options.onProgress?.({
          kind: "thinking",
          message: "思考摘要",
          detail: "先检查相关文件",
          activityId: "thinking-1",
          phase: "running",
        });
        resolveStarted();
        await new Promise<void>((resolve) => { release = resolve; });
        options.onProgress?.({ kind: "assistant", message: "检查完成" });
        return "检查完成";
      },
    };
    const manager = new AssistantExecutionManager(runner, store);
    const { run } = manager.createRun("conversation-1", "user-1");
    const firstEvents: string[] = [];
    const unsubscribeFirst = manager.subscribe(run.id, 0, (event) => firstEvents.push(event.event));
    manager.start(run, { messages: [{ role: "user", content: "请检查项目" }] });
    await started;

    const reconnectEvents: string[] = [];
    const unsubscribeReconnect = manager.subscribe(run.id, 0, (event) => reconnectEvents.push(event.event));
    release();
    await waitFor(() => store.getRun(run.id)?.status === "completed");

    expect(firstEvents).toEqual(expect.arrayContaining(["thinking", "assistant", "done"]));
    expect(reconnectEvents).toEqual(expect.arrayContaining(["thinking", "assistant", "done"]));
    expect(store.getConversation("conversation-1")?.messages.at(-1)?.content).toBe("检查完成");

    unsubscribeFirst();
    unsubscribeReconnect();
    await manager.close();
    store.close();
  });
});
