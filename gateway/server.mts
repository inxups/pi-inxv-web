import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { GatewayConfig } from "./config.mts";
import { AuthError, GatewayAuthService, type AuthContext, type IssuedSession } from "./auth-service.mts";
import { AuthRateLimiter, retryAfterSeconds } from "./rate-limit.mts";
import {
  bearerTokenFromRequest,
  clearSessionCookie,
  hasUnsafeBrowserSession,
  headerValue,
  isRequestHostAllowed,
  isSameOriginRequest,
  readJsonBody,
  redirect,
  requestContext,
  requestPath,
  requestPathWithQuery,
  sendHtml,
  sendJson,
  sendText,
  sessionCookie,
  sessionTokenFromRequest,
} from "./http.mts";
import { renderAccountPage, renderLoginPage, renderSetupPage } from "./pages.mts";
import { proxyToApp } from "./proxy.mts";
import {
  apiTokenAllowsMethod,
  normalizeApiTokenScopes,
  type ApiTokenScope,
} from "./token-policy.mts";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthError(400, "invalid_request", `${name} is required`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new AuthError(400, "invalid_request", `${name} must be a string`);
  }
  return value;
}

function tokenScopesFromBody(value: unknown): ApiTokenScope[] {
  try {
    return normalizeApiTokenScopes(value);
  } catch (error) {
    throw new AuthError(
      400,
      "invalid_token_scope",
      error instanceof Error ? error.message : "Invalid API token scope",
    );
  }
}

function tokenExpiryFromBody(value: unknown, now = Date.now()): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= now
    || value > now + 10 * 365 * 24 * 60 * 60 * 1000
  ) {
    throw new AuthError(400, "invalid_token_expiry", "Invalid API token expiry");
  }
  return value;
}

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/";
  return value;
}

function loginRedirect(request: IncomingMessage, config: GatewayConfig): string {
  const url = new URL(request.url ?? "/", config.publicOrigin);
  const next = `${url.pathname}${url.search}`;
  const query = new URLSearchParams();
  query.set("next", safeNextPath(next));
  return `/auth/login?${query.toString()}`;
}

function setSessionCookie(
  response: ServerResponse,
  context: AuthContext & { protocol: "http" | "https" },
  session: IssuedSession,
): void {
  const maxAge = Math.max(
    1,
    Math.floor((session.session.absoluteExpiresAt - Date.now()) / 1000),
  );
  response.setHeader(
    "Set-Cookie",
    sessionCookie(context.protocol, session.token, maxAge),
  );
}

function clearSession(response: ServerResponse, protocol: "http" | "https"): void {
  response.setHeader("Set-Cookie", clearSessionCookie(protocol));
}

function authError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (typeof statusCode === "number") {
    return new AuthError(statusCode, "invalid_request", error instanceof Error
      ? error.message
      : "Invalid request");
  }
  return new AuthError(500, "internal_error", "Gateway authentication failed");
}

function responseForAuthError(
  response: ServerResponse,
  error: unknown,
  service: GatewayAuthService,
  context: AuthContext,
): void {
  const normalized = authError(error);
  service.db.appendAudit(
    "auth_error",
    null,
    context.ip,
    context.userAgent,
    { code: normalized.code, status: normalized.status },
  );
  if (normalized.status >= 500) {
    console.error(`[pi-web-gateway] ${normalized.message}`);
  } else if (normalized.status >= 400) {
    console.warn(
      `[pi-web-gateway] authentication failure code=${normalized.code} status=${normalized.status} ip=${context.ip ?? "unknown"}`,
    );
  }
  sendJson(response, normalized.status, {
    error: normalized.message,
    code: normalized.code,
  });
}

function rateLimitKey(prefix: string, context: AuthContext): string {
  return `${prefix}:${context.ip ?? "unknown"}`;
}

function enforceRateLimit(
  limiter: AuthRateLimiter,
  key: string,
  response: ServerResponse,
): boolean {
  const retryAfterMs = limiter.retryAfterMs(key);
  if (retryAfterMs <= 0) return true;
  sendJson(response, 429, {
    error: "Too many authentication attempts",
    code: "rate_limited",
    retryAfterMs,
  }, {
    "Retry-After": String(retryAfterSeconds(retryAfterMs)),
  });
  return false;
}

function enforceRequestBudget(
  limiter: AuthRateLimiter,
  key: string,
  limit: number,
  windowMs: number,
  response: ServerResponse,
): boolean {
  const retryAfterMs = limiter.consume(key, limit, windowMs);
  if (retryAfterMs <= 0) return true;
  sendJson(response, 429, {
    error: "Too many authentication requests",
    code: "rate_limited",
    retryAfterMs,
  }, {
    "Retry-After": String(retryAfterSeconds(retryAfterMs)),
  });
  return false;
}

