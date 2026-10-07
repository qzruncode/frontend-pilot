import { describe, it, expect } from "vitest";
import { GitLabOAuthService } from "../src/gitlab-oauth.js";
import { GitLabOAuthSessionStore } from "../src/gitlab-oauth-store.js";
import { JiraUserCredentialStore } from "../src/jira-user-credentials.js";
import { InspectionAccounts } from "../src/inspection-accounts.js";
import { UserStore } from "../src/user-store.js";
import { config } from "./app-fixtures.js";

describe("inspection credential isolation", () => {
  it("moves a completed browser-bound authorization to its maintainer without affecting another account", async () => {
    const store = new GitLabOAuthSessionStore(":memory:", "key");
    const oauthConfig = { baseUrl: "https://gitlab.example", apiBaseUrl: "https://gitlab.example/api/v4", clientId: "id", clientSecret: "secret", redirectUri: "https://pilot.example/api/v1/inspections/gitlab/oauth/callback", scope: "api" };
    const mockFetch: typeof fetch = async input => new Response(JSON.stringify(String(input).endsWith("/oauth/token")
      ? { access_token: "alice-token", refresh_token: "alice-refresh", expires_in: 7200 }
      : { id: 1, username: "alice", name: "Alice" }), { status: 200 });
    try {
      const oauth = new GitLabOAuthService(oauthConfig, mockFetch, store);
      const state = new URL(oauth.authorizationUrl("alice:browser-a")!).searchParams.get("state")!;
      await oauth.complete("alice:browser-a", "code", state, "maintainer-alice");
      expect(oauth.status("alice:browser-a").connected).toBe(false);
      expect(oauth.status("maintainer-alice").connected).toBe(true);
      expect(oauth.status("maintainer-bob").connected).toBe(false);
      const restored = new GitLabOAuthService(oauthConfig, mockFetch, store);
      expect((await restored.getConnection("maintainer-alice"))?.token).toBe("alice-token");
      restored.disconnect("maintainer-bob");
      expect(restored.status("maintainer-alice").connected).toBe(true);
    } finally { store.close(); }
  });
  it("keeps Jira credentials separate from the system store and refuses disabled owners", () => {
    const users = new UserStore(":memory:", [{ username: "admin", password: "password", role: "admin" }]);
    const systemCredentials = new JiraUserCredentialStore(":memory:", config.triggerToken);
    const accounts = new InspectionAccounts(config, users, { baseUrl: "https://gitlab.invalid", apiBaseUrl: config.gitlabApiBaseUrl, token: "global" },
      { baseUrl: config.jiraBaseUrl, apiBaseUrl: config.jiraApiBaseUrl, username: "global", token: "global", projectKey: "TEST" });
    try {
      const a = accounts.users.create({ username: "alice", password: "password" });
      const b = accounts.users.create({ username: "bob", password: "password" });
      systemCredentials.write(a.id, { jiraUsername: "system-alice", token: "system-secret" });
      expect(accounts.jiraClient(a.id)).toBeNull();
      accounts.jiraCredentials.write(a.id, { jiraUsername: "inspection-alice", token: "inspection-secret" });
      expect(accounts.jiraCredentials.read(b.id)).toBeNull();
      expect(systemCredentials.read(a.id)?.token).toBe("system-secret");
      const actor = { maintainerId: a.id, operatorId: users.findByUsername("admin")!.id };
      expect(() => accounts.assertIdentity(actor)).not.toThrow();
      accounts.users.update(a.id, { enabled: false });
      expect(() => accounts.assertIdentity(actor)).toThrow("维护人员");
    } finally { accounts.close(); systemCredentials.close(); users.close(); }
  });
});
