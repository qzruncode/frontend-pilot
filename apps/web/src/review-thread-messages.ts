import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ReviewJob, ReviewProgressEvent } from "@contracts";

type ThreadContent = Exclude<ThreadMessageLike["content"], string>;
type ThreadPart = ThreadContent[number];
type ReviewTextPart = Extract<ThreadPart, { type: "text" }>;
type ReviewToolPart = Extract<ThreadPart, { type: "tool-call" }>;
type ReviewPart = ReviewTextPart | ReviewToolPart;

function metaString(event: ReviewProgressEvent, key: string): string | null {
  const value = event.meta?.[key];
  return typeof value === "string" ? value : null;
}

function metaBoolean(event: ReviewProgressEvent, key: string): boolean {
  return event.meta?.[key] === true;
}

function appendText(content: ReviewPart[], text: string): void {
  if (!text) return;
  const previous = content[content.length - 1];
  if (previous?.type === "text") content[content.length - 1] = { ...previous, text: previous.text + text };
  else content.push({ type: "text", text });
}

interface ReviewFindingView {
  severity?: string;
  category?: string;
  path?: string;
  line?: number | null;
  issue?: string;
  suggestion?: string;
}

function reviewFindingText(finding: ReviewFindingView, index: number): string {
  const location = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ""}` : "位置未提供";
  const severity = [finding.severity, finding.category].filter(Boolean).join(" · ");
  return [
    `${index}. ${severity ? `[${severity}] ` : ""}${location}`,
    `问题：${finding.issue || "未提供问题描述"}`,
    `建议：${finding.suggestion || "未提供修改建议"}`,
  ].join("\n");
}

function readableReviewResult(detail: string, fallback: string): string {
  try {
    const parsed = JSON.parse(detail) as { summary?: unknown; findings?: unknown; ruleFindings?: unknown; ruleResults?: unknown };
    if (!parsed || typeof parsed !== "object") return detail || fallback;
    const findings = Array.isArray(parsed.findings) ? parsed.findings as ReviewFindingView[] : [];
    const ruleFindings = Array.isArray(parsed.ruleFindings) ? parsed.ruleFindings as ReviewFindingView[] : [];
    const ruleResults = Array.isArray(parsed.ruleResults) ? parsed.ruleResults.filter((item): item is { ruleName?: unknown; conclusion?: unknown; findings?: unknown } => Boolean(item && typeof item === "object")) : [];
    const lines = ["审查结论", String(parsed.summary ?? "未提供总结。"), ""];
    if (ruleResults.length > 0) {
      lines.push("按规则结论");
      ruleResults.forEach((rule) => {
        const ruleFindingsForBlock = Array.isArray(rule.findings) ? rule.findings as ReviewFindingView[] : [];
        lines.push(`\n${String(rule.ruleName ?? "未命名规则")}`, String(rule.conclusion ?? "未提供该规则结论。"), ruleFindingsForBlock.length > 0 ? ruleFindingsForBlock.map(reviewFindingText).join("\n\n") : "未发现明确问题。", "");
      });
    } else {
      lines.push(`规范问题（${ruleFindings.length}）`, ruleFindings.length > 0 ? ruleFindings.map(reviewFindingText).join("\n\n") : "未发现规范问题。", "");
    }
    lines.push(`跨规则高价值问题（${findings.length}）`, findings.length > 0 ? findings.map(reviewFindingText).join("\n\n") : "未发现高价值问题。");
    return lines.join("\n");
  } catch {
    return detail || fallback;
  }
}

export type ReviewContext = Pick<ReviewJob, "projectPath" | "mrIid" | "headSha" | "targetBranch">;

interface ReviewDraft {
  id: string;
  role: "assistant" | "system";
  content: ReviewPart[];
  streamId: string;
  at: string;
  closed: boolean;
  errored: boolean;
}

export function buildReviewThreadMessages(events: ReviewProgressEvent[], live: boolean, context: ReviewContext): ThreadMessageLike[] {
  const createdAt = events[0]?.at ? new Date(events[0].at) : new Date();
  const drafts: ReviewDraft[] = [];
  const toolParts = new Map<string, { draft: ReviewDraft; index: number }>();
  let currentDraft: ReviewDraft | null = null;
  const userMessage: ThreadMessageLike = {
    id: `review-request-${events[0]?.id ?? "empty"}`,
    role: "user",
    content: [
      `请审查 ${context.projectPath ?? "项目"} !${context.mrIid}`,
      `目标分支：${context.targetBranch ?? "未指定"}`,
      `Commit：${context.headSha ?? "跟随 MR 最新提交"}`,
      "",
      "读取完整仓库上下文，检查变更及其调用方、类型、配置和测试，并只报告有价值的问题。",
    ].join("\n"),
    createdAt,
  };
  const startAssistantDraft = (streamId: string, at: string): ReviewDraft => {
    if (currentDraft && currentDraft.streamId === streamId && !currentDraft.closed) return currentDraft;
    // The event list is rebuilt on every streamed chunk. Do not include its
    // current length in the message id: that would make the same assistant
    // message look like a new message to assistant-ui for every chunk.
    const draft: ReviewDraft = { id: `review-turn-${streamId}`, role: "assistant", content: [], streamId, at, closed: false, errored: false };
    drafts.push(draft);
    currentDraft = draft;
    return draft;
  };
  const appendSystemDraft = (event: ReviewProgressEvent, text: string): void => {
    drafts.push({ id: `review-system-${event.id}`, role: "system", content: [{ type: "text", text }], streamId: `system:${event.id}`, at: event.at, closed: true, errored: event.kind === "error" });
  };

  for (const event of events) {
    const stream = metaString(event, "stream");
    const phase = metaString(event, "phase");
    const detail = event.detail ?? "";
    if (["stage", "system", "status", "thinking"].includes(event.kind)) {
      appendSystemDraft(event, [event.message, detail].filter(Boolean).join("\n"));
      continue;
    }
    if (event.kind === "assistant") {
      if (stream === "assistant" && phase === "end") {
        const activeDraft = currentDraft as ReviewDraft | null;
        if (activeDraft) activeDraft.closed = true;
        currentDraft = null;
        continue;
      }
      appendText(startAssistantDraft(stream === "assistant" ? String(event.meta?.streamId ?? "assistant") : "legacy", event.at).content, detail);
      continue;
    }
    if (event.kind === "tool") {
      const toolCallId = metaString(event, "toolUseId") ?? event.id;
      const toolName = metaString(event, "tool") ?? (event.message.replace(/^调用工具\s*/, "") || "工具");
      const draft = currentDraft ?? startAssistantDraft(`tool:${event.id}`, event.at);
      toolParts.set(toolCallId, { draft, index: draft.content.length });
      draft.content.push({ type: "tool-call", toolCallId, toolName, args: { detail }, argsText: detail });
      continue;
    }
    if (event.kind === "tool_result") {
      const toolCallId = metaString(event, "toolUseId") ?? event.id;
      const toolPart = toolParts.get(toolCallId);
      if (!toolPart) {
        const toolName = metaString(event, "tool") ?? (event.message.replace(/\s*返回结果$/, "") || "工具");
        const draft = currentDraft ?? startAssistantDraft(`tool:${event.id}`, event.at);
        toolParts.set(toolCallId, { draft, index: draft.content.length });
        draft.content.push({ type: "tool-call", toolCallId, toolName, args: { detail: "" }, argsText: "", result: detail, isError: metaBoolean(event, "isError") });
      } else {
        const previous = toolPart.draft.content[toolPart.index];
        if (previous?.type === "tool-call") toolPart.draft.content[toolPart.index] = { ...previous, result: detail || "工具执行完成", isError: metaBoolean(event, "isError") };
      }
      continue;
    }
    if (event.kind === "result") {
      if (!metaBoolean(event, "output")) {
        appendSystemDraft(event, `已完成\n${detail || event.message}`);
        currentDraft = null;
        continue;
      }
      drafts.push({ id: `review-result-${event.id}`, role: "assistant", content: [{ type: "text", text: readableReviewResult(detail, event.message) }], streamId: `result:${event.id}`, at: event.at, closed: true, errored: false });
      currentDraft = null;
      continue;
    }
    if (event.kind === "warning" || event.kind === "error") {
      appendSystemDraft(event, `${event.kind === "error" ? "审查失败\n失败原因：" : "需要注意\n"}${detail || event.message}`);
      const activeDraft = currentDraft as ReviewDraft | null;
      if (activeDraft) activeDraft.errored = event.kind === "error";
    }
  }

  return [userMessage, ...drafts.map((draft): ThreadMessageLike => {
    const baseMessage = { id: draft.id, role: draft.role, content: draft.content, createdAt: new Date(draft.at) };
    return draft.role === "assistant"
      ? { ...baseMessage, status: live && !draft.closed ? { type: "running" } : draft.errored ? { type: "incomplete", reason: "error" } : { type: "complete", reason: "stop" } }
      : baseMessage;
  })];
}
