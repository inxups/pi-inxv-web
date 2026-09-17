import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalMode = process.env.PI_WEB_AUTH_MODE;
const originalSecret = process.env.PI_WEB_GATEWAY_ATTESTATION_SECRET;
const secret = "gateway-attestation-secret-with-enough-entropy";
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { signGatewayAssertion, GATEWAY_AUTH_HEADER } = await jiti.import(
  "../gateway/attestation.ts",
);

before(() => {
  process.env.PI_WEB_AUTH_MODE = "gateway";
  process.env.PI_WEB_GATEWAY_ATTESTATION_SECRET = secret;
});
after(() => {
  if (originalMode === undefined) delete process.env.PI_WEB_AUTH_MODE;
  else process.env.PI_WEB_AUTH_MODE = originalMode;
  if (originalSecret === undefined) delete process.env.PI_WEB_GATEWAY_ATTESTATION_SECRET;
  else process.env.PI_WEB_GATEWAY_ATTESTATION_SECRET = originalSecret;
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", ...headers },
  });
}

test("accepts only a valid gateway assertion for the exact request", async () => {
  const assertion = await signGatewayAssertion(secret, {
    user: "user-id",
    session: "session-id",
    method: "GET",
    path: "/api/sessions",
  });
  const accepted = await proxy(request("/api/sessions", {
    [GATEWAY_AUTH_HEADER]: assertion,
  }));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("x-middleware-next"), "1");

  const rejected = await proxy(request("/api/other", {
    [GATEWAY_AUTH_HEADER]: assertion,
  }));
  assert.equal(rejected.status, 401);
});

test("does not fall back to PI_WEB_PASSWORD in gateway mode", async () => {
  const response = await proxy(request("/api/sessions", {
    Authorization: `Basic ${Buffer.from("pi:secret").toString("base64")}`,
  }));
  assert.equal(response.status, 401);
});
