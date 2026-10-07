import { createSign, randomBytes } from "node:crypto";
import { z } from "zod";
import { JiraOidcSession } from "./jira-oidc.js";
import type { JiraIssueAttachmentInput } from "./jira-attachment-upload.js";
import {
  JIRA_BOARD_STATUS_IDS,
  type JiraCreateIssueInput,
  type JiraCreateIssueAdvancedOptions,
  type JiraCreateIssueCustomFieldIds,
  type JiraCreateIssueOption,
  type JiraCreateIssueOptions,
  type JiraCreateIssueSupportingOptions,
} from "./contracts.js";
import {
  normalizeJiraComment,
  normalizeJiraAttachment,
  normalizeJiraIssue,
  normalizeJiraTransition,
  normalizeJiraUser,
  RawJiraCommentSchema,
  RawJiraIssueResponseSchema,
  RawJiraSearchResponseSchema,
  RawJiraTransitionsResponseSchema,
  RawJiraUserResponseSchema,
  type JiraIdentity,
  type JiraIssueComment,
  type JiraIssueDetails,
  type JiraIssueListQuery,
  type JiraIssuePage,
  type JiraIssueSummary,
  type JiraIssueTransition,
} from "./jira-workbench.js";

const JiraCommentResponseSchema = RawJiraCommentSchema;
const EmptyJiraResponseSchema = z.union([z.null(), z.object({}).passthrough()]);
const RawCreatedJiraIssueSchema = z.object({
  id: z.union([z.string().trim().min(1), z.number().int()]),
  key: z.string().trim().min(1),
}).passthrough();
const RawJiraNamedOptionSchema = z.object({
  id: z.union([z.string().trim().min(1), z.number().int()]),
  name: z.string().trim().min(1),
}).passthrough();
const RawJiraVersionSchema = RawJiraNamedOptionSchema.extend({
  archived: z.boolean().optional(),
  released: z.boolean().optional(),
});
const RawJiraCreateMetaFieldSchema = z.object({
  required: z.boolean().optional(),
  allowedValues: z.array(z.unknown()).nullable().optional(),
}).passthrough();
const RawJiraCreateMetaIssueTypeSchema = z.object({
  id: z.union([z.string().trim().min(1), z.number().int()]),
  name: z.string().trim().min(1),
  fields: z.record(z.string(), RawJiraCreateMetaFieldSchema).optional(),
}).passthrough();
const RawJiraFieldSchema = z.object({
  id: z.string().trim().regex(/^customfield_\d+$/),
  name: z.string().trim().min(1),
}).passthrough();
const RawJiraCreateMetaResponseSchema = z.object({
  projects: z.array(z.object({
    key: z.string().trim().optional(),
    issuetypes: z.array(RawJiraCreateMetaIssueTypeSchema).optional(),
  }).passthrough()),
}).passthrough();
const JiraIssueFields = ["summary", "description", "status", "issuetype", "priority", "project", "assignee", "reporter", "labels", "created", "updated", "resolution", "comment", "attachment"].join(",");
const CREATE_OPTION_REQUEST_DEADLINE_MS = 3_500;

export interface JiraClientPort {
  getCurrentUser(): Promise<JiraIdentity>;
  /** Omit username to list all assignable users; provide it to search Jira users. */
  listAssignableUsers(projectKey: string, username?: string): Promise<JiraIdentity[]>;
  listProjectComponents(projectKey: string): Promise<JiraCreateIssueOption[]>;
  listProjectVersions(projectKey: string): Promise<JiraCreateIssueOption[]>;
  listLabels(projectKey: string): Promise<string[]>;
  getCreateIssueOptions(projectKey: string, issueTypeId?: string): Promise<JiraCreateIssueOptions>;
  getCreateIssueSupportingOptions(projectKey: string): Promise<JiraCreateIssueSupportingOptions>;
  getCreateIssueAdvancedOptions(projectKey: string): Promise<JiraCreateIssueAdvancedOptions>;
  listIssues(query: JiraIssueListQuery): Promise<JiraIssuePage>;
  getIssue(key: string): Promise<JiraIssueDetails>;
  getAttachment(issueKey: string, attachmentId: string, range?: string): Promise<JiraAttachmentDownload>;
  getTransitions(key: string): Promise<JiraIssueTransition[]>;
  transitionIssue(key: string, transitionId: string): Promise<JiraIssueDetails>;
  addComment(key: string, body: string): Promise<JiraIssueComment>;
  addAttachments(key: string, attachments: JiraIssueAttachmentInput[]): Promise<void>;
  createIssue(projectKey: string, input: JiraCreateIssueInput): Promise<JiraIssueDetails>;
}

