import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { createWebSessionToken } = await jiti.import("./web-auth.ts");
const { recordAuthSuccess } = await import("./auth-throttle.ts");

before(() => { process.env.PI_WEB_PASSWORD = "secret"; });
beforeEach(() => { recordAuthSuccess(); });
after(() => {
  recordAuthSuccess();
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", ...headers },
  });
}

test("redirects page navigation to the login page and preserves its query", async () => {
  const response = await proxy(request("/?session=abc"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login?next=%2F%3Fsession%3Dabc");
});

test("accepts a signed session for pages", async () => {
  const token = createWebSessionToken("secret");
  const response = await proxy(request("/", { Cookie: `pi_web_session=${token}` }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("keeps Basic Auth compatibility for APIs but not pages", async () => {
  const authorization = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
  assert.equal((await proxy(request("/api/sessions", { Authorization: authorization }))).status, 200);
  assert.equal((await proxy(request("/", { Authorization: authorization }))).status, 307);
  assert.equal((await proxy(request("/api/sessions"))).status, 401);
});

test("throttles failed Basic Auth attempts", async () => {
  const authorization = `Basic ${Buffer.from("pi:wrong").toString("base64")}`;
  assert.equal((await proxy(request("/api/sessions", { Authorization: authorization }))).status, 401);

  const blocked = await proxy(request("/api/sessions", { Authorization: authorization }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "1");
  assert.match(blocked.headers.get("www-authenticate"), /^Basic /);
});

test("a signed browser session still works while Basic Auth is throttled", async () => {
  const authorization = `Basic ${Buffer.from("pi:wrong").toString("base64")}`;
  assert.equal((await proxy(request("/api/sessions", { Authorization: authorization }))).status, 401);

  const token = createWebSessionToken("secret");
  const response = await proxy(request("/api/sessions", { Cookie: `pi_web_session=${token}` }));
  assert.equal(response.status, 200);
});

test("leaves the login endpoint reachable without a session", async () => {
  assert.equal((await proxy(request("/login"))).status, 200);
  assert.match(
    (await proxy(request("/login"))).headers.get("content-security-policy"),
    /script-src 'self' 'nonce-/,
  );
  assert.equal((await proxy(request("/api/web-auth"))).status, 200);
});
