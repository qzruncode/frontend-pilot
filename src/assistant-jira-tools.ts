import type { JiraCreateIssueInput } from "./contracts.js";
import type { JiraIssueDetails, JiraIssueListQuery, JiraIssueSummary, JiraIssueState, JiraIssueTransition } from "./jira-workbench.js";
import { JiraApiError, resolveJiraCreateIssueInput } from "./jira-client.js";
import { JiraCreateIssueInputSchema } from "./contracts.js";
import { clip, failure, result, type AssistantJiraClient, type AssistantToolContext, type AssistantToolResult } from "./assistant-tools.js";

const MAX_JIRA_COMMENTS = 20;
const MAX_JIRA_ATTACHMENTS = 20;
const MAX_JIRA_TRANSITIONS = 50;
const MAX_JIRA_CREATE_OPTIONS = 50;

function authRequired(): AssistantToolResult {
  return result({
    authRequired: {
      kind: "auth_required",
      provider: "jira",
      title: "需要配置 Jira 连接",
      description: "这项任务需要访问你的 Jira 个人账号，请先连接或重新连接 Jira 账号。",
      actionLabel: "去连接 Jira",
      actionPath: "/jira-workbench",
    },
  });
}

function jiraReady(context: AssistantToolContext): AssistantJiraClient | null {
  const configured = context.jiraConfigured ? context.jiraConfigured() : Boolean(context.jira);
  return configured ? context.jira ?? null : null;
}

function jiraFailure(error: unknown, fallback: string): AssistantToolResult {
  const status = error instanceof JiraApiError ? error.status : undefined;
  if (status === 401 || status === 403) return authRequired();
  return failure(error, fallback);
}

function jiraIssueSummary(issue: JiraIssueSummary | JiraIssueDetails): Record<string, unknown> {
  return {
    key: issue.key,
    summary: clip(issue.summary, 500),
    description: issue.description ? clip(issue.description, 4_000) : null,
    status: issue.status,
    priority: issue.priority,
    issueType: issue.issueType,
    projectKey: issue.projectKey,
    assignee: issue.assignee,
    reporter: issue.reporter,
    labels: issue.labels,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    resolution: issue.resolution,
    webUrl: issue.webUrl,
  };
}

function jiraIssueDetailsSummary(issue: JiraIssueDetails): Record<string, unknown> {
  return {
    ...jiraIssueSummary(issue),
    comments: issue.comments.slice(-MAX_JIRA_COMMENTS).map((comment) => ({
      id: comment.id,
      body: clip(comment.body, 1_000),
      author: comment.author,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
    attachments: issue.attachments.slice(0, MAX_JIRA_ATTACHMENTS).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      url: attachment.url,
      mimeType: attachment.mimeType,
      size: attachment.size,
      createdAt: attachment.createdAt,
      author: attachment.author,
    })),
  };
}

function jiraTransitionSummary(transition: JiraIssueTransition): Record<string, unknown> {
  return {
    id: transition.id,
    name: transition.name,
    toStatus: transition.toStatus,
    toStatusId: transition.toStatusId,
  };
}

function limitedOptions<T>(values: readonly T[]): { values: T[]; truncated: boolean } {
  return {
    values: values.slice(0, MAX_JIRA_CREATE_OPTIONS),
    truncated: values.length > MAX_JIRA_CREATE_OPTIONS,
  };
}

function jiraCreateInputError(input: JiraCreateIssueInput): AssistantToolResult | null {
  const parsed = JiraCreateIssueInputSchema.safeParse(input);
  if (parsed.success) return null;
  const message = [...new Set(parsed.error.issues.map((issue) => issue.message).filter(Boolean))].join("；");
  return failure(new Error(message || "请检查 Jira 创建参数"), "Jira 创建参数不完整");
}

export async function getJiraCurrentUser(context: AssistantToolContext): Promise<AssistantToolResult> {
  const jira = jiraReady(context);
  if (!jira) return authRequired();
  try {
    return result({ provider: "jira", user: await jira.getCurrentUser() });
  } catch (error) {
    return jiraFailure(error, "无法读取当前 Jira 用户");
  }
}

