import { describe, expect, it } from "vitest";
import { JiraUserCredentialStore } from "../src/jira-user-credentials.js";

describe("JiraUserCredentialStore", () => {
  it("isolates credentials by product user and round-trips each token", () => {
    const store = new JiraUserCredentialStore(":memory:", "test-encryption-secret");

    store.write("Biao.Chen", { jiraUsername: "chenglong.chen", token: "biao-token" });
    store.write("hui.dai", { jiraUsername: "hui.zang", token: "hui-token" });

    expect(store.read("biao.chen")).toMatchObject({ productUsername: "biao.chen", jiraUsername: "chenglong.chen", token: "biao-token" });
    expect(store.read("HUI.DAI")).toMatchObject({ productUsername: "hui.dai", jiraUsername: "hui.zang", token: "hui-token" });
    expect(store.read("unknown-user")).toBeNull();
    expect(store.delete("BIAO.CHEN")).toBe(true);
    expect(store.read("biao.chen")).toBeNull();

    store.close();
  });
});
