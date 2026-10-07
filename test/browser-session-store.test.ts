import { describe, expect, it } from "vitest";
import { BrowserSessionStore, sessionMaxAgeSeconds } from "../src/browser-session-store.js";

describe("BrowserSessionStore", () => {
  it("supports idle renewal without extending the absolute expiry", () => {
    const store = new BrowserSessionStore(":memory:", "session-secret");
    try {
      const now = 1_000_000;
      const created = store.create({ id: "user-1", username: "pilot-user" }, {
        now,
        idleTtlSeconds: 10,
        absoluteTtlSeconds: 30,
      });
      expect(store.read(created.token, now + 9_000)?.id).toBe("user-1");
      const touched = store.touch(created.token, { now: now + 9_000, idleTtlSeconds: 10 });
      expect(touched?.lastSeenAt).toBe(now + 9_000);
      expect(touched?.idleExpiresAt).toBe(now + 19_000);
      expect(touched?.absoluteExpiresAt).toBe(now + 30_000);
      expect(sessionMaxAgeSeconds(touched!, now + 9_000)).toBe(10);
      expect(store.read(created.token, now + 30_000)).toBeNull();
      expect(store.read(created.token, now + 30_001)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("revokes a session and rejects it afterwards", () => {
    const store = new BrowserSessionStore(":memory:", "session-secret");
    try {
      const created = store.create({ id: "user-1", username: "pilot-user" }, {
        now: 1_000_000,
        idleTtlSeconds: 100,
        absoluteTtlSeconds: 200,
      });
      expect(store.read(created.token, 1_000_001)).not.toBeNull();
      store.revoke(created.token, 1_000_002);
      expect(store.read(created.token, 1_000_003)).toBeNull();
    } finally {
      store.close();
    }
  });
});
