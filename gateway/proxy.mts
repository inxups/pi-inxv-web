import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline, Transform } from "node:stream";
import type { GatewayConfig } from "./config.mts";
import { signGatewayAssertion, GATEWAY_AUTH_HEADER } from "./attestation.ts";
import { headerValue, requestContext, requestPathWithQuery, sendJson } from "./http.mts";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function copyRequestHeaders(
  request: IncomingMessage,
  assertion: string,
  context: ReturnType<typeof requestContext>,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (
      value === undefined
      || HOP_BY_HOP_HEADERS.has(lower)
      || lower === "cookie"
      || lower === "authorization"
      || lower === "proxy-authorization"
      || lower.startsWith("x-pi-gateway-")
    ) {
      continue;
    }
    headers[lower] = value;
  }
  headers[GATEWAY_AUTH_HEADER] = assertion;
  headers["x-forwarded-proto"] = context.protocol;
  if (context.ip) {
    headers["x-forwarded-for"] = context.ip;
  }
  const host = headerValue(request.headers, "host");
  if (host) headers["x-forwarded-host"] = host;
  return headers;
}

function copyResponseHeaders(
  upstream: IncomingMessage,
  response: ServerResponse,
): void {
  for (const [name, value] of Object.entries(upstream.headers)) {
    const lower = name.toLowerCase();
    if (
      value === undefined
      || HOP_BY_HOP_HEADERS.has(lower)
      || lower === "set-cookie"
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
}

export async function proxyToApp(
  request: IncomingMessage,
  response: ServerResponse,
  config: GatewayConfig,
  identity: { user: string; session: string },
  attestationSecret: string,
): Promise<void> {
  const context = requestContext(request, config);
  const path = requestPathWithQuery(request);
  const assertion = await signGatewayAssertion(attestationSecret, {
    user: identity.user,
    session: identity.session,
    method: request.method ?? "GET",
    path,
  });
  const headers = copyRequestHeaders(request, assertion, context);
  const requestOptions = {
    protocol: config.appUrl.protocol,
    hostname: config.appUrl.hostname,
    port: config.appUrl.port || (config.appUrl.protocol === "https:" ? 443 : 80),
    method: request.method,
    path,
    headers,
  };

  await new Promise<void>((resolve) => {
    const upstreamRequest = config.appUrl.protocol === "https:"
      ? httpsRequest(requestOptions)
      : httpRequest(requestOptions);
    let upstreamResponse: IncomingMessage | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    let settled = false;

    const clearTimeoutTimer = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeoutTimer();
      resolve();
    };

    const fail = (status: number, message: string, error?: Error) => {
      if (settled) return;
      if (!response.headersSent) {
        sendJson(response, status, { error: message });
      } else {
        response.destroy(error);
      }
      finish();
    };

    const armTimeout = () => {
      clearTimeoutTimer();
      timeout = setTimeout(() => {
        timedOut = true;
        upstreamResponse?.destroy();
        upstreamRequest.destroy();
        fail(504, "Pi Web backend timed out");
      }, config.upstreamTimeoutMs);
      timeout.unref();
    };

    upstreamRequest.on("response", (incomingResponse) => {
      upstreamResponse = incomingResponse;
      armTimeout();
      incomingResponse.on("data", armTimeout);
      copyResponseHeaders(incomingResponse, response);
      response.writeHead(incomingResponse.statusCode ?? 502);
      incomingResponse.pipe(response);
      incomingResponse.on("end", finish);
      incomingResponse.on("close", finish);
      incomingResponse.on("error", finish);
    });

    upstreamRequest.on("error", (error) => {
      if (timedOut) return;
      fail(502, "Pi Web backend is unavailable", error);
    });

    const contentLength = Number(headerValue(request.headers, "content-length"));
    if (Number.isFinite(contentLength) && contentLength > config.maxRequestBodyBytes) {
      fail(413, "Request body is too large");
      upstreamRequest.destroy();
      return;
    }

    let receivedBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > config.maxRequestBodyBytes) {
          callback(Object.assign(new Error("Request body is too large"), {
            statusCode: 413,
          }));
          return;
        }
        callback(null, chunk);
      },
    });
    armTimeout();
    pipeline(request, limiter, upstreamRequest, (error) => {
      if (error && !settled && !timedOut) {
        const status = (error as Error & { statusCode?: number }).statusCode ?? 502;
        fail(
          status,
          status === 413 ? "Request body is too large" : "Pi Web backend is unavailable",
          error,
        );
      }
    });
  });
}
