import { CreateReviewBodySchema, type CreateReviewInput } from "./contracts.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function extractHeadSha(attributes: Record<string, unknown>, payload: Record<string, unknown>): string | null {
  const lastCommit = record(attributes.last_commit);
  const payloadLastCommit = record(payload.last_commit);
  const objectLastCommit = record(record(payload.object_attributes).last_commit);
  const value = attributes.last_commit_id
    ?? lastCommit.id
    ?? payloadLastCommit.id
    ?? objectLastCommit.id;
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function optionalPath(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function scalarIdentifier(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export interface MergeRequestTerminalEvent {
  projectId: string;
  mrIid: string;
  action: "merge" | "close";
}

export function normalizeMergeRequestEvent(payload: unknown): (CreateReviewInput & { source: "gitlab-webhook" }) | null {
  const body = record(payload);
  const attributes = record(body.object_attributes);
  const project = record(body.project);
  const action = String(attributes.action ?? "update");
  if (body.object_kind !== "merge_request" || !["open", "reopen", "update"].includes(action)) return null;

  const projectId = project.id ?? body.project_id;
  const mergeRequest = record(body.merge_request);
  const mrIid = attributes.iid ?? mergeRequest.iid;
  const projectIdentifier = scalarIdentifier(projectId);
  const mergeRequestIdentifier = scalarIdentifier(mrIid);
  if (projectIdentifier === null || mergeRequestIdentifier === null) return null;

  const parsed = CreateReviewBodySchema.safeParse({
    projectId: projectIdentifier,
    projectPath: optionalPath(project.path_with_namespace),
    mrIid: mergeRequestIdentifier,
    headSha: extractHeadSha(attributes, body),
    targetBranch: optionalPath(attributes.target_branch),
  });
  return parsed.success ? { ...parsed.data, source: "gitlab-webhook" } : null;
}

export function normalizeMergeRequestTerminalEvent(payload: unknown): MergeRequestTerminalEvent | null {
  const body = record(payload);
  const attributes = record(body.object_attributes);
  const action = String(attributes.action ?? "");
  if (body.object_kind !== "merge_request" || !["merge", "close"].includes(action)) return null;

  const project = record(body.project);
  const projectId = scalarIdentifier(project.id ?? body.project_id);
  const mergeRequest = record(body.merge_request);
  const mrIid = scalarIdentifier(attributes.iid ?? mergeRequest.iid);
  if (projectId === null || mrIid === null) return null;

  return { projectId: String(projectId), mrIid: String(mrIid), action: action as MergeRequestTerminalEvent["action"] };
}
