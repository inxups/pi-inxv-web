import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createProbe } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, "test-results/gateway-auth");
mkdirSync(artifacts, { recursive: true });
const stateDir = mkdtempSync(join(tmpdir(), "pi-web-gateway-e2e-"));
const jiti = createJiti(import.meta.url, {
  alias: { "@": root },
  interopDefault: true,
});
const { parseGatewayConfig } = await jiti.import("../gateway/config.mts");
const { loadOrCreateGatewaySecrets } = await jiti.import("../gateway/secrets.mts");
const { GatewayDatabase } = await jiti.import("../gateway/db.mts");
const { GatewayAuthService } = await jiti.import("../gateway/auth-service.mts");
const { startGatewayServer } = await jiti.import("../gateway/server.mts");
const { totpCode } = await jiti.import("../gateway/totp.mts");

async function freePort() {
  const server = createProbe();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const gatewayPort = await freePort();
const upstreamPort = await freePort();
const publicOrigin = `http://localhost:${gatewayPort}`;
const upstream = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
});
upstream.listen(upstreamPort, "127.0.0.1");
await once(upstream, "listening");

const config = parseGatewayConfig({
  HOME: stateDir,
  PI_WEB_AUTH_MODE: "gateway",
  PI_WEB_PUBLIC_ORIGIN: publicOrigin,
  PI_WEB_APP_URL: `http://127.0.0.1:${upstreamPort}`,
  PI_WEB_GATEWAY_HOST: "127.0.0.1",
  PI_WEB_GATEWAY_PORT: String(gatewayPort),
  PI_WEB_GATEWAY_STATE_DIR: stateDir,
});
const secrets = await loadOrCreateGatewaySecrets(config.secretFilePath);
const service = new GatewayAuthService(
  new GatewayDatabase(config.databasePath),
  secrets,
  config,
);
const gateway = await startGatewayServer(config, service);
const bootstrap = service.createBootstrapCode();

let browser;
let context;
let page;
try {
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto(`${publicOrigin}/auth/setup`);
  await page.locator("#setup-code").fill(bootstrap);
  await page.locator("#setup-form button").click();
  await page.locator("#finish").waitFor({ state: "visible" });

  const totpSecret = (await page.locator("#totp-secret").textContent())?.trim();
  assert.ok(totpSecret, "setup must display a TOTP secret");
  await page.locator("#register-passkey").click();
  await page.getByText(/Passkey 已获取/).waitFor();
  await page.locator("#finish-password").fill("correct horse battery staple");
  await page.locator("#finish-code").fill(totpCode(totpSecret));
  await page.locator("#finish-form button").click();
  await page.locator("#recovery").waitFor({ state: "visible" });
  const recoveryCodes = (await page.locator("#recovery-codes").textContent())?.trim().split("\n") ?? [];
  assert.equal(recoveryCodes.length, 10);

  const cookies = await context.cookies(publicOrigin);
  const sessionCookie = cookies.find((cookie) => cookie.name === "pi_session");
  assert.ok(sessionCookie, "loopback setup must issue a session cookie");
  assert.equal(sessionCookie.httpOnly, true);
  assert.equal(sessionCookie.sameSite, "Strict");

  await page.goto(`${publicOrigin}/auth/account`);
  await page.locator("#token-form").waitFor();
  await page.locator("#token-name").fill("browser-read");
  await page.locator("#token-scope").selectOption("agent:read");
  await page.locator("#token-expiry").selectOption("7");
  await page.locator("#token-form button").click();
  await page.locator("#new-token-wrap").waitFor({ state: "visible" });
  const readToken = (await page.locator("#new-token").textContent())?.trim();
  assert.match(readToken, /^piw_a_/);
  await page.getByText("api_token_created", { exact: true }).waitFor();

  let response = await fetch(`${publicOrigin}/api/sessions`, {
    headers: { Authorization: `Bearer ${readToken}` },
  });
  assert.equal(response.status, 200);

  response = await fetch(`${publicOrigin}/api/agent/browser-test`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "insufficient_scope");

  response = await fetch(`${publicOrigin}/api/auth/account`, {
    headers: { Authorization: `Bearer ${readToken}` },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "browser_session_required");

  await page.locator("#logout").click();
  await page.waitForURL(`${publicOrigin}/auth/login`);
  await page.locator("#passkey").click();
  await page.waitForURL(`${publicOrigin}/`);

  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  console.log("PASS: gateway browser setup, Passkey registration, token scopes, audit, and Passkey login");
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await closeServer(gateway);
  await closeServer(upstream);
  service.close();
  rmSync(stateDir, { recursive: true, force: true });
}
