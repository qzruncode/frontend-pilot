const SENSITIVE_VALUE_PATTERNS = [
  /(authorization\s*:\s*(?:bearer\s+)?)[^\s,;]+/gi,
  /(x-api-key\s*[:=]\s*)[^\s,;]+/gi,
  /(private-token\s*[:=]\s*)[^\s,;]+/gi,
  /(job-token\s*[:=]\s*)[^\s,;]+/gi,
  /((?:api[_ -]?key|auth[_ -]?token|access[_ -]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
];

function redactSensitiveText(message: string): string {
  return SENSITIVE_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "$1[已隐藏]"),
    message,
  );
}

export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function safeErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message ? redactSensitiveText(message) : fallback;
}
