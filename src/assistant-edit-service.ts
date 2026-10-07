import { randomUUID } from "node:crypto";
import type {
  AssistantEditOperationStatus,
  AssistantEditSessionRetentionMode,
  AssistantEditSessionStatus,
  AssistantEditStore,
  StoredAssistantEditOperation,
  StoredAssistantEditSession,
} from "./assistant-edit-store.js";
import { GitAssistantEditWorkspaceProvider, type AssistantEditWorkspaceInput, type AssistantEditPublishInput } from "./assistant-edit-workspace.js";
import type { GitLabConnection } from "./gitlab-connection.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_OPERATION_SUMMARY_LENGTH = 500;
const MAX_OPERATIONS_PER_SESSION = 100;

export interface AssistantEditCreateInput {
  ownerKey: string;
  projectId: string;
  projectPath: string;
  baseRef: string;
}

export interface AssistantEditPatchInput {
  path: string;
  patch: string;
  summary: string;
  expectedFileSha256?: string | null;
}

export interface AssistantEditOperationView {
  id: string;
  sessionId: string;
  path: string;
  summary: string;
  diff: string;
  status: AssistantEditOperationStatus;
  beforeSha256: string | null;
  afterSha256: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantEditSessionView {
  id: string;
  projectId: string;
  projectPath: string;
  baseRef: string;
  baseSha: string;
  status: AssistantEditSessionStatus;
  retentionMode: AssistantEditSessionRetentionMode;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  changedFiles: number;
  pendingOperationCount: number;
  operations: AssistantEditOperationView[];
}

export interface AssistantEditRunnerContext {
  id: string;
  ownerKey: string;
  projectPath: string;
  baseRef: string;
  baseSha: string;
  workspacePath: string;
  pendingOperationCount: number;
}

export class AssistantEditError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "conflict" | "invalid" | "expired" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "AssistantEditError";
  }
}

function summary(value: string): string {
  const normalized = value.trim();
  return normalized.length > MAX_OPERATION_SUMMARY_LENGTH
    ? `${normalized.slice(0, MAX_OPERATION_SUMMARY_LENGTH - 1)}…`
    : normalized || "助手提出了代码修改";
}

