import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_INSPECTION_OWNER_PROMPT, INSPECTION_OWNER_PROMPT_ID, INSPECTION_PROMPT_DEFINITIONS, InspectionPromptStore } from "../src/inspection-prompts.js";
import { InspectionRulesStore } from "../src/inspection-rules.js";

describe("InspectionPromptStore", () => {
  it("returns the default prompt in the generic list until a custom prompt is saved", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-owner-prompt-"));
    const store = new InspectionPromptStore({ promptDir: path.join(directory, "prompts"), legacyOwnerPromptPath: path.join(directory, "legacy-owner.md") });
    try {
      await expect(store.read(INSPECTION_OWNER_PROMPT_ID)).resolves.toMatchObject({ id: INSPECTION_OWNER_PROMPT_ID, content: DEFAULT_INSPECTION_OWNER_PROMPT });
      const summaries = await store.list();
      expect(summaries).toHaveLength(INSPECTION_PROMPT_DEFINITIONS.length);
      expect(summaries.map((summary) => summary.id)).toEqual(INSPECTION_PROMPT_DEFINITIONS.map((definition) => definition.id));
      expect(summaries[0]).not.toHaveProperty("content");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("trims and persists updates for the selected prompt", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-owner-prompt-"));
    const store = new InspectionPromptStore({ promptDir: directory });
    try {
      await expect(store.update(INSPECTION_OWNER_PROMPT_ID, "  请直接判断负责人。\n不要让用户选择。\n")).resolves.toMatchObject({ content: "请直接判断负责人。\n不要让用户选择。" });
      await expect(store.read(INSPECTION_OWNER_PROMPT_ID)).resolves.toMatchObject({ content: "请直接判断负责人。\n不要让用户选择。" });
      await expect(readFile(path.join(directory, "inspection-owner.md"), "utf8")).resolves.toBe("请直接判断负责人。\n不要让用户选择。\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an empty prompt", async () => {
    const store = new InspectionPromptStore({ promptDir: os.tmpdir() });
    await expect(store.update(INSPECTION_OWNER_PROMPT_ID, " \n ")).rejects.toThrow("不能为空");
  });

  it("isolates prompt overrides and inspection rule edits by maintainer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "frontend-pilot-inspection-scope-"));
    const promptStore = new InspectionPromptStore({ promptDir: path.join(directory, "prompts") });
    const rulesDir = path.join(directory, "rules");
    const profileConfigPath = path.join(directory, "inspection-profiles.json");
    await mkdir(path.join(rulesDir, "inspection"), { recursive: true });
    await writeFile(path.join(rulesDir, "inspection", "security.md"), "系统规则", "utf8");
    await writeFile(profileConfigPath, JSON.stringify({ default: {
      displayName: "默认 profile",
      rules: [{ id: "security", name: "安全", description: "", enabled: true, order: 0, file: "inspection/security.md" }],
    } }), "utf8");
    const rulesStore = new InspectionRulesStore({ rulesDir, profileConfigPath });
    try {
      await promptStore.update(INSPECTION_OWNER_PROMPT_ID, "Alice 的负责人规则", "alice");
      expect((await promptStore.read(INSPECTION_OWNER_PROMPT_ID, "alice")).content).toBe("Alice 的负责人规则");
      expect((await promptStore.read(INSPECTION_OWNER_PROMPT_ID, "bob")).content).toBe(DEFAULT_INSPECTION_OWNER_PROMPT);

      await rulesStore.updateRule({ profile: "default", ruleId: "security", name: "Alice 安全", description: "", enabled: true, content: "Alice 的巡检规则" }, "alice");
      expect((await rulesStore.readForProject("group/project", "alice")).rules[0]).toMatchObject({ name: "Alice 安全", content: "Alice 的巡检规则" });
      expect((await rulesStore.readForProject("group/project", "bob")).rules[0]).toMatchObject({ name: "安全", content: "系统规则" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
