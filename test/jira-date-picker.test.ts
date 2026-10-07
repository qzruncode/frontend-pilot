import { describe, expect, it } from "vitest";
import {
  formatJiraDate,
  formatJiraDateDisplay,
  getJiraCalendarDays,
  parseJiraDate,
  shiftJiraMonth,
} from "../apps/web/src/jira-create-issue-date-picker-utils";

describe("Jira date picker helpers", () => {
  it("round-trips Jira dates without accepting impossible calendar dates", () => {
    const date = parseJiraDate("2026-08-27");

    if (!date) throw new Error("expected a valid Jira date");
    expect(formatJiraDate(date)).toBe("2026-08-27");
    expect(formatJiraDateDisplay(date)).toBe("2026/08/27");
    expect(parseJiraDate("2026-02-30")).toBeNull();
  });

  it("keeps a Monday-first six-week grid when navigating months", () => {
    const date = parseJiraDate("2026-08-27");
    if (!date) throw new Error("expected a valid Jira date");
    const days = getJiraCalendarDays(date);
    const nextMonth = shiftJiraMonth(date, 1);

    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(1);
    expect(nextMonth.getFullYear()).toBe(2026);
    expect(nextMonth.getMonth()).toBe(8);
  });
});
