import type { InspectionAuthor, InspectionFinding, InspectionOwnership } from "./api-contracts.js";
import type { GitLabClientPort } from "./gitlab-client.js";
import type { JiraClientPort } from "./jira-client.js";
import type { JiraIdentity } from "./jira-workbench.js";
import { normalizeFindingPath } from "./inspection-findings.js";

export interface InspectionOwnershipInput {
  projectId: string;
  projectPath: string;
  branch: string;
  headSha: string;
  jiraProjectKey: string;
  findings: Array<Pick<InspectionFinding, "id" | "path" | "line" | "scope" | "relatedPaths" | "issue" | "suggestion"> & { jiraKey: string | null }>;
  gitlab: Pick<GitLabClientPort, "listRepositoryCommits" | "getRepositoryFileBlame" | "listMergeRequests" | "getMergeRequestDetails">;
  jira: Pick<JiraClientPort, "listIssues" | "getIssue" | "listAssignableUsers">;
  validate: () => void;
}

export type InspectionOwnershipResult = { findingId: string; ownership: InspectionOwnership };

export function inspectionRepositoryPath(value: string): string | null {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || /[\x00-\x1f*?]/.test(path) || path.split("/").includes("..")) return null;
  const normalized = normalizeFindingPath(path).replace(/\/$/, "");
  return normalized && normalized !== "." ? normalized : null;
}

export function mergeFindingScope(target: Pick<InspectionFinding, "scope" | "relatedPaths">, incoming: Pick<InspectionFinding, "scope" | "relatedPaths">): void {
  const rank = { line: 1, file: 2, cross_file: 3 };
  if (incoming.scope && rank[incoming.scope] > (target.scope ? rank[target.scope] : 0)) target.scope = incoming.scope;
  if (incoming.relatedPaths) target.relatedPaths = [...new Set([...(target.relatedPaths ?? []), ...incoming.relatedPaths])];
}

export function jiraAuthorSearchQueries(author: InspectionAuthor): string[] {
  const email = author.email?.trim() ?? "";
  return [...new Set([email, email.split("@", 1)[0] ?? "", author.name]
    .map((value) => value.trim()).filter((value) => value && value !== "未知作者"))];
}

// Code-author identities map to the same Jira owner only after exact identity
// matching; a single fuzzy search result is not enough to confirm the account.
export function jiraIdentityForAuthor(author: InspectionAuthor, users: JiraIdentity[]): JiraIdentity | null {
  const comparable = (value: string) => value.trim().toLowerCase();
  const unique = [...new Map(users.map((user) => [comparable(user.username), user])).values()];
  const emailMatches = author.email ? unique.filter((user) => user.email && comparable(user.email) === comparable(author.email!)) : [];
  if (emailMatches.length) return emailMatches.length === 1 ? emailMatches[0]! : null;
  const terms = jiraAuthorSearchQueries(author).map(comparable);
  const usernames = unique.filter((user) => terms.includes(comparable(user.username))
    && (!author.email || !user.email || comparable(author.email) === comparable(user.email)));
  return usernames.length === 1 ? usernames[0]! : null;
}
