export const JIRA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}-\d+$/;

export function titleWithJiraKey(title: string, value: string): string {
  const key = value.trim().toUpperCase();
  if (!JIRA_KEY_PATTERN.test(key)) return title.trim();
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = title.trim()
    .replace(new RegExp(`\\s*\\(#${escaped}\\)$`, "i"), "")
    .replace(new RegExp(`\\s+#${escaped}$`, "i"), "")
    .trim();
  const suffix = ` (#${key})`;
  return `${base.slice(0, Math.max(1, 255 - suffix.length)).trimEnd()}${suffix}`;
}

export function extractJiraKey(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const match = value?.match(/\b([A-Za-z][A-Za-z0-9_]{0,63}-\d+)\b/);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}