function finishLogin(
  response: ServerResponse,
  service: GatewayAuthService,
  context: AuthContext & { protocol: "http" | "https" },
  session: IssuedSession,
): void {
  setSessionCookie(response, context, session);
  sendJson(response, 200, {
    ok: true,
    csrfToken: session.csrfToken,
    user: {
      username: session.user.username,
      displayName: session.user.displayName,
    },
  });
}

async function authenticateRequest(
  request: IncomingMessage,
  service: GatewayAuthService,
  protocol: "http" | "https",
): Promise<{ session: IssuedSession; source: "bearer" | "cookie" } | null> {
  const bearer = bearerTokenFromRequest(request);
  if (bearer) {
    const session = service.authenticateApiToken(bearer);
    return session ? { session, source: "bearer" } : null;
  }
  const session = service.authenticateSession(sessionTokenFromRequest(request, protocol));
  return session ? { session, source: "cookie" } : null;
}

function accountPayload(
  service: GatewayAuthService,
  current: IssuedSession,
): Record<string, unknown> {
  const user = service.getUser();
  if (!user) throw new AuthError(401, "invalid_user", "User no longer exists");
  return {
    user: {
      username: user.username,
      displayName: user.displayName,
    },
    methods: service.methods(),
    credentials: service.listCredentials(user.id).map((credential) => ({
      id: credential.id,
      name: credential.name,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
      transports: credential.transports,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
    })),
    sessions: service.listSessions(user.id).map((session) => ({
      id: session.id,
      current: session.id === current.session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      ip: session.ip,
      userAgent: session.userAgent,
    })),
    apiTokens: service.listApiTokens().map((token) => ({
      id: token.id,
      name: token.name,
      scopes: token.scopes,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
    })),
    audit: service.listAudit(50),
  };
}

function isProtectedAuthApi(path: string): boolean {
  return path === "/api/auth/account"
    || path === "/api/auth/logout"
    || path === "/api/auth/passkey/register/options"
    || path === "/api/auth/passkey/register/verify"
    || path === "/api/auth/sessions"
    || path.startsWith("/api/auth/sessions/")
    || path === "/api/auth/credentials"
    || path.startsWith("/api/auth/credentials/")
    || path === "/api/auth/api-tokens"
    || path.startsWith("/api/auth/api-tokens/")
    || path === "/api/web-auth";
}

