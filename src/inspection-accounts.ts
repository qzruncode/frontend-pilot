import type { FastifyRequest, FastifyReply } from "fastify";
import { createHmac } from "node:crypto";
import { UserStore, type ProductUser, type UserStorePort } from "./user-store.js";
import { JiraUserCredentialStore } from "./jira-user-credentials.js";
import { GitLabOAuthSessionStore } from "./gitlab-oauth-store.js";
import { GitLabOAuthService } from "./gitlab-oauth.js";
import { JiraClient } from "./jira-client.js";
import { browserSessionKey, browserSessionUser, isAllowedWebOrigin } from "./app-route-utils.js";
import { BROWSER_SESSION_COOKIE, browserSessionIdentity, cookieValue, createBrowserSession, isValidBrowserSession, tokenHash } from "./auth.js";
import { GitReviewWorkspaceProvider } from "./review-workspace.js";
import type { AppConfig } from "./config.js";
import type { GitLabConnection } from "./gitlab-connection.js";
import type { JiraConnection } from "./jira-connection.js";
import type { InspectionExecutionIdentity, InspectionDependencies } from "./inspection-service.js";

const COOKIE = "inspection_session";
const INSPECTION_GITLAB_OAUTH_CALLBACK = "/api/v1/inspections/gitlab/oauth/callback";

