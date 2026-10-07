import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { InspectionService, type InspectionExecutionIdentity } from "../src/inspection-service.js";
import { InspectionStore } from "../src/inspection-store.js";
import type { GitLabClientPort } from "../src/gitlab-client.js";
import { config } from "./app-fixtures.js";

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("inspection did not finish");
}
describe("inspection execution identity", () => {
  it("keeps project configuration, runs, and scheduled bindings inside each maintainer scope", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "inspection-identity-"));
    const store = new InspectionStore(path.join(dir, "runs.sqlite"));
    const observed: string[] = [];
    const a: InspectionExecutionIdentity = { maintainerId: "a", maintainerName: "Alice", operatorId: "admin", operatorName: "Admin" };
    const b: InspectionExecutionIdentity = { ...a, maintainerId: "b", maintainerName: "Bob" };
    let allowed = true;
    const service = new InspectionService({
      gitlab: { listRepositoryCommits: async () => { throw new Error("global client must not be used"); } } as unknown as GitLabClientPort,
      runner: { runInspection: async () => JSON.stringify({ summary: "done", findings: [] }) },
      store, config: { rulesDir: config.inspectionRulesDir, profileConfigPath: config.inspectionProfileConfigPath, maintainerRootDir: path.join(dir, "inspection-maintainers") }, jiraProjectKey: () => "GLOBAL",
      validateIdentity: (identity) => { if (!allowed || !identity.maintainerId) throw new Error("identity revoked"); },
      resolveDependencies: async (identity) => ({
        gitlab: { listRepositoryCommits: async () => { observed.push(identity.maintainerId!); return [{ id: `sha-${identity.maintainerId}` }]; } } as GitLabClientPort,
        jiraProjectKey: () => "ISOLATED",
      }), schedulerIntervalMs: 60_000,
    });
    try {
      await service.upsertProject({ ...a, projectId: "1", projectName: "Project", projectPath: "group/project", branch: "main", enabled: true,
        scheduleEnabled: true, scheduleCron: "0 0 * * *", jiraMode: "off", jiraComponent: null, jiraFixVersion: null, inspectionRuleIds: [] });
      await service.upsertProject({ ...b, projectId: "1", projectName: "Project", projectPath: "group/project", branch: "release", enabled: true,
        scheduleEnabled: true, scheduleCron: "0 0 * * *", jiraMode: "off", jiraComponent: null, jiraFixVersion: null, inspectionRuleIds: [] });
      const manual = await service.enqueue("1", "manual", b);
      await waitFor(() => service.getRun(manual.run.id)?.status === "completed");
      expect(service.getRun(manual.run.id)).toMatchObject({ maintainerId: "b", operatorId: "admin", headSha: "sha-b" });
      expect(service.getProject("1", a)?.branch).toBe("main");
      expect(service.getProject("1", b)?.branch).toBe("release");
      expect(service.listProjects(a)).toHaveLength(1);
      expect(service.listProjects(b)).toHaveLength(1);
      const scheduled = await service.enqueue("1", "schedule", a);
      await waitFor(() => service.getRun(scheduled.run.id)?.status === "completed");
      expect(service.getRun(scheduled.run.id)).toMatchObject({ maintainerId: "a", headSha: "sha-a" });
      expect(service.listRuns(100, a).map((run) => run.id)).toEqual([scheduled.run.id]);
      expect(service.listRuns(100, b).map((run) => run.id)).toEqual([manual.run.id]);
      expect(service.getRun(manual.run.id, a)).toBeNull();
      expect(service.getProgressEvents(manual.run.id, a)).toBeNull();
      await expect(service.retry(manual.run.id, a)).rejects.toThrow("不属于当前维护人员");
      expect(observed).toEqual(["b", "a"]);
      expect(store.loadProjects()).toHaveLength(2);
      expect(store.loadProjects().find(project => project.maintainerId === "a")).toMatchObject({ operatorId: "admin", branch: "main" });
      expect(store.loadProjects().find(project => project.maintainerId === "b")).toMatchObject({ operatorId: "admin", branch: "release" });
      expect(store.loadRuns().find(run => run.id === manual.run.id)).toMatchObject({ maintainerId: "b", operatorName: "Admin" });
      allowed = false;
      await expect(service.enqueue("1", "schedule", a)).rejects.toThrow("identity revoked");
      expect(observed).toEqual(["b", "a"]);
    } finally { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
