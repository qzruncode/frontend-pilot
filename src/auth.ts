import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const BROWSER_SESSION_COOKIE = "mr_review_session";
export const BROWSER_SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface BrowserSessionIdentity {
  username: string;
}

export function secureEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

export function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function bearerToken(value: string | string[] | undefined): string {
  const header = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

export function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function cookieValue(value: string | string[] | undefined, name: string): string {
  const header = headerValue(value);
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // A malformed cookie cannot be authenticated and should be ignored.
      return "";
    }
  }
  return "";
}

export function createBrowserSession(secret: string, now = Date.now(), identity?: BrowserSessionIdentity, ttlSeconds = BROWSER_SESSION_TTL_SECONDS): string {
  const expiresAt = Math.floor(now / 1_000) + Math.max(1, ttlSeconds);
  const nonce = randomBytes(16).toString("base64url");
  const subject = identity ? Buffer.from(identity.username, "utf8").toString("base64url") : "";
  const payload = subject ? `${expiresAt}.${nonce}.${subject}` : `${expiresAt}.${nonce}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function browserSessionIdentity(value: string, secret: string, now = Date.now()): BrowserSessionIdentity | null {
  const parts = value.split(".");
  const expiresAtText = parts[0];
  const nonce = parts[1];
  const signature = parts.at(-1);
  if (!expiresAtText || !nonce || !signature || parts.length < 3 || !/^\d+$/.test(expiresAtText)) return null;

  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1_000)) return null;

  const payload = parts.slice(0, -1).join(".");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!secureEqual(signature, expected) || parts.length < 4) return null;
  try {
    const username = Buffer.from(parts[2] ?? "", "base64url").toString("utf8").trim();
    return username ? { username } : null;
  } catch {
    return null;
  }
}

export function isValidBrowserSession(value: string, secret: string, now = Date.now()): boolean {
  const parts = value.split(".");
  const expiresAtText = parts[0];
  const nonce = parts[1];
  const signature = parts.at(-1);
  if (!expiresAtText || !nonce || !signature || parts.length < 3 || !/^\d+$/.test(expiresAtText)) return false;

  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1_000)) return false;
  const payload = parts.slice(0, -1).join(".");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  return secureEqual(signature, expected);
}
