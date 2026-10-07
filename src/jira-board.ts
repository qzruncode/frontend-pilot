import type { JiraBoardColumn, JiraBoardColumnId, JiraBoardMember, JiraBoardResponse } from "./contracts.js";
import type { JiraClientPort } from "./jira-client.js";
import type { JiraIdentity } from "./jira-workbench.js";
import type { ProductUser } from "./user-store.js";
import { resolveJiraIdentityForAccount } from "./jira-account-mapping.js";

const BOARD_PAGE_SIZE = 15;

const boardColumns: ReadonlyArray<{ id: JiraBoardColumnId; label: string }> = [
  { id: "review", label: "评审/设计" },
  { id: "todo", label: "待办" },
  { id: "in_progress", label: "处理中" },
  { id: "acceptance", label: "验收中" },
  { id: "done", label: "已完成" },
];

function fallbackMember(account: ProductUser): JiraBoardMember {
  return {
    accountUsername: account.username,
    username: account.username,
    name: account.username,
    avatarUrl: null,
  };
}

function boardMemberFor(account: ProductUser, jiraUsers: JiraIdentity[]): JiraBoardMember {
  const resolved = resolveJiraIdentityForAccount(account.username, jiraUsers);
  return resolved ? { ...resolved, accountUsername: account.username } : fallbackMember(account);
}

function selectedBoardMember(members: JiraBoardMember[], selectedAccount?: string): JiraBoardMember | null {
  const normalized = selectedAccount?.trim().toLowerCase();
  if (!normalized || normalized === "all") return null;
  return members.find((member) => member.accountUsername.toLowerCase() === normalized || member.username.toLowerCase() === normalized) ?? null;
}

async function boardMembers(client: JiraClientPort, projectKey: string, accounts: ProductUser[]): Promise<JiraBoardMember[]> {
  const activeAccounts = accounts.filter((account) => account.enabled && account.role === "user" && !account.username.toLowerCase().startsWith("pilot-"));
  const assignableUsers = await client.listAssignableUsers(projectKey).catch(() => []);
  return activeAccounts.map((account) => boardMemberFor(account, assignableUsers));
}

export async function loadJiraBoard(client: JiraClientPort, projectKey: string, accounts: ProductUser[], selectedAccount?: string): Promise<JiraBoardResponse> {
  const members = await boardMembers(client, projectKey, accounts);
  const selectedMember = selectedBoardMember(members, selectedAccount);
  const columns = await Promise.all(boardColumns.map(async ({ id, label }): Promise<JiraBoardColumn> => {
    const result = await client.listIssues({ scope: "all", state: id, projectKey, assignee: selectedMember?.username, page: 1, perPage: BOARD_PAGE_SIZE });
    return { id, label, issues: result.issues, total: result.total, hasMore: result.total > result.issues.length };
  }));
  return {
    projectKey,
    members,
    columns,
    total: columns.reduce((sum, column) => sum + column.total, 0),
  };
}
