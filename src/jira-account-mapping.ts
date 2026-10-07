import type { JiraIdentity } from "./jira-workbench.js";

const nativeJiraAccountOverrides: Readonly<Record<string, Pick<JiraIdentity, "username" | "name">>> = {
  "biao.chen": { username: "chenglong.chen", name: "陈彪" },
  "dengjian.chen": { username: "dengjian.chen", name: "陈登舰" },
  "hui.dai": { username: "hui.zang", name: "臧晖" },
  "jiawei.ye": { username: "jiawei.ye01", name: "叶家伟" },
  "jing.guo": { username: "jing.guo", name: "郭静" },
  "shanghui.li": { username: "shanghui.li", name: "李尚辉" },
  "shijia.guo": { username: "shijia.guo", name: "郭士嘉" },
  "xu.yuan": { username: "xu.yuan", name: "袁旭" },
  "yun.song": { username: "yun.song-cn", name: "宋云" },
};

function comparableUsername(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function usernameWithoutNumericSuffix(value: string): string {
  return comparableUsername(value).replace(/\d+$/, "");
}

export function resolveJiraIdentityForAccount(accountUsername: string, jiraUsers: JiraIdentity[]): JiraIdentity | null {
  const normalized = accountUsername.trim().toLowerCase();
  const exact = jiraUsers.find((user) => user.username.toLowerCase() === normalized);
  const accountKey = usernameWithoutNumericSuffix(accountUsername);
  const suffixMatch = jiraUsers.find((user) => usernameWithoutNumericSuffix(user.username) === accountKey);
  const override = nativeJiraAccountOverrides[normalized];
  if (!override && !exact && !suffixMatch) return null;
  return {
    ...(override ?? exact ?? suffixMatch!),
    avatarUrl: exact?.avatarUrl ?? suffixMatch?.avatarUrl ?? null,
  };
}

export function resolveJiraUsernameForAccount(accountUsername: string, jiraUsers: JiraIdentity[]): string {
  return resolveJiraIdentityForAccount(accountUsername, jiraUsers)?.username ?? accountUsername.trim();
}
