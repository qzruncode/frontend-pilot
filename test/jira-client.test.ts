import { describe, expect, it, vi } from "vitest";
import { JiraCreateIssueInputSchema } from "../src/contracts.js";
import { JiraApiError, JiraClient, jiraJqlFor } from "../src/jira-client.js";

const baseConnection = {
  baseUrl: "https://jira.example.com",
  apiBaseUrl: "https://jira.example.com/rest/api/2",
  username: "jira-user",
  token: "jira-secret",
};

describe("JiraClient", () => {
  it("limits synchronization searches to quoted issue keys", () => {
    expect(jiraJqlFor({ scope: "all", state: "all", issueKeys: ["TEST-1", 'TEST-2" OR key != "TEST-3'], page: 1, perPage: 50 }))
      .toBe('key in ("TEST-1", "TEST-2\\" OR key != \\"TEST-3") ORDER BY updated DESC');
  });
  it("requires a non-empty description when creating an issue", () => {
    const result = JiraCreateIssueInputSchema.safeParse({
      summary: "完善发布流程的错误提示",
      issueType: "10001",
      components: ["frontend"],
      fixVersions: ["release-2026"],
      description: "  ",
      labels: [],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe("请填写描述");
  });

  it("requires Jira components and fix versions when creating an issue", () => {
    const result = JiraCreateIssueInputSchema.safeParse({
      summary: "完善发布流程的错误提示",
      issueType: "10001",
      components: [],
      fixVersions: [],
      description: "补充错误提示和验收标准",
      labels: [],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining(["请选择模块", "请选择修复的版本"]));
  });

  it("uses Basic auth and builds bounded JQL for issue lists", async () => {
    const requests: Array<{ url: string; authorization: string | null; contentType: string | null }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      requests.push({
        url: `${url.pathname}${url.search}`,
        authorization: headers.get("authorization"),
        contentType: headers.get("content-type"),
      });
      return new Response(JSON.stringify({
        total: 1,
        issues: [{
          id: "428812",
          key: "AIP-113931",
          fields: {
            summary: "配置部署调整",
            description: "需要调整部署配置",
            status: { id: "6", name: "已关闭", statusCategory: { key: "done" } },
            issuetype: { name: "改进" },
            priority: { name: "重要" },
            project: { key: "AIP", name: "Sophon" },
            assignee: { name: "jiawei.ye01", displayName: "叶家伟" },
            reporter: { name: "jiawei.ye01", displayName: "叶家伟" },
            labels: ["frontend"],
            resolution: { name: "完成" },
            created: "2026-08-13T10:00:00.000+0800",
            updated: "2026-08-19T10:00:00.000+0800",
          },
        }],
      }), { status: 200 });
    });
    const client = new JiraClient({ ...baseConnection, fetchImpl });

    await expect(client.listIssues({ scope: "assigned_to_me", state: "todo", projectKey: "AIP", search: "部署", page: 1, perPage: 25 })).resolves.toMatchObject({
      total: 1,
      issues: [{ key: "AIP-113931", projectKey: "AIP", statusId: "6", assignee: { username: "jiawei.ye01" } }],
    });
    expect(requests[0].authorization).toBe(`Basic ${Buffer.from("jira-user:jira-secret").toString("base64")}`);
    expect(requests[0].contentType).toBe("application/json");
    const query = new URLSearchParams(requests[0].url.split("?", 2)[1]);
    expect(query.get("jql")).toBe("project = AIP AND assignee = currentUser() AND status in (10612, 11206, 1, 11208, 10902, 10101, 10605, 12405, 11003) AND text ~ \"部署\" ORDER BY updated DESC");
    expect(query.get("maxResults")).toBe("25");
  });

  it("reads the Jira users assignable to the configured project", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(`${url.pathname}${url.search}`);
      return new Response(JSON.stringify([
        { name: "jiawei.ye01", displayName: "叶家伟", avatarUrls: { "48x48": "https://jira.invalid/avatar/1" } },
        { displayName: "没有账号的用户" },
      ]), { status: 200 });
    });
    const client = new JiraClient({ ...baseConnection, fetchImpl });

    await expect(client.listAssignableUsers("AIP")).resolves.toEqual([{ username: "jiawei.ye01", name: "叶家伟", avatarUrl: "https://jira.invalid/avatar/1" }]);
    const query = new URLSearchParams(requests[0].split("?", 2)[1]);
    expect(requests[0]).toContain("/user/assignable/search");
    expect(query.get("project")).toBe("AIP");
    expect(query.get("maxResults")).toBe("300");
  });

  it("passes the author query to Jira when searching assignable users", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(`${url.pathname}${url.search}`);
      return new Response(JSON.stringify([{ name: "ChenDengjian", displayName: "陈登舰" }]), { status: 200 });
    });
    const client = new JiraClient({ ...baseConnection, fetchImpl });

    await expect(client.listAssignableUsers("AIP", "dengjian.chen")).resolves.toEqual([
      { username: "ChenDengjian", name: "陈登舰", avatarUrl: null },
    ]);
    const query = new URLSearchParams(requests[0].split("?", 2)[1]);
    expect(query.get("project")).toBe("AIP");
    expect(query.get("username")).toBe("dengjian.chen");
  });

  it("preserves identity email and excludes inactive assignable search results", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { name: "owner", displayName: "负责人", emailAddress: "owner@example.com", active: true },
      { name: "former-owner", displayName: "已停用人员", active: false },
    ]), { status: 200 }));
    const client = new JiraClient({ ...baseConnection, fetchImpl });
    await expect(client.listAssignableUsers("AIP", "owner")).resolves.toEqual([
      { username: "owner", name: "负责人", email: "owner@example.com", avatarUrl: null },
    ]);
  });

  it("reads project-aware options for the create issue form", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/myself")) {
        return new Response(JSON.stringify({ name: "jiawei.ye01", displayName: "叶家伟" }), { status: 200 });
      }
      if (url.pathname.endsWith("/issue/createmeta")) {
        return new Response(JSON.stringify({ projects: [{ key: "AIP", issuetypes: [
          { id: "10001", name: "任务", fields: { priority: { required: true, allowedValues: [{ id: "3", name: "重要" }, { id: "4", name: "次要" }] } } },
          { id: "10002", name: "任务", fields: { priority: { required: true, allowedValues: [{ id: "3", name: "重要" }] } } },
          { id: "10003", name: "故障", fields: { priority: { required: true, allowedValues: [{ id: "3", name: "重要" }, { id: "5", name: "重要" }] }, customfield_10907: { allowedValues: [{ id: "11417", value: "过程" }] } } },
        ] }] }), { status: 200 });
      }
      if (url.pathname.endsWith("/user/assignable/search")) {
        return new Response(JSON.stringify([{ name: "jiawei.ye01", displayName: "叶家伟" }]), { status: 200 });
      }
      if (url.pathname.endsWith("/project/AIP/components")) {
        return new Response(JSON.stringify([{ id: "10", name: "frontend" }]), { status: 200 });
      }
      if (url.pathname.endsWith("/project/AIP/versions")) {
        return new Response(JSON.stringify([{ id: "20", name: "release-2026", released: false, archived: false }]), { status: 200 });
      }
      if (url.pathname.endsWith("/field")) {
        return new Response(JSON.stringify([
          { id: "customfield_10566", name: "Customer Name" },
          { id: "customfield_10007", name: "Epic Link" },
          { id: "customfield_10006", name: "Sprint" },
        ]), { status: 200 });
      }
      expect(url.pathname).toBe("/rest/api/2/search");
      const jql = url.searchParams.get("jql") ?? "";
      if (jql.includes("labels is not EMPTY")) return new Response(JSON.stringify({ issues: [{ id: "1", key: "AIP-1", fields: { labels: ["frontend", "release"] } }] }), { status: 200 });
      if (jql.includes("customfield_10566")) return new Response(JSON.stringify({ issues: [{ id: "2", key: "AIP-2", fields: { customfield_10566: ["客户A"] } }] }), { status: 200 });
      if (jql.includes("customfield_10006")) return new Response(JSON.stringify({ issues: [{ id: "3", key: "AIP-3", fields: { customfield_10006: [{ id: 42, name: "Sprint 42" }] } }] }), { status: 200 });
      const summary = jql.includes("issuetype = Epic") ? "Epic issue" : "Link issue";
      return new Response(JSON.stringify({ issues: [{ id: "4", key: "AIP-4", fields: { summary } }] }), { status: 200 });
    });
    const client = new JiraClient({ ...baseConnection, fetchImpl });

    await expect(client.getCreateIssueOptions("AIP")).resolves.toEqual({
      issueTypes: [{ id: "10001", name: "任务" }, { id: "10003", name: "故障" }],
      priorities: [{ id: "3", name: "重要" }, { id: "4", name: "次要" }, { id: "5", name: "重要" }],
      priorityRequired: true,
      assignees: [],
      reporters: [{ username: "jiawei.ye01", name: "叶家伟", avatarUrl: null }],
      currentUser: { username: "jiawei.ye01", name: "叶家伟", avatarUrl: null },
      components: [],
      fixVersions: [],
      customers: [],
      epics: [],
      sprints: [],
      linkableIssues: [],
      customFieldIds: { customerName: null, epicLink: null, sprint: null },
      labels: [],
    });
    expect(requests).toHaveLength(2);
    const metadataQuery = new URLSearchParams(requests.find((request) => request.includes("createmeta"))?.split("?", 2)[1]);
    expect(metadataQuery.get("projectKeys")).toBe("AIP");
    expect(metadataQuery.get("expand")).toBe("projects.issuetypes.fields");
    expect(requests.some((request) => request.endsWith("/priority"))).toBe(false);

    await expect(client.getCreateIssueOptions("AIP", "10003")).resolves.toMatchObject({
      priorities: [{ id: "3", name: "重要" }, { id: "5", name: "重要" }],
      priorityRequired: true,
    });
    expect(requests).toHaveLength(4);

    await expect(client.getCreateIssueSupportingOptions("AIP")).resolves.toEqual({
      assignees: [{ username: "jiawei.ye01", name: "叶家伟", avatarUrl: null }],
      components: [{ id: "10", name: "frontend" }],
      fixVersions: [{ id: "20", name: "release-2026" }],
      labels: ["frontend", "release"],
    });
    expect(requests).toHaveLength(8);
    const labelQuery = new URLSearchParams(requests.find((request) => request.endsWith("/search?jql=project+%3D+AIP+AND+labels+is+not+EMPTY+ORDER+BY+updated+DESC&startAt=0&maxResults=300&fields=labels&validateQuery=true"))?.split("?", 2)[1]);
    expect(labelQuery.get("maxResults")).toBe("300");
    expect(labelQuery.get("fields")).toBe("labels");
  });

  it("builds explicit assignee and reporter filters for product-account queries", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(`${url.pathname}${url.search}`);
      return new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 });
    });
    const client = new JiraClient({ ...baseConnection, fetchImpl });

    await client.listIssues({ scope: "all", state: "all", projectKey: "AIP", assignee: "chenglong.chen", page: 1, perPage: 25 });
    await client.listIssues({ scope: "all", state: "all", projectKey: "AIP", reporter: "chenglong.chen", page: 1, perPage: 25 });

    expect(new URLSearchParams(requests[0].split("?", 2)[1]).get("jql")).toBe("project = AIP AND assignee = \"chenglong.chen\" ORDER BY updated DESC");
    expect(new URLSearchParams(requests[1].split("?", 2)[1]).get("jql")).toBe("project = AIP AND reporter = \"chenglong.chen\" ORDER BY updated DESC");
  });

  it("falls back to the Jira OIDC login session when REST Basic auth is challenged", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null; cookie: string | null; body: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      requests.push({
        url: `${url.origin}${url.pathname}`,
        method: init?.method || "GET",
        authorization: headers.get("authorization"),
        cookie: headers.get("cookie"),
        body: String(init?.body ?? ""),
      });
      if (url.pathname === "/rest/api/2/myself") {
        if (headers.get("cookie")?.includes("JSESSIONID=oidc-session")) {
          return new Response(JSON.stringify({ name: "oidc-user", displayName: "OIDC User" }), { status: 200 });
        }
        return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "OAuth realm=\"jira\"" } });
      }
      if (url.pathname === "/login.jsp") {
        return new Response(null, { status: 302, headers: { location: "/plugins/servlet/oidc/login;jsessionid=initial", "set-cookie": "JSESSIONID=initial; Path=/" } });
      }
      if (url.hostname === "jira.example.com" && url.pathname.startsWith("/plugins/servlet/oidc/login")) {
        return new Response(null, { status: 302, headers: { location: "https://sso.example.com/auth/realms/example/protocol/openid-connect/auth?state=state" } });
      }
      if (url.hostname === "sso.example.com" && url.pathname === "/auth/realms/example/protocol/openid-connect/auth") {
        return new Response('<form action="/auth/realms/example/login-actions/authenticate?execution=x&amp;client_id=jira" method="post"><input type="hidden" name="execution" value="x"><input name="username"><input type="password" name="password"><input type="submit" name="login" value="Sign In"></form>', { status: 200 });
      }
      if (url.hostname === "sso.example.com" && url.pathname === "/auth/realms/example/login-actions/authenticate") {
        return new Response(null, { status: 302, headers: { location: "https://jira.example.com/plugins/servlet/oidc/auth?code=code" } });
      }
      if (url.hostname === "jira.example.com" && url.pathname === "/plugins/servlet/oidc/auth") {
        return new Response(null, { status: 302, headers: { location: "/", "set-cookie": "JSESSIONID=oidc-session; Path=/" } });
      }
      if (url.hostname === "jira.example.com" && url.pathname === "/") return new Response("ok", { status: 200 });
      throw new Error(`Unexpected Jira OIDC request: ${url.toString()}`);
    });
    const client = new JiraClient({ ...baseConnection, fetchImpl });

    await expect(client.getCurrentUser()).resolves.toMatchObject({ username: "oidc-user", name: "OIDC User" });
    const loginRequest = requests.find((request) => request.url.includes("login-actions/authenticate"));
    const loginForm = new URLSearchParams(loginRequest?.body);
    expect(loginForm.get("username")).toBe("jira-user");
    expect(loginForm.get("password")).toBe("jira-secret");
    expect(requests.filter((request) => request.url.endsWith("/rest/api/2/myself"))).toEqual([
      expect.objectContaining({ authorization: `Basic ${Buffer.from("jira-user:jira-secret").toString("base64")}` }),
      expect.objectContaining({ authorization: "Bearer jira-secret" }),
      expect.objectContaining({ authorization: null, cookie: expect.stringContaining("JSESSIONID=oidc-session") }),
    ]);
  });

  it("falls back from an email login name to its Jira account name", async () => {
    const loginUsernames: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.pathname === "/rest/api/2/myself") {
        if (headers.get("cookie")?.includes("JSESSIONID=oidc-session")) {
          return new Response(JSON.stringify({ name: "oidc-user", displayName: "OIDC User" }), { status: 200 });
        }
        return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "OAuth realm=\"jira\"" } });
      }
      if (url.pathname === "/login.jsp") {
        return new Response(null, { status: 302, headers: { location: "/plugins/servlet/oidc/login;jsessionid=initial", "set-cookie": "JSESSIONID=initial; Path=/" } });
      }
      if (url.hostname === "jira.example.com" && url.pathname.startsWith("/plugins/servlet/oidc/login")) {
        return new Response(null, { status: 302, headers: { location: "https://sso.example.com/auth/realms/example/protocol/openid-connect/auth?state=state" } });
      }
      if (url.hostname === "sso.example.com" && url.pathname === "/auth/realms/example/protocol/openid-connect/auth") {
        return new Response('<form action="/auth/realms/example/login-actions/authenticate?execution=x&amp;client_id=jira" method="post"><input type="hidden" name="execution" value="x"><input name="username"><input type="password" name="password"><input type="submit" name="login" value="Sign In"></form>', { status: 200 });
      }
      if (url.hostname === "sso.example.com" && url.pathname === "/auth/realms/example/login-actions/authenticate") {
        const username = new URLSearchParams(String(init?.body ?? "")).get("username") ?? "";
        loginUsernames.push(username);
        const code = username === "jira-user@example.com" ? "email-code" : "account-code";
        return new Response(null, { status: 302, headers: { location: `https://jira.example.com/plugins/servlet/oidc/auth?code=${code}` } });
      }
      if (url.hostname === "jira.example.com" && url.pathname === "/plugins/servlet/oidc/auth") {
        const session = url.searchParams.get("code") === "email-code" ? "email-session" : "oidc-session";
        return new Response(null, { status: 302, headers: { location: "/", "set-cookie": `JSESSIONID=${session}; Path=/` } });
      }
      if (url.hostname === "jira.example.com" && url.pathname === "/") return new Response("ok", { status: 200 });
      throw new Error(`Unexpected Jira OIDC request: ${url.toString()}`);
    });
    const client = new JiraClient({ ...baseConnection, username: "jira-user@example.com", fetchImpl });

    await expect(client.getCurrentUser()).resolves.toMatchObject({ username: "oidc-user", name: "OIDC User" });
    expect(loginUsernames).toEqual(["jira-user@example.com", "jira-user"]);
  });

  it("uses Jira REST session login before the SSO redirect", async () => {
    const requests: Array<{ path: string; method: string; username?: string; cookie: string | null }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const request: { path: string; method: string; username?: string; cookie: string | null } = {
        path: url.pathname,
        method: init?.method ?? "GET",
        cookie: headers.get("cookie"),
      };
      if (url.pathname === "/rest/api/2/myself") {
        requests.push(request);
        if (headers.get("cookie")?.includes("JSESSIONID=rest-session")) {
          return new Response(JSON.stringify({ name: "rest-user", displayName: "REST User" }), { status: 200 });
        }
        return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "OAuth realm=\"jira\"" } });
      }
      if (url.pathname === "/rest/auth/1/session") {
        request.username = JSON.parse(String(init?.body ?? "{}")).username;
        requests.push(request);
        if (request.username === "jira-user") {
          return new Response("{}", { status: 200, headers: { "set-cookie": "JSESSIONID=rest-session; Path=/" } });
        }
        return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "OAuth realm=\"jira\"" } });
      }
      throw new Error(`Unexpected Jira REST request: ${url.toString()}`);
    });
    const client = new JiraClient({ ...baseConnection, username: "jira-user@example.com", fetchImpl });

    await expect(client.getCurrentUser()).resolves.toMatchObject({ username: "rest-user", name: "REST User" });
    expect(requests).toEqual([
      { path: "/rest/api/2/myself", method: "GET", cookie: null },
      { path: "/rest/api/2/myself", method: "GET", cookie: null },
      { path: "/rest/auth/1/session", method: "POST", username: "jira-user@example.com", cookie: null },
      { path: "/rest/auth/1/session", method: "POST", username: "jira-user", cookie: null },
      { path: "/rest/api/2/myself", method: "GET", cookie: "JSESSIONID=rest-session" },
    ]);
  });

  it("accepts a raw Jira personal access token after the Basic auth challenge", async () => {
    const requests: Array<{ authorization: string | null; cookie: string | null }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.pathname !== "/rest/api/2/myself") throw new Error(`Unexpected Jira request: ${url.toString()}`);
      requests.push({ authorization: headers.get("authorization"), cookie: headers.get("cookie") });
      if (headers.get("authorization") === "Bearer jira-pat") {
        return new Response(JSON.stringify({ name: "pat-user", displayName: "PAT User" }), { status: 200 });
      }
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "OAuth realm=\"jira\"" } });
    });
    const client = new JiraClient({ ...baseConnection, token: "jira-pat", fetchImpl });

    await expect(client.getCurrentUser()).resolves.toMatchObject({ username: "pat-user", name: "PAT User" });
    expect(requests).toEqual([
      { authorization: `Basic ${Buffer.from("jira-user:jira-pat").toString("base64")}`, cookie: null },
      { authorization: "Bearer jira-pat", cookie: null },
    ]);
  });

  it("honors an explicitly prefixed Jira bearer token even when a username is supplied", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push(headers.get("authorization") ?? "");
      return new Response(JSON.stringify({ name: "pat-user", displayName: "PAT User" }), { status: 200 });
    });
    const client = new JiraClient({ ...baseConnection, token: "Bearer jira-pat", fetchImpl });

    await expect(client.getCurrentUser()).resolves.toMatchObject({ username: "pat-user", name: "PAT User" });
    expect(requests).toEqual(["Bearer jira-pat"]);
  });

  it("normalizes issue detail comments and publishes a comment", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/comment")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ body: "请补充验证结果" });
        return new Response(JSON.stringify({ id: "99", body: "请补充验证结果", author: { name: "jira-user", displayName: "Jira User" }, created: "2026-08-20T01:00:00Z" }), { status: 201 });
      }
      return new Response(JSON.stringify({
        id: "428812",
        key: "AIP-113931",
        fields: {
          summary: "配置部署调整",
          status: { id: "3", name: "进行中", statusCategory: { key: "indeterminate" } },
          issuetype: { name: "任务" },
          project: { key: "AIP", name: "Sophon" },
          attachment: [{ id: 77, filename: "部署截图.png", content: "/secure/attachment/77/deploy.png", mimeType: "image/png", size: 2048, created: "2026-08-19T02:00:00Z", author: { name: "reviewer", displayName: "Reviewer" } }],
          comment: { comments: [{ id: "11", body: "先看部署日志", author: { name: "reviewer", displayName: "Reviewer" }, created: "2026-08-19T01:00:00Z" }] },
        },
      }), { status: 200 });
    });
    const client = new JiraClient({ ...baseConnection, fetchImpl });

    await expect(client.getIssue("AIP-113931")).resolves.toMatchObject({
      key: "AIP-113931",
      statusId: "3",
      comments: [{ id: "11", body: "先看部署日志" }],
      attachments: [{ id: "77", filename: "部署截图.png", url: "https://jira.example.com/secure/attachment/77/deploy.png", mimeType: "image/png", size: 2048 }],
    });
    await expect(client.addComment("AIP-113931", "请补充验证结果")).resolves.toMatchObject({ id: "99", body: "请补充验证结果" });
  });

  it("creates an issue with the configured project and refreshes its detail", async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      requests.push({ method, url: `${url.pathname}${url.search}`, body: String(init?.body ?? "") });
      if (method === "POST" && url.pathname === "/rest/api/2/issue") {
        return new Response(JSON.stringify({ id: "428813", key: "AIP-113932", self: "https://jira.example.com/rest/api/2/issue/428813" }), { status: 201 });
      }
      if (method === "POST" && url.pathname === "/rest/api/2/issuelink") {
        return new Response(null, { status: 204 });
      }
      expect(method).toBe("GET");
      expect(url.pathname).toBe("/rest/api/2/issue/AIP-113932");
      return new Response(JSON.stringify({
        id: "428813",
        key: "AIP-113932",
        fields: {
          summary: "完善发布流程的错误提示",
          description: "补充错误提示和验收标准",
          status: { id: "1", name: "待办", statusCategory: { key: "new" } },
          issuetype: { name: "任务" },
          priority: { name: "重要" },
          project: { key: "AIP", name: "Sophon" },
          assignee: { name: "jiawei.ye01", displayName: "叶家伟" },
          labels: ["frontend", "release"],
        },
      }), { status: 200 });
    });
    const client = new JiraClient({ ...baseConnection, fetchImpl });

    await expect(client.createIssue("AIP", {
      summary: "完善发布流程的错误提示",
      issueType: "10001",
      dueDate: "2026-09-01",
      components: ["frontend"],
      fixVersions: ["release-2026"],
      description: "补充错误提示和验收标准",
      priority: "3",
      assignee: "jiawei.ye01",
      reporter: "reviewer.01",
      environment: "生产环境",
      originalEstimate: "3h",
      remainingEstimate: "2h",
      linkedIssueType: "blocks",
      linkedIssueKey: "AIP-113931",
      customFields: { customfield_10566: "客户A", customfield_10007: "AIP-123" },
      labels: ["frontend", "release"],
    })).resolves.toMatchObject({ key: "AIP-113932", summary: "完善发布流程的错误提示", labels: ["frontend", "release"] });
    expect(JSON.parse(requests[0].body)).toEqual({ fields: {
      project: { key: "AIP" },
      issuetype: { id: "10001" },
      summary: "完善发布流程的错误提示",
      duedate: "2026-09-01",
      components: [{ name: "frontend" }],
      fixVersions: [{ name: "release-2026" }],
      description: "补充错误提示和验收标准",
      priority: { id: "3" },
      assignee: { name: "jiawei.ye01" },
      reporter: { name: "reviewer.01" },
      environment: "生产环境",
      timetracking: { originalEstimate: "3h", remainingEstimate: "2h" },
      customfield_10566: "客户A",
      customfield_10007: "AIP-123",
      labels: ["frontend", "release"],
    } });
    expect(JSON.parse(requests[1].body)).toEqual({
      type: { name: "blocks" },
      inwardIssue: { key: "AIP-113931" },
      outwardIssue: { key: "AIP-113932" },
    });
  });

  it("reads Jira transitions and returns the refreshed issue after a transition", async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      requests.push({ method, url: `${url.pathname}${url.search}`, body: String(init?.body ?? "") });
      if (url.pathname.endsWith("/transitions") && method === "GET") {
        return new Response(JSON.stringify({ transitions: [
          { id: 111, name: "CLOSED", to: { id: "6", name: "已关闭", statusCategory: { key: "done" } } },
          { id: 11, name: "开始分析", to: { id: "10613", name: "待评审", statusCategory: { key: "new" } } },
        ] }), { status: 200 });
      }
      if (url.pathname.endsWith("/transitions") && method === "POST") {
        expect(JSON.parse(String(init?.body))).toEqual({ transition: { id: "11" } });
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ id: "428812", key: "AIP-113931", fields: { summary: "配置部署调整", status: { name: "处理中", statusCategory: { key: "indeterminate" } }, issuetype: { name: "任务" }, project: { key: "AIP", name: "Sophon" } } }), { status: 200 });
    });
    const client = new JiraClient({ ...baseConnection, fetchImpl });

    await expect(client.getTransitions("AIP-113931")).resolves.toEqual([
      { id: "111", name: "CLOSED", toStatus: "已关闭", toStatusId: "6" },
      { id: "11", name: "开始分析", toStatus: "待评审", toStatusId: "10613" },
    ]);
    await expect(client.transitionIssue("AIP-113931", "11")).resolves.toMatchObject({ key: "AIP-113931", status: "处理中" });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("uploads issue attachments as Jira multipart data", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/rest/api/2/issue/AIP-113931/attachments");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-atlassian-token")).toBe("no-check");
      expect(headers.get("content-type")).toBeNull();
      expect(init?.body).toBeInstanceOf(FormData);
      const entries = Array.from((init?.body as FormData).entries());
      expect(entries).toHaveLength(1);
      expect(entries[0]?.[0]).toBe("file");
      expect(entries[0]?.[1]).toMatchObject({ name: "截图.png", type: "image/png" });
      return new Response("[]", { status: 200 });
    });
    const client = new JiraClient({ ...baseConnection, fetchImpl });

    await expect(client.addAttachments("AIP-113931", [{ filename: "截图.png", mimeType: "image/png", data: Buffer.from("image-data") }])).resolves.toBeUndefined();
  });

  it("downloads an issue attachment through the authenticated Jira origin", async () => {
    const requests: Array<{ url: string; authorization: string | null; range: string | null }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      requests.push({ url: url.toString(), authorization: headers.get("authorization"), range: headers.get("range") });
      if (url.pathname.startsWith("/rest/api/2/issue/")) {
        return new Response(JSON.stringify({
          id: "428812",
          key: "AIP-113931",
          fields: {
            summary: "配置部署调整",
            status: { name: "处理中", statusCategory: { key: "indeterminate" } },
            issuetype: { name: "任务" },
            project: { key: "AIP", name: "Sophon" },
            attachment: [{ id: 77, filename: "视频.mp4", content: "/secure/attachment/77/video.mp4", mimeType: "video/mp4", size: 10 }],
          },
        }), { status: 200 });
      }
      expect(url.pathname).toBe("/secure/attachment/77/video.mp4");
      return new Response("video-data", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-9/10", "accept-ranges": "bytes" } });
    });
    const client = new JiraClient({ ...baseConnection, fetchImpl });

    const download = await client.getAttachment("AIP-113931", "77", "bytes=0-9");
    expect(download.attachment.filename).toBe("视频.mp4");
    expect(download.response.status).toBe(206);
    expect(await download.response.text()).toBe("video-data");
    expect(requests.at(-1)).toMatchObject({ authorization: `Basic ${Buffer.from("jira-user:jira-secret").toString("base64")}`, range: "bytes=0-9" });
  });

  it("rejects malformed successful responses", async () => {
    const client = new JiraClient({ ...baseConnection, fetchImpl: vi.fn(async () => new Response(JSON.stringify({ name: 42 }), { status: 200 })) });
    await expect(client.getCurrentUser()).rejects.toMatchObject({ name: "JiraApiError", status: 200, message: "Jira API returned an invalid response" } satisfies Partial<JiraApiError>);
  });

  it("preserves Jira's authentication challenge on rejected requests", async () => {
    const client = new JiraClient({
      ...baseConnection,
      fetchImpl: vi.fn(async () => new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "OAuth realm=\"https%3A%2F%2Fjira.example.com\"" },
      })),
    });
    await expect(client.getCurrentUser()).rejects.toMatchObject({
      name: "JiraApiError",
      status: 401,
      authChallenge: "OAuth realm=\"https%3A%2F%2Fjira.example.com\"",
    } satisfies Partial<JiraApiError>);
  });

  it("does not duplicate ORDER BY when no filters are present", () => {
    expect(jiraJqlFor({ scope: "all", state: "all", page: 1, perPage: 25 })).toBe("ORDER BY updated DESC");
  });

  it("maps the Jira workflow status filters to JQL", () => {
    expect(jiraJqlFor({ scope: "all", state: "review", page: 1, perPage: 25 })).toBe("status in (11203, 10613, 11205, 10611, 11202, 11207, 12202, 12102, 12201, 12002, 11018, 10802, 12406) ORDER BY updated DESC");
    expect(jiraJqlFor({ scope: "all", state: "todo", page: 1, perPage: 25 })).toBe("status in (10612, 11206, 1, 11208, 10902, 10101, 10605, 12405, 11003) ORDER BY updated DESC");
    expect(jiraJqlFor({ scope: "all", state: "in_progress", page: 1, perPage: 25 })).toBe("status in (3, 10617, 11301, 11006, 11211, 11501, 10701) ORDER BY updated DESC");
    expect(jiraJqlFor({ scope: "all", state: "acceptance", page: 1, perPage: 25 })).toBe("status in (11201, 10002, 10001, 12302, 12013, 11218, 12206, 12203) ORDER BY updated DESC");
    expect(jiraJqlFor({ scope: "all", state: "done", page: 1, perPage: 25 })).toBe("status in (10608, 6, 5, 11801, 10102, 12006, 11601, 11011, 11204, 11212) ORDER BY updated DESC");
  });

  it("searches an exact issue key instead of only full text", () => {
    expect(jiraJqlFor({ scope: "all", state: "all", projectKey: "AIP", search: "AIP-113931", page: 1, perPage: 25 }))
      .toBe('project = AIP AND key = "AIP-113931" ORDER BY updated DESC');
  });

  it("filters a board column by a selected Jira assignee", () => {
    expect(jiraJqlFor({ scope: "all", state: "todo", assignee: "jiawei.ye01", page: 1, perPage: 15 }))
      .toBe('assignee = "jiawei.ye01" AND status in (10612, 11206, 1, 11208, 10902, 10101, 10605, 12405, 11003) ORDER BY updated DESC');
  });
});