function operationView(operation: StoredAssistantEditOperation): AssistantEditOperationView {
  return {
    id: operation.id,
    sessionId: operation.sessionId,
    path: operation.path,
    summary: operation.summary,
    diff: operation.patch,
    status: operation.status,
    beforeSha256: operation.beforeSha256,
    afterSha256: operation.afterSha256,
    error: operation.error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

export class AssistantEditService {
  constructor(
    private readonly store: AssistantEditStore,
    private readonly workspaceProvider: GitAssistantEditWorkspaceProvider,
  ) {}

  async createSession(input: AssistantEditCreateInput, connection: GitLabConnection, options: { signal?: AbortSignal } = {}): Promise<AssistantEditSessionView> {
    const projectPath = input.projectPath.trim();
    const baseRef = input.baseRef.trim();
    if (!input.ownerKey || !input.projectId.trim() || !projectPath || !baseRef) {
      throw new AssistantEditError("invalid", "项目、项目路径和基线分支不能为空");
    }
    const id = randomUUID();
    const workspaceInput: AssistantEditWorkspaceInput = {
      ownerKey: input.ownerKey,
      sessionId: id,
      projectId: input.projectId.trim(),
      projectPath,
      baseRef,
      connection,
    };
    const workspace = await this.workspaceProvider.create(workspaceInput, options);
    const now = new Date();
    const stored: StoredAssistantEditSession = {
      id,
      ownerKey: input.ownerKey,
      projectId: input.projectId.trim(),
      projectPath,
      baseRef,
      baseSha: workspace.baseSha,
      workspacePath: workspace.path,
      status: "active",
      retentionMode: "auto",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    };
    try {
      this.store.createSession(stored);
    } catch (error) {
      await workspace.dispose().catch(() => undefined);
      throw error;
    }
    return this.sessionView(stored);
  }

  async listSessions(ownerKey: string): Promise<AssistantEditSessionView[]> {
    const sessions = this.store.listSessions(["active", "approval_pending"], ownerKey);
    const views = await Promise.all(sessions.map((session) => this.getSession(session.id, ownerKey)));
    return views.filter((session): session is AssistantEditSessionView => session !== null && ["active", "approval_pending"].includes(session.status));
  }

  async publish(id: string, ownerKey: string, input: Omit<AssistantEditPublishInput, "baseSha">): Promise<string> {
    const session = this.authorizedSession(id, ownerKey, true);
    if (!session || session.status !== "active") throw new AssistantEditError("conflict", "编辑工作区尚未就绪");
    return this.workspaceProvider.publish(session.workspacePath, { ...input, baseSha: session.baseSha });
  }

  async getSession(id: string, ownerKey: string): Promise<AssistantEditSessionView | null> {
    const session = this.authorizedSession(id, ownerKey, false);
    if (!session) return null;
    await this.expireIfNeeded(session);
    const current = this.store.getSession(id, ownerKey);
    if (!current) return null;
    if (current.status !== "closed" && current.status !== "expired" && !(await this.workspaceProvider.exists(current.workspacePath))) {
      this.store.updateSessionStatus(id, ownerKey, "failed");
      return this.sessionView({ ...current, status: "failed" });
    }
    return this.sessionView(current);
  }

  async getRunnerContext(id: string, ownerKey: string): Promise<AssistantEditRunnerContext | null> {
    const session = this.authorizedSession(id, ownerKey, false);
    if (!session) return null;
    await this.expireIfNeeded(session);
    const current = this.store.getSession(id, ownerKey);
    if (!current || !["active", "approval_pending"].includes(current.status)) return null;
    if (!(await this.workspaceProvider.exists(current.workspacePath))) {
      this.store.updateSessionStatus(id, ownerKey, "failed");
      return null;
    }
    return {
      id: current.id,
      ownerKey: current.ownerKey,
      projectPath: current.projectPath,
      baseRef: current.baseRef,
      baseSha: current.baseSha,
      workspacePath: current.workspacePath,
      pendingOperationCount: this.pendingOperations(current.id, ownerKey).length,
    };
  }

  async getDiff(id: string, ownerKey: string): Promise<{ session: AssistantEditSessionView; diff: string; changedFiles: number }> {
    const session = this.authorizedSession(id, ownerKey, true);
    if (!session) throw new AssistantEditError("not_found", "编辑会话不存在");
    if (!(await this.workspaceProvider.exists(session.workspacePath))) throw new AssistantEditError("failed", "编辑工作区已不可用");
    const diff = await this.workspaceProvider.diff(session.workspacePath);
    return { session: await this.sessionView(session, diff.changedFiles), diff: diff.diff, changedFiles: diff.changedFiles };
  }

  async setRetentionMode(id: string, ownerKey: string, retentionMode: AssistantEditSessionRetentionMode): Promise<AssistantEditSessionView> {
    const session = this.authorizedSession(id, ownerKey, true);
    if (!session) throw new AssistantEditError("not_found", "编辑会话不存在");
    await this.expireIfNeeded(session);
    const current = this.store.getSession(id, ownerKey);
    if (!current || !["active", "approval_pending"].includes(current.status)) {
      throw new AssistantEditError("expired", "编辑会话已关闭或已过期");
    }
    const expiresAt = retentionMode === "pinned"
      ? current.expiresAt
      : new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.store.updateSessionRetention(id, ownerKey, retentionMode, expiresAt);
    const updated = this.store.getSession(id, ownerKey);
    if (!updated) throw new AssistantEditError("failed", "编辑会话状态更新失败");
    return this.sessionView(updated);
  }

  async applyFilePatch(id: string, ownerKey: string, input: AssistantEditPatchInput): Promise<AssistantEditOperationView> {
    const session = this.authorizedSession(id, ownerKey, true);
    if (!session || !["active", "approval_pending"].includes(session.status)) {
      throw new AssistantEditError("expired", "编辑会话已关闭或已过期");
    }
    if (this.store.listOperations(session.id, ownerKey).length >= MAX_OPERATIONS_PER_SESSION) {
      throw new AssistantEditError("invalid", `单个编辑会话最多保留 ${MAX_OPERATIONS_PER_SESSION} 次修改`);
    }
    if (!(await this.workspaceProvider.exists(session.workspacePath))) throw new AssistantEditError("failed", "编辑工作区已不可用");
    const path = input.path.trim();
    const beforeSha256 = await this.workspaceProvider.fileSha256(session.workspacePath, path);
    if (input.expectedFileSha256 !== undefined && input.expectedFileSha256 !== beforeSha256) {
      throw new AssistantEditError("conflict", "目标文件已经发生变化，请重新读取后再提出修改");
    }
    const normalizedPatch = (await this.workspaceProvider.checkPatch(session.workspacePath, path, input.patch)) ?? input.patch;
    const now = new Date().toISOString();
    const operation = this.store.createOperation({
      id: randomUUID(),
      sessionId: session.id,
      path,
      summary: summary(input.summary),
      patch: normalizedPatch,
      status: "pending",
      beforeSha256,
      afterSha256: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    try {
      await this.workspaceProvider.applyPatch(session.workspacePath, path, normalizedPatch);
      const afterSha256 = await this.workspaceProvider.fileSha256(session.workspacePath, path);
      const applied = this.store.updateOperation(operation.id, ownerKey, { status: "applied", afterSha256, error: null });
      this.refreshSessionStatus(session.id, ownerKey);
      if (!applied) throw new AssistantEditError("failed", "修改状态更新失败");
      return operationView(applied);
    } catch (error) {
      this.store.updateOperation(operation.id, ownerKey, {
        status: "failed",
        afterSha256: null,
        error: error instanceof Error ? error.message : "应用修改失败",
      });
      this.refreshSessionStatus(session.id, ownerKey);
      if (error instanceof AssistantEditError) throw error;
      throw new AssistantEditError("failed", error instanceof Error ? error.message : "应用修改失败");
    }
  }

  async approveOperation(id: string, operationId: string, ownerKey: string): Promise<AssistantEditOperationView> {
    const session = this.authorizedSession(id, ownerKey, true);
    if (!session) throw new AssistantEditError("not_found", "编辑会话不存在");
    const operation = this.store.getOperation(operationId, ownerKey);
    if (!operation || operation.sessionId !== id) throw new AssistantEditError("not_found", "修改提案不存在");
    if (operation.status !== "pending") return operationView(operation);
    if (!(await this.workspaceProvider.exists(session.workspacePath))) throw new AssistantEditError("failed", "编辑工作区已不可用");
    const currentSha256 = await this.workspaceProvider.fileSha256(session.workspacePath, operation.path);
    if (currentSha256 !== operation.beforeSha256) {
      const conflict = this.store.updateOperation(operation.id, ownerKey, {
        status: "conflict",
        afterSha256: null,
        error: "目标文件已经发生变化，请重新生成修改提案",
      });
      this.refreshSessionStatus(session.id, ownerKey);
      return operationView(conflict ?? { ...operation, status: "conflict", error: "目标文件已经发生变化，请重新生成修改提案" });
    }
    try {
      await this.workspaceProvider.applyPatch(session.workspacePath, operation.path, operation.patch);
      const afterSha256 = await this.workspaceProvider.fileSha256(session.workspacePath, operation.path);
      const applied = this.store.updateOperation(operation.id, ownerKey, { status: "applied", afterSha256, error: null });
      this.refreshSessionStatus(session.id, ownerKey);
      if (!applied) throw new AssistantEditError("failed", "修改提案状态更新失败");
      return operationView(applied);
    } catch (error) {
      this.store.updateOperation(operation.id, ownerKey, {
        status: "failed",
        afterSha256: null,
        error: error instanceof Error ? error.message : "应用修改失败",
      });
      this.refreshSessionStatus(session.id, ownerKey);
      if (error instanceof AssistantEditError) throw error;
      throw new AssistantEditError("failed", error instanceof Error ? error.message : "应用修改失败");
    }
  }

  async rejectOperation(id: string, operationId: string, ownerKey: string): Promise<AssistantEditOperationView> {
    const session = this.authorizedSession(id, ownerKey, true);
    if (!session) throw new AssistantEditError("not_found", "编辑会话不存在");
    const operation = this.store.getOperation(operationId, ownerKey);
    if (!operation || operation.sessionId !== id) throw new AssistantEditError("not_found", "修改提案不存在");
    if (operation.status !== "pending") return operationView(operation);
    const rejected = this.store.updateOperation(operation.id, ownerKey, { status: "rejected", afterSha256: null, error: null });
    this.refreshSessionStatus(session.id, ownerKey);
    if (!rejected) throw new AssistantEditError("failed", "修改提案状态更新失败");
    return operationView(rejected);
  }

  async closeSession(id: string, ownerKey: string): Promise<AssistantEditSessionView | null> {
    const session = this.authorizedSession(id, ownerKey, false);
    if (!session) return null;
    if (session.status !== "closed") {
      this.store.updateSessionStatus(id, ownerKey, "closed");
      await this.workspaceProvider.dispose(session.workspacePath).catch((error) => {
        throw new AssistantEditError("failed", error instanceof Error ? error.message : "清理编辑工作区失败");
      });
    }
    return this.getSession(id, ownerKey);
  }

  private authorizedSession(id: string, ownerKey: string, throwOnMissing: boolean): StoredAssistantEditSession | null {
    const session = this.store.getSession(id, ownerKey);
    if (!session && throwOnMissing) throw new AssistantEditError("not_found", "编辑会话不存在");
    return session;
  }

  private async expireIfNeeded(session: StoredAssistantEditSession): Promise<void> {
    if (["closed", "expired", "failed"].includes(session.status)) return;
    if (session.retentionMode === "pinned") return;
    if (Date.parse(session.expiresAt) > Date.now()) return;
    this.store.updateSessionStatus(session.id, session.ownerKey, "expired");
    await this.workspaceProvider.dispose(session.workspacePath).catch(() => undefined);
  }

  private pendingOperations(sessionId: string, ownerKey: string): StoredAssistantEditOperation[] {
    return this.store.listOperations(sessionId, ownerKey).filter((operation) => operation.status === "pending");
  }

  private refreshSessionStatus(sessionId: string, ownerKey: string): void {
    const session = this.store.getSession(sessionId, ownerKey);
    if (!session || ["closed", "expired", "failed"].includes(session.status)) return;
    this.store.updateSessionStatus(sessionId, ownerKey, this.pendingOperations(sessionId, ownerKey).length > 0 ? "approval_pending" : "active");
  }

  private async sessionView(session: StoredAssistantEditSession, changedFiles?: number): Promise<AssistantEditSessionView> {
    const operations = this.store.listOperations(session.id, session.ownerKey).map(operationView);
    const resolvedChangedFiles = changedFiles ?? (await this.workspaceProvider.exists(session.workspacePath)
      ? (await this.workspaceProvider.diff(session.workspacePath)).changedFiles
      : 0);
    return {
      id: session.id,
      projectId: session.projectId,
      projectPath: session.projectPath,
      baseRef: session.baseRef,
      baseSha: session.baseSha,
      status: session.status,
      retentionMode: session.retentionMode,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      changedFiles: resolvedChangedFiles,
      pendingOperationCount: operations.filter((operation) => operation.status === "pending").length,
      operations,
    };
  }
}
