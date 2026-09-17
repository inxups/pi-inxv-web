import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

export function hmacSha256(key: string | Uint8Array, value: string | Uint8Array): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

export function constantTimeEqual(
  actual: string | Uint8Array,
  expected: string | Uint8Array,
): boolean {
  const actualBuffer = typeof actual === "string" ? Buffer.from(actual, "utf8") : Buffer.from(actual);
  const expectedBuffer = typeof expected === "string"
    ? Buffer.from(expected, "utf8")
    : Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function encryptString(value: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ciphertext]).toString("base64url");
}

export function decryptString(value: string, key: Buffer): string {
  const payload = Buffer.from(value, "base64url");
  if (payload.length < 28) throw new Error("Invalid encrypted value");
  const nonce = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function newOpaqueToken(prefix = ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}
