import { createHmac, randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

export interface TotpVerification {
  readonly step: number;
}

export function encodeBase32(value: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error("Invalid base32 value");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

function codeForCounter(secret: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  );
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, "0");
}

export function totpStepAt(timestampMs: number): number {
  return Math.floor(timestampMs / (TOTP_PERIOD_SECONDS * 1000));
}

export function totpCode(secret: string, timestampMs = Date.now()): string {
  return codeForCounter(decodeBase32(secret), totpStepAt(timestampMs));
}

export function verifyTotpCode(
  secret: string,
  suppliedCode: string,
  timestampMs = Date.now(),
  window = 1,
): TotpVerification | null {
  if (!/^\d{6}$/.test(suppliedCode)) return null;
  const decoded = decodeBase32(secret);
  const currentStep = totpStepAt(timestampMs);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = currentStep + offset;
    if (step < 0) continue;
    const expected = codeForCounter(decoded, step);
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
      difference |= expected.charCodeAt(index) ^ suppliedCode.charCodeAt(index);
    }
    if (difference === 0) return { step };
  }
  return null;
}

export function totpUri(
  secret: string,
  username: string,
  issuer: string,
): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