export async function getJiraCreateOptions(context: AssistantToolContext): Promise<AssistantToolResult> {
  const jira = jiraReady(context);
  if (!jira) return authRequired();
  const projectKey = context.jiraProjectKey?.().trim();
  if (!projectKey) return failure(new Error("Jira 项目未配置"), "无法读取 Jira 创建选项");
  try {
    const [hotOptions, supportingOptions] = await Promise.all([
      jira.getCreateIssueOptions(projectKey),
      jira.getCreateIssueSupportingOptions(projectKey),
    ]);
    const issueTypes = limitedOptions(hotOptions.issueTypes);
    const priorities = limitedOptions(hotOptions.priorities);
    const assignees = limitedOptions(supportingOptions.assignees);
    const reporters = limitedOptions(hotOptions.reporters);
    const components = limitedOptions(supportingOptions.components);
    const fixVersions = limitedOptions(supportingOptions.fixVersions);
    const labels = limitedOptions(supportingOptions.labels);
    return result({
      provider: "jira",
      projectKey,
      currentUser: hotOptions.currentUser,
      requiredFields: ["summary", "issueType", "description", "components", "fixVersions", ...(hotOptions.priorityRequired ? ["priority"] : [])],
      issueTypes: issueTypes.values,
      priorities: priorities.values,
      assignees: assignees.values,
      reporters: reporters.values,
      components: components.values,
      fixVersions: fixVersions.values,
      labels: labels.values,
      truncated: {
        issueTypes: issueTypes.truncated,
        priorities: priorities.truncated,
        assignees: assignees.truncated,
        reporters: reporters.truncated,
        components: components.truncated,
        fixVersions: fixVersions.truncated,
        labels: labels.truncated,
      },
    });
  } catch (error) {
    return jiraFailure(error, "无法读取 Jira 创建选项");
  }
}

export async function createJiraIssue(context: AssistantToolContext, input: JiraCreateIssueInput): Promise<AssistantToolResult> {
  const jira = jiraReady(context);
  if (!jira) return authRequired();
  const inputError = jiraCreateInputError(input);
  if (inputError) return inputError;
  const projectKey = context.jiraProjectKey?.().trim();
  if (!projectKey) return failure(new Error("Jira 项目未配置"), "无法创建 Jira 问题");
  try {
    const parsed = JiraCreateIssueInputSchema.parse(input);
    const normalized = await resolveJiraCreateIssueInput(jira, projectKey, parsed);
    const created = await jira.createIssue(projectKey, normalized);
    return result({
      provider: "jira",
      created: true,
      projectKey,
      issue: jiraIssueSummary(created),
    });
  } catch (error) {
    return jiraFailure(error, "无法创建 Jira 问题");
  }
}

export async function listJiraIssues(context: AssistantToolContext, input: JiraIssueListQuery): Promise<AssistantToolResult> {
  const jira = jiraReady(context);
  if (!jira) return authRequired();
  try {
    const page = await jira.listIssues({
      scope: input.scope,
      state: input.state,
      search: input.search,
      projectKey: input.projectKey?.trim() || context.jiraProjectKey?.() || undefined,
      assignee: input.assignee,
      page: input.page,
      perPage: input.perPage,
    });
    return result({
      provider: "jira",
      scope: input.scope,
      state: input.state,
      query: {
        scope: input.scope,
        state: input.state,
        search: input.search ?? null,
        projectKey: input.projectKey?.trim() || context.jiraProjectKey?.() || null,
        assignee: input.assignee ?? null,
      },
      page: page.page,
      perPage: page.perPage,
      total: page.total,
      hasNextPage: page.page * page.perPage < page.total,
      issues: page.issues.map(jiraIssueSummary),
    });
  } catch (error) {
    return jiraFailure(error, "无法读取 Jira 问题列表");
  }
}

export async function listMyJiraTodos(context: AssistantToolContext, input: { state: JiraIssueState; limit: number; page?: number }): Promise<AssistantToolResult> {
  const jira = jiraReady(context);
  if (!jira) return authRequired();
  try {
    const projectKey = context.jiraProjectKey?.() || undefined;
    const query: JiraIssueListQuery = {
      scope: "assigned_to_me",
      state: input.state,
      projectKey,
      page: input.page ?? 1,
      perPage: input.limit,
    };
    const [user, page] = await Promise.all([jira.getCurrentUser(), jira.listIssues(query)]);
    return result({
      provider: "jira",
      scope: "assigned_to_me",
      state: input.state,
      user,
      query: { scope: query.scope, state: query.state, projectKey: query.projectKey ?? null },
      page: page.page,
      perPage: page.perPage,
      total: page.total,
      hasNextPage: page.page * page.perPage < page.total,
      issues: page.issues.map(jiraIssueSummary),
    });
  } catch (error) {
    return jiraFailure(error, "无法读取当前用户的 Jira 待办");
  }
}

export async function getJiraIssueTransitions(context: AssistantToolContext, input: { key: string }): Promise<AssistantToolResult> {
  const jira = jiraReady(context);
  if (!jira) return authRequired();
  try {
    const transitions = await jira.getTransitions(input.key);
    return result({
      provider: "jira",
      key: input.key,
      transitions: transitions.slice(0, MAX_JIRA_TRANSITIONS).map(jiraTransitionSummary),
      truncated: transitions.length > MAX_JIRA_TRANSITIONS,
    });
  } catch (error) {
    return jiraFailure(error, "无法读取 Jira 可用状态");
  }
}

export async function getJiraIssue(context: AssistantToolContext, input: { key: string }): Promise<AssistantToolResult> {
  const jira = jiraReady(context);
  if (!jira) return authRequired();
  try {
    return result({ provider: "jira", issue: jiraIssueDetailsSummary(await jira.getIssue(input.key)) });
  } catch (error) {
    return jiraFailure(error, "无法读取 Jira 问题详情");
  }
}
