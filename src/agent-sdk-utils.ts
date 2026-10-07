/**
 * The Agent SDK exposes several message shapes through an intentionally loose
 * event stream. Keep the runtime narrowing in one place so the assistant and
 * review runners do not drift apart.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[无法显示工具输出]";
    }
  }
  return value === null || value === undefined ? "" : String(value);
}

export function contentBlocks(value: unknown): Record<string, unknown>[] {
  const content = asRecord(value)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .map(asRecord)
    .filter((block): block is Record<string, unknown> => block !== null);
}
