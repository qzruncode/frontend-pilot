const INSPECTION_FINDING_TITLE_MAX_LENGTH = 96;
const CODE_LOCATION_PAREN_PATTERN = /\s*[（(][^（）()]*?(?:\/|\\)[^（）()]*?[）)]/gu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeKnownLocation(value: string, path: string | undefined, line: number | null | undefined): string {
  const normalizedPath = path?.trim();
  if (!normalizedPath) return value;
  const linePattern = `(?::\\d+(?:-\\d+)?)?`;
  return value.replace(
    new RegExp(`\\s*[（(]?${escapeRegExp(normalizedPath)}${linePattern}[）)]?`, "giu"),
    " ",
  );
}

function clipTitle(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= INSPECTION_FINDING_TITLE_MAX_LENGTH) return value;
  return `${characters.slice(0, INSPECTION_FINDING_TITLE_MAX_LENGTH - 1).join("").trimEnd()}…`;
}

/** Keep evidence in the body while giving inspection findings a scannable title. */
export function shortenInspectionFindingTitle(issue: string, path?: string, line?: number | null): string {
  const normalized = issue.replace(/\s+/gu, " ").trim();
  if (!normalized) return "巡检问题";
  const withoutLocation = removeKnownLocation(normalized, path, line)
    .replace(CODE_LOCATION_PAREN_PATTERN, " ")
    .replace(/^问题(?:描述)?\s*[:：]\s*/u, "")
    .replace(/^[\s，,：:；;]+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const candidate = withoutLocation || normalized;
  const boundary = candidate.search(/[；;。！？!?]/u);
  const primary = boundary >= 20 ? candidate.slice(0, boundary).trim() : candidate;
  return clipTitle(primary || candidate);
}

export function buildInspectionJiraSummary(severity: string, issue: string, path?: string, line?: number | null): string {
  return `[巡检][${severity.trim() || "medium"}] ${shortenInspectionFindingTitle(issue, path, line)}`;
}
