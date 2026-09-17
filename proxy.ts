import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  recordAuthSuccess,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import {
  isValidWebSessionToken,
  isValidBasicAuthorization,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
} from "@/lib/web-auth";
import {
  gatewayAttestationSecret,
  isGatewayAuthMode,
} from "@/lib/auth-mode";
import {
  GATEWAY_AUTH_HEADER,
  verifyGatewayAssertion,
} from "@/gateway/attestation";

export async function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  if (isGatewayAuthMode()) {
    const assertion = await verifyGatewayAssertion(
      gatewayAttestationSecret(),
      request.headers.get(GATEWAY_AUTH_HEADER),
      {
        method: request.method,
        path: `${request.nextUrl.pathname}${request.nextUrl.search}`,
      },
    );
    if (assertion) return NextResponse.next();

    if (isApiRequest) {
      return NextResponse.json(
        { error: "Gateway assertion required" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    return new NextResponse("Gateway assertion required", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (!isWebPasswordEnabled(password)) {
    if (request.nextUrl.pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  let authenticated = isValidWebSessionToken(
    request.cookies.get(PI_WEB_SESSION_COOKIE)?.value,
    password,
  );
  const authorization = isApiRequest ? request.headers.get("authorization") : null;
  if (!authenticated && authorization && /^Basic\s/i.test(authorization)) {
    const retryAfterMs = getAuthRetryAfterMs();
    if (retryAfterMs > 0) {
      return new NextResponse("Too many authentication attempts", {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(retryAfterSeconds(retryAfterMs)),
          "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
        },
      });
    }

    authenticated = isValidBasicAuthorization(authorization, password);
    if (authenticated) recordAuthSuccess();
    else recordAuthFailure();
  }
  if (request.nextUrl.pathname === "/login") {
    return authenticated
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }
  if (request.nextUrl.pathname === "/api/web-auth") return NextResponse.next();

  if (!authenticated) {
    if (!isApiRequest) {
      const loginUrl = new URL("/login", request.url);
      if (request.nextUrl.search) {
        loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      }
      return NextResponse.redirect(loginUrl);
    }
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/login", "/api/:path*"] };
