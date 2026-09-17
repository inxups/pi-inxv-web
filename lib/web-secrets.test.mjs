import assert from "node:assert/strict";
import test from "node:test";

const { stripWebAuthSecrets } = await import("./web-secrets.ts");

test("removes the web password while preserving unrelated environment variables", () => {
  assert.deepEqual(
    stripWebAuthSecrets({
      PI_WEB_PASSWORD: "secret",
      PI_WEB_HOSTNAME: "127.0.0.1",
      HOME: "/home/pi",
    }, "linux"),
    {
      PI_WEB_HOSTNAME: "127.0.0.1",
      HOME: "/home/pi",
    },
  );
});

test("matches environment variable names case-insensitively on Windows", () => {
  assert.deepEqual(
    stripWebAuthSecrets({
      Pi_Web_Password: "secret",
      PI_WEB_PASSWORD: "second-secret",
      Path: "C:\\Windows",
    }, "win32"),
    { Path: "C:\\Windows" },
  );
});

test("does not remove lowercase secret names on POSIX platforms", () => {
  assert.deepEqual(
    stripWebAuthSecrets({ pi_web_password: "unrelated" }, "linux"),
    { pi_web_password: "unrelated" },
  );
});

test("removes gateway assertion and state secrets from child processes", () => {
  assert.deepEqual(
    stripWebAuthSecrets({
      PI_WEB_GATEWAY_ATTESTATION_SECRET: "assertion",
      PI_WEB_GATEWAY_SECRET_FILE: "/run/pi-web/secrets.json",
      PI_WEB_GATEWAY_STATE_DIR: "/run/pi-web",
      PI_WEB_PUBLIC_ORIGIN: "https://pi.example.com",
    }, "linux"),
    { PI_WEB_PUBLIC_ORIGIN: "https://pi.example.com" },
  );
});
