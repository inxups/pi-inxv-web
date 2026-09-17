export function contentSecurityPolicy(
  nonce: string,
  options: { allowEval?: boolean } = {},
): string {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(nonce)) {
    throw new Error("Invalid CSP nonce");
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${options.allowEval ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function contentSecurityPolicyNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}
