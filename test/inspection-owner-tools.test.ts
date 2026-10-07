import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createInspectionOwnerToolServer, type InspectionOwnershipInput } from "../src/inspection-owner-tools.js";

function input(): InspectionOwnershipInput {
  return {
    projectId: "22775", projectPath: "saas/saas-frontend", branch: "dev", headSha: "pinned", jiraProjectKey: "AIP", validate: vi.fn(),
    findings: [{ id: "f1", path: "src/Connectors/Dialog.tsx", line: 1, scope: "file", issue: "组件 818 行", suggestion: "拆分表单", jiraKey: "AIP-114661" }],
    gitlab: {
      listRepositoryCommits: vi.fn(async () => [{ id: "commit", shortId: "commit", title: "功能维护", message: "AIP-123 功能调整", authorName: "其他作者", authorEmail: "author@example.com", authoredAt: null, committedAt: null, webUrl: null }]),
      getRepositoryFileBlame: vi.fn(async () => [{ authorName: "陈成龙", authorEmail: "chenglong.chen@example.com", lines: Array.from({ length: 818 }, (_, i) => `line ${i + 1}`) }]),
    },
    jira: {
      listIssues: vi.fn(async () => ({ issues: [], total: 0, page: 1, perPage: 20 })),
      getIssue: vi.fn(async () => ({ key: "AIP-114661", summary: "组件 818 行", description: "Connectors", assignee: { username: "chenglong.chen", name: "陈成龙" }, labels: ["code-inspection"], webUrl: "https://jira.invalid/browse/AIP-114661", updatedAt: "2026-09-07",
        comments: [{ id: "c1", body: "2026-09-07 已确认 Connectors 归宋云负责", createdAt: "2026-09-07", author: null }] }) as never),
      listAssignableUsers: vi.fn(async () => [{ username: "yun.song-cn", name: "SongYun 宋云", avatarUrl: null }]),
    },
  };
}

async function connected(context = input()) {
  const lookup = createInspectionOwnerToolServer(context);
  const client = new Client({ name: "ownership-test", version: "1.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await lookup.server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  return { lookup, client, context, close: async () => { await client.close(); await lookup.server.instance.close(); } };
}

const decision = (assignee: string | null, evidenceIds: string[]) => ({ decisions: [{ findingId: "f1", status: "resolved" as const, assignee,
  reason: "9 月 7 日最新评论明确 Connectors 由宋云负责；首行提交作者无法证明整文件归属。", evidenceIds }] });

describe("inspection owner read tools", () => {
  it("uses live issue comments and verified Jira usernames, retaining only actually read references", async () => {
    const test = await connected();
    try {
      const issue = await test.client.callTool({ name: "get_jira_issue", arguments: { key: "AIP-114661" } });
      expect(JSON.stringify(issue.content)).toContain("宋云");
      await test.client.callTool({ name: "search_jira_users", arguments: { query: "宋云" } });
      expect(test.lookup.results(decision("yun.song-cn", ["e1"]))[0]!.ownership).toMatchObject({ status: "resolved", assignee: "yun.song-cn",
        evidence: [{ source: "jira_issue", url: "https://jira.invalid/browse/AIP-114661" }] });
      expect(test.lookup.results(decision("SongYun", ["e1"]))[0]!.ownership.status).toBe("uncertain");
      expect(test.lookup.results(decision("yun.song-cn", ["invented"]))[0]!.ownership.status).toBe("uncertain");
      expect(test.lookup.results(decision("yun.song-cn", ["e2"]))[0]!.ownership.status).toBe("uncertain");
      expect(test.lookup.results({ decisions: [] })[0]!.ownership.status).toBe("uncertain");
      expect(test.lookup.results({ decisions: [...decision("yun.song-cn", ["e1"]).decisions, ...decision("yun.song-cn", ["e1"]).decisions] })[0]!.ownership.status).toBe("uncertain");
      expect((await test.client.listTools()).tools.every((tool) => !/create|update|assign_issue/.test(tool.name))).toBe(true);
    } finally { await test.close(); }
  });

  it("distinguishes current history from inspection code and searches all owners and states", async () => {
    const test = await connected();
    try {
      await test.client.callTool({ name: "get_file_history", arguments: { path: "src/Connectors/Dialog.tsx" } });
      await test.client.callTool({ name: "get_file_history", arguments: { path: "src/Connectors/Dialog.tsx", revision: "inspection", page: 2 } });
      expect(test.context.gitlab.listRepositoryCommits).toHaveBeenNthCalledWith(1, "22775", expect.objectContaining({ ref: "dev", page: 1, path: "src/Connectors/Dialog.tsx" }));
      expect(test.context.gitlab.listRepositoryCommits).toHaveBeenNthCalledWith(2, "22775", expect.objectContaining({ ref: "pinned", page: 2 }));
      const file = await test.client.callTool({ name: "read_file", arguments: { path: "src/Connectors/Dialog.tsx", startLine: 121 } });
      const decoded = JSON.parse((file.content as Array<{ text: string }>)[0]!.text);
      expect(decoded.data.totalLines).toBe(818);
      expect(decoded.data.lines[0].line).toBe(121);
      expect(decoded.data.lines).toHaveLength(120);
      await test.client.callTool({ name: "search_jira_issues", arguments: { query: "Connectors" } });
      expect(test.context.jira.listIssues).toHaveBeenCalledWith(expect.objectContaining({ projectKey: "AIP", scope: "all", state: "all", search: "Connectors" }));
    } finally { await test.close(); }
  });

  it("rejects escaped paths, another Jira project, failed reads and revoked identity", async () => {
    const test = await connected();
    try {
      expect((await test.client.callTool({ name: "read_file", arguments: { path: "../secret" } })).isError).toBe(true);
      expect((await test.client.callTool({ name: "get_jira_issue", arguments: { key: "OTHER-1" } })).isError).toBe(true);
      expect(test.context.gitlab.getRepositoryFileBlame).not.toHaveBeenCalled();
      expect(test.context.jira.getIssue).not.toHaveBeenCalled();
      vi.mocked(test.context.jira.getIssue).mockRejectedValueOnce(new Error("403"));
      expect((await test.client.callTool({ name: "get_jira_issue", arguments: { key: "AIP-114661" } })).isError).toBe(true);
      await test.client.callTool({ name: "search_jira_users", arguments: { query: "宋云" } });
      expect(test.lookup.results(decision("yun.song-cn", ["e1"]))[0]!.ownership.status).toBe("uncertain");
      vi.mocked(test.context.gitlab.listRepositoryCommits!).mockResolvedValueOnce([]);
      await test.client.callTool({ name: "get_file_history", arguments: { path: "src/missing.ts" } });
      expect(test.lookup.results(decision("yun.song-cn", ["e2"]))[0]!.ownership.status).toBe("uncertain");
      vi.mocked(test.context.validate).mockImplementation(() => { throw new Error("授权已撤销"); });
      expect((await test.client.callTool({ name: "get_file_history", arguments: { path: "src/file.ts" } })).isError).toBe(true);
      expect(test.context.gitlab.listRepositoryCommits).toHaveBeenCalledTimes(1);
    } finally { await test.close(); }
  });
});
