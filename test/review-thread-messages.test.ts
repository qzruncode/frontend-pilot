import { describe, expect, it } from "vitest";
import { buildReviewThreadMessages } from "../apps/web/src/review-thread-messages";
import type { ReviewProgressEvent } from "../src/contracts.js";

const context = {
  projectPath: "demo/project",
  mrIid: "7",
  headSha: "head-1",
  targetBranch: "main",
};

function assistantMessage(events: ReviewProgressEvent[]) {
  return buildReviewThreadMessages(events, true, context).find((message) => message.role === "assistant");
}

describe("review thread streaming messages", () => {
  it("keeps the streamed assistant message identity stable as chunks arrive", () => {
    const firstChunk: ReviewProgressEvent[] = [{
      id: "job:1",
      at: "2026-08-17T10:00:00.000Z",
      kind: "assistant",
      message: "",
      detail: "你",
      meta: { stream: "assistant", phase: "chunk", streamId: 1 },
    }];
    const nextChunk = [...firstChunk, {
      id: "job:2",
      at: "2026-08-17T10:00:00.100Z",
      kind: "assistant" as const,
      message: "",
      detail: "好",
      meta: { stream: "assistant", phase: "chunk", streamId: 1 },
    }];

    const firstMessage = assistantMessage(firstChunk);
    const nextMessage = assistantMessage(nextChunk);

    expect(firstMessage?.id).toBe(nextMessage?.id);
    expect(nextMessage?.content).toEqual([{ type: "text", text: "你好" }]);
  });
});
