import type { GitLabClientPort } from "./gitlab-client.js";
import type { GitLabMergeRequestDetails, GitLabMergeRequestSummary } from "./gitlab-workbench.js";

const GITLAB_DRAFT_TITLE_PREFIX = /^\s*(?:draft\s*:\s*|\[draft\]\s*|\(draft\)\s*)([\s\S]*)$/iu;
const GITLAB_DRAFT_TITLE_LABEL = "Draft: ";
const GITLAB_TITLE_MAX_LENGTH = 255;

/** Returns null when the title does not use a GitLab Draft prefix. */
export function gitLabTitleWithoutDraftPrefix(title: string): string | null {
  const match = GITLAB_DRAFT_TITLE_PREFIX.exec(title);
  return match ? match[1].trim() : null;
}

/** Adds GitLab's Draft title marker while keeping the title within GitLab's limit. */
export function ensureGitLabDraftTitle(title: string): string {
  const normalized = title.trim();
  if (gitLabTitleWithoutDraftPrefix(normalized) !== null) return normalized;
  const jiraSuffix = normalized.match(/\s+\(#[A-Za-z][A-Za-z0-9_]{0,63}-\d+\)$/u)?.[0] ?? "";
  const base = jiraSuffix ? normalized.slice(0, -jiraSuffix.length).trimEnd() : normalized;
  const maxBaseLength = Math.max(1, GITLAB_TITLE_MAX_LENGTH - GITLAB_DRAFT_TITLE_LABEL.length - jiraSuffix.length);
  return `${GITLAB_DRAFT_TITLE_LABEL}${base.slice(0, maxBaseLength).trimEnd()}${jiraSuffix}`;
}

/**
 * Remove the Draft marker from a verified, open MR title. The caller must
 * only invoke this after the current head has passed Pipeline and Pipeline
 * Review verification.
 */
export async function clearGitLabDraftTitle(
  gitlab: GitLabClientPort,
  mr: Pick<GitLabMergeRequestDetails, "projectId" | "iid" | "title">,
): Promise<GitLabMergeRequestSummary | null> {
  const nextTitle = gitLabTitleWithoutDraftPrefix(mr.title);
  if (nextTitle === null) return null;
  if (!nextTitle) throw new Error("MR 标题只有 Draft 标记，无法自动移除");
  if (!gitlab.updateMergeRequest) throw new Error("当前 GitLab 连接不支持自动移除 MR 的 Draft 标记");

  const updated = await gitlab.updateMergeRequest(mr.projectId, mr.iid, { title: nextTitle });
  if (gitLabTitleWithoutDraftPrefix(updated.title) !== null) {
    throw new Error("自动移除 MR Draft 标记后，GitLab 返回的标题仍保留 Draft");
  }
  return updated;
}
