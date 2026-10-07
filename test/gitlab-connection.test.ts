import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitLabConnectionStore } from "../src/gitlab-connection.js";

describe("GitLabConnectionStore", () => {
  it("reads the existing project .env keys and writes back to the same configuration", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-gitlab-config-"));
    try {
      await mkdir(rootDir, { recursive: true });
      await writeFile(
        path.join(rootDir, ".env"),
        "# project config\nGITLAB_API_URL=https://old.gitlab.example.com/api/v4\nGITLAB__PERSONAL_ACCESS_TOKEN=old-token\n",
      );
      const store = new GitLabConnectionStore(rootDir);

      await expect(store.read({ apiBaseUrl: "https://fallback.example.com/api/v4", token: "fallback-token" }))
        .resolves.toEqual({
          baseUrl: "https://old.gitlab.example.com",
          apiBaseUrl: "https://old.gitlab.example.com/api/v4",
          token: "old-token",
        });

      await store.write({
        baseUrl: "https://new.gitlab.example.com",
        apiBaseUrl: "https://new.gitlab.example.com/api/v4",
        token: "new-token",
      });

      const saved = await readFile(path.join(rootDir, ".env"), "utf8");
      expect(saved).toContain("GITLAB_BASE_URL=https://new.gitlab.example.com");
      expect(saved).toContain("GITLAB_API_URL=https://new.gitlab.example.com/api/v4");
      expect(saved).toContain("GITLAB__PERSONAL_ACCESS_TOKEN=new-token");
      expect(saved).toContain("# project config");

      await store.write({
        baseUrl: "https://new.gitlab.example.com",
        apiBaseUrl: "https://new.gitlab.example.com/api/v4",
        token: "",
      });
      await expect(store.read({ apiBaseUrl: "https://fallback.example.com/api/v4", token: "fallback-token" }))
        .resolves.toMatchObject({ token: "" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
