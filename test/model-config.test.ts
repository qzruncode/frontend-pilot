import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DatabaseClaudeSettingsStore,
  ClaudeModelConfigStore,
  withoutClaudeSettingsEnvironment,
  testClaudeSettings,
} from "../src/model-config.js";

describe("Claude runtime environment", () => {
  it("keeps the gateway compatibility switch while excluding model settings", () => {
    expect(withoutClaudeSettingsEnvironment({
      PATH: "/usr/bin",
      ANTHROPIC_BASE_URL: "https://model.example.com",
      CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES: "1",
    })).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_NORMALIZE_SYSTEM_MESSAGES: "1",
    });
  });
});

describe("ClaudeModelConfigStore", () => {
  it("rejects a successful provider response that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream is not ready", { status: 200 })));
    try {
      await expect(testClaudeSettings({
        env: {
          ANTHROPIC_AUTH_TOKEN: "test-token",
          ANTHROPIC_BASE_URL: "https://model.example.com",
          ANTHROPIC_MODEL: "test-model",
        },
      })).rejects.toThrow("无法解析的响应");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("exposes a non-sensitive network cause when the provider cannot be reached", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND models.example.com"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause });
    }));
    try {
      await expect(testClaudeSettings({
        env: {
          ANTHROPIC_AUTH_TOKEN: "test-token",
          ANTHROPIC_BASE_URL: "https://model.example.com",
          ANTHROPIC_MODEL: "test-model",
        },
      })).rejects.toThrow("错误码 ENOTFOUND");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a clear timeout when the provider does not respond", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }));
    try {
      await expect(testClaudeSettings({
        env: {
          ANTHROPIC_AUTH_TOKEN: "test-token",
          ANTHROPIC_BASE_URL: "https://model.example.com",
          ANTHROPIC_MODEL: "test-model",
        },
      })).rejects.toThrow("请求超时（15 秒）");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the model selector stored outside env for the connection test", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      expect(body.model).toBe("selected-model");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(testClaudeSettings({
        model: "selected-model",
        env: {
          ANTHROPIC_AUTH_TOKEN: "test-token",
          ANTHROPIC_BASE_URL: "https://model.example.com",
          ANTHROPIC_MODEL: "legacy-env-model",
        },
      })).resolves.toMatchObject({ model: "selected-model" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads and writes the project Claude settings without adding page-only fields", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-model-config-"));
    const settingsDir = path.join(rootDir, ".claude");
    const settingsPath = path.join(settingsDir, "settings.json");
    const initialSettings = {
      permissions: { deny: ["Bash"] },
      env: {
        ANTHROPIC_AUTH_TOKEN: "old-token",
        ANTHROPIC_BASE_URL: "https://old.example.com",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
        ANTHROPIC_MODEL: "old-model",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "old-model",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "old-model",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "old-model",
      },
    };
    try {
      await mkdir(settingsDir, { recursive: true });
      await writeFile(settingsPath, JSON.stringify(initialSettings));
      const store = new ClaudeModelConfigStore(rootDir);

      expect(await store.read()).toEqual(initialSettings);

      const nextSettings = {
        ...initialSettings,
        env: { ...initialSettings.env, ANTHROPIC_MODEL: "new-model" },
      };
      expect(await store.write(nextSettings)).toEqual(nextSettings);

      const saved = JSON.parse(await readFile(settingsPath, "utf8")) as typeof nextSettings;
      expect(saved).toEqual(nextSettings);
      expect(saved.env).not.toHaveProperty("FRONTEND_PILOT_MODEL_PROVIDER");
      expect(saved.env).not.toHaveProperty("CLAUDE_MAX_TOKENS");
      expect(saved.env).not.toHaveProperty("CLAUDE_TEMPERATURE");
      expect(saved).not.toHaveProperty("provider");
      expect(saved).not.toHaveProperty("maxTokens");
      expect(saved).not.toHaveProperty("temperature");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("persists Claude settings in the application database", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-model-config-db-"));
    const databasePath = path.join(rootDir, "frontend-pilot.sqlite");
    const initialSettings = {
      env: {
        ANTHROPIC_AUTH_TOKEN: "initial-token",
        ANTHROPIC_BASE_URL: "https://model.example.com",
        ANTHROPIC_MODEL: "initial-model",
      },
    };
    const store = new DatabaseClaudeSettingsStore(databasePath, initialSettings);
    try {
      expect(await store.read()).toEqual(initialSettings);
      const nextSettings = {
        ...initialSettings,
        env: { ...initialSettings.env, ANTHROPIC_MODEL: "saved-model" },
      };
      expect(await store.write(nextSettings)).toEqual(nextSettings);
    } finally {
      store.close();
    }

    const reopened = new DatabaseClaudeSettingsStore(databasePath, { env: {} });
    try {
      expect(await reopened.read()).toEqual({
        ...initialSettings,
        env: { ...initialSettings.env, ANTHROPIC_MODEL: "saved-model" },
      });
    } finally {
      reopened.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
