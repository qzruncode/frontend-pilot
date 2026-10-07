import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { GitLabCreateMergeRequestInputSchema, GitLabMergeMergeRequestInputSchema, GitLabNoteBodySchema, GitLabUpdateMergeRequestInputSchema, JiraCreateIssueInputSchema } from "./contracts.js";
import {
  ASSISTANT_MAX_PROGRESS_EVENTS,
  ASSISTANT_TOOL_SERVER_NAME,
  cancelReview,
  getMergeRequest,
  getReviewDetail,
  getReviewProgress,
  getReviewRules,
  getReviewStats,
  listReviews,
  startReview,
  startReviewFromUrl,
  type AssistantToolContext,
} from "./assistant-tools.js";
import {
  getGitLabCurrentUser,
  getGitLabCommitActivity,
  getGitLabMergeRequestCreateOptions,
  searchGitLabProjectMembers,
  getGitLabMergeRequestDetails,
  getGitLabPipelineJobs,
  createGitLabMergeRequest,
  updateGitLabMergeRequest,
  mergeGitLabMergeRequest,
  createGitLabMergeRequestNote,
  retryGitLabPipeline,
  cancelGitLabPipeline,
  getJiraCreateOptions,
  getJiraCurrentUser,
  getJiraIssue,
  getJiraIssueTransitions,
  createJiraIssue,
  listJiraIssues,
  listGitLabProjectCommits,
  listMyGitLabContributedProjects,
  listGitLabPipelines,
  listMyGitLabMergeRequests,
  listMyJiraTodos,
} from "./assistant-workbench-tools.js";

