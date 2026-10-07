import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  GitLabCreateMergeRequestInputSchema,
  GitLabGenerateMergeRequestDescriptionInputSchema,
  GitLabMergeMergeRequestInputSchema,
  GitLabNoteBodySchema,
  GitLabUpdateMergeRequestInputSchema,
  type ReviewRuleProfile,
} from "./contracts.js";
import type { AppRouteContext } from "./app-route-context.js";
import {
  GitLabApiError,
  type GitLabClientPort,
  type GitLabCurrentUser,
} from "./gitlab-client.js";
import type { GitLabIdentity, GitLabProject } from "./gitlab-workbench.js";
import { hasServiceBearerAccess, hasTriggerAccess, productAccountKey, unauthorized, zodError } from "./app-route-utils.js";
import { ReviewTerminalError } from "./review-service.js";

const GitLabListScopeSchema = z.enum(["assigned_to_me", "created_by_me", "review_requested", "all"]);
export function gitlabProjectsResponse(projects: GitLabProject[], profiles: (Pick<ReviewRuleProfile, "name" | "displayName" | "isDefault"> & { rules: readonly unknown[] })[]) {
  const profileByName = new Map(profiles.map((profile) => [profile.name, profile]));
  const defaultProfile = profiles.find((profile) => profile.isDefault) ?? profiles[0];
  return {
    projects: projects.map((project) => {
      const customProfile = profileByName.get(project.pathWithNamespace);
      const profile = customProfile ?? defaultProfile;
      return { ...project, reviewProfileName: profile?.name ?? "default", reviewProfileDisplayName: profile?.displayName ?? "默认 profile", customReviewProfile: Boolean(customProfile), reviewRuleCount: profile?.rules.length ?? 0 };
    }),
    profiles: profiles.map((profile) => ({ name: profile.name, displayName: profile.displayName, isDefault: profile.isDefault, ruleCount: profile.rules.length })),
  };
}
const GitLabListStateSchema = z.enum(["opened", "closed", "merged", "all"]);
const GitLabMergeRequestQuerySchema = z.object({
  scope: GitLabListScopeSchema.default("assigned_to_me"),
  state: GitLabListStateSchema.default("opened"),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(25),
}).strict();

const GitLabPipelineQuerySchema = z.object({
  ref: z.string().trim().max(256).optional(),
  status: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).max(100).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

const GitLabProjectQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(30),
}).strict();

const GitLabMergeRequestParamsSchema = z.object({
  projectId: z.string().trim().min(1).max(128),
  iid: z.string().trim().regex(/^\d+$/).max(32),
}).strict();

const GitLabPipelineParamsSchema = GitLabMergeRequestParamsSchema.extend({
  pipelineId: z.string().trim().min(1).max(128),
}).strict();

const GitLabProjectPipelineParamsSchema = z.object({
  projectId: z.string().trim().min(1).max(128),
  pipelineId: z.string().trim().min(1).max(128),
}).strict();

function identity(value: GitLabCurrentUser): GitLabIdentity {
  return {
    id: value.id === undefined || value.id === null ? null : String(value.id),
    username: value.username?.trim() ?? "",
    name: value.name?.trim() || value.username?.trim() || "未知用户",
    webUrl: value.web_url ?? null,
    avatarUrl: null,
  };
}

function gitlabFailure(reply: FastifyReply, error: unknown, fallback: string): FastifyReply {
  if (error instanceof ReviewTerminalError) {
    return reply.code(409).send({ error: "merge_request_terminal", state: error.state, details: error.message });
  }
  if (error instanceof GitLabApiError) {
    return reply.code(502).send({ error: "gitlab_api_error", details: error.message });
  }
  return reply.code(500).send({ error: "gitlab_workbench_failed", details: fallback });
}

function noCapability(reply: FastifyReply, capability: string): FastifyReply {
  return reply.code(503).send({ error: "gitlab_capability_not_configured", details: `当前 GitLab 客户端不支持${capability}` });
}

async function workbenchClient(request: FastifyRequest, reply: FastifyReply, context: AppRouteContext): Promise<GitLabClientPort | null> {
  if (hasServiceBearerAccess(request, context.config)) return context.gitlabClient;
  const sessionKey = productAccountKey(request, context.config, context.userStore);
  const client = sessionKey ? await context.gitlabOAuth.getClient(sessionKey) : null;
  if (client) return client;
  reply.code(428).send({ error: "gitlab_oauth_required", details: "请先连接你的 GitLab 账号，再使用工作台" });
  return null;
}

