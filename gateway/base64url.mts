const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new Error("Invalid base64url value");
  }
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function randomBase64Url(bytes: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