async function handleProtectedAuthApi(
  request: IncomingMessage,
  response: ServerResponse,
  service: GatewayAuthService,
  context: AuthContext & { protocol: "http" | "https" },
  current: IssuedSession,
  path: string,
  method: string,
): Promise<boolean> {
  if (path === "/api/web-auth" && method === "GET") {
    sendJson(response, 200, {
      enabled: true,
      authenticated: true,
      mode: "gateway",
    });
    return true;
  }
  if (path === "/api/web-auth" && method === "POST") {
    sendJson(response, 404, {
      error: "Password authentication is handled by the gateway login page",
      code: "password_login_disabled",
    });
    return true;
  }
  if (path === "/api/web-auth" && method === "DELETE") {
    if (current.session.id.startsWith("token:")) {
      service.revokeApiToken(current.session.id.slice("token:".length), Date.now(), context);
    } else {
      service.revokeSession(current.user.id, current.session.id, Date.now(), context);
    }
    clearSession(response, context.protocol);
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (path === "/api/auth/account" && method === "GET") {
    sendJson(response, 200, accountPayload(service, current));
    return true;
  }
  if (path === "/api/auth/logout" && method === "POST") {
    if (current.session.id.startsWith("token:")) {
      service.revokeApiToken(current.session.id.slice("token:".length), Date.now(), context);
    } else {
      service.revokeSession(current.user.id, current.session.id, Date.now(), context);
    }
    clearSession(response, context.protocol);
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (path === "/api/auth/passkey/register/options" && method === "POST") {
    const body = asRecord(await readJsonBody(request, service.config.maxJsonBodyBytes));
    const result = await service.startPasskeyRegistration(
      context,
      optionalString(body?.deviceName, "deviceName"),
    );
    sendJson(response, 200, result);
    return true;
  }
  if (path === "/api/auth/passkey/register/verify" && method === "POST") {
    const body = asRecord(await readJsonBody(request, service.config.maxJsonBodyBytes));
    if (!body) throw new AuthError(400, "invalid_request", "JSON object is required");
    const credential = body.response;
    if (!credential || typeof credential !== "object") {
      throw new AuthError(400, "invalid_request", "Passkey response is required");
    }
    const created = await service.finishPasskeyRegistration({
      challengeId: requiredString(body.challengeId, "challengeId"),
      response: credential as never,
      deviceName: optionalString(body.deviceName, "deviceName"),
    }, context);
    sendJson(response, 200, { ok: true, credentialId: created.id });
    return true;
  }
  if (path === "/api/auth/sessions" && method === "GET") {
    const account = accountPayload(service, current) as { sessions: unknown[] };
    sendJson(response, 200, account.sessions);
    return true;
  }
  if (path === "/api/auth/sessions" && method === "DELETE") {
    const count = service.revokeAllSessions(
      current.user.id,
      current.session.id,
      Date.now(),
      context,
    );
    sendJson(response, 200, { ok: true, revoked: count });
    return true;
  }
  const sessionMatch = /^\/api\/auth\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch && method === "DELETE") {
    const id = decodeURIComponent(sessionMatch[1]);
    const revoked = service.revokeSession(current.user.id, id, Date.now(), context);
    if (id === current.session.id) clearSession(response, context.protocol);
    sendJson(response, revoked ? 200 : 404, { ok: revoked });
    return true;
  }
  const credentialMatch = /^\/api\/auth\/credentials\/([^/]+)$/.exec(path);
  if (credentialMatch && method === "DELETE") {
    const id = decodeURIComponent(credentialMatch[1]);
    const deleted = service.deleteCredential(current.user.id, id, context);
    sendJson(response, deleted ? 200 : 404, { ok: deleted });
    return true;
  }
  if (path === "/api/auth/api-tokens" && method === "POST") {
    const body = asRecord(await readJsonBody(request, service.config.maxJsonBodyBytes));
    if (!body) throw new AuthError(400, "invalid_request", "JSON object is required");
    const result = service.issueApiToken(
      requiredString(body.name, "name"),
      tokenExpiryFromBody(body.expiresAt),
      tokenScopesFromBody(body.scopes),
    );
    sendJson(response, 201, result);
    return true;
  }
  if (path === "/api/auth/api-tokens" && method === "GET") {
    sendJson(response, 200, service.listApiTokens().map((token) => ({
      id: token.id,
      name: token.name,
      scopes: token.scopes,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
    })));
    return true;
  }
  const tokenMatch = /^\/api\/auth\/api-tokens\/([^/]+)$/.exec(path);
  if (tokenMatch && method === "DELETE") {
    const id = decodeURIComponent(tokenMatch[1]);
    sendJson(response, service.revokeApiToken(id, Date.now(), context) ? 200 : 404, { ok: true });
    return true;
  }
  return false;
}

async function handleAuthApi(
  request: IncomingMessage,
  response: ServerResponse,
  service: GatewayAuthService,
  context: AuthContext & { protocol: "http" | "https" },
  limiter: AuthRateLimiter,
  path: string,
  method: string,
): Promise<boolean> {
  if (!enforceRequestBudget(
    limiter,
    rateLimitKey("auth-request", context),
    60,
    60_000,
    response,
  )) return true;
  if (path === "/api/auth/status" && method === "GET") {
    const authenticated = Boolean(await authenticateRequest(request, service, context.protocol));
    sendJson(response, 200, { ...service.methods(), authenticated });
    return true;
  }

  const rateKey = rateLimitKey("auth", context);
  if (path === "/api/auth/passkey/options" && method === "POST") {
    if (!enforceRateLimit(limiter, rateKey, response)) return true;
    const result = await service.startPasskeyLogin(context);
    sendJson(response, 200, result);
    return true;
  }
  if (path === "/api/auth/passkey/verify" && method === "POST") {
    if (!enforceRateLimit(limiter, rateKey, response)) return true;
    const body = asRecord(await readJsonBody(request, service.config.maxJsonBodyBytes));
    if (!body) throw new AuthError(400, "invalid_request", "JSON object is required");
    if (!body.response || typeof body.response !== "object") {
      throw new AuthError(400, "invalid_request", "Passkey response is required");
    }
    try {
      const session = await service.finishPasskeyLogin({
        challengeId: requiredString(body.challengeId, "challengeId"),
        response: body.response as never,
      }, context);
      limiter.recordSuccess(rateKey);
      finishLogin(response, service, context, session);
    } catch (error) {
      limiter.recordFailure(rateKey);
      throw error;
    }
    return true;
  }
  if (path === "/api/auth/totp" && method === "POST") {
    if (!enforceRateLimit(limiter, rateKey, response)) return true;
    const body = asRecord(await readJsonBody(request, service.config.maxJsonBodyBytes));
    if (!body) throw new AuthError(400, "invalid_request", "JSON object is required");
    try {
      const session = await service.finishPasswordTotpLogin(
        requiredString(body.password, "password"),
        requiredString(body.code, "code"),
        context,
      );
      limiter.recordSuccess(rateKey);
      finishLogin(response, service, context, session);
    } catch (error) {
      limiter.recordFailure(rateKey);
      throw error;
    }
    return true;
  }
  if (path === "/api/auth/recovery" && method === "POST") {
    if (!enforceRateLimit(limiter, rateKey, response)) return true;
    const body = asRecord(await readJsonBody(request, service.config.maxJsonBodyBytes));
    if (!body) throw new AuthError(400, "invalid_request", "JSON object is required");
    try {
      const session = await service.finishRecoveryLogin(
        requiredString(body.code, "code"),
        context,
      );
      limiter.recordSuccess(rateKey);
      finishLogin(response, service, context, session);
    } catch (error) {
      limiter.recordFailure(rateKey);
      throw error;
    }
    return true;
  }
  return false;
}

async function handleSetupApi(
  request: IncomingMessage,
  response: ServerResponse,
  service: GatewayAuthService,
  context: AuthContext & { protocol: "http" | "https" },
  limiter: AuthRateLimiter,
  path: string,
  method: string,
): Promise<boolean> {
  if (!enforceRequestBudget(
    limiter,
    rateLimitKey("setup-request", context),
    20,
    10 * 60_000,
    response,
  )) return true;
  if (path === "/api/setup/start" && method === "POST") {
    const key = rateLimitKey("setup", context);
    if (!enforceRateLimit(limiter, key, response)) return true;
    const body = asRecord(await readJsonBody(request, service.config.maxJsonBodyBytes));
    if (!body) throw new AuthError(400, "invalid_request", "JSON object is required");
    try {
      const result = await service.startSetup(
        requiredString(body.code, "code"),
        context,
      );
      limiter.recordSuccess(key);
      sendJson(response, 200, result);
    } catch (error) {
      limiter.recordFailure(key);
      throw error;
    }
    return true;
  }
  if (path === "/api/setup/finish" && method === "POST") {
    const body = asRecord(await readJsonBody(request, service.config.maxJsonBodyBytes));
    if (!body) throw new AuthError(400, "invalid_request", "JSON object is required");
    const session = await service.finishSetup({
      challengeId: requiredString(body.challengeId, "challengeId"),
      credential: body.credential && typeof body.credential === "object"
        ? body.credential as never
        : undefined,
      password: requiredString(body.password, "password"),
      totpCode: requiredString(body.totpCode, "totpCode"),
      deviceName: optionalString(body.deviceName, "deviceName"),
    }, context);
    setSessionCookie(response, context, session);
    sendJson(response, 200, {
      ok: true,
      recoveryCodes: session.recoveryCodes,
      user: {
        username: session.user.username,
        displayName: session.user.displayName,
      },
    });
    return true;
  }
  return false;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: GatewayAuthService,
  config: GatewayConfig,
  limiter: AuthRateLimiter,
): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const path = requestPath(request);
  const context = requestContext(request, config);
  if (request.url && request.url.length > 16_384) {
    sendText(response, 414, "Request URI too long");
    return;
  }
  if (!isRequestHostAllowed(request, config)) {
    sendJson(response, 421, {
      error: "Untrusted host",
      code: "untrusted_host",
    });
    return;
  }
  if (config.publicOrigin.protocol === "https:" && context.protocol !== "https") {
    redirect(
      response,
      new URL(requestPathWithQuery(request), config.publicOrigin).toString(),
      308,
    );
    return;
  }
  if (context.protocol === "https") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  if (path.startsWith("/api/")) {
    response.setHeader("Cache-Control", "no-store");
  }

  const hasCookie = hasUnsafeBrowserSession(request, headerValue(request.headers, "cookie"));
  const hasBearer = Boolean(bearerTokenFromRequest(request));
  const isBrowserAuthRequest = path.startsWith("/api/auth/")
    || path.startsWith("/api/setup/")
    || path === "/api/web-auth";
  if (
    UNSAFE_METHODS.has(method)
    && !hasBearer
    && (hasCookie || isBrowserAuthRequest)
    && !isSameOriginRequest(request, config, true)
  ) {
    sendJson(response, 403, {
      error: "Cross-origin request rejected",
      code: "cross_origin_request",
    });
    return;
  }

  if (path === "/healthz" && method === "GET") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (path === "/login" && method === "GET") {
    redirect(response, loginRedirect(request, config));
    return;
  }
  if (path === "/auth/login" && method === "GET") {
    const current = await authenticateRequest(request, service, context.protocol);
    if (current) {
      redirect(response, safeNextPath(new URL(request.url ?? "/", config.publicOrigin).searchParams.get("next")));
      return;
    }
    const page = renderLoginPage();
    sendHtml(response, 200, page.html, page.contentSecurityPolicy);
    return;
  }
  if (path === "/auth/setup" && method === "GET") {
    if (!service.methods().setupRequired) {
      redirect(response, "/auth/login");
      return;
    }
    const page = renderSetupPage();
    sendHtml(response, 200, page.html, page.contentSecurityPolicy);
    return;
  }

  if (path.startsWith("/api/setup/")) {
    if (await handleSetupApi(request, response, service, context, limiter, path, method)) return;
  }
  if (path.startsWith("/api/auth/") || path === "/api/web-auth") {
    if (!isProtectedAuthApi(path)) {
      if (await handleAuthApi(request, response, service, context, limiter, path, method)) return;
      sendJson(response, 404, { error: "Not found", code: "not_found" });
      return;
    }
  }

  const authenticated = await authenticateRequest(request, service, context.protocol);
  if (!authenticated) {
    if (path === "/auth/account" || path.startsWith("/api/auth/") || path === "/api/web-auth") {
      if (path.startsWith("/api/")) {
        sendJson(response, 401, {
          error: "Authentication required",
          code: "authentication_required",
        }, {
          "WWW-Authenticate": "Bearer",
        });
      } else {
        redirect(response, loginRedirect(request, config));
      }
      return;
    }
    if (path.startsWith("/api/")) {
      sendJson(response, 401, {
        error: "Authentication required",
        code: "authentication_required",
      }, {
        "WWW-Authenticate": "Bearer",
      });
    } else {
      redirect(response, loginRedirect(request, config));
    }
    return;
  }
  const current = authenticated.session;

  if (authenticated.source === "bearer") {
    if (
      path === "/api/web-auth"
      || path.startsWith("/api/auth/")
      || path.startsWith("/auth/account")
    ) {
      sendJson(response, 403, {
        error: "Gateway account management requires a browser session",
        code: "browser_session_required",
      });
      return;
    }
    if (!apiTokenAllowsMethod(current.apiTokenScopes ?? [], method)) {
      sendJson(response, 403, {
        error: "API token scope does not allow this request",
        code: "insufficient_scope",
      });
      return;
    }
  }

  if (path.startsWith("/api/auth/")) {
    if (await handleProtectedAuthApi(request, response, service, context, current, path, method)) return;
    sendJson(response, 404, { error: "Not found", code: "not_found" });
    return;
  }
  if (path === "/api/web-auth") {
    if (await handleProtectedAuthApi(request, response, service, context, current, path, method)) return;
  }
  if (path === "/auth/account" && method === "GET") {
    const page = renderAccountPage();
    sendHtml(response, 200, page.html, page.contentSecurityPolicy);
    return;
  }
  if (path === "/auth/account/") {
    redirect(response, "/auth/account");
    return;
  }

  if (!enforceRequestBudget(
    limiter,
    `proxy:${current.session.id}`,
    config.proxyRequestLimit,
    config.proxyRequestWindowMs,
    response,
  )) return;

  await proxyToApp(request, response, config, {
    user: current.user.id,
    session: current.session.id,
  }, service.secrets.attestationSecret);
}

export async function createGatewayServer(
  config: GatewayConfig,
  service: GatewayAuthService,
): Promise<Server> {
  const limiter = new AuthRateLimiter();
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response, service, config, limiter).catch((error) => {
      responseForAuthError(response, error, service, requestContext(request, config));
    });
  };

  const server = config.tlsCertificatePath && config.tlsKeyPath
    ? createHttpsServer({
        cert: await readFile(config.tlsCertificatePath),
        key: await readFile(config.tlsKeyPath),
        minVersion: "TLSv1.2",
      }, handler)
    : createHttpServer(handler);

  server.headersTimeout = config.headersTimeoutMs;
  server.requestTimeout = config.requestTimeoutMs;
  server.keepAliveTimeout = 65_000;
  return server;
}

export async function startGatewayServer(
  config: GatewayConfig,
  service: GatewayAuthService,
): Promise<Server> {
  const server = await createGatewayServer(config, service);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}
