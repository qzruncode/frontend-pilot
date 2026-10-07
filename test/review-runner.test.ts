import { describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSdkReviewRunner, DryRunReviewRunner } from "../src/review-runner.js";
import type { InspectionRunnerInput, PreSubmitReviewInput, ReviewProgressInput, ReviewRunnerInput } from "../src/contracts.js";
import type { GitLabReviewDecisionInput } from "../src/gitlab-review-decision.js";
import type { InspectionJiraCreatePromptInput, MergeRequestDescriptionPromptInput } from "../src/prompt-generation.js";

const input: ReviewRunnerInput = {
  projectPath: "demo/project",
  mrIid: "3",
  workspacePath: "/tmp/review-workspace",
  profile: {
    name: "default",
    displayName: "默认 profile",
    rules: [{ id: "high-value", name: "高价值问题审查", description: "", enabled: true, order: 0, file: "audit.md", sharedBy: ["default"], content: "audit" }],
  },
};

const inspectionInput: InspectionRunnerInput = {
  projectPath: "demo/project",
  branch: "main",
  headSha: "head-1",
  workspacePath: "/tmp/inspection-workspace",
  profile: {
    name: "default",
    displayName: "默认巡检 Profile",
    isDefault: true,
    rules: [{ id: "security", name: "安全", description: "检查安全风险", enabled: true, order: 0, file: "security.md", sharedBy: ["default"], content: "检查安全" }],
  },
};

const preSubmitInput: PreSubmitReviewInput = {
  projectPath: "demo/project",
  jiraKey: "TEST-42",
  jiraTitle: "修复默认值",
  jiraDescription: "默认值必须为 new。",
  targetBranch: "main",
  baseSha: "base-1",
  diff: "diff --git a/demo.ts b/demo.ts",
  workspacePath: "/tmp/edit-workspace",
  profile: input.profile,
};

function resultMessage(output: unknown): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: JSON.stringify(output),
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {} as never,
    modelUsage: {},
    permission_denials: [],
    structured_output: output,
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "session-id",
  } as SDKMessage;
}

