import { randomUUID } from "node:crypto";
import type {
  AssistantChatInput,
  AssistantProgressEvent,
  AssistantRunner,
} from "./assistant-runner.js";
import {
  type AssistantRunEvent,
  type AssistantRunSnapshot,
  AssistantStore,
} from "./assistant-store.js";
import { safeErrorMessage } from "./errors.js";

type RunSubscriber = (event: AssistantRunEvent) => void;

const MAX_ASSISTANT_MESSAGE_LENGTH = 60_000;

function limitAssistantMessage(value: string): string {
  return value.length > MAX_ASSISTANT_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_ASSISTANT_MESSAGE_LENGTH)}\n\n[助手回复过长，已截断]`
    : value;
}

interface ActiveExecution {
  controller: AbortController;
  cancelRequested: boolean;
  promise: Promise<void>;
}

function errorMessage(error: unknown): string {
  return safeErrorMessage(error, "助手服务返回了未知错误");
}

export class AssistantExecutionManager {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly subscribers = new Map<string, Set<RunSubscriber>>();
  private closing = false;

  constructor(
    private readonly runner: AssistantRunner,
    private readonly store: AssistantStore,
  ) {}

  createRun(conversationId: string, userMessageId: string): { run: AssistantRunSnapshot; created: boolean } {
    return this.store.createRun({
      id: randomUUID(),
      conversationId,
      userMessageId,
      assistantMessageId: randomUUID(),
    });
  }

  subscribe(runId: string, afterSequence: number, subscriber: RunSubscriber): () => void {
    const listeners = this.subscribers.get(runId) ?? new Set<RunSubscriber>();
    this.subscribers.set(runId, listeners);
    let lastDeliveredSequence = Math.max(0, Math.floor(afterSequence));
    const deliver = (event: AssistantRunEvent): void => {
      if (event.sequence <= lastDeliveredSequence) return;
      lastDeliveredSequence = event.sequence;
      subscriber(event);
    };
    listeners.add(deliver);
    for (const event of this.store.listRunEvents(runId, lastDeliveredSequence)) deliver(event);
    return () => {
      listeners.delete(deliver);
      if (listeners.size === 0) this.subscribers.delete(runId);
    };
  }

  start(run: AssistantRunSnapshot, input: AssistantChatInput): Promise<void> {
    if (this.closing) return Promise.resolve();
    const active = this.active.get(run.id);
    if (active) return active.promise;
    const controller = new AbortController();
    const execution: ActiveExecution = {
      controller,
      cancelRequested: false,
      promise: Promise.resolve(),
    };
    this.active.set(run.id, execution);
    execution.promise = this.execute(run, input, execution);
    return execution.promise;
  }

  cancel(runId: string): boolean {
    const execution = this.active.get(runId);
    if (execution) {
      execution.cancelRequested = true;
      execution.controller.abort(new Error("助手请求已取消"));
      return true;
    }
    const run = this.store.getRun(runId);
    if (!run || run.status !== "running") return false;
    this.store.finishRun(runId, "canceled", "已停止生成");
    this.publish(runId, "error", {
      runId,
      conversationId: run.conversationId,
      message: "已停止生成",
      meta: { canceled: true },
    });
    return true;
  }

  async close(): Promise<void> {
    this.closing = true;
    const executions = [...this.active.values()];
    for (const execution of executions) {
      execution.cancelRequested = true;
      execution.controller.abort(new Error("服务正在关闭"));
    }
    await Promise.allSettled(executions.map((execution) => execution.promise));
    this.subscribers.clear();
  }

  private async execute(
    run: AssistantRunSnapshot,
    input: AssistantChatInput,
    execution: ActiveExecution,
  ): Promise<void> {
    this.publish(run.id, "status", {
      runId: run.id,
      conversationId: run.conversationId,
      message: "Claude 正在准备上下文",
    });
    try {
      const result = limitAssistantMessage(await this.runner.run(input, {
        signal: execution.controller.signal,
        onProgress: (event: AssistantProgressEvent) => {
          const { kind, ...payload } = event;
          this.publish(run.id, kind, {
            ...payload,
            runId: run.id,
            conversationId: run.conversationId,
          });
        },
      }));
      if (execution.cancelRequested || execution.controller.signal.aborted) {
        throw new Error("助手请求已取消");
      }
      this.store.appendMessage(run.conversationId, {
        id: run.assistantMessageId,
        role: "assistant",
        content: result,
        createdAt: new Date().toISOString(),
      });
      this.store.finishRun(run.id, "completed");
      this.publish(run.id, "done", {
        runId: run.id,
        conversationId: run.conversationId,
        message: result,
      });
    } catch (error) {
      const canceled = execution.cancelRequested || execution.controller.signal.aborted;
      const message = canceled ? "已停止生成" : `Claude 助手请求失败：${errorMessage(error)}`;
      this.store.finishRun(run.id, canceled ? "canceled" : "failed", message);
      this.publish(run.id, "error", {
        runId: run.id,
        conversationId: run.conversationId,
        message,
        meta: { canceled },
      });
    } finally {
      this.active.delete(run.id);
    }
  }

  private publish(runId: string, event: string, payload: Record<string, unknown>): void {
    const storedEvent = this.store.appendRunEvent(runId, event, payload);
    for (const subscriber of this.subscribers.get(runId) ?? []) subscriber(storedEvent);
  }
}