export class JiraCreateOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraCreateOptionError";
  }
}

function findJiraCreateOption(options: JiraCreateIssueOption[], value: string): JiraCreateIssueOption | undefined {
  const normalized = value.trim();
  return options.find((option) => option.id === normalized || option.name === normalized);
}

export async function resolveJiraCreateIssueInput(
  jira: Pick<JiraClientPort, "getCreateIssueOptions">,
  projectKey: string,
  input: JiraCreateIssueInput,
): Promise<JiraCreateIssueInput> {
  const options = await jira.getCreateIssueOptions(projectKey);
  const issueType = findJiraCreateOption(options.issueTypes, input.issueType);
  if (!issueType) {
    throw new JiraCreateOptionError(`Jira 当前项目不存在问题类型“${input.issueType}”。`);
  }

  const issueTypeOptions = await jira.getCreateIssueOptions(projectKey, issueType.id);
  if (issueTypeOptions.priorityRequired && !input.priority) {
    throw new JiraCreateOptionError(`Jira 问题类型“${issueType.name}”要求设置优先级。`);
  }
  const priority = input.priority ? findJiraCreateOption(issueTypeOptions.priorities, input.priority) : undefined;
  if (input.priority && !priority) {
    const available = issueTypeOptions.priorities.map((option) => option.name).join("、") || "无";
    throw new JiraCreateOptionError(`Jira 问题类型“${issueType.name}”不允许优先级“${input.priority}”；当前可选：${available}。`);
  }

  return {
    ...input,
    issueType: issueType.id,
    priority: priority?.id,
  };
}

export interface JiraOAuthCredentials {
  consumerKey: string;
  privateKey: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface JiraAttachmentDownload {
  response: Response;
  attachment: JiraIssueDetails["attachments"][number];
}

export class JiraApiError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  readonly authChallenge?: string;

  constructor(message: string, { status, body, authChallenge }: { status?: number; body?: unknown; authChallenge?: string } = {}) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
    this.body = body;
    this.authChallenge = authChallenge;
  }
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function createJiraOAuthHeader(method: string, requestUrl: string, parameters: Record<string, string>, privateKey: string): string {
  const url = new URL(requestUrl);
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams) pairs.push([name, value]);
  for (const [name, value] of Object.entries(parameters)) pairs.push([name, value]);
  const normalizedParameters = pairs
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const normalizedUrl = `${url.origin}${url.pathname}`;
  const signatureBase = [method.toUpperCase(), rfc3986(normalizedUrl), rfc3986(normalizedParameters)].join("&");
  const signer = createSign("RSA-SHA1");
  signer.update(signatureBase);
  const signature = signer.sign(privateKey.replace(/\\n/g, "\n"), "base64");
  const headerParameters = { ...parameters, oauth_signature: signature };
  return `OAuth ${Object.entries(headerParameters).map(([name, value]) => `${rfc3986(name)}="${rfc3986(value)}"`).join(", ")}`;
}