describe("ClaudeAgentSdkReviewRunner", () => {
  it("uses a Chinese summary for dry-run inspections", async () => {
    const raw = await new DryRunReviewRunner().runInspection();

    expect(JSON.parse(raw)).toMatchObject({ summary: "演示巡检已完成。" });
  });

  it("runs pre-submit review with Jira requirements and read-only tools", async () => {
    let call: { prompt: string; options?: Options } | undefined;
    const runner = new ClaudeAgentSdkReviewRunner({ query: (params) => (async function* () {
      call = params;
      yield resultMessage({
        summary: "需求已实现",
        requirementChecks: [{ requirement: "默认值必须为 new", status: "satisfied", evidence: "demo.ts:1" }],
        ruleResults: [],
        findings: [],
      });
    }()) });

    const raw = await runner.runPreSubmitReview(preSubmitInput);

    expect(JSON.parse(raw)).toMatchObject({ requirementChecks: [{ status: "satisfied" }] });
    expect(call?.prompt).toContain("默认值必须为 new");
    expect(call?.prompt).toContain("提交前代码验收机器人");
    expect(call?.options?.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(call?.options?.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]));
    expect(call?.options?.outputFormat).toMatchObject({ type: "json_schema" });
  });

  it("labels inspection result progress separately from Review", async () => {
    const progress: ReviewProgressInput[] = [];
    const runner = new ClaudeAgentSdkReviewRunner({
      apiKey: "test-key",
      query: () => (async function* () {
        yield resultMessage({ summary: "巡检完成", ruleResults: [], findings: [] });
      }()),
    });

    await runner.runInspection(inspectionInput, { onProgress: (event) => progress.push(event) });

    expect(progress.find((event) => event.kind === "result")?.message).toBe("Claude 已返回巡检结果");
  });

  it("runs enabled inspection rules as isolated audits and merges them in order", async () => {
    const rules = [
      { id: "abstraction-reuse", name: "代码抽象", description: "检查重复实现", content: "检查代码抽象", enabled: true, order: 0, file: "abstraction-reuse.md", sharedBy: [] },
      { id: "file-line-limit", name: "文件大小", description: "检查超大文件", content: "检查文件大小", enabled: true, order: 1, file: "file-line-limit.md", sharedBy: [] },
      { id: "security", name: "安全", description: "检查安全风险", content: "检查安全", enabled: true, order: 2, file: "security.md", sharedBy: [] },
    ];
    const calls: Array<{ prompt: string; options?: Options }> = [];
    const runner = new ClaudeAgentSdkReviewRunner({
      apiKey: "test-key",
      query: (params) => (async function* () {
        calls.push(params);
        const rule = rules.find((candidate) => params.prompt.includes(`### 1. ${candidate.id} · ${candidate.name}`));
        if (!rule) throw new Error("isolated rule was not included in prompt");
        yield resultMessage({
          summary: `${rule.name} 已完成独立核查`,
          ruleResults: [{ ruleId: rule.id, ruleName: rule.name, conclusion: `${rule.name} 已核查`, findings: [] }],
          findings: [],
        });
      }()),
    });

    const raw = await runner.runInspection({
      ...inspectionInput,
      profile: { ...inspectionInput.profile, rules },
    });
    const output = JSON.parse(raw) as { summary: string; ruleResults: Array<{ ruleId: string; ruleName: string; conclusion: string; findings: unknown[] }>; findings: unknown[] };

    expect(calls).toHaveLength(rules.length);
    expect(calls.map((call) => rules.find((rule) => call.prompt.includes(`### 1. ${rule.id} · ${rule.name}`))?.id)).toEqual(rules.map((rule) => rule.id));
    for (const call of calls) {
      expect(call.prompt.match(/### 1\./g)).toHaveLength(1);
      expect(call.prompt).not.toContain("### 2.");
    }
    expect(output.ruleResults.map((rule) => rule.ruleId)).toEqual(rules.map((rule) => rule.id));
    expect(output.ruleResults.map((rule) => rule.ruleName)).toEqual(rules.map((rule) => rule.name));
    expect(output.summary).toContain("独立执行 3 条规则");
  });

  it("registers the per-finding inspection tool when a reporter is provided", async () => {
    const calls: Array<{ options?: Options }> = [];
    const runner = new ClaudeAgentSdkReviewRunner({
      apiKey: "test-key",
      query: (params) => (async function* () {
        calls.push(params);
        yield resultMessage({ summary: "巡检完成", ruleResults: [], findings: [] });
      }()),
    });

    await runner.runInspection(inspectionInput, {
      onInspectionFinding: async () => ({ recorded: true, duplicate: false, findingId: "finding-1", message: "问题已记录" }),
    });

    expect(calls[0]?.options?.allowedTools).toContain("mcp__inspection_workbench__report_inspection_finding");
    expect(calls[0]?.options?.mcpServers).toHaveProperty("inspection_workbench");
  });

  it("uses the existing structured SDK for duplicate decisions without file or external tools", async () => {
    let call: { prompt: string; options?: Options } | undefined;
    const runner = new ClaudeAgentSdkReviewRunner({ query: (params) => (async function* () {
      call = params;
      yield resultMessage({ status: "matched", duplicateIds: ["existing"], reason: "中英文描述对应相同根因" });
    }()) });
    const finding = { severity: "low", category: "边界", path: "src/a.ts", line: 2, issue: "百分比未收敛", suggestion: "限制范围" };
    const output = await runner.resolveInspectionDuplicates({ ruleId: "hidden-bug", finding,
      candidates: [{ id: "existing", ruleId: null, finding: { ...finding, issue: "Percentage is not clamped" } }] });
    expect(output).toMatchObject({ status: "matched", duplicateIds: ["existing"] });
    expect(call?.prompt).toContain("Percentage is not clamped");
    expect(call?.prompt).toContain("同一行上的注入、权限隔离等不同根因必须分别保留");
    expect(call?.options?.tools).toEqual([]);
    expect(call?.options?.allowedTools).toEqual([]);
    expect(call?.options?.mcpServers).toBeUndefined();
    expect(call?.options?.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Agent", "Write"]));
    expect(call?.options?.outputFormat).toMatchObject({ type: "json_schema" });
  });

  it("judges a Pipeline Review report with one structured no-tool turn", async () => {
    let call: { prompt: string; options?: Options } | undefined;
    const runner = new ClaudeAgentSdkReviewRunner({ query: (params) => (async function* () {
      call = params;
      yield resultMessage({ needsRepair: false, reason: "报告仅说明验证环境限制，没有代码问题。" });
    }()) });
    const decisionInput: GitLabReviewDecisionInput = {
      projectPath: "group/demo",
      mrIid: "42",
      headSha: "head-1",
      report: "## Claude 代码审查报告\n✅ 全部通过\n\n补充说明：未执行额外测试。",
    };

    await expect(runner.judgeGitLabReview(decisionInput)).resolves.toEqual({
      needsRepair: false,
      reason: "报告仅说明验证环境限制，没有代码问题。",
    });
    expect(call?.prompt).toContain("补充说明：未执行额外测试");
    expect(call?.options?.tools).toEqual([]);
    expect(call?.options?.allowedTools).toEqual([]);
    expect(call?.options?.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Agent", "Write"]));
    expect(call?.options?.maxTurns).toBe(1);
    expect(call?.options?.outputFormat).toMatchObject({ type: "json_schema" });
  });

  it("preserves inspection scope and all related paths in SDK output and multi-rule merging", async () => {
    const finding = { severity: "medium", category: "design", path: "src/a.ts", line: 1, issue: "跨文件设计问题", suggestion: "统一调整", scope: "cross_file", relatedPaths: ["src/b.ts"] };
    const formats: unknown[] = [];
    const runner = new ClaudeAgentSdkReviewRunner({ query: (params) => (async function* () {
      formats.push(params.options?.outputFormat);
      yield resultMessage({ summary: "完成", ruleResults: [], findings: [finding] });
    }()) });
    const rules = [inspectionInput.profile.rules[0]!, { ...inspectionInput.profile.rules[0]!, id: "design", name: "设计" }];
    const output = JSON.parse(await runner.runInspection({ ...inspectionInput, profile: { ...inspectionInput.profile, rules } }));
    expect(output.findings).toEqual([finding, finding]);
    expect(JSON.stringify(formats[0])).toContain('"relatedPaths"');
    expect(JSON.stringify(formats[0])).toContain('"cross_file"');
  });

  it("gives ownership analysis scoped read tools without allowing local commands or mutations", async () => {
    let options: Options | undefined;
    let prompt = "";
    const runner = new ClaudeAgentSdkReviewRunner({
      inspectionOwnershipPrompt: async () => "这是从提示词管理页面读取的负责人判断要求。",
      query: (params) => (async function* () {
      options = params.options;
      prompt = params.prompt;
      yield resultMessage({ decisions: [{ findingId: "f", status: "resolved", assignee: "guessed-user", reason: "guess", evidenceIds: ["invented"] }] });
      }()),
    });
    const output = await runner.resolveInspectionOwners({ projectId: "1", projectPath: "group/project", branch: "dev", headSha: "sha", jiraProjectKey: "AIP",
      findings: [{ id: "f", path: "src/a.ts", line: 1, issue: "文件过大", suggestion: "拆分", jiraKey: null }], gitlab: {},
      jira: {} as never, validate: () => {},
    });
    expect(options?.tools).toEqual([]);
    expect(options?.allowedTools).toContain("mcp__inspection_ownership__get_jira_issue");
    expect(options?.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write", "Edit"]));
    expect(options?.maxTurns).toBe(64);
    expect(prompt).toContain("这是从提示词管理页面读取的负责人判断要求。");
    expect(output[0]!.ownership).toMatchObject({ status: "uncertain", assignee: null });
  });

  it("loads the managed Jira and MR prompt definitions for structured generation", async () => {
    const calls: string[] = [];
    const runner = new ClaudeAgentSdkReviewRunner({
      inspectionJiraDescriptionPrompt: async () => "巡检 Jira 描述规则",
      inspectionJiraFieldsPrompt: async () => "巡检 Jira 字段规则",
      mergeRequestDescriptionPrompt: async () => "Merge Request 描述规则",
      query: (params) => (async function* () {
        calls.push(params.prompt);
        if (params.prompt.includes("Jira 创建计划")) {
          yield resultMessage({
            description: "h2. 背景\n已确认的问题。\n\nh2. 问题描述 / 目标\n修复问题。\n\nh2. 验收标准\n* [ ] 完成修复。",
            labels: ["release-20260915"],
            dueDate: "2026-09-15",
          });
        } else {
          yield resultMessage({ description: "## Background\n已知背景。\n\n## 改动\n- 已完成修改。\n\n## 验证\n- 已完成检查。\n\n## 关联\n- Jira: AIP-1" });
        }
      }()),
    });
    const jiraInput: InspectionJiraCreatePromptInput = {
      projectPath: "group/project", branch: "main", headSha: "sha", createdAt: "2026-09-09T00:00:00.000Z",
      finding: { severity: "high", category: "正确性", path: "src/a.ts", line: 2, issue: "问题", suggestion: "修复" },
      owner: { username: "alice", name: null, reason: "已确认", evidence: [] },
    };
    const mrInput: MergeRequestDescriptionPromptInput = {
      projectPath: "group/project", jiraKey: "AIP-1", sourceBranch: "feature/aip-1", targetBranch: "main", title: "fix: 修复 (#AIP-1)",
    };

    const plan = await runner.generateInspectionJiraCreatePlan(jiraInput);
    const description = await runner.generateMergeRequestDescription(mrInput);

    expect(plan).toMatchObject({ labels: ["release-20260915"], dueDate: "2026-09-15" });
    expect(description).toContain("## 关联");
    expect(calls[0]).toContain("巡检 Jira 描述规则");
    expect(calls[0]).toContain("巡检 Jira 字段规则");
    expect(calls[1]).toContain("Merge Request 描述规则");
  });

  it("loads local settings sources and returns validated structured output", async () => {
    const calls: Array<{ prompt: string; options?: Options }> = [];
    const output = {
      summary: "发现一个问题",
      ruleResults: [],
      findings: [{
        severity: "high",
        category: "logic",
        path: "src/example.ts",
        line: 3,
        issue: "存在问题",
        suggestion: "修复问题",
      }],
    };
    const runner = new ClaudeAgentSdkReviewRunner({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
      query: (params) => (async function* () {
        calls.push(params);
        yield resultMessage(output);
      }()),
    });

    const raw = await runner.run(input);

    expect(JSON.parse(raw)).toEqual(output);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("完整仓库上下文");
    expect(calls[0]?.options).toEqual(expect.objectContaining({
      model: "claude-sonnet-4-6",
      cwd: "/tmp/review-workspace",
      settingSources: ["user", "project"],
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: ["Read", "Grep", "Glob", "Bash", "Task", "Agent"],
      disallowedTools: ["Edit", "Write", "NotebookEdit"],
      permissionMode: "dontAsk",
      persistSession: true,
      includePartialMessages: true,
    }));
    expect(calls[0]?.options).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(calls[0]?.options?.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(calls[0]?.options?.systemPrompt).toMatchObject({
      append: expect.stringContaining("本次是纯静态代码审查"),
    });
    expect(calls[0]?.options?.systemPrompt).toMatchObject({
      append: expect.stringContaining("禁止安装、下载或更新依赖"),
    });
    expect(calls[0]?.options?.systemPrompt).toMatchObject({
      append: expect.stringContaining("Task/Agent 如用于静态分工，必须向子任务传递相同的静态审查约束"),
    });
    expect(calls[0]?.options).not.toHaveProperty("skills");
    expect(calls[0]?.options?.outputFormat).toEqual(expect.objectContaining({ type: "json_schema" }));
    expect(calls[0]?.options?.outputFormat?.schema).not.toHaveProperty("$schema");
    expect(calls[0]?.options?.env?.ANTHROPIC_API_KEY).toBe("test-key");
    expect(calls[0]?.options?.env?.CI).toBe("true");
    expect(calls[0]?.options?.abortController).toBeInstanceOf(AbortController);
  });

  it("resumes the same Claude Code session for a later MR push", async () => {
    let call: { prompt: string; options?: Options } | undefined;
    const sessionIds: string[] = [];
    const runner = new ClaudeAgentSdkReviewRunner({
      apiKey: "test-key",
      query: (params) => (async function* () {
        call = params;
        yield resultMessage({ summary: "已复核", ruleResults: [], findings: [] });
      }()),
    });

    await runner.run(input, {
      resumeSessionId: "session-from-previous-push",
      onSessionId: (sessionId) => sessionIds.push(sessionId),
    });

    expect(call?.prompt).toContain("继续同一个 MR 的审查会话");
    expect(call?.prompt).toContain("自主检查当前 Git 状态、提交历史和实际变更");
    expect(call?.prompt).toContain("不要机械重复已经修复的问题");
    expect(call?.prompt).not.toContain("当前 diff");
    expect(call?.options?.resume).toBe("session-from-previous-push");
    expect(call?.options?.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(sessionIds).toEqual(["session-id"]);
  });

  it("passes the review workspace Git authentication to Claude Bash", async () => {
    let call: { options?: Options } | undefined;
    const runner = new ClaudeAgentSdkReviewRunner({
      apiKey: "test-key",
      query: (params) => (async function* () {
        call = params;
        yield resultMessage({ summary: "已完成", ruleResults: [], findings: [] });
      }()),
    });

    await runner.run(input, {
      gitEnvironment: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/tmp/review-workspace/.git/frontend-pilot-askpass.sh",
        GITLAB_REVIEW_TOKEN: "gitlab-token",
      },
    });

    expect(call?.options?.cwd).toBe("/tmp/review-workspace");
    expect(call?.options?.env).toEqual(expect.objectContaining({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/tmp/review-workspace/.git/frontend-pilot-askpass.sh",
      GITLAB_REVIEW_TOKEN: "gitlab-token",
    }));
  });

  it("turns Agent SDK failures into review runner errors", async () => {
    const runner = new ClaudeAgentSdkReviewRunner({
      apiKey: "test-key",
      query: () => (async function* () {
        throw new Error("401 unauthorized");
      }()),
    });

    await expect(runner.run(input)).rejects.toThrow("Claude Agent SDK request failed: 401 unauthorized");
  });

  it("rejects invalid structured output from the Agent SDK", async () => {
    const runner = new ClaudeAgentSdkReviewRunner({
      apiKey: "test-key",
      query: () => (async function* () {
        yield resultMessage({ summary: "missing findings" });
      }()),
    });

    await expect(runner.run(input)).rejects.toThrow("Claude Agent SDK returned invalid review JSON");
  });

  it("passes an abort signal into the Agent SDK query", async () => {
    const controller = new AbortController();
    let received: AbortController | undefined;
    const runner = new ClaudeAgentSdkReviewRunner({
      apiKey: "test-key",
      query: ({ options }) => (async function* () {
        received = options?.abortController;
        yield resultMessage({ summary: "ok", ruleResults: [], findings: [] });
      }()),
    });

    await runner.run(input, { signal: controller.signal });

    expect(received).toBeInstanceOf(AbortController);
  });

  it("forwards safe SDK lifecycle, tool, and result events", async () => {
    const output = { summary: "ok", ruleResults: [], findings: [] };
    const progress: ReviewProgressInput[] = [];
    const runner = new ClaudeAgentSdkReviewRunner({
      apiKey: "test-key",
      query: () => (async function* () {
        yield {
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4-6",
          cwd: "/tmp/review-workspace",
          tools: ["Read", "Grep", "Glob"],
          claude_code_version: "1.0.0",
          mcp_servers: [],
        } as unknown as SDKMessage;
        yield {
          type: "stream_event",
          event: { type: "message_start", message: { id: "message-1" } },
        } as unknown as SDKMessage;
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "完整的 " } },
        } as unknown as SDKMessage;
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "模型输出" } },
        } as unknown as SDKMessage;
        yield {
          type: "stream_event",
          event: { type: "message_stop" },
        } as unknown as SDKMessage;
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/example.ts" } }],
          },
        } as unknown as SDKMessage;
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "const value = 1;" }],
          },
        } as unknown as SDKMessage;
        yield { type: "system", subtype: "thinking_tokens", estimated_tokens: 1 } as unknown as SDKMessage;
        yield { type: "system", subtype: "thinking_tokens", estimated_tokens: 2 } as unknown as SDKMessage;
        yield resultMessage(output);
      }()),
    });

    await runner.run(input, { onProgress: (event) => progress.push(event) });

    expect(progress.map((event) => event.kind)).toEqual(expect.arrayContaining(["system", "tool", "tool_result", "result"]));
    expect(progress.find((event) => event.kind === "tool")?.detail).toContain("读取 src/example.ts");
    expect(progress.find((event) => event.kind === "tool_result")?.detail).toContain("const value = 1;");
    expect(progress.filter((event) => event.kind === "thinking")).toHaveLength(0);
    expect(progress.filter((event) => event.meta?.stream === "assistant" && event.meta.phase === "chunk").map((event) => event.detail).join("")).toBe("完整的 模型输出");
    expect(progress.some((event) => event.meta?.stream === "assistant" && event.meta.phase === "end")).toBe(true);
    expect(progress.find((event) => event.kind === "result")?.detail).toContain('"summary"');
  });
});
