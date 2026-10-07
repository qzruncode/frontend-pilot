import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JiraConnectionStore } from "../src/jira-connection.js";

describe("JiraConnectionStore", () => {
  it("defaults the project key when a legacy fallback omits it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-jira-config-"));
    try {
      await expect(new JiraConnectionStore(rootDir).read({
        baseUrl: "https://jira.example.com",
        apiBaseUrl: "https://jira.example.com/rest/api/2",
        username: "jira-user",
        token: "jira-token",
      })).resolves.toEqual({
        baseUrl: "https://jira.example.com",
        apiBaseUrl: "https://jira.example.com/rest/api/2",
        projectKey: "AIP",
        username: "jira-user",
        token: "jira-token",
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