interface GitLabRouteOptions {
  prefix?: string;
  authorize?: (request: FastifyRequest, reply: FastifyReply) => boolean;
  getClient?: (request: FastifyRequest, reply: FastifyReply) => Promise<GitLabClientPort | null>;
  listProfiles?: (request: FastifyRequest) => Promise<(Pick<ReviewRuleProfile, "name" | "displayName" | "isDefault"> & { rules: readonly unknown[] })[]>;
  allowReview?: boolean;
}
export function registerGitLabRoutes(app: FastifyInstance, context: AppRouteContext, options: GitLabRouteOptions = {}): void {
  const prefix = options.prefix ?? "/api/v1/gitlab";
  const authorize = options.authorize ?? ((request, reply) => {
    if (hasTriggerAccess(request, context.config, context.userStore)) return true;
    unauthorized(reply); return false;
  });
  const getClient = options.getClient ?? ((request, reply) => workbenchClient(request, reply, context));
  app.get(`${prefix}/overview`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.getCurrentUser || !client.listMergeRequests) return noCapability(reply, "工作台概览");
    try {
      const user = identity(await client.getCurrentUser());
      const [assigned, created, reviewRequested] = await Promise.all([
        client.listMergeRequests({ scope: "assigned_to_me", state: "opened", page: 1, perPage: 8 }),
        client.listMergeRequests({ scope: "created_by_me", state: "opened", page: 1, perPage: 8 }),
        user.username
          ? client.listMergeRequests({ scope: "review_requested", state: "opened", reviewerUsername: user.username, page: 1, perPage: 8 })
          : Promise.resolve([]),
      ]);
      return reply.send({ user, assigned, created, reviewRequested });
    } catch (error) {
      return gitlabFailure(reply, error, "无法读取 GitLab 工作台概览");
    }
  });

  app.get(`${prefix}/merge-requests`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.listMergeRequests) return noCapability(reply, "Merge Request 列表");
    const parsed = GitLabMergeRequestQuerySchema.safeParse(request.query);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const query = parsed.data.scope === "review_requested"
        ? await reviewerScopedQuery(client, parsed.data, reply)
        : parsed.data;
      if (!query) return reply;
      const mergeRequests = await client.listMergeRequests(query);
      return reply.send({ mergeRequests, page: parsed.data.page, perPage: parsed.data.perPage });
    } catch (error) {
      return gitlabFailure(reply, error, "无法读取 GitLab Merge Request");
    }
  });

  app.get<{ Params: { projectId: string; iid: string } }>(`${prefix}/merge-requests/:projectId/:iid`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.getMergeRequestDetails) return noCapability(reply, "Merge Request 详情");
    const parsed = GitLabMergeRequestParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send(await client.getMergeRequestDetails(parsed.data.projectId, parsed.data.iid));
    } catch (error) {
      return gitlabFailure(reply, error, "无法读取 GitLab Merge Request 详情");
    }
  });

  app.get<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/merge-request-options`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.getMergeRequestCreateOptions) return noCapability(reply, "新建 Merge Request 的下拉选项");
    const parsed = z.object({ projectId: z.string().trim().min(1).max(128) }).strict().safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send(await client.getMergeRequestCreateOptions(parsed.data.projectId));
    } catch (error) {
      return gitlabFailure(reply, error, "无法读取新建 Merge Request 的下拉选项");
    }
  });

  app.get(`${prefix}/recent-push`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.getRecentPush) return noCapability(reply, "最近一次 GitLab 推送");
    try {
      return reply.send({ recentPush: await client.getRecentPush() });
    } catch (error) {
      return gitlabFailure(reply, error, "无法读取最近一次 GitLab 推送");
    }
  });

  app.post(`${prefix}/merge-requests/description`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!context.promptRunner) return noCapability(reply, "生成 Merge Request 描述");
    const parsed = GitLabGenerateMergeRequestDescriptionInputSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const description = await context.promptRunner.generateMergeRequestDescription(parsed.data);
      return reply.send({ description });
    } catch (error) {
      return gitlabFailure(reply, error, "无法生成 GitLab Merge Request 描述");
    }
  });

  app.post(`${prefix}/merge-requests`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.createMergeRequest) return noCapability(reply, "创建 Merge Request");
    const parsed = GitLabCreateMergeRequestInputSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.code(201).send(await client.createMergeRequest(parsed.data));
    } catch (error) {
      return gitlabFailure(reply, error, "无法创建 GitLab Merge Request");
    }
  });

  app.put<{ Params: { projectId: string; iid: string } }>(`${prefix}/merge-requests/:projectId/:iid`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.updateMergeRequest) return noCapability(reply, "更新 Merge Request");
    const parsedParams = GitLabMergeRequestParamsSchema.safeParse(request.params);
    const parsedBody = GitLabUpdateMergeRequestInputSchema.safeParse(request.body);
    if (!parsedParams.success) return zodError(reply, parsedParams.error);
    if (!parsedBody.success) return zodError(reply, parsedBody.error);
    try {
      return reply.send(await client.updateMergeRequest(parsedParams.data.projectId, parsedParams.data.iid, parsedBody.data));
    } catch (error) {
      return gitlabFailure(reply, error, "无法更新 GitLab Merge Request");
    }
  });

  app.put<{ Params: { projectId: string; iid: string } }>(`${prefix}/merge-requests/:projectId/:iid/merge`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.mergeMergeRequest) return noCapability(reply, "合并 Merge Request");
    const parsedParams = GitLabMergeRequestParamsSchema.safeParse(request.params);
    const parsedBody = GitLabMergeMergeRequestInputSchema.safeParse(request.body);
    if (!parsedParams.success) return zodError(reply, parsedParams.error);
    if (!parsedBody.success) return zodError(reply, parsedBody.error);
    try {
      return reply.send(await client.mergeMergeRequest(parsedParams.data.projectId, parsedParams.data.iid, parsedBody.data));
    } catch (error) {
      return gitlabFailure(reply, error, "无法合并 GitLab Merge Request");
    }
  });

  app.get<{ Params: { projectId: string; iid: string } }>(`${prefix}/merge-requests/:projectId/:iid/pipelines`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.getMergeRequestDetails) return noCapability(reply, "Merge Request Pipeline");
    const parsed = GitLabMergeRequestParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const detail = await client.getMergeRequestDetails(parsed.data.projectId, parsed.data.iid);
      return reply.send({ pipelines: detail.pipelines, page: 1, perPage: detail.pipelines.length });
    } catch (error) {
      return gitlabFailure(reply, error, "无法读取 Merge Request Pipeline");
    }
  });

  app.get<{ Params: { projectId: string; iid: string; pipelineId: string } }>(`${prefix}/merge-requests/:projectId/:iid/pipelines/:pipelineId/jobs`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.listPipelineJobs) return noCapability(reply, "Pipeline Job");
    const parsed = GitLabPipelineParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ jobs: await client.listPipelineJobs(parsed.data.projectId, parsed.data.pipelineId) });
    } catch (error) {
      return gitlabFailure(reply, error, "无法读取 Pipeline Job");
    }
  });

  app.get(`${prefix}/projects`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.listProjects) return noCapability(reply, "GitLab 项目列表");
    const parsed = GitLabProjectQuerySchema.safeParse(request.query);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const [projects, profiles] = await Promise.all([
        client.listProjects(parsed.data),
        (options.listProfiles ?? (() => context.reviewRulesStore.list()))(request),
      ]);
      return reply.send(gitlabProjectsResponse(projects, profiles));
    } catch (error) {
      return gitlabFailure(reply, error, "无法读取 GitLab 项目配置");
    }
  });

  app.get<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/pipelines`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.listPipelines) return noCapability(reply, "项目 Pipeline");
    const parsedParams = z.object({ projectId: z.string().trim().min(1).max(128) }).strict().safeParse(request.params);
    const parsedQuery = GitLabPipelineQuerySchema.safeParse(request.query);
    if (!parsedParams.success) return zodError(reply, parsedParams.error);
    if (!parsedQuery.success) return zodError(reply, parsedQuery.error);
    try {
      return reply.send({
        pipelines: await client.listPipelines(parsedParams.data.projectId, parsedQuery.data),
        page: parsedQuery.data.page,
        perPage: parsedQuery.data.perPage,
      });
    } catch (error) {
      return gitlabFailure(reply, error, "无法读取项目 Pipeline");
    }
  });

  app.get<{ Params: { projectId: string; pipelineId: string } }>(`${prefix}/projects/:projectId/pipelines/:pipelineId/jobs`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.listPipelineJobs) return noCapability(reply, "Pipeline Job");
    const parsed = GitLabProjectPipelineParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send({ jobs: await client.listPipelineJobs(parsed.data.projectId, parsed.data.pipelineId) });
    } catch (error) {
      return gitlabFailure(reply, error, "无法读取项目 Pipeline Job");
    }
  });

  app.post<{ Params: { projectId: string; pipelineId: string } }>(`${prefix}/projects/:projectId/pipelines/:pipelineId/retry`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.retryPipeline) return noCapability(reply, "重试 Pipeline");
    const parsed = GitLabProjectPipelineParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send(await client.retryPipeline(parsed.data.projectId, parsed.data.pipelineId));
    } catch (error) {
      return gitlabFailure(reply, error, "无法重试 Pipeline");
    }
  });

  app.post<{ Params: { projectId: string; pipelineId: string } }>(`${prefix}/projects/:projectId/pipelines/:pipelineId/cancel`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.cancelPipeline) return noCapability(reply, "取消 Pipeline");
    const parsed = GitLabProjectPipelineParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.send(await client.cancelPipeline(parsed.data.projectId, parsed.data.pipelineId));
    } catch (error) {
      return gitlabFailure(reply, error, "无法取消 Pipeline");
    }
  });

  app.post<{ Params: { projectId: string; iid: string } }>(`${prefix}/merge-requests/:projectId/:iid/notes`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    const parsedParams = GitLabMergeRequestParamsSchema.safeParse(request.params);
    const parsedBody = GitLabNoteBodySchema.safeParse(request.body);
    if (!parsedParams.success) return zodError(reply, parsedParams.error);
    if (!parsedBody.success) return zodError(reply, parsedBody.error);
    try {
      const note = await client.createNote(parsedParams.data.projectId, parsedParams.data.iid, parsedBody.data.body);
      return reply.send({ note: { id: String(note.id), body: note.body ?? parsedBody.data.body, author: null, createdAt: null, updatedAt: null, system: false, resolvable: false } });
    } catch (error) {
      return gitlabFailure(reply, error, "无法发布 GitLab 评论");
    }
  });

  if (options.allowReview !== false) app.post<{ Params: { projectId: string; iid: string } }>(`${prefix}/merge-requests/:projectId/:iid/review`, async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const client = await getClient(request, reply);
    if (!client) return reply;
    if (!client.getMergeRequestDetails) return noCapability(reply, "从 Merge Request 发起 Review");
    const parsed = GitLabMergeRequestParamsSchema.safeParse(request.params);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      const mergeRequest = await client.getMergeRequestDetails(parsed.data.projectId, parsed.data.iid);
      const result = await context.service.enqueue({
        projectId: mergeRequest.projectId || parsed.data.projectId,
        projectPath: mergeRequest.projectPath || null,
        mrIid: parsed.data.iid,
        headSha: mergeRequest.headSha,
        targetBranch: mergeRequest.targetBranch,
        source: "gitlab-workbench",
      });
      return reply.code(202).send({ accepted: true, ...result });
    } catch (error) {
      return gitlabFailure(reply, error, "无法从 GitLab Merge Request 发起 Review");
    }
  });
}

async function reviewerScopedQuery(
  client: GitLabClientPort,
  query: z.output<typeof GitLabMergeRequestQuerySchema>,
  reply: FastifyReply,
) {
  if (!client.getCurrentUser) return noCapability(reply, "当前 GitLab 用户身份");
  const user = await client.getCurrentUser();
  const reviewerUsername = user.username?.trim() ?? "";
  if (!reviewerUsername) {
    return reply.code(502).send({ error: "gitlab_user_identity_missing", details: "无法确定当前 GitLab 用户，不能筛选请求我审查的 MR" });
  }
  return { ...query, reviewerUsername };
}
