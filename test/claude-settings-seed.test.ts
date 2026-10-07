import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Claude settings image defaults", () => {
  it("merges tracked defaults and runtime credentials without dropping existing settings", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-claude-settings-"));
    const settingsPath = path.join(rootDir, ".claude", "settings.json");
    const templatePath = path.resolve(process.cwd(), "config/claude-settings.json");
    const scriptPath = path.resolve(process.cwd(), "scripts/seed-claude-settings.mjs");
    try {
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({
        permissions: { deny: ["Bash"] },
        env: {
          ANTHROPIC_MODEL: "custom-model",
          CUSTOM_SETTING: "keep-me",
        },
      }), { encoding: "utf8" });

      await execFileAsync(process.execPath, [scriptPath, settingsPath, templatePath], {
        env: { ...process.env, ANTHROPIC_AUTH_TOKEN: "runtime-secret", ANTHROPIC_API_KEY: "" },
      });

      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        permissions: { deny: string[] };
        env: Record<string, string>;
      };
      expect(settings.permissions).toEqual({ deny: ["Bash"] });
      expect(settings.env).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: "runtime-secret",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_MODEL: "custom-model",
        CUSTOM_SETTING: "keep-me",
      });

      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
