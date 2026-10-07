import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { JiraAttachmentDownload, JiraClientPort } from "../src/jira-client.js";
import type { JiraConnection } from "../src/jira-connection.js";
import type { JiraUserCredential, JiraUserCredentialStorePort } from "../src/jira-user-credentials.js";
import type { JiraCreateIssueOptions, JiraIssue, JiraIssueDetails } from "../src/contracts.js";
import { UserStore } from "../src/user-store.js";
import { config, service } from "./app-fixtures.js";

const issue: JiraIssue = {
  id: "428812",
  key: "AIP-113931",
  summary: "配置部署调整",
  description: "调整部署配置",
  status: "进行中",
  statusId: "3",
  statusCategory: "indeterminate",
  issueType: "任务",
  priority: "重要",
  projectKey: "AIP",
  projectName: "Sophon",
  webUrl: "https://jira.example.com/browse/AIP-113931",
  createdAt: "2026-08-19T01:00:00Z",
  updatedAt: "2026-08-20T01:00:00Z",
  resolution: null,
  labels: [],
  assignee: { username: "jira-user", name: "Jira User", avatarUrl: null },
  reporter: { username: "jira-user", name: "Jira User", avatarUrl: null },
};

const detail: JiraIssueDetails = { ...issue, comments: [], attachments: [] };
const createOptionsFixture: JiraCreateIssueOptions = {
  issueTypes: [{ id: "10001", name: "任务" }],
  priorities: [{ id: "3", name: "重要" }],
  priorityRequired: true,
  assignees: [{ username: "jira-user", name: "Jira User", avatarUrl: null }],
  reporters: [{ username: "jira-user", name: "Jira User", avatarUrl: null }],
  currentUser: { username: "jira-user", name: "Jira User", avatarUrl: null },
  components: [],
  fixVersions: [],
  customers: [],
  epics: [],
  sprints: [],
  linkableIssues: [],
  customFieldIds: { customerName: null, epicLink: null, sprint: null },
  labels: ["frontend"],
};

function jiraConnectionStore() {
  let current: JiraConnection = {
    baseUrl: "https://jira.example.com",
    apiBaseUrl: "https://jira.example.com/rest/api/2",
    projectKey: "AIP",
    username: "jira-user",
    token: "jira-token",
  };
  return {
    async read() { return current; },
    async write(next: JiraConnection) { current = next; return current; },
  };
}

function jiraUserCredentialStore(initial: JiraUserCredential[] = []): JiraUserCredentialStorePort {
  const credentials = new Map(initial.map((credential) => [credential.productUsername, credential]));
  return {
    read(productUsername) { return credentials.get(productUsername.trim().toLowerCase()) ?? null; },
    write(productUsername, input) {
      const credential = { productUsername: productUsername.trim().toLowerCase(), ...input, updatedAt: "2026-08-25T00:00:00.000Z" };
      credentials.set(credential.productUsername, credential);
      return credential;
    },
    delete(productUsername) { return credentials.delete(productUsername.trim().toLowerCase()); },
    close() {},
  };
}

