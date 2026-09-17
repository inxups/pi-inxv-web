import assert from "node:assert/strict";
import test from "node:test";
import {
  apiTokenAllowsMethod,
  normalizeApiTokenScopes,
  storedApiTokenScopes,
} from "./token-policy.mts";

test("defaults new API tokens to least-privilege agent read access", () => {
  assert.deepEqual(normalizeApiTokenScopes(undefined), ["agent:read"]);
  assert.deepEqual(normalizeApiTokenScopes(["agent:read", "agent:read"]), ["agent:read"]);
  assert.deepEqual(normalizeApiTokenScopes("agent:write"), ["agent:write"]);
  assert.throws(() => normalizeApiTokenScopes(["account"]), /scope must be one of/);
});

test("enforces read and write token scopes by HTTP method", () => {
  assert.equal(apiTokenAllowsMethod(["agent:read"], "GET"), true);
  assert.equal(apiTokenAllowsMethod(["agent:read"], "HEAD"), true);
  assert.equal(apiTokenAllowsMethod(["agent:read"], "POST"), false);
  assert.equal(apiTokenAllowsMethod(["agent:write"], "POST"), true);
  assert.equal(apiTokenAllowsMethod(["agent:write"], "DELETE"), true);
  assert.equal(apiTokenAllowsMethod(["full"], "POST"), true);
  assert.equal(apiTokenAllowsMethod([], "GET"), false);
});

test("treats malformed legacy token scopes as full compatibility access", () => {
  assert.deepEqual(storedApiTokenScopes([]), ["full"]);
  assert.deepEqual(storedApiTokenScopes(["agent:read", "agent:read"]), ["agent:read"]);
});
