export const GATEWAY_AUTH_HEADER = "x-pi-gateway-auth";

const ASSERTION_VERSION = "v1";
const ASSERTION_TTL_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface GatewayAssertionPayload {
  readonly version: 1;
  readonly user: string;
  readonly session: string;
  readonly method: string;
  readonly path: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomNonce(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

async function importKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("Gateway attestation secret is too short");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function assertionPayload(
  payload: Omit<GatewayAssertionPayload, "version" | "nonce" | "issuedAt" | "expiresAt">,
  now = Date.now(),
): GatewayAssertionPayload {
  return {
    version: 1,
    user: payload.user,
    session: payload.session,
    method: payload.method.toUpperCase(),
    path: payload.path,
    issuedAt: now,
    expiresAt: now + ASSERTION_TTL_MS,
    nonce: randomNonce(),
  };
}

export async function signGatewayAssertion(
  secret: string,
  payload: Omit<GatewayAssertionPayload, "version" | "nonce" | "issuedAt" | "expiresAt">,
  now = Date.now(),
): Promise<string> {
  const complete = assertionPayload(payload, now);
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(complete)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret),
    encoder.encode(`${ASSERTION_VERSION}.${encodedPayload}`),
  );
  return `${ASSERTION_VERSION}.${encodedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function isGatewayAssertionPayload(value: unknown): value is GatewayAssertionPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<GatewayAssertionPayload>;
  return payload.version === 1
    && typeof payload.user === "string"
    && typeof payload.session === "string"
    && typeof payload.method === "string"
    && typeof payload.path === "string"
    && typeof payload.issuedAt === "number"
    && typeof payload.expiresAt === "number"
    && typeof payload.nonce === "string";
}

export async function verifyGatewayAssertion(
  secret: string,
  assertion: string | null,
  expected: { method: string; path: string },
  now = Date.now(),
): Promise<GatewayAssertionPayload | null> {
  if (!assertion) return null;
  const match = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(assertion);
  if (!match) return null;

  try {
    const signatureValid = await crypto.subtle.verify(
      "HMAC",
      await importKey(secret),
      base64UrlToBytes(match[2]) as BufferSource,
      encoder.encode(`${ASSERTION_VERSION}.${match[1]}`),
    );
    if (!signatureValid) return null;

    const payload = JSON.parse(decoder.decode(base64UrlToBytes(match[1]))) as unknown;
    if (!isGatewayAssertionPayload(payload)) return null;
    if (payload.expiresAt <= now || payload.issuedAt > now + MAX_CLOCK_SKEW_MS) return null;
    if (payload.expiresAt - payload.issuedAt > ASSERTION_TTL_MS) return null;
    if (payload.method.toUpperCase() !== expected.method.toUpperCase()) return null;
    if (payload.path !== expected.path) return null;
    return payload;
  } catch {
    return null;
  }
}
