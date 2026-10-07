import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function encryptionKey(secret: string): Buffer | null {
  return secret ? createHash("sha256").update(secret).digest() : null;
}

export function encryptCredential(value: string, secret: string): string | null {
  const key = encryptionKey(secret);
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1$${iv.toString("base64url")}$${cipher.getAuthTag().toString("base64url")}$${ciphertext.toString("base64url")}`;
}

export function decryptCredential(encoded: string, secret: string): string | null {
  const key = encryptionKey(secret);
  if (!key) return null;
  const [version, ivValue, tagValue, ciphertextValue] = encoded.split("$");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
