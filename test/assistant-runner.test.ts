import { describe, expect, it, vi } from "vitest";
import type { Options as ClaudeAgentOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type AssistantToolContext } from "../src/assistant-tools.js";
import { ClaudeAgentSdkAssistantRunner, type AssistantProgressEvent } from "../src/assistant-runner.js";

describe("ClaudeAgentSdkAssistantRunner", () => {
  it("streams text while keeping the assistant session read-only", async () => {
    let receivedPrompt = "";
    let receivedOptions: ClaudeAgentOptions | undefined;
    const query = async function* ({ prompt, options }: { prompt: string; options?: ClaudeAgentOptions }): AsyncIterable<SDKMessage> {
      receivedPrompt = prompt;
      receivedOptions = options;
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Claude " },
        },
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "回复" },
        },
      } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", result: "Claude 回复" } as unknown as SDKMessage;
    };
    const progress: string[] = [];
    const runner = new ClaudeAgentSdkAssistantRunner({ query, model: "claude-sonnet-4-6" });

    const result = await runner.run({
      messages: [{ role: "user", content: "请回复" }],
    }, {
      onProgress: (event) => {
        if (event.kind === "assistant") progress.push(event.message);
      },
    });

    expect(result).toBe("Claude 回复");
    expect(progress).toEqual(["Claude ", "回复"]);
    expect(receivedPrompt).toContain("用户：请回复");
    expect(receivedPrompt).toContain("Review 查询工具");
    expect(receivedOptions?.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(receivedOptions?.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(receivedOptions?.disallowedTools).toEqual(["Bash", "Edit", "Write", "NotebookEdit", "Task"]);
    expect(receivedOptions?.permissionMode).toBe("dontAsk");
    expect(receivedOptions?.maxTurns).toBe(6);
    expect(receivedOptions?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(receivedOptions?.effort).toBe("high");
    expect(receivedOptions?.persistSession).toBe(false);
  });

  it("uses the database settings provider without project settings files", async () => {
    let receivedOptions: ClaudeAgentOptions | undefined;
    const query = async function* ({ options }: { prompt: string; options?: ClaudeAgentOptions }): AsyncIterable<SDKMessage> {
      receivedOptions = options;
      yield { type: "result", subtype: "success", result: "已完成" } as unknown as SDKMessage;
    };
    const runner = new ClaudeAgentSdkAssistantRunner({
      query,
      settingsProvider: async () => ({
        ANTHROPIC_AUTH_TOKEN: "database-token",
        ANTHROPIC_BASE_URL: "https://model.example.com",
        ANTHROPIC_MODEL: "database-model",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
        CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
      }),
    });

    await runner.run({ messages: [{ role: "user", content: "请回复" }] });

    expect(receivedOptions?.settingSources).toEqual([]);
    expect(receivedOptions?.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "database-token",
      ANTHROPIC_BASE_URL: "https://model.example.com",
      ANTHROPIC_MODEL: "database-model",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    });
  });

  it("uses thinking and effort values from the model settings page", async () => {
    let receivedOptions: ClaudeAgentOptions | undefined;
    const query = async function* ({ options }: { prompt: string; options?: ClaudeAgentOptions }): AsyncIterable<SDKMessage> {
      receivedOptions = options;
      yield { type: "result", subtype: "success", result: "已完成" } as unknown as SDKMessage;
    };
    const runner = new ClaudeAgentSdkAssistantRunner({
      query,
      settingsProvider: async () => ({
        CLAUDE_THINKING_MODE: "enabled",
        CLAUDE_THINKING_BUDGET_TOKENS: "4096",
        CLAUDE_CODE_EFFORT_LEVEL: "low",
      }),
    });

    await runner.run({ messages: [{ role: "user", content: "请回复" }] });

    expect(receivedOptions?.thinking).toEqual({ type: "enabled", budgetTokens: 4_096, display: "summarized" });
    expect(receivedOptions?.effort).toBe("low");
  });

  it("can disable extended thinking from the model settings page", async () => {
    let receivedOptions: ClaudeAgentOptions | undefined;
    const query = async function* ({ options }: { prompt: string; options?: ClaudeAgentOptions }): AsyncIterable<SDKMessage> {
      receivedOptions = options;
      yield { type: "result", subtype: "success", result: "已完成" } as unknown as SDKMessage;
    };
    const runner = new ClaudeAgentSdkAssistantRunner({
      query,
      settingsProvider: async () => ({ CLAUDE_THINKING_MODE: "disabled", CLAUDE_CODE_EFFORT_LEVEL: "low" }),
    });

    await runner.run({ messages: [{ role: "user", content: "请回复" }] });

    expect(receivedOptions?.thinking).toEqual({ type: "disabled" });
    expect(receivedOptions?.effort).toBe("low");
  });

  it.each([undefined, "4"])("bounds SDK retries while honoring an explicit override (%s)", async (override) => {
    vi.stubEnv("CLAUDE_CODE_MAX_RETRIES", undefined);
    try {
      let receivedOptions: ClaudeAgentOptions | undefined;
      const query = async function* ({ options }: { prompt: string; options?: ClaudeAgentOptions }): AsyncIterable<SDKMessage> {
        receivedOptions = options;
        yield { type: "result", subtype: "success", result: "已完成" } as unknown as SDKMessage;
      };
      const runner = new ClaudeAgentSdkAssistantRunner({ query, settingsProvider: async () => ({}),
        environment: override ? { CLAUDE_CODE_MAX_RETRIES: override } : {} });
      await runner.run({ messages: [{ role: "user", content: "检查代码" }] });
      expect(receivedOptions?.env?.CLAUDE_CODE_MAX_RETRIES).toBe(override ?? "2");
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([true, false])("records model reconnection separately from a terminal failure (recovered=%s)", async (recovered) => {
    const events: AssistantProgressEvent[] = [];
    const query = async function* (): AsyncIterable<SDKMessage> {
      yield { type: "system", subtype: "api_retry", attempt: 1, retry_delay_ms: 600, error: "server_error" } as unknown as SDKMessage;
      yield { type: "system", subtype: "api_retry", attempt: 2, retry_delay_ms: 1200, error: "server_error" } as unknown as SDKMessage;
      if (!recovered) throw new Error("API Error: 502");
      yield { type: "stream_event", event: { type: "message_start" } } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", result: "已完成" } as unknown as SDKMessage;
    };
    const runner = new ClaudeAgentSdkAssistantRunner({ query, settingsProvider: async () => ({}) });
    const result = runner.run({ messages: [{ role: "user", content: "检查代码" }] }, { onProgress: event => events.push(event) });
    if (recovered) await expect(result).resolves.toBe("已完成");
    else await expect(result).rejects.toThrow("502");
    const reconnect = events.filter(event => event.activityId?.startsWith("model-retry-"));
    expect(reconnect.map(event => event.phase)).toEqual(["running", "running", recovered ? "complete" : "error"]);
    expect(new Set(reconnect.map(event => event.activityId)).size).toBe(1);
    expect(reconnect.every(event => event.kind === "system")).toBe(true);
  });

  it("reports streamed tool input without storing partial patches or flooding progress events", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const events: AssistantProgressEvent[] = [];
      const query = async function* (): AsyncIterable<SDKMessage> {
        yield { type: "stream_event", event: { type: "message_start" } } as unknown as SDKMessage;
        yield { type: "stream_event", event: { type: "content_block_start", index: 1,
          content_block: { type: "tool_use", id: "patch-1", name: "apply_file_patch", input: {} } } } as unknown as SDKMessage;
        for (let i = 0; i < 100; i++) {
          now += 100;
          yield { type: "stream_event", event: { type: "content_block_delta", index: 1,
            delta: { type: "input_json_delta", partial_json: "patch-content" } } } as unknown as SDKMessage;
        }
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: "patch-1", name: "apply_file_patch", input: { patch: "complete-patch" } }] } } as unknown as SDKMessage;
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "patch-1", content: "applied" }] } } as unknown as SDKMessage;
        yield { type: "result", subtype: "success", result: "已完成" } as unknown as SDKMessage;
      };
      const runner = new ClaudeAgentSdkAssistantRunner({ query, settingsProvider: async () => ({}) });
      await runner.run({ messages: [{ role: "user", content: "检查代码" }] }, { onProgress: event => events.push(event) });
      const progress = events.filter(event => event.meta?.stream === "tool_input");
      expect(progress).toHaveLength(5);
      expect(progress.every(event => event.phase === "start" && event.activityId === "patch-1")).toBe(true);
      expect(progress.at(-1)?.meta?.inputCharacters).toBe(81 * "patch-content".length);
      expect(JSON.stringify(progress)).not.toContain("patch-content");
      expect(events.find(event => event.phase === "running" && event.kind === "tool")?.toolInput).toEqual({ patch: "complete-patch" });
      expect(events.find(event => event.kind === "tool_result")?.phase).toBe("complete");
    } finally { clock.mockRestore(); }
  });

  it("uses an idle timeout so active streaming can exceed the timeout window", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const query = async function* ({ options }: { prompt: string; options?: ClaudeAgentOptions }): AsyncIterable<SDKMessage> {
        const signal = options?.abortController?.signal;
        const wait = (milliseconds: number) => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, milliseconds);
          signal?.addEventListener("abort", () => {
            aborted = true;
            clearTimeout(timer);
            reject(signal.reason ?? new Error("aborted"));
          }, { once: true });
        });
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "第一段" } },
        } as unknown as SDKMessage;
        await wait(100);
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "第二段" } },
        } as unknown as SDKMessage;
        await wait(100);
        yield { type: "result", subtype: "success", result: "第一段第二段" } as unknown as SDKMessage;
      };
      const runner = new ClaudeAgentSdkAssistantRunner({ query, idleTimeoutMs: 150, settingsProvider: async () => ({}) });
      const result = runner.run({ messages: [{ role: "user", content: "请继续输出" }] });
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toBe("第一段第二段");
      expect(aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a task contract and a focused tool for weekly summaries", async () => {
    let receivedPrompt = "";
    let receivedOptions: ClaudeAgentOptions | undefined;
    const query = async function* ({ prompt, options }: { prompt: string; options?: ClaudeAgentOptions }): AsyncIterable<SDKMessage> {
      receivedPrompt = prompt;
      receivedOptions = options;
      yield { type: "result", subtype: "success", result: "已完成总结" } as unknown as SDKMessage;
    };
    const assistantToolContext: AssistantToolContext = {
      reviewService: {
        stats: () => ({ queued: 0, running: 0, completed: 0, failed: 0, superseded: 0, canceled: 0 }),
        listJobs: () => [],
        getJob: () => null,
        getProgressEvents: () => null,
        async enqueue() { throw new Error("not used"); },
        async cancel() { return null; },
      },
      gitlab: { async getMergeRequest() { return {}; } },
      reviewRules: { async list() { return []; } },
    };
    const runner = new ClaudeAgentSdkAssistantRunner({ query, assistantToolContext });

    await runner.run({ messages: [{ role: "user", content: "帮我总结上周的工作任务" }] });

    expect(receivedPrompt).toContain("本轮任务类型：GitLab 提交活动总结（默认上周）");
    expect(receivedPrompt).toContain("换算成明确的 since/until");
    expect(receivedPrompt).toContain("如果工具返回 authRequired，立即停止其他 GitLab 查询");
    expect(receivedPrompt).toContain("本轮任务不需要 Review 快照");
    expect(receivedOptions?.allowedTools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "mcp__frontend_pilot__get_gitlab_current_user",
      "mcp__frontend_pilot__list_gitlab_contributed_projects",
      "mcp__frontend_pilot__list_gitlab_project_commits",
      "mcp__frontend_pilot__get_gitlab_commit_activity",
    ]);
    expect(receivedOptions?.maxTurns).toBe(10);
  });

  it("exposes the Jira creation tools only for an explicit creation request", async () => {
    let receivedPrompt = "";
    let receivedOptions: ClaudeAgentOptions | undefined;
    const query = async function* ({ prompt, options }: { prompt: string; options?: ClaudeAgentOptions }): AsyncIterable<SDKMessage> {
      receivedPrompt = prompt;
      receivedOptions = options;
      yield { type: "result", subtype: "success", result: "请补充 Jira 必填项" } as unknown as SDKMessage;
    };
    const assistantToolContext: AssistantToolContext = {
      reviewService: {
        stats: () => ({ queued: 0, running: 0, completed: 0, failed: 0, superseded: 0, canceled: 0 }),
        listJobs: () => [],
        getJob: () => null,
        getProgressEvents: () => null,
        async enqueue() { throw new Error("not used"); },
        async cancel() { return null; },
      },
      gitlab: { async getMergeRequest() { return {}; } },
      reviewRules: { async list() { return []; } },
    };
    const runner = new ClaudeAgentSdkAssistantRunner({ query, assistantToolContext });

    await runner.run({ messages: [{ role: "user", content: "帮我新建一个 Jira 问题" }] });

    expect(receivedPrompt).toContain("create_jira_issue");
    expect(receivedOptions?.allowedTools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "mcp__frontend_pilot__get_jira_create_options",
      "mcp__frontend_pilot__create_jira_issue",
    ]);
  });

  it("uses visible fixed-budget thinking for compatible non-Claude models", async () => {
    let receivedOptions: ClaudeAgentOptions | undefined;
    const query = async function* ({ options }: { prompt: string; options?: ClaudeAgentOptions }): AsyncIterable<SDKMessage> {
      receivedOptions = options;
      yield {
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 128,
        estimated_tokens_delta: 128,
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "reasoning_delta", reasoning: "先检查配置，再回答。" },
        },
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "已完成。" },
        },
      } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", result: "已完成。" } as unknown as SDKMessage;
    };
    const events: Array<{ kind: string; message: string; detail?: string | null }> = [];
    const runner = new ClaudeAgentSdkAssistantRunner({ query, model: "ai/glm-5.2[1m]", thinkingMode: "enabled" });

    await runner.run({ messages: [{ role: "user", content: "请检查配置" }] }, {
      onProgress: (event) => events.push({ kind: event.kind, message: event.message, detail: event.detail }),
    });

    expect(receivedOptions?.thinking).toEqual({ type: "enabled", budgetTokens: 4_096, display: "summarized" });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "thinking", message: "模型正在思考" }),
      expect.objectContaining({ kind: "thinking", detail: "先检查配置，再回答。" }),
    ]));
  });

  it("registers read-only Review tools when the application context is supplied", async () => {
    let receivedOptions: ClaudeAgentOptions | undefined;
    const query = async function* ({ options }: { prompt: string; options?: ClaudeAgentOptions }): AsyncIterable<SDKMessage> {
      receivedOptions = options;
      yield { type: "result", subtype: "success", result: "已读取" } as unknown as SDKMessage;
    };
    const assistantToolContext: AssistantToolContext = {
      reviewService: {
        stats: () => ({ queued: 0, running: 0, completed: 0, failed: 0, superseded: 0, canceled: 0 }),
        listJobs: () => [],
        getJob: () => null,
        getProgressEvents: () => null,
        async enqueue() { throw new Error("not used"); },
        async cancel() { return null; },
      },
      gitlab: { async getMergeRequest() { return {}; } },
      reviewRules: { async list() { return []; } },
    };
    const runner = new ClaudeAgentSdkAssistantRunner({ query, assistantToolContext });

    await runner.run({ messages: [{ role: "user", content: "查询状态" }] });

    expect(receivedOptions?.mcpServers).toHaveProperty("frontend_pilot");
    expect(receivedOptions?.allowedTools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "mcp__frontend_pilot__get_review_stats",
      "mcp__frontend_pilot__list_reviews",
      "mcp__frontend_pilot__get_review_detail",
      "mcp__frontend_pilot__get_review_progress",
      "mcp__frontend_pilot__get_merge_request",
    ]);
    expect(receivedOptions?.permissionMode).toBe("dontAsk");
  });

  it("emits summarized thinking and native Claude tool activity", async () => {
    const query = async function* (): AsyncIterable<SDKMessage> {
      yield {
        type: "stream_event",
        event: { type: "message_start" },
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking" },
        },
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "先检查相关文件，再给出判断。" },
        },
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool-1", name: "Glob", input: { pattern: "src/**/*.ts" } },
        },
      } as unknown as SDKMessage;
      yield {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tool-1", name: "Glob", input: { pattern: "src/**/*.ts" } }],
        },
      } as unknown as SDKMessage;
      yield {
        type: "tool_progress",
        tool_use_id: "tool-1",
        tool_name: "Glob",
        elapsed_time_seconds: 1,
      } as unknown as SDKMessage;
      yield {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "src/app.ts\nsrc/assistant-runner.ts" }],
        },
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "找到了相关文件。" },
        },
      } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", result: "找到了相关文件。" } as unknown as SDKMessage;
    };
    const events: Array<{ kind: string; detail?: string | null; activityId?: string | null }> = [];
    const runner = new ClaudeAgentSdkAssistantRunner({ query });

    await runner.run({ messages: [{ role: "user", content: "请检查文件" }] }, {
      onProgress: (event) => events.push(event),
    });

    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["thinking", "tool", "tool_result", "assistant"]));
    expect(events.find((event) => event.kind === "thinking" && event.detail)?.detail).toContain("先检查相关文件");
    expect(events.find((event) => event.kind === "tool_result")?.detail).toContain("src/app.ts");
    expect(events.find((event) => event.kind === "tool_result")?.activityId).toBe("tool-1");
  });

  it("emits a structured Review task reference from an action tool result", async () => {
    const query = async function* (): AsyncIterable<SDKMessage> {
      yield {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "review-tool-1", name: "mcp__frontend_pilot__start_review", input: { projectId: "7", mrIid: "17" } }],
        },
      } as unknown as SDKMessage;
      yield {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "review-tool-1",
            content: JSON.stringify({
              accepted: true,
              deduplicated: false,
              review: {
                id: "review-17",
                projectId: "7",
                projectPath: "group/project",
                mrIid: "17",
                headSha: "head-17",
                targetBranch: "main",
                status: "queued",
              },
            }),
          }],
        },
      } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", result: "已启动 Review" } as unknown as SDKMessage;
    };
    const events: AssistantProgressEvent[] = [];
    const runner = new ClaudeAgentSdkAssistantRunner({ query });

    await runner.run({ messages: [{ role: "user", content: "启动 Review" }] }, {
      onProgress: (event) => events.push(event),
    });

    expect(events.find((event) => event.kind === "tool_result")?.reviewTask).toEqual({
      id: "review-17",
      projectId: "7",
      projectPath: "group/project",
      mrIid: "17",
      headSha: "head-17",
      targetBranch: "main",
      status: "queued",
      error: null,
      action: "started",
      deduplicated: false,
    });
  });

  it("stops after an authentication card instead of leaving the run open", async () => {
    let interrupted = false;
    const query = async function* (): AsyncIterable<SDKMessage> {
      yield {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "jira-tool-1", name: "mcp__frontend_pilot__get_jira_issues", input: {} }],
        },
      } as unknown as SDKMessage;
      yield {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "jira-tool-1",
            content: JSON.stringify({
              authRequired: {
                kind: "auth_required",
                provider: "jira",
                title: "需要配置 Jira 连接",
                description: "这项任务需要读取你的 Jira 个人数据，请先连接或重新连接 Jira 账号。",
                actionLabel: "去连接 Jira",
                actionPath: "/jira-workbench",
              },
            }),
          }],
        },
      } as unknown as SDKMessage;
      throw new Error("模型在鉴权失败后不应继续等待");
    };
    const stream = query({ prompt: "", options: {} }) as AsyncIterable<SDKMessage> & { interrupt?: () => Promise<void> };
    stream.interrupt = async () => { interrupted = true; };
    const events: AssistantProgressEvent[] = [];
    const runner = new ClaudeAgentSdkAssistantRunner({ query: () => stream });

    const result = await runner.run({ messages: [{ role: "user", content: "列下我的待办 Jira" }] }, { onProgress: (event) => events.push(event) });

    expect(interrupted).toBe(true);
    expect(result).toContain("连接完成后，请重新提交刚才的问题。");
    expect(events.find((event) => event.kind === "tool_result")?.card).toMatchObject({ provider: "jira", actionPath: "/jira-workbench" });
  });
});
