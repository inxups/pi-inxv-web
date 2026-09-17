import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAppAuthConfiguration,
  isGatewayAuthMode,
  webAuthMode,
} from "./auth-mode.ts";

test("defaults to the local authentication mode", () => {
  assert.equal(webAuthMode({}), "local");
  assert.equal(isGatewayAuthMode({}), false);
});

test("requires a loopback bind and assertion secret in gateway mode", () => {
  const valid = {
    PI_WEB_AUTH_MODE: "gateway",
    PI_WEB_HOSTNAME: "127.0.0.1",
    PI_WEB_GATEWAY_ATTESTATION_SECRET: "secret-with-enough-entropy-for-hmac",
  };
  assert.doesNotThrow(() => assertAppAuthConfiguration(valid));
  assert.throws(
    () => assertAppAuthConfiguration({ ...valid, PI_WEB_HOSTNAME: "0.0.0.0" }),
    /loopback/,
  );
  assert.throws(
    () => assertAppAuthConfiguration({ ...valid, PI_WEB_GATEWAY_ATTESTATION_SECRET: "short" }),
    /at least 32/,
  );
  assert.throws(
    () => assertAppAuthConfiguration({ ...valid, PI_WEB_PASSWORD: "legacy" }),
    /must be unset/,
  );
});

test("rejects an unknown authentication mode", () => {
  assert.throws(() => webAuthMode({ PI_WEB_AUTH_MODE: "proxy" }), /local or gateway/);
});
