import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.mts";
import {
  addressMatchesCidr,
  isLoopbackAddress,
  isLoopbackHostname,
  isTrustedProxy,
} from "./config.mts";
import { randomBase64Url } from "./base64url.mts";

export const SECURE_SESSION_COOKIE = "__Host-pi_session";
export const LOOPBACK_SESSION_COOKIE = "pi_session";

export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface RequestContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly protocol: "http" | "https";
}

export function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://gateway.invalid").pathname;
}

export function requestPathWithQuery(request: IncomingMessage): string {
  const url = new URL(request.url ?? "/", "http://gateway.invalid");
  return `${url.pathname}${url.search}`;
}

export function requestContext(
  request: IncomingMessage,
  config: GatewayConfig,
): RequestContext {
  const remoteAddress = request.socket.remoteAddress ?? null;
  let ip = remoteAddress;
  if (remoteAddress && isTrustedProxy(remoteAddress, config)) {
    const forwarded = headerValue(request.headers, "x-forwarded-for");
    if (forwarded) {
      const candidates = forwarded.split(",").map((value) => value.trim()).filter(Boolean);
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index];
        if (!config.trustedProxies.some((cidr) => addressMatchesCidr(candidate, cidr))) {
          ip = candidate;
          break;
        }
      }
    }
  }

  const forwardedProtocol = headerValue(request.headers, "x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  const protocol = "encrypted" in request.socket && request.socket.encrypted
    ? "https"
    : isTrustedProxy(remoteAddress ?? undefined, config) && forwardedProtocol === "https"
      ? "https"
      : forwardedProtocol === "http" && isTrustedProxy(remoteAddress ?? undefined, config)
        ? "http"
        : "http";

  return {
    ip,
    userAgent: headerValue(request.headers, "user-agent")?.slice(0, 1024) ?? null,
    protocol,
  };
}

export function hostnameFromHostHeader(host: string | undefined): string | null {
  if (!host || /[\s/@\\]/.test(host)) return null;
  try {
    const parsed = new URL(`http://${host}`);
    if (
      parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

export function isRequestHostAllowed(
  request: IncomingMessage,
  config: GatewayConfig,
): boolean {
  const hostname = hostnameFromHostHeader(headerValue(request.headers, "host"));
  if (!hostname) return false;
  if (config.allowedHosts.has(hostname)) return true;
  const isLoopback = isLoopbackHostname(hostname) || isLoopbackAddress(hostname);
  if (!isLoopback) return false;
  return isLoopbackHostname(config.publicOrigin.hostname)
    || isTrustedProxy(request.socket.remoteAddress ?? undefined, config);
}

export function requestOriginFromHeaders(
  request: IncomingMessage,
  config: GatewayConfig,
): string | null {
  const host = headerValue(request.headers, "host");
  if (!host) return null;
  const forwardedProtocol = isTrustedProxy(request.socket.remoteAddress ?? undefined, config)
    ? headerValue(request.headers, "x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    : undefined;
  const socketProtocol = "encrypted" in request.socket && request.socket.encrypted
    ? "https"
    : "http";
  const scheme = forwardedProtocol === "https" ? "https" : socketProtocol;
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return null;
  }
}

export function isSameOriginRequest(
  request: IncomingMessage,
  config: GatewayConfig,
  requireOrigin = false,
): boolean {
  const origin = headerValue(request.headers, "origin");
  const fetchSite = headerValue(request.headers, "sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (!origin) return !requireOrigin;
  try {
    const parsed = new URL(origin).origin;
    return parsed === config.publicOrigin.origin
      || parsed === requestOriginFromHeaders(request, config);
  } catch {
    return false;
  }
}

export function hasUnsafeBrowserSession(
  request: IncomingMessage,
  cookieHeader: string | undefined,
): boolean {
  if (!cookieHeader) return false;
  return parseCookies(cookieHeader).has(SECURE_SESSION_COOKIE)
    || parseCookies(cookieHeader).has(LOOPBACK_SESSION_COOKIE);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    cookies.set(name, value);
  }
  return cookies;
}

export function sessionTokenFromRequest(
  request: IncomingMessage,
  protocol: "http" | "https",
): string | undefined {
  const cookies = parseCookies(headerValue(request.headers, "cookie"));
  if (protocol === "https") return cookies.get(SECURE_SESSION_COOKIE);
  return cookies.get(LOOPBACK_SESSION_COOKIE) ?? cookies.get(SECURE_SESSION_COOKIE);
}

export function bearerTokenFromRequest(request: IncomingMessage): string | undefined {
  const authorization = headerValue(request.headers, "authorization");
  if (!authorization) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match?.[1];
}

export function sessionCookie(
  protocol: "http" | "https",
  token: string,
  maxAgeSeconds: number,
): string {
  const name = protocol === "https" ? SECURE_SESSION_COOKIE : LOOPBACK_SESSION_COOKIE;
  const attributes = [
    `${name}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (protocol === "https") attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie(protocol: "http" | "https"): string {
  const name = protocol === "https" ? SECURE_SESSION_COOKIE : LOOPBACK_SESSION_COOKIE;
  const attributes = [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (protocol === "https") attributes.push("Secure");
  return attributes.join("; ");
}

function commonHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

export function sendText(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    ...commonHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    ...commonHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(payload);
}

export function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
  contentSecurityPolicy: string,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    ...commonHeaders(),
    "Content-Security-Policy": contentSecurityPolicy,
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(body);
}

export function redirect(
  response: ServerResponse,
  location: string,
  status = 302,
): void {
  sendText(response, status, "", {
    Location: location,
    "Cache-Control": "no-store",
  });
}

export async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  const contentType = headerValue(request.headers, "content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), { statusCode: 415 });
  }
  const contentLength = Number(headerValue(request.headers, "content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maximumBytes) {
      throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    }
    chunks.push(buffer);
  }
  if (size === 0) throw Object.assign(new Error("Request body is required"), { statusCode: 400 });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
  }
}

export function requestNonce(): string {
  return randomBase64Url(16);
}