export function createAssistantToolServer(context: AssistantToolContext): McpSdkServerConfigWithInstance {
  const reviewIdShape = { reviewId: z.string().trim().min(1).max(128) };
  const limitShape = { limit: z.number().int().min(1).max(ASSISTANT_MAX_PROGRESS_EVENTS).default(10) };
  const listShape = { limit: z.number().int().min(1).max(50).default(20) };
  const mergeRequestShape = {
    projectId: z.string().trim().min(1).max(256),
    mrIid: z.string().trim().min(1).max(64),
  };
  const rulesShape = { projectPath: z.string().trim().min(1).max(512).optional() };
  const startShape = {
    projectId: z.string().trim().min(1).max(256),
    mrIid: z.string().trim().min(1).max(64),
    projectPath: z.string().trim().min(1).max(512).optional(),
    headSha: z.string().trim().min(1).max(128).optional(),
    targetBranch: z.string().trim().min(1).max(256).optional(),
  };
  const startFromUrlShape = {
    url: z.string().trim().url().max(2_048).refine((value) => {
      const parsed = new URL(value);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
    }, "必须是没有用户名和密码的 HTTP(S) 地址"),
  };
  const jiraTodosShape = {
    state: z.enum(["todo", "in_progress", "acceptance", "all"]).default("todo"),
    limit: z.number().int().min(1).max(50).default(25),
    page: z.number().int().min(1).max(100).default(1),
  };
  const jiraIssueListShape = {
    scope: z.enum(["assigned_to_me", "reported_by_me", "all"]).default("assigned_to_me"),
    state: z.enum(["todo", "in_progress", "acceptance", "done", "all"]).default("todo"),
    search: z.string().trim().max(200).optional(),
    projectKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).optional(),
    assignee: z.string().trim().max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
    page: z.number().int().min(1).max(100).default(1),
    perPage: z.number().int().min(1).max(50).default(25),
  };
  const jiraIssueShape = { key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}-\d+$/).max(80) };
  const jiraCreateIssueShape = JiraCreateIssueInputSchema.omit({
    dueDate: true,
    environment: true,
    originalEstimate: true,
    remainingEstimate: true,
    linkedIssueType: true,
    linkedIssueKey: true,
    customFields: true,
  }).shape;
  const gitlabMergeRequestsShape = {
    scope: z.enum(["assigned_to_me", "created_by_me", "review_requested", "all"]).default("assigned_to_me"),
    state: z.enum(["opened", "closed", "merged", "all"]).default("opened"),
    limit: z.number().int().min(1).max(50).default(25),
  };
  const gitlabMergeRequestDetailsShape = {
    projectId: z.string().trim().min(1).max(256),
    mrIid: z.string().trim().regex(/^\d+$/).max(64),
  };
  const gitlabPipelinesShape = {
    projectId: z.string().trim().min(1).max(256),
    ref: z.string().trim().max(256).optional(),
    status: z.string().trim().max(64).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  };
  const gitlabMergeRequestCreateOptionsShape = {
    projectId: z.string().trim().min(1).max(256),
  };
  const gitlabMemberSearchShape = {
    projectId: z.string().trim().min(1).max(256),
    query: z.string().trim().min(1).max(128),
  };
  const gitlabPipelineJobsShape = {
    projectId: z.string().trim().min(1).max(256),
    pipelineId: z.string().trim().min(1).max(128),
  };
  const gitlabCreateMergeRequestShape = GitLabCreateMergeRequestInputSchema.shape;
  const gitlabUpdateMergeRequestShape = { ...gitlabMergeRequestDetailsShape, ...GitLabUpdateMergeRequestInputSchema.shape };
  const gitlabMergeMergeRequestShape = { ...gitlabMergeRequestDetailsShape, ...GitLabMergeMergeRequestInputSchema.shape };
  const gitlabNoteShape = { ...gitlabMergeRequestDetailsShape, ...GitLabNoteBodySchema.shape };
  const gitlabDateShape = z.string().trim().min(10).max(64).refine((value) => Number.isFinite(Date.parse(value)), "必须是有效的日期或 ISO 8601 时间");
  const gitlabCommitActivityShape = {
    since: gitlabDateShape,
    until: gitlabDateShape,
    maxDetails: z.number().int().min(1).max(40).default(40),
  };
  const gitlabProjectCommitsShape = {
    projectId: z.string().trim().min(1).max(256),
    since: gitlabDateShape,
    until: gitlabDateShape,
    author: z.string().trim().min(1).max(320).optional(),
    page: z.number().int().min(1).max(200).default(1),
    perPage: z.number().int().min(1).max(50).default(50),
  };
  return createSdkMcpServer({
    name: ASSISTANT_TOOL_SERVER_NAME,
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool("get_review_stats", "读取当前 Review 队列和任务状态统计。只读，不会修改任务。", {}, async () => getReviewStats(context)),
      tool("list_reviews", "列出最近的 Review 任务摘要。可用 limit 控制返回数量。只读。", listShape, async (input) => listReviews(context, input)),
      tool("get_review_detail", "读取指定 Review 任务的状态、结果摘要和最近进度。只读。", reviewIdShape, async (input) => getReviewDetail(context, input)),
      tool("get_review_progress", "读取指定 Review 任务最近的进度事件。只读。", { ...reviewIdShape, ...limitShape }, async (input) => getReviewProgress(context, input)),
      tool("get_merge_request", "读取 GitLab Merge Request 的目标分支、Head SHA 和源目标项目路径。不会读取 diff，也不会写评论。", mergeRequestShape, async (input) => getMergeRequest(context, input)),
      tool("get_review_rules", "读取审查 profile 列表；传入 MR 所属仓库路径后返回自动匹配的规则内容。只读。", rulesShape, async (input) => getReviewRules(context, input)),
      tool("get_jira_current_user", "读取当前 Jira 连接身份。未连接或凭据失效时返回登录卡片。只读。", {}, async () => getJiraCurrentUser(context)),
      tool("get_jira_create_options", "读取当前 Jira 项目新建问题所需的必填项和下拉选项。只读，不会创建问题。", {}, async () => getJiraCreateOptions(context)),
      tool("list_jira_issues", "按范围、状态、关键词和分页查询 Jira 问题；默认查询当前用户的待办。只读。", jiraIssueListShape, async (input) => listJiraIssues(context, input)),
      tool("list_my_jira_todos", "列出当前 Jira 用户的待办问题；这是 list_jira_issues 的便捷原子入口，支持分页。只读。", jiraTodosShape, async (input) => listMyJiraTodos(context, input)),
      tool("get_jira_issue", "读取指定 Jira 问题的摘要、描述、评论和附件元数据。只读。", jiraIssueShape, async (input) => getJiraIssue(context, input)),
      tool("get_jira_issue_transitions", "读取指定 Jira 问题当前可用的状态流转。只读，不会修改问题。", jiraIssueShape, async (input) => getJiraIssueTransitions(context, input)),
      tool("create_jira_issue", "仅在用户明确要求创建 Jira 问题且标题、描述、问题类型、模块和修复版本都已确认后调用。此工具会写入 Jira。", jiraCreateIssueShape, async (input) => createJiraIssue(context, { ...input, customFields: {} })),
      tool("get_gitlab_current_user", "读取当前 GitLab 个人账号身份。未连接时返回登录卡片。只读。", {}, async () => getGitLabCurrentUser(context)),
      tool("list_gitlab_contributed_projects", "列出当前 GitLab 用户可访问的代码项目；优先使用成员项目列表，兼容不支持 contributed_projects 的 GitLab 实例。只读。", {}, async () => listMyGitLabContributedProjects(context)),
      tool("list_gitlab_project_commits", "按明确的时间范围分页读取指定 GitLab 项目的提交。默认 all=true，覆盖所有分支；继续请求下一页直到 hasNextPage=false。只读。", gitlabProjectCommitsShape, async (input) => listGitLabProjectCommits(context, input)),
      tool("get_gitlab_commit_activity", "按明确的 since/until 时间范围汇总当前用户在其贡献项目中的提交。适合工作总结；时间范围不是固定的‘上周’，由调用参数决定。只读。", gitlabCommitActivityShape, async (input) => getGitLabCommitActivity(context, input)),
      tool("list_my_gitlab_merge_requests", "列出当前 GitLab 用户相关的 Merge Request。只读。", gitlabMergeRequestsShape, async (input) => listMyGitLabMergeRequests(context, input)),
      tool("get_gitlab_merge_request_details", "读取 GitLab Merge Request 的描述、变更摘要、评论和 Pipeline。只读。", gitlabMergeRequestDetailsShape, async (input) => getGitLabMergeRequestDetails(context, input)),
      tool("get_gitlab_merge_request_create_options", "读取指定 GitLab 项目新建 Merge Request 所需的分支、成员、Milestone 和 Label 选项。只读，不会创建 MR。", gitlabMergeRequestCreateOptionsShape, async (input) => getGitLabMergeRequestCreateOptions(context, input)),
      tool("search_gitlab_project_members", "按姓名或用户名搜索指定 GitLab 项目中可作为 Assignee 或 Reviewer 的成员，返回可直接用于创建/编辑 MR 的数字 ID。只读。", gitlabMemberSearchShape, async (input) => searchGitLabProjectMembers(context, input)),
      tool("list_gitlab_pipelines", "读取 GitLab 项目的最近 Pipeline。只读。", gitlabPipelinesShape, async (input) => listGitLabPipelines(context, input)),
      tool("get_gitlab_pipeline_jobs", "读取指定 GitLab Pipeline 的 Job。只读。", gitlabPipelineJobsShape, async (input) => getGitLabPipelineJobs(context, input)),
      tool("create_gitlab_merge_request", "仅在用户明确要求新建或创建 GitLab Merge Request，且源/目标项目、源/目标分支和标题都已确认后调用。此工具会真实写入 GitLab。", gitlabCreateMergeRequestShape, async (input) => createGitLabMergeRequest(context, input)),
      tool("update_gitlab_merge_request", "仅在用户明确要求编辑或修改 GitLab Merge Request，并已确认要修改的字段后调用。此工具会真实写入 GitLab。", gitlabUpdateMergeRequestShape, async (input) => updateGitLabMergeRequest(context, input)),
      tool("merge_gitlab_merge_request", "仅在用户明确要求合并 GitLab Merge Request 后调用；调用前应先读取详情确认当前状态和 Head SHA。此工具会真实写入 GitLab。", gitlabMergeMergeRequestShape, async (input) => mergeGitLabMergeRequest(context, input)),
      tool("create_gitlab_merge_request_note", "仅在用户明确要求向 GitLab Merge Request 发布评论或留言后调用。此工具会真实写入 GitLab。", gitlabNoteShape, async (input) => createGitLabMergeRequestNote(context, input)),
      tool("retry_gitlab_pipeline", "仅在用户明确要求重新执行或重试 GitLab Pipeline 后调用。此工具会真实写入 GitLab。", gitlabPipelineJobsShape, async (input) => retryGitLabPipeline(context, input)),
      tool("cancel_gitlab_pipeline", "仅在用户明确要求取消或停止 GitLab Pipeline 后调用。此工具会真实写入 GitLab。", gitlabPipelineJobsShape, async (input) => cancelGitLabPipeline(context, input)),
      tool("start_review", "在用户明确要求时启动一次 Review 任务。需要 projectId 和 mrIid；不会因为单纯查询状态而调用。", startShape, async (input) => startReview(context, input)),
      tool("start_review_from_url", "在用户明确要求时，根据 GitLab MR 地址解析并启动 Review 任务。", startFromUrlShape, async (input) => startReviewFromUrl(context, input)),
      tool("cancel_review", "在用户明确要求时取消指定的排队中或运行中的 Review 任务。", reviewIdShape, async (input) => cancelReview(context, input)),
    ],
  });
}
