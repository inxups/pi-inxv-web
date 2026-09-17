import assert from "node:assert/strict";
import test from "node:test";
import { parseGatewayConfig } from "./config.mts";
import {
  isRequestHostAllowed,
  sessionCookie,
  sessionTokenFromRequest,
} from "./http.mts";

function request(host, remoteAddress) {
  return {
    headers: { host },
    socket: { remoteAddress },
  };
}

test("rejects direct IP-host access to a public hostname deployment", () => {
  const config = parseGatewayConfig({
    PI_WEB_AUTH_MODE: "gateway",
    PI_WEB_PUBLIC_ORIGIN: "https://pi.example.com",
    PI_WEB_GATEWAY_HOST: "127.0.0.1",
    PI_WEB_TRUSTED_PROXIES: "127.0.0.1/32",
    PI_WEB_ALLOWED_HOSTS: "pi.example.com",
  });
  assert.equal(isRequestHostAllowed(request("127.0.0.1:30142", "203.0.113.5"), config), false);
  assert.equal(isRequestHostAllowed(request("pi.example.com", "203.0.113.5"), config), true);
  assert.equal(isRequestHostAllowed(request("127.0.0.1:30142", "127.0.0.1"), config), true);
});

test("allows loopback hosts for a loopback-only development origin", () => {
  const config = parseGatewayConfig({
    PI_WEB_AUTH_MODE: "gateway",
    PI_WEB_PUBLIC_ORIGIN: "http://127.0.0.1:30142",
    PI_WEB_GATEWAY_HOST: "127.0.0.1",
  });
  assert.equal(isRequestHostAllowed(request("127.0.0.1:30142", "127.0.0.1"), config), true);
  assert.equal(isRequestHostAllowed(request("localhost:30142", "127.0.0.1"), config), true);
});

test("does not accept a non-secure legacy cookie over HTTPS", () => {
  const requestWithCookies = {
    headers: {
      cookie: "pi_session=legacy; __Host-pi_session=secure",
    },
    socket: { remoteAddress: "127.0.0.1", encrypted: true },
  };
  assert.equal(sessionTokenFromRequest(requestWithCookies, "https"), "secure");
  assert.equal(sessionTokenFromRequest({
    ...requestWithCookies,
    headers: { cookie: "pi_session=legacy" },
  }, "https"), undefined);
});

test("emits the hardened host-only session cookie over HTTPS", () => {
  const cookie = sessionCookie("https", "token", 3600);
  assert.match(cookie, /^__Host-pi_session=token/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
});
