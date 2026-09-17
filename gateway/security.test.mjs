import assert from "node:assert/strict";
import test from "node:test";
import { AuthRateLimiter } from "./rate-limit.mts";
import { totpCode, verifyTotpCode } from "./totp.mts";

test("matches the RFC 6238 SHA-1 test vector for a six-digit code", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(secret, 59_000), "287082");
  assert.equal(verifyTotpCode(secret, "287082", 59_000)?.step, 1);
});

test("rate limits failures without allocating entries for successful checks", () => {
  const limiter = new AuthRateLimiter();
  assert.equal(limiter.retryAfterMs("unknown"), 0);
  const delay = limiter.recordFailure("ip:127.0.0.1", 1_000);
  assert.equal(delay, 1_000);
  assert.equal(limiter.retryAfterMs("ip:127.0.0.1", 1_000), 1_000);
  assert.equal(limiter.retryAfterMs("ip:127.0.0.1", 2_000), 0);
  limiter.recordSuccess("ip:127.0.0.1");
  assert.equal(limiter.retryAfterMs("ip:127.0.0.1", 2_000), 0);
  assert.equal(limiter.consume("ip:127.0.0.2", 1, 1_000, 2_000), 0);
  assert.equal(limiter.consume("ip:127.0.0.2", 1, 1_000, 2_100), 900);
  assert.equal(limiter.consume("ip:127.0.0.2", 1, 1_000, 3_000), 0);
});
