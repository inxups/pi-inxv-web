import assert from "node:assert/strict";
import test from "node:test";

const { safeLoginDestination } = await import("./login-destination.ts");

const ORIGIN = "https://pi.example.com";

test("preserves same-origin paths, query strings, and fragments", () => {
  assert.equal(
    safeLoginDestination("/chat?session=abc#latest", ORIGIN),
    "/chat?session=abc#latest",
  );
  assert.equal(safeLoginDestination("/%5Cevil.example", ORIGIN), "/%5Cevil.example");
});

test("rejects absolute, protocol-relative, and backslash-normalized destinations", () => {
  assert.equal(safeLoginDestination("https://evil.example", ORIGIN), "/");
  assert.equal(safeLoginDestination("//evil.example", ORIGIN), "/");
  assert.equal(safeLoginDestination("/\\evil.example", ORIGIN), "/");
  assert.equal(safeLoginDestination("///evil.example", ORIGIN), "/");
});

test("falls back to root for missing, malformed, or non-path values", () => {
  assert.equal(safeLoginDestination(null, ORIGIN), "/");
  assert.equal(safeLoginDestination("chat", ORIGIN), "/");
  assert.equal(safeLoginDestination("/chat", "not a url"), "/");
});