function escapeJqlText(value: string): string {
  return value.replace(/[\\"\r\n]/g, (match) => `\\${match}`);
}

function jiraOptionField(value: string): { id: string } | { name: string } {
  return /^\d+$/.test(value) ? { id: value } : { name: value };
}

function projectClause(projectKey: string | undefined): string | null {
  const normalized = projectKey?.trim();
  return normalized ? `project = ${normalized}` : null;
}

function statusClause(state: JiraIssueListQuery["state"]): string | null {
  const statusIds = state === "all" ? undefined : JIRA_BOARD_STATUS_IDS[state];
  return statusIds ? `status in (${statusIds.join(", ")})` : null;
}

function jqlFor(query: JiraIssueListQuery): string {
  const clauses = [projectClause(query.projectKey)];
  if (query.issueKeys?.length) clauses.push(`key in (${query.issueKeys.map((key) => `"${escapeJqlText(key)}"`).join(", ")})`);
  if (query.scope === "assigned_to_me") clauses.push("assignee = currentUser()");
  if (query.scope === "reported_by_me") clauses.push("reporter = currentUser()");
  if (query.assignee?.trim()) clauses.push(`assignee = "${escapeJqlText(query.assignee.trim())}"`);
  if (query.reporter?.trim()) clauses.push(`reporter = "${escapeJqlText(query.reporter.trim())}"`);
  const status = statusClause(query.state);
  if (status) clauses.push(status);
  const search = query.search?.trim();
  if (search) {
    const escapedSearch = escapeJqlText(search);
    clauses.push(/^[A-Za-z][A-Za-z0-9_]{0,63}-\d+$/.test(search) ? `key = "${escapedSearch}"` : `text ~ "${escapedSearch}"`);
  }
  const where = clauses.filter((value): value is string => Boolean(value)).join(" AND ");
  return `${where ? `${where} ` : ""}ORDER BY updated DESC`;
}

function normalizeJiraNamedOptions(options: Array<{ id: string | number; name: string }>): JiraCreateIssueOption[] {
  const names = new Set<string>();
  return options.flatMap((option) => {
    const id = String(option.id).trim();
    const name = option.name.trim();
    if (!id || !name || names.has(name)) return [];
    names.add(name);
    return [{ id, name }];
  });
}

function normalizeJiraNamedOptionsById(options: Array<{ id: string | number; name: string }>): JiraCreateIssueOption[] {
  const ids = new Set<string>();
  return options.flatMap((option) => {
    const id = String(option.id).trim();
    const name = option.name.trim();
    if (!id || !name || ids.has(id)) return [];
    ids.add(id);
    return [{ id, name }];
  });
}

function normalizeRawJiraNamedOptions(options: unknown[], preserveDuplicateNames = false): JiraCreateIssueOption[] {
  const parsed = options.flatMap((option) => {
    const parsed = RawJiraNamedOptionSchema.safeParse(option);
    return parsed.success ? [parsed.data] : [];
  });
  return preserveDuplicateNames ? normalizeJiraNamedOptionsById(parsed) : normalizeJiraNamedOptions(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withDeadline<T>(promise: Promise<T>, fallback: T, timeoutMs = CREATE_OPTION_REQUEST_DEADLINE_MS): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

function customFieldIds(fields: Array<{ id: string; name: string }>, fallback: JiraCreateIssueCustomFieldIds): JiraCreateIssueCustomFieldIds {
  const find = (name: string, fallbackId: string | null) => fields.find((field) => field.name.toLocaleLowerCase() === name.toLocaleLowerCase())?.id ?? fallbackId;
  return {
    customerName: find("Customer Name", fallback.customerName),
    epicLink: find("Epic Link", fallback.epicLink),
    sprint: find("Sprint", fallback.sprint),
  };
}

function customFieldOptions(value: unknown): JiraCreateIssueOption[] {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text ? [{ id: text, name: text }] : [];
  }
  if (Array.isArray(value)) return value.flatMap(customFieldOptions);
  if (!isRecord(value)) return [];
  const record = value;
  const id = typeof record.id === "string" || typeof record.id === "number" ? String(record.id).trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  return id && name ? [{ id, name }] : name ? [{ id: name, name }] : [];
}

export class JiraClient implements JiraClientPort {
  private baseUrl: string;
  private apiBaseUrl: string;
  private username: string;
  private token: string;
  private readonly oauth?: JiraOAuthCredentials;
  private readonly fetchImpl: typeof fetch;
  private oidcSession: JiraOidcSession;

  constructor({ baseUrl, apiBaseUrl, username = "", token = "", oauth, fetchImpl = fetch }: {
    baseUrl: string;
    apiBaseUrl: string;
    username?: string;
    token?: string;
    oauth?: JiraOAuthCredentials;
    fetchImpl?: typeof fetch;
  }) {
    if (!baseUrl || !apiBaseUrl) throw new Error("Jira 地址和 API 地址不能为空");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.username = username;
    this.token = token;
    this.oauth = oauth;
    this.fetchImpl = fetchImpl;
    this.oidcSession = new JiraOidcSession(this.baseUrl, this.fetchImpl);
  }

  updateConnection({ baseUrl, apiBaseUrl, username, token }: { baseUrl: string; apiBaseUrl: string; username: string; token: string }): void {
    if (!baseUrl || !apiBaseUrl) throw new Error("Jira 地址和 API 地址不能为空");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.username = username;
    this.token = token;
    this.oidcSession.updateBaseUrl(this.baseUrl);
  }

  private async sendRequest(path: string, options: RequestInit, targetBaseUrl = this.apiBaseUrl, accept = "application/json"): Promise<Response> {
    const headers = new Headers(options.headers ?? {});
    headers.set("accept", accept);
    const requestUrl = `${targetBaseUrl}${path}`;
    if (this.oauth && !headers.has("authorization")) {
      headers.set("authorization", createJiraOAuthHeader(options.method ?? "GET", requestUrl, {
        oauth_consumer_key: this.oauth.consumerKey,
        oauth_nonce: randomBytes(18).toString("base64url"),
        oauth_signature_method: "RSA-SHA1",
        oauth_timestamp: String(Math.floor(Date.now() / 1_000)),
        oauth_token: this.oauth.accessToken,
        oauth_version: "1.0",
      }, this.oauth.privateKey));
    } else if (this.token && !this.oidcSession.hasSession() && !headers.has("authorization")) {
      const authorization = this.hasBearerScheme()
        ? `Bearer ${this.bearerToken()}`
        : this.username
          ? `Basic ${Buffer.from(`${this.username}:${this.token}`, "utf8").toString("base64")}`
          : `Bearer ${this.token}`;
      headers.set("authorization", authorization);
    }
    const cookie = this.oidcSession.cookieHeader(targetBaseUrl);
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
    // Jira MCP sends JSON content negotiation headers on every REST request,
    // including GET /myself. Keep the server-side client wire-compatible.
    const isFormDataBody = typeof FormData !== "undefined" && options.body instanceof FormData;
    if (accept === "application/json" && !isFormDataBody && !headers.has("content-type")) headers.set("content-type", "application/json");

    return this.fetchImpl(requestUrl, { ...options, headers });
  }

  private async request<T>(path: string, schema: z.ZodType<T>, options: RequestInit = {}): Promise<T> {
    let response = await this.sendRequest(path, options);
    let body = await this.responseBody(response);
    let shouldUseOidc = !response.ok && this.shouldUseOidc(response);
    if (!response.ok && this.shouldTryBearer(response)) {
      const bearerHeaders = new Headers(options.headers ?? {});
      bearerHeaders.set("authorization", `Bearer ${this.token}`);
      const bearerResponse = await this.sendRequest(path, { ...options, headers: bearerHeaders });
      const bearerBody = await this.responseBody(bearerResponse);
      response = bearerResponse;
      body = bearerBody;
      shouldUseOidc = shouldUseOidc && response.status === 401;
    }
    if (shouldUseOidc) {
      try {
        ({ response, body } = await this.requestWithOidcFallback(path, options));
      } catch {
        throw new JiraApiError(`Jira API request failed with ${response.status}`, {
          status: response.status,
          body,
          authChallenge: response.headers.get("www-authenticate") ?? undefined,
        });
      }
    }
    if (!response.ok) {
      throw new JiraApiError(`Jira API request failed with ${response.status}`, {
        status: response.status,
        body,
        authChallenge: response.headers.get("www-authenticate") ?? undefined,
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new JiraApiError("Jira API returned an invalid response", { status: response.status });
    return parsed.data;
  }

  private shouldUseOidc(response: Response): boolean {
    return Boolean(!this.hasBearerScheme() && this.username && this.token && response.headers.get("www-authenticate")?.toLowerCase().includes("oauth"));
  }

  private bearerToken(): string {
    const match = this.token.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || this.token;
  }

  private hasBearerScheme(): boolean {
    return /^Bearer\s+/i.test(this.token);
  }

  private shouldTryBearer(response: Response): boolean {
    return Boolean(this.username && this.token && !this.hasBearerScheme() && response.status === 401 && response.headers.get("www-authenticate")?.toLowerCase().includes("oauth"));
  }

  private async requestWithOidcFallback(path: string, options: RequestInit, targetBaseUrl = this.apiBaseUrl, accept = "application/json"): Promise<{ response: Response; body: unknown }> {
    let lastError: unknown;
    const loginMethods = [
      (username: string) => this.oidcSession.loginWithRestSession(username, this.token),
      (username: string) => this.oidcSession.login(username, this.token),
    ];
    for (const login of loginMethods) {
      for (const username of this.oidcUsernames()) {
        this.oidcSession.clear();
        try {
          await login(username);
          const response = await this.sendRequest(path, options, targetBaseUrl, accept);
          const body = await this.responseBody(response);
          if (response.status !== 401) return { response, body };
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw lastError ?? new Error("Jira SSO 登录用户名不能为空");
  }

  private oidcUsernames(): string[] {
    const username = this.username.trim();
    const atIndex = username.indexOf("@");
    const accountName = atIndex > 0 ? username.slice(0, atIndex).trim() : "";
    return [...new Set([username, accountName].filter(Boolean))];
  }

  private async responseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      // Preserve non-JSON Jira error pages for the status-only diagnostic.
      return text;
    }
  }

  getCurrentUser(): Promise<JiraIdentity> {
    return this.request("/myself", RawJiraUserResponseSchema).then(normalizeJiraUser);
  }

  async listAssignableUsers(projectKey: string, username?: string): Promise<JiraIdentity[]> {
    const params = new URLSearchParams({ project: projectKey, maxResults: "300" });
    if (username?.trim()) params.set("username", username.trim());
    const users = await this.request(`/user/assignable/search?${params.toString()}`, z.array(RawJiraUserResponseSchema));
    return users.filter((user) => user.active !== false).map(normalizeJiraUser).filter((user) => Boolean(user.username));
  }

  async listCreateIssueTypes(projectKey: string): Promise<JiraCreateIssueOption[]> {
    const metadata = await this.getCreateIssueMetadata(projectKey);
    const project = this.createMetaProject(metadata, projectKey);
    return normalizeJiraNamedOptions(project?.issuetypes ?? []);
  }

  private getCreateIssueMetadata(projectKey: string) {
    const params = new URLSearchParams({ projectKeys: projectKey, expand: "projects.issuetypes.fields" });
    return this.request(`/issue/createmeta?${params.toString()}`, RawJiraCreateMetaResponseSchema);
  }

  private createMetaProject(metadata: z.infer<typeof RawJiraCreateMetaResponseSchema>, projectKey: string) {
    return metadata.projects.find((item) => item.key?.toLowerCase() === projectKey.toLowerCase()) ?? metadata.projects[0];
  }

  private createMetaPriorities(issueTypes: z.infer<typeof RawJiraCreateMetaIssueTypeSchema>[], issueTypeId?: string): JiraCreateIssueOption[] {
    const scopedIssueTypes = issueTypeId
      ? issueTypes.filter((issueType) => String(issueType.id) === issueTypeId)
      : issueTypes;
    return normalizeRawJiraNamedOptions(scopedIssueTypes.flatMap((issueType) => issueType.fields?.priority?.allowedValues ?? []), true);
  }

  private createMetaPriorityRequired(issueTypes: z.infer<typeof RawJiraCreateMetaIssueTypeSchema>[], issueTypeId?: string): boolean {
    const scopedIssueTypes = issueTypeId
      ? issueTypes.filter((issueType) => String(issueType.id) === issueTypeId)
      : issueTypes;
    return scopedIssueTypes.some((issueType) => issueType.fields?.priority?.required === true);
  }

  async listLabels(projectKey: string): Promise<string[]> {
    const params = new URLSearchParams({
      jql: `project = ${projectKey} AND labels is not EMPTY ORDER BY updated DESC`,
      startAt: "0",
      maxResults: "300",
      fields: "labels",
      validateQuery: "true",
    });
    const result = await this.request(`/search?${params.toString()}`, RawJiraSearchResponseSchema);
    return [...new Set(result.issues.flatMap((issue) => issue.fields.labels ?? []).map((label) => label.trim()).filter(Boolean))]
      .slice(0, 1000)
      .sort((left, right) => left.localeCompare(right));
  }

  async listProjectComponents(projectKey: string): Promise<JiraCreateIssueOption[]> {
    const components = await this.request(`/project/${encodeURIComponent(projectKey)}/components`, z.array(RawJiraNamedOptionSchema));
    return normalizeJiraNamedOptions(components);
  }

  async listProjectVersions(projectKey: string): Promise<JiraCreateIssueOption[]> {
    const versions = await this.request(`/project/${encodeURIComponent(projectKey)}/versions`, z.array(RawJiraVersionSchema));
    return normalizeJiraNamedOptions(versions.filter((version) => !version.archived && !version.released));
  }

  async listCreateIssueFields(): Promise<Array<{ id: string; name: string }>> {
    return this.request("/field", z.array(RawJiraFieldSchema));
  }

  private async listIssueOptions(projectKey: string, jql: string, maxResults: number): Promise<JiraCreateIssueOption[]> {
    const params = new URLSearchParams({ jql, startAt: "0", maxResults: String(maxResults), fields: "summary", validateQuery: "true" });
    const result = await this.request(`/search?${params.toString()}`, RawJiraSearchResponseSchema);
    return result.issues.map((issue) => ({ id: issue.key, name: `${issue.key} · ${issue.fields.summary?.trim() || "未命名问题"}` }));
  }

  private async listCustomFieldOptions(projectKey: string, fieldId: string | null): Promise<JiraCreateIssueOption[]> {
    if (!fieldId) return [];
    const params = new URLSearchParams({
      jql: `project = ${projectKey} AND ${fieldId} is not EMPTY ORDER BY updated DESC`,
      startAt: "0",
      maxResults: "500",
      fields: fieldId,
      validateQuery: "true",
    });
    const result = await this.request(`/search?${params.toString()}`, RawJiraSearchResponseSchema);
    const options = result.issues.flatMap((issue) => customFieldOptions(issue.fields[fieldId]));
    return normalizeJiraNamedOptions(options);
  }

  async getCreateIssueOptions(projectKey: string, issueTypeId?: string): Promise<JiraCreateIssueOptions> {
    const [metadata, currentUser] = await Promise.all([this.getCreateIssueMetadata(projectKey), this.getCurrentUser()]);
    const project = this.createMetaProject(metadata, projectKey);
    const issueTypes = normalizeJiraNamedOptions(project?.issuetypes ?? []);
    const issueTypeMetadata = project?.issuetypes ?? [];
    const priorities = this.createMetaPriorities(issueTypeMetadata, issueTypeId);
    return {
      issueTypes,
      priorities,
      priorityRequired: this.createMetaPriorityRequired(issueTypeMetadata, issueTypeId),
      assignees: [],
      reporters: [currentUser],
      currentUser,
      components: [],
      fixVersions: [],
      customers: [],
      epics: [],
      sprints: [],
      linkableIssues: [],
      customFieldIds: { customerName: null, epicLink: null, sprint: null },
      labels: [],
    };
  }

  async getCreateIssueSupportingOptions(projectKey: string): Promise<JiraCreateIssueSupportingOptions> {
    const [assignees, components, fixVersions, labels] = await Promise.all([
      withDeadline(this.listAssignableUsers(projectKey), []),
      withDeadline(this.listProjectComponents(projectKey), []),
      withDeadline(this.listProjectVersions(projectKey), []),
      withDeadline(this.listLabels(projectKey), []),
    ]);
    return {
      assignees,
      components,
      fixVersions,
      labels,
    };
  }

  async getCreateIssueAdvancedOptions(projectKey: string): Promise<JiraCreateIssueAdvancedOptions> {
    const [fields, epics, linkableIssues] = await Promise.all([
      withDeadline(this.listCreateIssueFields(), []),
      withDeadline(this.listIssueOptions(projectKey, `project = ${projectKey} AND issuetype = Epic ORDER BY updated DESC`, 100), []),
      withDeadline(this.listIssueOptions(projectKey, `project = ${projectKey} ORDER BY updated DESC`, 100), []),
    ]);
    const fieldIds = customFieldIds(fields, { customerName: null, epicLink: null, sprint: null });
    const [customers, sprints] = await Promise.all([
      withDeadline(this.listCustomFieldOptions(projectKey, fieldIds.customerName), []),
      withDeadline(this.listCustomFieldOptions(projectKey, fieldIds.sprint), []),
    ]);
    return {
      customers: customers.map((option) => option.name),
      epics,
      sprints,
      linkableIssues,
      customFieldIds: fieldIds,
    };
  }

  async listIssues(query: JiraIssueListQuery): Promise<JiraIssuePage> {
    const params = new URLSearchParams({
      jql: jqlFor(query),
      startAt: String((query.page - 1) * query.perPage),
      maxResults: String(query.perPage),
      fields: JiraIssueFields,
      validateQuery: "true",
    });
    const result = await this.request(`/search?${params.toString()}`, RawJiraSearchResponseSchema);
    return {
      issues: result.issues.map((issue) => normalizeJiraIssue(issue, this.baseUrl)),
      page: query.page,
      perPage: query.perPage,
      total: result.total ?? result.issues.length,
    };
  }

  async getIssue(key: string): Promise<JiraIssueDetails> {
    const params = new URLSearchParams({ fields: JiraIssueFields });
    const issue = await this.request(`/issue/${encodeURIComponent(key)}?${params.toString()}`, RawJiraIssueResponseSchema);
    const summary = normalizeJiraIssue(issue, this.baseUrl);
    return {
      ...summary,
      comments: (issue.fields.comment?.comments ?? []).map(normalizeJiraComment),
      attachments: (issue.fields.attachment ?? []).map((attachment) => normalizeJiraAttachment(attachment, this.baseUrl)),
    };
  }

  async getAttachment(issueKey: string, attachmentId: string, range?: string): Promise<JiraAttachmentDownload> {
    const issue = await this.getIssue(issueKey);
    const attachment = issue.attachments.find((item) => item.id === attachmentId);
    if (!attachment?.url) throw new JiraApiError("Jira attachment not found", { status: 404 });

    const targetUrl = new URL(attachment.url);
    const baseUrl = new URL(`${this.baseUrl}/`);
    if (targetUrl.origin !== baseUrl.origin) throw new JiraApiError("Jira attachment URL is not trusted", { status: 502 });

    const options: RequestInit = range ? { headers: { range } } : {};
    let response = await this.sendRequest(`${targetUrl.pathname}${targetUrl.search}`, options, this.baseUrl, "*/*");
    if (!response.ok && this.shouldUseOidc(response)) {
      try {
        ({ response } = await this.requestWithOidcFallback(`${targetUrl.pathname}${targetUrl.search}`, options, this.baseUrl, "*/*"));
      } catch {
        throw new JiraApiError(`Jira attachment request failed with ${response.status}`, {
          status: response.status,
          authChallenge: response.headers.get("www-authenticate") ?? undefined,
        });
      }
    }
    if (!response.ok) throw new JiraApiError(`Jira attachment request failed with ${response.status}`, { status: response.status });
    return { response, attachment };
  }

  async getTransitions(key: string): Promise<JiraIssueTransition[]> {
    const result = await this.request(`/issue/${encodeURIComponent(key)}/transitions`, RawJiraTransitionsResponseSchema);
    return result.transitions.map(normalizeJiraTransition);
  }

  async transitionIssue(key: string, transitionId: string): Promise<JiraIssueDetails> {
    await this.request(`/issue/${encodeURIComponent(key)}/transitions`, EmptyJiraResponseSchema, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
    return this.getIssue(key);
  }

  addComment(key: string, body: string): Promise<JiraIssueComment> {
    return this.request(`/issue/${encodeURIComponent(key)}/comment`, JiraCommentResponseSchema, {
      method: "POST",
      body: JSON.stringify({ body }),
    }).then(normalizeJiraComment);
  }

  async addAttachments(key: string, attachments: JiraIssueAttachmentInput[]): Promise<void> {
    const formData = new FormData();
    attachments.forEach((attachment) => {
      const buffer = new ArrayBuffer(attachment.data.byteLength);
      new Uint8Array(buffer).set(attachment.data);
      const blob = new Blob([buffer], { type: attachment.mimeType || "application/octet-stream" });
      formData.append("file", blob, attachment.filename);
    });
    await this.request(`/issue/${encodeURIComponent(key)}/attachments`, z.unknown(), {
      method: "POST",
      headers: { "X-Atlassian-Token": "no-check" },
      body: formData,
    });
  }

  async createIssue(projectKey: string, input: JiraCreateIssueInput): Promise<JiraIssueDetails> {
    const components = input.components ?? [];
    const fixVersions = input.fixVersions ?? [];
    const customFields = input.customFields ?? {};
    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      issuetype: jiraOptionField(input.issueType),
      summary: input.summary,
    };
    if (input.dueDate) fields.duedate = input.dueDate;
    if (components.length > 0) fields.components = components.map((name) => ({ name }));
    if (fixVersions.length > 0) fields.fixVersions = fixVersions.map((name) => ({ name }));
    if (input.description) fields.description = input.description;
    if (input.priority) fields.priority = jiraOptionField(input.priority);
    if (input.assignee) fields.assignee = { name: input.assignee };
    if (input.reporter) fields.reporter = { name: input.reporter };
    if (input.environment) fields.environment = input.environment;
    if (input.originalEstimate || input.remainingEstimate) {
      fields.timetracking = {
        ...(input.originalEstimate ? { originalEstimate: input.originalEstimate } : {}),
        ...(input.remainingEstimate ? { remainingEstimate: input.remainingEstimate } : {}),
      };
    }
    if (input.labels.length > 0) fields.labels = input.labels;

    const created = await this.request("/issue", RawCreatedJiraIssueSchema, {
      method: "POST",
      body: JSON.stringify({ fields: { ...fields, ...customFields } }),
    });
    if (input.linkedIssueKey && input.linkedIssueType) {
      await this.request("/issuelink", EmptyJiraResponseSchema, {
        method: "POST",
        body: JSON.stringify({
          type: { name: input.linkedIssueType },
          inwardIssue: { key: input.linkedIssueKey },
          outwardIssue: { key: created.key },
        }),
      });
    }
    return this.getIssue(created.key);
  }
}

export function jiraJqlFor(query: JiraIssueListQuery): string {
  return jqlFor(query);
}
