import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGatewayConfig } from "./config.mts";
import { loadOrCreateGatewaySecrets } from "./secrets.mts";
import { GatewayDatabase } from "./db.mts";
import { GatewayAuthService } from "./auth-service.mts";
import { startGatewayServer } from "./server.mts";
import { totpCode } from "./totp.mts";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("gateway authenticates before proxying and strips browser credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-gateway-server-"));
  const gatewayPort = await freePort();
  const upstreamPort = await freePort();
  const observed = [];
  const upstream = createServer((request, response) => {
    observed.push({
      url: request.url,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      assertion: request.headers["x-pi-gateway-auth"],
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, url: request.url }));
  });
  upstream.listen(upstreamPort, "127.0.0.1");
  await once(upstream, "listening");

  const config = parseGatewayConfig({
    HOME: directory,
    PI_WEB_AUTH_MODE: "gateway",
    PI_WEB_PUBLIC_ORIGIN: `http://localhost:${gatewayPort}`,
    PI_WEB_APP_URL: `http://127.0.0.1:${upstreamPort}`,
    PI_WEB_GATEWAY_HOST: "127.0.0.1",
    PI_WEB_GATEWAY_PORT: String(gatewayPort),
    PI_WEB_GATEWAY_STATE_DIR: directory,
  });
  const secrets = await loadOrCreateGatewaySecrets(config.secretFilePath);
  const service = new GatewayAuthService(
    new GatewayDatabase(config.databasePath),
    secrets,
    config,
  );
  const gateway = await startGatewayServer(config, service);

  try {
    const publicOrigin = `http://localhost:${gatewayPort}`;
    const bootstrap = service.createBootstrapCode();
    let response = await fetch(`${publicOrigin}/api/setup/start`, {
      method: "POST",
      headers: {
        Origin: publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: bootstrap }),
    });
    assert.equal(response.status, 200);
    const setup = await response.json();
    assert.equal(typeof setup.totpSecret, "string");

    response = await fetch(`${publicOrigin}/api/setup/finish`, {
      method: "POST",
      headers: {
        Origin: publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        challengeId: setup.challengeId,
        password: "correct horse battery staple",
        totpCode: totpCode(setup.totpSecret),
      }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    assert.match(cookie, /^pi_session=/);

    response = await fetch(`${publicOrigin}/`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, url: "/" });
    assert.equal(observed.length, 1);
    assert.equal(observed[0].cookie, undefined);
    assert.match(observed[0].assertion, /^v1\./);

    response = await fetch(`${publicOrigin}/api/sessions`);
    assert.equal(response.status, 401);
    assert.equal(observed.length, 1);

    const apiToken = service.issueApiToken("test-cli", null, ["agent:read"]).token;
    response = await fetch(`${publicOrigin}/api/sessions`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(response.status, 200);
    assert.equal(observed.length, 2);
    assert.equal(observed[1].authorization, undefined);
    assert.match(observed[1].assertion, /^v1\./);

    response = await fetch(`${publicOrigin}/api/agent/test`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "insufficient_scope");
    assert.equal(observed.length, 2);

    response = await fetch(`${publicOrigin}/api/auth/account`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "browser_session_required");

    const writeToken = service.issueApiToken("test-write", null, ["agent:write"]).token;
    response = await fetch(`${publicOrigin}/api/agent/test`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${writeToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal(observed.length, 3);
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("streams SSE through the gateway and times out a stalled upstream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-gateway-stream-"));
  const gatewayPort = await freePort();
  const upstreamPort = await freePort();
  const upstream = createServer((request, response) => {
    if (request.url === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      });
      response.write("data: first\n\n");
      setTimeout(() => response.end("data: second\n\n"), 20);
      return;
    }
    if (request.url === "/slow") return;
    response.writeHead(404);
    response.end();
  });
  upstream.listen(upstreamPort, "127.0.0.1");
  await once(upstream, "listening");

  const config = parseGatewayConfig({
    HOME: directory,
    PI_WEB_AUTH_MODE: "gateway",
    PI_WEB_PUBLIC_ORIGIN: `http://localhost:${gatewayPort}`,
    PI_WEB_APP_URL: `http://127.0.0.1:${upstreamPort}`,
    PI_WEB_GATEWAY_HOST: "127.0.0.1",
    PI_WEB_GATEWAY_PORT: String(gatewayPort),
    PI_WEB_GATEWAY_STATE_DIR: directory,
    PI_WEB_GATEWAY_UPSTREAM_TIMEOUT_MS: "1000",
  });
  const secrets = await loadOrCreateGatewaySecrets(config.secretFilePath);
  const service = new GatewayAuthService(
    new GatewayDatabase(config.databasePath),
    secrets,
    config,
  );
  const gateway = await startGatewayServer(config, service);

  try {
    const publicOrigin = `http://localhost:${gatewayPort}`;
    const bootstrap = service.createBootstrapCode();
    const setup = await service.startSetup(bootstrap, {
      ip: "127.0.0.1",
      userAgent: "test",
    });
    await service.finishSetup({
      challengeId: setup.challengeId,
      password: "correct horse battery staple",
      totpCode: totpCode(setup.totpSecret),
    }, {
      ip: "127.0.0.1",
      userAgent: "test",
    });
    const token = service.issueApiToken("sse", null, ["agent:read"]).token;

    let response = await fetch(`${publicOrigin}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    assert.equal(await response.text(), "data: first\n\ndata: second\n\n");

    const startedAt = Date.now();
    response = await fetch(`${publicOrigin}/slow`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error, "Pi Web backend timed out");
    assert.ok(Date.now() - startedAt >= 900);
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