describe("Jira workbench API", () => {
  it("serves overview, filtered issues, issue detail, and comments", async () => {
    const queries: Array<Record<string, unknown>> = [];
    const personalQueries: Array<Record<string, unknown>> = [];
    const assigneeQueries: Array<{ projectKey: string; query?: string }> = [];
    const jira: JiraClientPort = {
      async getCurrentUser() { return { username: "jira-user", name: "Jira User", avatarUrl: null }; },
      async listAssignableUsers(projectKey, query) { assigneeQueries.push({ projectKey, query }); return [{ username: "jira-user", name: "Jira User", avatarUrl: null }]; },
      async listProjectComponents() { return [{ id: "component-1", name: "MLOps" }]; },
      async listProjectVersions() { return [{ id: "version-1", name: "release-2026" }]; },
      async listLabels() { return ["frontend"]; },
      async getCreateIssueOptions(projectKey) {
        expect(projectKey).toBe("AIP");
        return createOptionsFixture;
      },
      async getCreateIssueSupportingOptions() { return { assignees: [], components: [], fixVersions: [], labels: [] }; },
      async getCreateIssueAdvancedOptions() { return { customers: [], epics: [], sprints: [], linkableIssues: [], customFieldIds: { customerName: null, epicLink: null, sprint: null } }; },
      async listIssues(query) { queries.push(query); return { issues: [issue], page: query.page, perPage: query.perPage, total: 1 }; },
      async getIssue() { return detail; },
      async getAttachment() { return { response: new Response("attachment"), attachment: { id: "77", filename: "附件.txt", url: "https://jira.example.com/secure/attachment/77/attachment.txt", mimeType: "text/plain", size: 10, createdAt: null, author: null } } satisfies JiraAttachmentDownload; },
      async getTransitions() { return [{ id: "11", name: "开始处理", toStatus: "处理中", toStatusId: "3" }]; },
      async transitionIssue() { return { ...detail, status: "处理中" }; },
      async addComment(_key, body) { return { id: "11", body, author: issue.assignee, createdAt: "2026-08-20T02:00:00Z", updatedAt: null }; },
      async addAttachments() {},
      async createIssue(projectKey, input) {
        expect(projectKey).toBe("AIP");
        expect(input).toEqual({ summary: "完善发布流程的错误提示", issueType: "10001", components: ["MLOps"], fixVersions: ["release-2026"], description: "补充错误提示和验收标准", priority: "3", assignee: "jira-user", customFields: {}, labels: ["frontend"] });
        return { ...detail, id: "428813", key: "AIP-113932", summary: input.summary, description: input.description ?? null };
      },
    };
    const personalJira: JiraClientPort = {
      ...jira,
      async getCurrentUser() { return { username: "chenglong.chen", name: "陈彪", avatarUrl: null }; },
      async listIssues(query) { personalQueries.push(query); return { issues: [issue], page: query.page, perPage: query.perPage, total: 1 }; },
    };
    const userStore = new UserStore(":memory:", [
      { username: "jira-user", password: "pilot-password", role: "user" },
      { username: "unmatched-user", password: "pilot-password", role: "user" },
      { username: "biao.chen", password: "pilot-password", role: "user" },
      { username: "hui.dai", password: "pilot-password", role: "user" },
      { username: "yun.song", password: "pilot-password", role: "user" },
    ]);
    const app = await buildApp({
      config,
      reviewService: service(),
      jira,
      jiraConnectionStore: jiraConnectionStore(),
      jiraUserCredentialStore: jiraUserCredentialStore([{
        productUsername: "biao.chen",
        jiraUsername: "chenglong.chen",
        token: "biao-token",
        updatedAt: "2026-08-25T00:00:00.000Z",
      }]),
      jiraClientForUser: (productUsername) => productUsername === "biao.chen" ? personalJira : null,
      userStore,
    });
    const headers = { authorization: "Bearer trigger-token" };

    const overview = await app.inject({ method: "GET", url: "/api/v1/jira/overview", headers });
    expect(overview.statusCode).toBe(200);
    expect(overview.headers["cache-control"]).toBe("private, no-store");
    expect(overview.json()).toMatchObject({
      user: { username: "jira-user" },
      assigned: [{ key: "AIP-113931" }],
      assignedTotal: 1,
      reportedTotal: 1,
      recentTotal: 1,
    });

    const list = await app.inject({ method: "GET", url: "/api/v1/jira/issues?scope=reported_by_me&state=all&search=部署", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ issues: [{ key: "AIP-113931" }], total: 1 });
    expect(queries.at(-1)).toMatchObject({ scope: "reported_by_me", state: "all", search: "部署", projectKey: "AIP" });

    const fetched = await app.inject({ method: "GET", url: "/api/v1/jira/issues/AIP-113931", headers });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ key: "AIP-113931", comments: [] });

    const inspectionSource = await app.inject({ method: "GET", url: "/api/v1/jira/issues/AIP-113931/inspection-ai-source", headers });
    expect(inspectionSource.statusCode).toBe(200);
    expect(inspectionSource.json()).toEqual({ source: null, maintainerId: null });

    const attachment = await app.inject({ method: "GET", url: "/api/v1/jira/issues/AIP-113931/attachments/77", headers });
    expect(attachment.statusCode).toBe(200);
    expect(attachment.headers["content-type"]).toContain("text/plain");
    expect(attachment.headers["content-disposition"]).toContain("filename*=UTF-8''");
    expect(attachment.headers["content-disposition"]).toContain(".txt");
    expect(attachment.body).toBe("attachment");

    const board = await app.inject({ method: "GET", url: "/api/v1/jira/board", headers });
    expect(board.statusCode).toBe(200);
    expect(board.json()).toMatchObject({ projectKey: "AIP", columns: [{ id: "review", label: "评审/设计" }, { id: "todo", label: "待办" }, { id: "in_progress", label: "处理中" }, { id: "acceptance", label: "验收中" }, { id: "done", label: "已完成" }] });
    expect(board.json().members).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountUsername: "jira-user", username: "jira-user" }),
      expect.objectContaining({ accountUsername: "unmatched-user", username: "unmatched-user" }),
      expect.objectContaining({ accountUsername: "biao.chen", username: "chenglong.chen", name: "陈彪" }),
      expect.objectContaining({ accountUsername: "hui.dai", username: "hui.zang", name: "臧晖" }),
      expect.objectContaining({ accountUsername: "yun.song", username: "yun.song-cn", name: "宋云" }),
    ]));

    const currentJiraUserBoard = await app.inject({ method: "GET", url: "/api/v1/jira/board?member=jira-user", headers });
    expect(currentJiraUserBoard.statusCode).toBe(200);
    expect(queries.slice(-5).every((query) => query.assignee === "jira-user")).toBe(true);

    const filteredBoard = await app.inject({ method: "GET", url: "/api/v1/jira/board?member=biao.chen", headers });
    expect(filteredBoard.statusCode).toBe(200);
    expect(queries.slice(-5).every((query) => query.assignee === "chenglong.chen")).toBe(true);

    const transitions = await app.inject({ method: "GET", url: "/api/v1/jira/issues/AIP-113931/transitions", headers });
    expect(transitions.statusCode).toBe(200);
    expect(transitions.json()).toEqual({ transitions: [{ id: "11", name: "开始处理", toStatus: "处理中", toStatusId: "3" }] });

    const transitioned = await app.inject({ method: "POST", url: "/api/v1/jira/issues/AIP-113931/transitions", headers, payload: { transitionId: "11" } });
    expect(transitioned.statusCode).toBe(200);
    expect(transitioned.json()).toMatchObject({ key: "AIP-113931", status: "处理中" });

    const comment = await app.inject({ method: "POST", url: "/api/v1/jira/issues/AIP-113931/comments", headers, payload: { body: "请补充验证结果" } });
    expect(comment.statusCode).toBe(201);
    expect(comment.json()).toMatchObject({ comment: { body: "请补充验证结果" } });

    const createOptions = await app.inject({ method: "GET", url: "/api/v1/jira/issues/create-options", headers });
    expect(createOptions.statusCode).toBe(200);
    expect(createOptions.json()).toEqual(createOptionsFixture);

    const supportingOptions = await app.inject({ method: "GET", url: "/api/v1/jira/issues/create-options/supporting", headers });
    expect(supportingOptions.statusCode).toBe(200);
    expect(supportingOptions.json()).toEqual({ assignees: [], components: [], fixVersions: [], labels: [] });

    const componentOptions = await app.inject({ method: "GET", url: "/api/v1/jira/issues/create-options/supporting/components", headers });
    expect(componentOptions.statusCode).toBe(200);
    expect(componentOptions.json()).toEqual({ components: [{ id: "component-1", name: "MLOps" }] });

    const searchedAssignees = await app.inject({ method: "GET", url: "/api/v1/jira/issues/create-options/supporting/assignees?query=%20SongYun%20", headers });
    expect(searchedAssignees.statusCode).toBe(200);
    expect(assigneeQueries.at(-1)).toEqual({ projectKey: "AIP", query: "SongYun" });
    expect((await app.inject({ method: "GET", url: `/api/v1/jira/issues/create-options/supporting/assignees?query=${"a".repeat(257)}`, headers })).statusCode).toBe(400);

    const invalidAttachmentUpload = await app.inject({ method: "POST", url: "/api/v1/jira/issues/AIP-113931/attachments", headers, payload: {} });
    expect(invalidAttachmentUpload.statusCode).toBe(400);
    expect(invalidAttachmentUpload.json()).toMatchObject({ error: "jira_attachment_upload_invalid" });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/jira/issues",
      headers,
      payload: { summary: "完善发布流程的错误提示", issueType: "任务", components: ["MLOps"], fixVersions: ["release-2026"], description: "补充错误提示和验收标准", priority: "重要", assignee: "jira-user", labels: ["frontend"] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ key: "AIP-113932", summary: "完善发布流程的错误提示" });

    const invalidPriority = await app.inject({
      method: "POST",
      url: "/api/v1/jira/issues",
      headers,
      payload: { summary: "不应创建", issueType: "任务", components: ["MLOps"], fixVersions: ["release-2026"], description: "非法优先级不应创建", priority: "docx" },
    });
    expect(invalidPriority.statusCode).toBe(400);
    expect(invalidPriority.json()).toMatchObject({ error: "invalid_jira_create_option" });

    const connection = await app.inject({ method: "GET", url: "/api/v1/jira-connection", headers });
    expect(connection.statusCode).toBe(200);
    expect(connection.headers["cache-control"]).toBe("no-store");
    expect(connection.json()).toEqual({ baseUrl: "https://jira.example.com", apiBaseUrl: "https://jira.example.com/rest/api/2", projectKey: "AIP", username: "jira-user", tokenConfigured: true });

    const deniedReveal = await app.inject({ method: "POST", url: "/api/v1/jira-connection/reveal-token", headers: { authorization: "Bearer wrong-token" } });
    expect(deniedReveal.statusCode).toBe(401);

    const revealedToken = await app.inject({ method: "POST", url: "/api/v1/jira-connection/reveal-token", headers });
    expect(revealedToken.statusCode).toBe(200);
    expect(revealedToken.headers["cache-control"]).toBe("no-store");
    expect(revealedToken.json()).toEqual({ token: "jira-token" });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: config.webOrigin },
      payload: { username: "biao.chen", password: "pilot-password" },
    });
    const productCookie = login.headers["set-cookie"]?.split(";", 1)[0] ?? "";
    const productHeaders = { cookie: productCookie };
    const productAccount = await app.inject({ method: "GET", url: "/api/v1/jira/account", headers: productHeaders });
    expect(productAccount.statusCode).toBe(200);
    expect(productAccount.json()).toEqual({ baseUrl: "https://jira.example.com", apiBaseUrl: "https://jira.example.com/rest/api/2", projectKey: "AIP", username: "chenglong.chen", tokenConfigured: true });
    const ordinaryAiTask = await app.inject({ method: "GET", url: "/api/v1/jira/issues/AIP-113931/ai-task", headers: productHeaders });
    expect(ordinaryAiTask.statusCode).toBe(200);
    expect(ordinaryAiTask.headers["cache-control"]).toBe("private, no-store");
    expect(ordinaryAiTask.json()).toEqual({ task: null });
    const ordinaryAiTaskSummaries = await app.inject({ method: "GET", url: "/api/v1/jira/ai-tasks?keys=AIP-113931,AIP-404", headers: productHeaders });
    expect(ordinaryAiTaskSummaries.statusCode).toBe(200);
    expect(ordinaryAiTaskSummaries.headers["cache-control"]).toBe("private, no-store");
    expect(ordinaryAiTaskSummaries.json()).toEqual({ tasks: [], prechecks: [] });
    const ordinaryAiPrecheck = await app.inject({ method: "GET", url: "/api/v1/jira/issues/AIP-113931/ai-precheck", headers: productHeaders });
    expect(ordinaryAiPrecheck.statusCode).toBe(200);
    expect(ordinaryAiPrecheck.headers["cache-control"]).toBe("private, no-store");
    expect(ordinaryAiPrecheck.json()).toEqual({ status: "idle", precheck: null, projectId: null });
    const productGlobalConnection = await app.inject({ method: "GET", url: "/api/v1/jira-connection", headers: productHeaders });
    expect(productGlobalConnection.statusCode).toBe(403);
    const productOverviewStart = queries.length;
    const productOverview = await app.inject({ method: "GET", url: "/api/v1/jira/overview", headers: productHeaders });
    expect(productOverview.statusCode).toBe(200);
    expect(productOverview.json()).toMatchObject({ user: { username: "chenglong.chen" } });
    expect(queries.slice(productOverviewStart)).toEqual([]);
    expect(personalQueries.slice(0, 3)).toEqual([
      expect.objectContaining({ scope: "assigned_to_me", state: "todo", projectKey: "AIP" }),
      expect.objectContaining({ scope: "reported_by_me", state: "todo", projectKey: "AIP" }),
      expect.objectContaining({ scope: "all", state: "all", projectKey: "AIP" }),
    ]);

    const productIssuesStart = personalQueries.length;
    const productIssues = await app.inject({ method: "GET", url: "/api/v1/jira/issues?scope=assigned_to_me&state=todo&assignee=jiawei.ye01", headers: productHeaders });
    expect(productIssues.statusCode).toBe(200);
    expect(personalQueries[productIssuesStart]).toMatchObject({ scope: "assigned_to_me", assignee: "jiawei.ye01" });

    const huiLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: config.webOrigin },
      payload: { username: "hui.dai", password: "pilot-password" },
    });
    const huiCookie = huiLogin.headers["set-cookie"]?.split(";", 1)[0] ?? "";
    const huiAccount = await app.inject({ method: "GET", url: "/api/v1/jira/account", headers: { cookie: huiCookie } });
    expect(huiAccount.statusCode).toBe(200);
    expect(huiAccount.json()).toMatchObject({ username: "", tokenConfigured: false });
    const huiSave = await app.inject({ method: "PUT", url: "/api/v1/jira/account", headers: { cookie: huiCookie }, payload: { username: "hui.zang", token: "hui-token" } });
    expect(huiSave.statusCode).toBe(200);
    expect(huiSave.json()).toMatchObject({ username: "hui.zang", tokenConfigured: true });
    const huiDelete = await app.inject({ method: "DELETE", url: "/api/v1/jira/account", headers: { cookie: huiCookie } });
    expect(huiDelete.statusCode).toBe(200);
    expect(huiDelete.json()).toMatchObject({ username: "", tokenConfigured: false });
    const huiOverview = await app.inject({ method: "GET", url: "/api/v1/jira/overview", headers: { cookie: huiCookie } });
    expect(huiOverview.statusCode).toBe(428);
    expect(huiOverview.json()).toMatchObject({ error: "jira_account_required" });
    await app.close();
    userStore.close();
  });

  it("requires a configured Jira credential before workbench reads", async () => {
    const store = {
      async read() { return { baseUrl: "https://jira.example.com", apiBaseUrl: "https://jira.example.com/rest/api/2", projectKey: "AIP", username: "jira-user", token: "" }; },
      async write(next: JiraConnection) { return next; },
    };
    const jira: JiraClientPort = {
      async getCurrentUser() { throw new Error("must not call Jira"); },
      async listAssignableUsers() { throw new Error("must not call Jira"); },
      async listProjectComponents() { throw new Error("must not call Jira"); },
      async listProjectVersions() { throw new Error("must not call Jira"); },
      async listLabels() { throw new Error("must not call Jira"); },
      async getCreateIssueOptions() { throw new Error("must not call Jira"); },
      async getCreateIssueSupportingOptions() { throw new Error("must not call Jira"); },
      async getCreateIssueAdvancedOptions() { throw new Error("must not call Jira"); },
      async listIssues() { throw new Error("must not call Jira"); },
      async getIssue() { throw new Error("must not call Jira"); },
      async getAttachment() { throw new Error("must not call Jira"); },
      async getTransitions() { throw new Error("must not call Jira"); },
      async transitionIssue() { throw new Error("must not call Jira"); },
      async addComment() { throw new Error("must not call Jira"); },
      async addAttachments() { throw new Error("must not call Jira"); },
      async createIssue() { throw new Error("must not call Jira"); },
    };
    const app = await buildApp({ config, reviewService: service(), jira, jiraConnectionStore: store });
    const response = await app.inject({ method: "GET", url: "/api/v1/jira/overview", headers: { authorization: "Bearer trigger-token" } });
    expect(response.statusCode).toBe(428);
    expect(response.json()).toMatchObject({ error: "jira_connection_required" });
    await app.close();
  });
});
