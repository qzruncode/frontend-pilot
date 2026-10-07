import { describe, expect, it } from "vitest";
import {
  ASSISTANT_ROUTE_PATHS,
  assistantPathForNavigation,
  readLegacyAssistantNavigationState,
} from "../apps/web/src/assistant-navigation-state";
import { settingsItems } from "../apps/web/src/assistant-settings";

describe("assistant navigation paths", () => {
  it("maps settings items to real pathname routes", () => {
    expect(ASSISTANT_ROUTE_PATHS["review-workbench"]).toBe("/review-workbench");
    expect(assistantPathForNavigation({ activeItem: "review-workbench", reviewHistoryFocusId: null })).toBe("/review-workbench");
    expect(ASSISTANT_ROUTE_PATHS["review-tools"]).toBe("/review-tools");
    expect(assistantPathForNavigation({ activeItem: "review-tools", reviewHistoryFocusId: null })).toBe("/review-tools");
    expect(assistantPathForNavigation({ activeItem: "runs", reviewHistoryFocusId: "review/17" })).toBe("/review-history/review%2F17");
  });

  it("exposes one visible Review navigation entry while keeping legacy items hidden", () => {
    const visibleReviewItems = settingsItems
      .filter((item) => ["review-workbench", "review-tools", "review-settings", "rules", "runs"].includes(item.id));
    expect(visibleReviewItems.map((item) => item.id)).toEqual(["review-workbench"]);
    expect(settingsItems.some((item) => item.visible === false)).toBe(false);
  });

  it("reads legacy query navigation only for the migration redirect", () => {
    expect(readLegacyAssistantNavigationState("?settings=review-tools")).toEqual({
      activeItem: "review-tools",
      reviewHistoryFocusId: null,
    });
    expect(readLegacyAssistantNavigationState("?settings=runs&review=review-17")).toEqual({
      activeItem: "runs",
      reviewHistoryFocusId: "review-17",
    });
    expect(readLegacyAssistantNavigationState("?settings=unknown")).toBeNull();
  });
});
