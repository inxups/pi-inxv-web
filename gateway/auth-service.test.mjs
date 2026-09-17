import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGatewayConfig } from "./config.mts";
import { loadOrCreateGatewaySecrets } from "./secrets.mts";
import { GatewayDatabase } from "./db.mts";
import { GatewayAuthService, AuthError } from "./auth-service.mts";
import { totpCode } from "./totp.mts";

const context = { ip: "127.0.0.1", userAgent: "test" };
const password = "correct horse battery staple";

async function createService() {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-gateway-auth-"));
  const config = parseGatewayConfig({
    HOME: directory,
    PI_WEB_AUTH_MODE: "gateway",
    PI_WEB_PUBLIC_ORIGIN: "http://localhost:30142",
    PI_WEB_GATEWAY_HOST: "127.0.0.1",
    PI_WEB_GATEWAY_STATE_DIR: directory,
  });
  const secrets = await loadOrCreateGatewaySecrets(config.secretFilePath);
  const service = new GatewayAuthService(
    new GatewayDatabase(config.databasePath),
    secrets,
    config,
  );
  return {
    directory,
    service,
    async close() {
      service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("bootstraps a single operator with TOTP, recovery codes, and revocable sessions", async () => {
  const fixture = await createService();
  try {
    const { service } = fixture;
    assert.equal(service.methods().setupRequired, true);

    const bootstrapCode = service.createBootstrapCode();
    const setup = await service.startSetup(bootstrapCode, context);
    assert.match(setup.totpSecret, /^[A-Z2-7]+$/);
    assert.equal(service.methods().setupRequired, true);

    const setupSession = await service.finishSetup({
      challengeId: setup.challengeId,
      password,
      totpCode: totpCode(setup.totpSecret),
      deviceName: "test-device",
    }, context);
    assert.equal(setupSession.user.username, "pi");
    assert.equal(setupSession.recoveryCodes.length, 10);
    assert.equal(service.methods().setupRequired, false);
    assert.equal(service.methods().totp, true);

    const session = service.authenticateSession(setupSession.token);
    assert.equal(session?.user.id, setupSession.user.id);
    assert.equal(service.revokeSession(setupSession.user.id, setupSession.session.id), true);
    assert.equal(service.authenticateSession(setupSession.token), null);

    const recoverySession = await service.finishRecoveryLogin(
      setupSession.recoveryCodes[0],
      context,
    );
    assert.equal(recoverySession.user.id, setupSession.user.id);
    assert.equal(service.db.listUnusedRecoveryCodes(setupSession.user.id).length, 9);

    const nextCode = totpCode(setup.totpSecret, Date.now() + 30_000);
    const totpSession = await service.finishPasswordTotpLogin(password, nextCode, context);
    assert.equal(totpSession.user.id, setupSession.user.id);
    await assert.rejects(
      async () => service.finishPasswordTotpLogin(password, nextCode, context),
      (error) => error instanceof AuthError && error.code === "replayed_totp",
    );
    await assert.rejects(
      async () => service.finishPasswordTotpLogin("wrong password", nextCode, context),
      (error) => error instanceof AuthError && error.code === "invalid_password",
    );
  } finally {
    await fixture.close();
  }
});

test("creates and revokes API tokens", async () => {
  const fixture = await createService();
  try {
    const { service } = fixture;
    const code = service.createBootstrapCode();
    const setup = await service.startSetup(code, context);
    await service.finishSetup({
      challengeId: setup.challengeId,
      password,
      totpCode: totpCode(setup.totpSecret),
    }, context);

    const token = service.issueApiToken("test", null, ["agent:read"]);
    assert.deepEqual(
      service.authenticateApiToken(token.token)?.apiTokenScopes,
      ["agent:read"],
    );
    assert.equal(service.revokeApiToken(token.id), true);
    assert.equal(service.authenticateApiToken(token.token), null);

    const writeToken = service.issueApiToken("write", null, ["agent:write"]);
    assert.deepEqual(
      service.authenticateApiToken(writeToken.token)?.apiTokenScopes,
      ["agent:write"],
    );
    assert.equal(
      service.listAudit(50).some((entry) => entry.event === "api_token_revoked"),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("rotates TOTP and recovery codes without preserving old credentials", async () => {
  const fixture = await createService();
  try {
    const { service } = fixture;
    const code = service.createBootstrapCode();
    const setup = await service.startSetup(code, context);
    const initial = await service.finishSetup({
      challengeId: setup.challengeId,
      password,
      totpCode: totpCode(setup.totpSecret),
    }, context);

    const rotated = service.rotateTotpSecret();
    assert.notEqual(rotated.secret, setup.totpSecret);
    assert.equal(service.authenticateSession(initial.token), null);
    await assert.rejects(
      async () => service.finishPasswordTotpLogin(
        password,
        totpCode(setup.totpSecret, Date.now() + 30_000),
        context,
      ),
      (error) => error instanceof AuthError && error.code === "invalid_totp",
    );

    const newSession = await service.finishPasswordTotpLogin(
      password,
      totpCode(rotated.secret, Date.now() + 30_000),
      context,
    );
    assert.equal(newSession.user.id, initial.user.id);

    const oldRecovery = initial.recoveryCodes[0];
    const regenerated = await service.regenerateRecoveryCodes();
    assert.equal(regenerated.length, 10);
    await assert.rejects(
      async () => service.finishRecoveryLogin(oldRecovery, context),
      (error) => error instanceof AuthError && error.code === "invalid_recovery_code",
    );
    assert.equal((await service.finishRecoveryLogin(regenerated[0], context)).user.id, initial.user.id);
  } finally {
    await fixture.close();
  }
});

test("rejects reuse of an invalid bootstrap code and unavailable passkeys", async () => {
  const fixture = await createService();
  try {
    const { service } = fixture;
    await assert.rejects(
      async () => service.startSetup("wrong", context),
      (error) => error instanceof AuthError && error.code === "invalid_bootstrap_code",
    );
    await assert.rejects(
      async () => service.finishPasswordTotpLogin(password, "000000", context),
      (error) => error instanceof AuthError && error.code === "mfa_unavailable",
    );
    await assert.rejects(
      async () => service.startPasskeyLogin(context),
      (error) => error instanceof AuthError && error.code === "setup_required",
    );
  } finally {
    await fixture.close();
  }
});
