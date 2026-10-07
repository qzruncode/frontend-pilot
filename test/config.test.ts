import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses generic example connections without corporate defaults", () => {
    const config = loadConfig({});
    expect(config.gitlabApiBaseUrl).toBe("https://gitlab.example.com/api/v4");
    expect(config.jiraBaseUrl).toBe("https://jira.example.com");
    expect(config.jiraProjectKey).toBe("DEMO");
  });
  it("normalizes a WEB_ORIGIN path to its browser origin", () => {
    const config = loadConfig({ WEB_ORIGIN: "http://192.0.2.10/pilot/" }, "/tmp/frontend-pilot");

    expect(config.webOrigin).toBe("http://192.0.2.10");
  });

  it("supports persistent inspection assets outside the application working directory", () => {
    const config = loadConfig({
      INSPECTION_RULES_DIR: "/app/var/review-rules/inspection",
      INSPECTION_PROFILE_CONFIG: "/app/var/inspection-profiles.json",
    }, "/app/var");

    expect(config.inspectionRulesDir).toBe("/app/var/review-rules/inspection");
    expect(config.inspectionProfileConfigPath).toBe("/app/var/inspection-profiles.json");
  });

  it("accepts the Jira MCP URL key as a compatibility alias", () => {
    const config = loadConfig({ JIRA_URL: "https://jira.example.test" }, "/tmp/frontend-pilot");

    expect(config.jiraBaseUrl).toBe("https://jira.example.test");
    expect(config.jiraApiBaseUrl).toBe("https://jira.example.test/rest/api/2");
  });

  it("validates the assistant idle timeout from the environment", () => {
    expect(loadConfig({ ASSISTANT_IDLE_TIMEOUT_MS: "60000" }).assistantIdleTimeoutMs).toBe(60_000);
    expect(loadConfig({ ASSISTANT_IDLE_TIMEOUT_MS: "1000" }).assistantIdleTimeoutMs).toBe(180_000);
  });

  it("validates the inspection AI concurrency from the environment", () => {
    expect(loadConfig({ INSPECTION_AI_CONCURRENCY: "4" }).inspectionAiConcurrency).toBe(4);
    expect(loadConfig({ INSPECTION_AI_CONCURRENCY: "9" }).inspectionAiConcurrency).toBe(2);
  });

  it("validates the inspection AI pre-submit repair limit from the environment", () => {
    expect(loadConfig({ INSPECTION_AI_MAX_PRE_SUBMIT_REPAIR_ATTEMPTS: "4" }).inspectionAiMaxPreSubmitRepairAttempts).toBe(4);
    expect(loadConfig({ INSPECTION_AI_MAX_PRE_SUBMIT_REPAIR_ATTEMPTS: "11" }).inspectionAiMaxPreSubmitRepairAttempts).toBe(2);
  });
});
