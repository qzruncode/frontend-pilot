import { describe, expect, it } from "vitest";
import {
  CreateReviewBodySchema,
  GitLabConnectionInputSchema,
  ResolveMergeRequestBodySchema,
  isInspectionFindingCompleted,
} from "../src/contracts.js";

describe("request contracts", () => {
  it("accepts ordinary review identifiers and normalizes empty optional values", () => {
    expect(CreateReviewBodySchema.parse({
      projectId: 17,
      projectPath: "group/project",
      mrIid: 3,
      headSha: "",
      targetBranch: "main",
    })).toEqual({
      projectId: "17",
      projectPath: "group/project",
      mrIid: "3",
      headSha: null,
      targetBranch: "main",
    });
  });

  it("only accepts HTTP(S) connection and MR URLs without embedded credentials", () => {
    expect(GitLabConnectionInputSchema.safeParse({
      baseUrl: "file:///tmp/gitlab",
      apiBaseUrl: "https://gitlab.example.com/api/v4",
    }).success).toBe(false);
    expect(GitLabConnectionInputSchema.safeParse({
      baseUrl: "https://user:password@gitlab.example.com",
      apiBaseUrl: "https://gitlab.example.com/api/v4",
    }).success).toBe(false);
    expect(ResolveMergeRequestBodySchema.safeParse({ url: "https://gitlab.example.com/group/project/-/merge_requests/1" }).success).toBe(true);
  });

  it("does not treat a rolled-back AI MR as a completed finding", () => {
    const jira = { status: "created" as const, key: "TEST-42", url: null, assignee: null, error: null, issueStatusCategory: "done" };
    expect(isInspectionFindingCompleted({ jira: { ...jira, aiResolutionStatus: "merged" } })).toBe(true);
    expect(isInspectionFindingCompleted({ jira: { ...jira, aiResolutionStatus: "reverted" } })).toBe(false);
  });
});
