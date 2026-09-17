import assert from "node:assert/strict";
import test from "node:test";
import {
  renderAccountPage,
  renderLoginPage,
  renderSetupPage,
} from "./pages.mts";

function scriptOf(html) {
  const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(match, "page script is present");
  assert.doesNotThrow(() => new Function(match[1]));
  return match[1];
}

test("renders compilable gateway login, setup, and account pages", () => {
  const login = renderLoginPage();
  assert.match(login.html, /totp-password/);
  assert.match(scriptOf(login.html), /password: \$\("#totp-password"\)\.value/);

  const setup = renderSetupPage();
  assert.match(setup.html, /finish-password/);
  assert.match(scriptOf(setup.html), /password: \$\("#finish-password"\)\.value/);

  const account = renderAccountPage();
  assert.match(account.html, /id="tokens"/);
  assert.match(scriptOf(account.html), /\/api\/auth\/api-tokens\//);
});
