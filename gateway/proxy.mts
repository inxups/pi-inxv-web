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
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    upstreamRequest.on("response", (upstreamResponse) => {
      copyResponseHeaders(upstreamResponse, response);
      response.writeHead(upstreamResponse.statusCode ?? 502);
      upstreamResponse.pipe(response);
      upstreamResponse.on("end", finish);
      upstreamResponse.on("error", finish);
    });

    upstreamRequest.on("error", (error) => {
      if (!response.headersSent) {
        sendJson(response, 502, { error: "Pi Web backend is unavailable" });
      } else {
        response.destroy(error);
      }
      finish();
    });

    const contentLength = Number(headerValue(request.headers, "content-length"));
    if (Number.isFinite(contentLength) && contentLength > config.maxRequestBodyBytes) {
      if (!response.headersSent) {
        sendJson(response, 413, { error: "Request body is too large" });
      }
      upstreamRequest.destroy();
      finish();
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
    pipeline(request, limiter, upstreamRequest, (error) => {
      if (error) {
        const status = (error as Error & { statusCode?: number }).statusCode ?? 502;
        if (!response.headersSent) {
          sendJson(response, status, {
            error: status === 413 ? "Request body is too large" : "Pi Web backend is unavailable",
          });
        } else {
          response.destroy(error);
        }
        finish();
      }
    });
  });
}
