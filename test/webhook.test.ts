import { describe, expect, it } from "vitest";
import { normalizeMergeRequestEvent, normalizeMergeRequestTerminalEvent } from "../src/webhook.js";

describe("GitLab webhook normalization", () => {
  it("drops malformed identifiers instead of enqueueing unbounded values", () => {
    expect(normalizeMergeRequestEvent({
      object_kind: "merge_request",
      project: { id: { unexpected: true } },
      object_attributes: { iid: 1, action: "update" },
    })).toBeNull();

    expect(normalizeMergeRequestEvent({
      object_kind: "merge_request",
      project: { id: 1 },
      object_attributes: { iid: 1, action: "update", target_branch: "x".repeat(300) },
    })).toBeNull();
  });

  it("normalizes merge and close events as terminal cleanup events", () => {
    expect(normalizeMergeRequestTerminalEvent({
      object_kind: "merge_request",
      project: { id: 7 },
      object_attributes: { iid: 3, action: "merge" },
    })).toEqual({ projectId: "7", mrIid: "3", action: "merge" });

    expect(normalizeMergeRequestTerminalEvent({
      object_kind: "merge_request",
      project: { id: 7 },
      object_attributes: { iid: 3, action: "close" },
    })).toEqual({ projectId: "7", mrIid: "3", action: "close" });
  });
});
