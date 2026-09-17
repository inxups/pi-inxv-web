import assert from "node:assert/strict";
import test from "node:test";
import { addressMatchesCidr, parseGatewayConfig } from "./config.mts";

const baseEnvironment = {
  HOME: "/tmp/pi-web-gateway-config-test",
  PI_WEB_AUTH_MODE: "gateway",
  PI_WEB_PUBLIC_ORIGIN: "http://127.0.0.1:30142",
  PI_WEB_GATEWAY_HOST: "127.0.0.1",
};

test("accepts loopback HTTP for local setup and testing", () => {
  const config = parseGatewayConfig(baseEnvironment);
  assert.equal(config.authMode, "gateway");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.publicOrigin.origin, "http://127.0.0.1:30142");
});

test("refuses a non-loopback listener without TLS", () => {
  assert.throws(
    () => parseGatewayConfig({
      ...baseEnvironment,
      PI_WEB_GATEWAY_HOST: "0.0.0.0",
      PI_WEB_PUBLIC_ORIGIN: "https://pi.example.com",
    }),
    /without PI_WEB_TLS_CERT/,
  );
});

test("refuses an HTTPS origin without local TLS or a trusted proxy", () => {
  assert.throws(
    () => parseGatewayConfig({
      ...baseEnvironment,
      PI_WEB_PUBLIC_ORIGIN: "https://pi.example.com",
    }),
    /PI_WEB_TRUSTED_PROXIES/,
  );
});

test("accepts a loopback gateway behind an explicitly trusted HTTPS proxy", () => {
  const config = parseGatewayConfig({
    ...baseEnvironment,
    PI_WEB_PUBLIC_ORIGIN: "https://pi.example.com",
    PI_WEB_ALLOWED_HOSTS: "pi.example.com",
    PI_WEB_TRUSTED_PROXIES: "127.0.0.1/32, ::1/128",
  });
  assert.equal(config.publicOrigin.origin, "https://pi.example.com");
  assert.equal(config.trustedProxies.length, 2);
});

test("matches IPv4 and IPv6 trusted proxy ranges", () => {
  assert.equal(addressMatchesCidr("127.0.0.1", { address: "127.0.0.0", prefix: 8 }), true);
  assert.equal(addressMatchesCidr("127.0.1.1", { address: "127.0.0.0", prefix: 8 }), true);
  assert.equal(addressMatchesCidr("10.0.0.1", { address: "127.0.0.0", prefix: 8 }), false);
  assert.equal(addressMatchesCidr("::1", { address: "::1", prefix: 128 }), true);
});

test("rejects unknown authentication modes", () => {
  assert.throws(
    () => parseGatewayConfig({ ...baseEnvironment, PI_WEB_AUTH_MODE: "proxy" }),
    /local or gateway/,
  );
  assert.throws(
    () => parseGatewayConfig({
      ...baseEnvironment,
      PI_WEB_PUBLIC_ORIGIN: "https://pi.example.com",
      PI_WEB_TRUSTED_PROXIES: "0.0.0.0/0",
    }),
    /entire address space/,
  );
});

test("accepts a parent RP ID but rejects unrelated or public-IP RP IDs", () => {
  const valid = parseGatewayConfig({
    ...baseEnvironment,
    PI_WEB_PUBLIC_ORIGIN: "https://pi.example.com",
    PI_WEB_TRUSTED_PROXIES: "127.0.0.1/32",
    PI_WEB_RP_ID: "example.com",
  });
  assert.equal(valid.rpId, "example.com");
  assert.throws(
    () => parseGatewayConfig({
      ...baseEnvironment,
      PI_WEB_PUBLIC_ORIGIN: "https://pi.example.com",
      PI_WEB_TRUSTED_PROXIES: "127.0.0.1/32",
      PI_WEB_RP_ID: "attacker.example",
    }),
    /parent domains/,
  );
  assert.throws(
    () => parseGatewayConfig({
      ...baseEnvironment,
      PI_WEB_PUBLIC_ORIGIN: "https://192.0.2.1",
      PI_WEB_GATEWAY_HOST: "127.0.0.1",
      PI_WEB_TRUSTED_PROXIES: "127.0.0.1/32",
    }),
    /domain name/,
  );
});