export function inspectionGitLabOAuthRedirectUri(config: Pick<AppConfig, "gitlabOAuthRedirectUri" | "webOrigin">): string {
  const url = new URL(config.gitlabOAuthRedirectUri || config.webOrigin);
  const callback = url.pathname.match(/^(.*)\/api\/v1\/(?:inspections\/)?gitlab\/oauth\/callback\/?$/);
  const prefix = callback?.[1]?.replace(/\/+$/, "") ?? "";
  url.pathname = `${prefix}${INSPECTION_GITLAB_OAUTH_CALLBACK}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class InspectionAccounts {
  readonly users: UserStore;
  readonly jiraCredentials: JiraUserCredentialStore;
  readonly gitlab: GitLabOAuthService;
  private readonly oauthStore: GitLabOAuthSessionStore;
  constructor(readonly config: AppConfig, private readonly systemUsers: UserStorePort,
    readonly gitlabConnection: GitLabConnection, readonly jiraConnection: JiraConnection) {
    const database = config.reviewDatabasePath === ":memory:" ? ":memory:" : `${config.reviewDatabasePath}.inspection-accounts`;
    this.users = new UserStore(database);
    this.jiraCredentials = new JiraUserCredentialStore(database, config.triggerToken);
    this.oauthStore = new GitLabOAuthSessionStore(database, config.triggerToken);
    this.gitlab = new GitLabOAuthService({
      baseUrl: gitlabConnection.baseUrl, apiBaseUrl: gitlabConnection.apiBaseUrl,
      clientId: config.gitlabOAuthClientId, clientSecret: config.gitlabOAuthClientSecret,
      redirectUri: inspectionGitLabOAuthRedirectUri(config),
      scope: config.gitlabOAuthScope,
    }, fetch, this.oauthStore);
  }
  operator(request: FastifyRequest): ProductUser | null {
    const user = browserSessionUser(request, this.config, this.systemUsers);
    return user && (user.role === "admin" || user.inspectionAccess) ? user : null;
  }
  requireOperator(request: FastifyRequest, reply: FastifyReply): ProductUser | null {
    const user = this.operator(request);
    if (!user) reply.code(403).send({ error: "inspection_access_required", details: "需要管理员授予巡检访问权限" });
    else if (!["GET", "HEAD"].includes(request.method) && !isAllowedWebOrigin(request, this.config)) {
      reply.code(403).send({ error: "browser_session_origin_not_allowed" });
      return null;
    }
    return user;
  }
  private secret(request: FastifyRequest): string {
    const user = browserSessionUser(request, this.config, this.systemUsers);
    const ownerKey = user ? `product:${user.id}` : browserSessionKey(request, this.config, this.systemUsers);
    return createHmac("sha256", this.config.triggerToken).update(`inspection:${ownerKey ?? "anonymous"}`).digest("hex");
  }
  private legacySecret(request: FastifyRequest): string | null {
    const parentSession = cookieValue(request.headers.cookie, BROWSER_SESSION_COOKIE);
    if (!isValidBrowserSession(parentSession, this.config.triggerToken)) return null;
    return createHmac("sha256", this.config.triggerToken).update(`inspection:${tokenHash(parentSession)}`).digest("hex");
  }
  private sessionIdentity(request: FastifyRequest) {
    const value = cookieValue(request.headers.cookie, COOKIE);
    const legacySecret = this.legacySecret(request);
    return browserSessionIdentity(value, this.secret(request))
      ?? (legacySecret ? browserSessionIdentity(value, legacySecret) : null);
  }
  current(request: FastifyRequest): ProductUser | null {
    if (!this.operator(request)) return null;
    const identity = this.sessionIdentity(request);
    if (!identity) return null;
    const [id, revision, createdAtText] = identity.username.split(":");
    const createdAt = createdAtText ? Number(createdAtText) : null;
    const absoluteTtlSeconds = this.config.inspectionSessionAbsoluteTtlSeconds ?? 30 * 24 * 60 * 60;
    if (createdAtText && (!Number.isSafeInteger(createdAt) || createdAt! + absoluteTtlSeconds * 1_000 <= Date.now())) return null;
    const user = this.users.findById(id!);
    return user?.enabled && revision === this.revision(user) ? user : null;
  }
  private revision(user: ProductUser): string {
    return createHmac("sha256", this.config.triggerToken).update(user.updatedAt).digest("hex");
  }
  requireMaintainer(request: FastifyRequest, reply: FastifyReply): ProductUser | null {
    if (!this.requireOperator(request, reply)) return null;
    const user = this.current(request);
    if (!user) reply.code(428).send({ error: "inspection_login_required", details: "请先登录巡检维护人员账号" });
    const expected = request.headers["x-inspection-maintainer-id"];
    if (user && expected && expected !== user.id) {
      reply.code(409).send({ error: "inspection_maintainer_changed", details: "维护人员账号已切换，请刷新页面后继续" });
      return null;
    }
    return user;
  }
  private sessionCreatedAt(request: FastifyRequest): number {
    const identity = this.sessionIdentity(request);
    const createdAt = Number(identity?.username.split(":")[2]);
    return Number.isSafeInteger(createdAt) ? createdAt : Date.now();
  }
  clearSession(reply: FastifyReply): void {
    reply.header("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${this.config.webOrigin.startsWith("https:") ? "; Secure" : ""}`);
  }
  setSession(request: FastifyRequest, reply: FastifyReply, user: ProductUser | null, createdAt = Date.now()): void {
    if (!user) {
      this.clearSession(reply);
      return;
    }
    const idleTtlSeconds = this.config.inspectionSessionIdleTtlSeconds ?? 7 * 24 * 60 * 60;
    const absoluteTtlSeconds = this.config.inspectionSessionAbsoluteTtlSeconds ?? 30 * 24 * 60 * 60;
    const cookieMaxAge = Math.min(idleTtlSeconds, absoluteTtlSeconds);
    const value = createBrowserSession(this.secret(request), Date.now(), { username: `${user.id}:${this.revision(user)}:${createdAt}` }, idleTtlSeconds);
    reply.header("set-cookie", `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${cookieMaxAge}${this.config.webOrigin.startsWith("https:") ? "; Secure" : ""}`);
  }
  refreshSession(request: FastifyRequest, reply: FastifyReply): ProductUser | null {
    const user = this.current(request);
    if (!user) return null;
    this.setSession(request, reply, user, this.sessionCreatedAt(request));
    return user;
  }
  identity(request: FastifyRequest): InspectionExecutionIdentity {
    const operator = this.operator(request)!;
    const maintainer = this.current(request)!;
    return { maintainerId: maintainer.id, maintainerName: maintainer.username, operatorId: operator.id, operatorName: operator.username };
  }
  assertIdentity(identity: InspectionExecutionIdentity): void {
    const operator = identity.operatorId ? this.systemUsers.findById(identity.operatorId) : null;
    if (!operator?.enabled || !(operator.role === "admin" || operator.inspectionAccess)) throw new Error("巡检配置人员已停用或没有巡检权限，请重新绑定维护人员。");
    if (!identity.maintainerId || !this.users.findById(identity.maintainerId)?.enabled) throw new Error("请绑定有效的巡检维护人员账号。");
  }
  jiraClient(id: string): JiraClient | null {
    const credential = this.jiraCredentials.read(id);
    return credential ? new JiraClient({ ...this.jiraConnection, username: credential.jiraUsername, token: credential.token }) : null;
  }
  async dependencies(identity: InspectionExecutionIdentity): Promise<InspectionDependencies> {
    this.assertIdentity(identity);
    const id = identity.maintainerId!;
    const gitlab = await this.gitlab.getClient(id);
    const connection = await this.gitlab.getConnection(id);
    if (!gitlab || !connection) throw new Error("维护人员的巡检 GitLab 授权缺失或已失效，请重新连接。");
    return { gitlab, jira: this.jiraClient(id) ?? undefined, jiraProjectKey: () => this.jiraConnection.projectKey,
      workspaceProvider: this.config.dryRun ? undefined : new GitReviewWorkspaceProvider({
        environment: this.config.environment, rootDir: `${this.config.reviewWorkspaceDir}/inspection`,
        gitlabApiBaseUrl: connection.apiBaseUrl, gitlabToken: connection.token,
        fetchDepth: this.config.gitFetchDepth,
      }),
    };
  }
  close(): void { this.users.close(); this.jiraCredentials.close(); this.oauthStore.close(); }
}
