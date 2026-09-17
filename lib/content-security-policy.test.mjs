import assert from "node:assert/strict";
import test from "node:test";
import { contentSecurityPolicy } from "./content-security-policy.ts";

test("builds a nonce-based content security policy with same-origin resources", () => {
  const policy = contentSecurityPolicy("test-nonce");
  assert.match(policy, /script-src 'self' 'nonce-test-nonce'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /unsafe-eval/);
});

test("allows eval only when explicitly enabled for the development server", () => {
  assert.match(
    contentSecurityPolicy("test-nonce", { allowEval: true }),
    /'unsafe-eval'/,
  );
});

test("rejects malformed nonce values", () => {
  assert.throws(() => contentSecurityPolicy("bad\nnonce"), /Invalid CSP nonce/);
});
