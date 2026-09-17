import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import type { GatewayConfig } from "./config.mts";
import {
  GatewayDatabase,
  type StoredChallenge,
  type StoredCredential,
  type StoredSession,
  type StoredUser,
} from "./db.mts";
import {
  constantTimeEqual,
  decryptString,
  encryptString,
  hmacSha256,
  newOpaqueToken,
  sha256,
} from "./crypto.mts";
import type { GatewaySecrets } from "./secrets.mts";
import { generateTotpSecret, totpUri, verifyTotpCode } from "./totp.mts";

const SETUP_CHALLENGE_TTL_MS = 10 * 60_000;
const LOGIN_CHALLENGE_TTL_MS = 2 * 60_000;
const BOOTSTRAP_CODE_TTL_MS = 15 * 60_000;

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export interface AuthContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface IssuedSession {
  readonly session: StoredSession;
  readonly token: string;
  readonly csrfToken: string;
  readonly user: StoredUser;
}

export interface AuthMethods {
  readonly setupRequired: boolean;
  readonly passkeys: number;
  readonly totp: boolean;
  readonly recoveryCodes: number;
  readonly password: boolean;
}

interface SetupChallengeData {
  readonly userId: string;
  readonly encryptedTotpSecret: string;
}

function challengeData<T>(challenge: StoredChallenge): T {
  return challenge.data as T;
}

function newId(): string {
  return crypto.randomUUID();
}

function credentialToWebAuthn(credential: StoredCredential): WebAuthnCredential {
  return {
    id: credential.id,
    publicKey: credential.publicKey as Uint8Array<ArrayBuffer>,
    counter: credential.counter,
    transports: credential.transports as WebAuthnCredential["transports"],
  };
}

function securityHeadersForJson(): Record<string, string> {
  return { "Cache-Control": "no-store" };
}

export class GatewayAuthService {
  readonly db: GatewayDatabase;
  readonly secrets: GatewaySecrets;
  readonly config: GatewayConfig;

  constructor(
    db: GatewayDatabase,
    secrets: GatewaySecrets,
    config: GatewayConfig,
  ) {
    this.db = db;
    this.secrets = secrets;
    this.config = config;
  }

  close(): void {
    this.db.close();
  }

  getUser(): StoredUser | null {
    return this.db.getUserByUsername(this.config.username);
  }

  methods(): AuthMethods {
    const user = this.getUser();
    const credentials = user ? this.db.listCredentials(user.id) : [];
    const recoveryCodes = user ? this.db.listUnusedRecoveryCodes(user.id) : [];
    return {
      setupRequired: !user,
      passkeys: credentials.length,
      totp: Boolean(user?.totpSecret),
      recoveryCodes: recoveryCodes.length,
      password: Boolean(user?.passwordHash),
    };
  }

  createBootstrapCode(now = Date.now()): string {
    if (this.getUser()) {
      throw new AuthError(409, "already_configured", "Gateway setup is already complete");
    }
    const code = `piw_setup_${newOpaqueToken()}`;
    this.db.createBootstrapCode(
      newId(),
      hmacSha256(this.secrets.attestationSecret, `bootstrap:${code}`),
      now,
      now + BOOTSTRAP_CODE_TTL_MS,
    );
    this.db.appendAudit("bootstrap_code_created", null, null, null, undefined, now);
    return code;
  }

  private verifyBootstrapCode(code: string, now: number): { id: string } {
    const codeHash = hmacSha256(
      this.secrets.attestationSecret,
      `bootstrap:${code}`,
    );
    const found = this.db.findBootstrapCodeByHash(codeHash, now);
    if (!found) {
      throw new AuthError(401, "invalid_bootstrap_code", "Invalid or expired setup code");
    }
    this.db.markBootstrapCodeUsed(found.id, now);
    return found;
  }

  async startSetup(code: string, context: AuthContext): Promise<{
    challengeId: string;
    passkeyOptions: Awaited<ReturnType<typeof generateRegistrationOptions>>;
    totpSecret: string;
    totpUri: string;
    recoveryCodeCount: number;
  }> {
    this.verifyBootstrapCode(code, Date.now());
    if (this.getUser()) {
      throw new AuthError(409, "already_configured", "Gateway setup is already complete");
    }

    const userId = newId();
    const totpSecret = generateTotpSecret();
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      userID: new TextEncoder().encode(userId),
      userName: this.config.username,
      userDisplayName: this.config.displayName,
      attestationType: "none",
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      timeout: 60_000,
    });
    const challengeId = newId();
    this.db.deleteChallenges("setup", null);
    this.db.createChallenge({
      id: challengeId,
      kind: "setup",
      userId: null,
      challenge: options.challenge,
      data: {
        userId,
        encryptedTotpSecret: encryptString(totpSecret, this.secrets.encryptionKey),
      } satisfies SetupChallengeData,
      expiresAt: Date.now() + SETUP_CHALLENGE_TTL_MS,
    });
    this.db.appendAudit("setup_started", null, context.ip, context.userAgent, undefined);
    return {
      challengeId,
      passkeyOptions: options,
      totpSecret,
      totpUri: totpUri(totpSecret, this.config.username, this.config.rpName),
      recoveryCodeCount: 10,
    };
  }

  private async createRecoveryCodeHashes(): Promise<{
    rawCodes: string[];
    storedCodes: Array<{ id: string; codeHash: string }>;
  }> {
    const rawCodes: string[] = [];
    const storedCodes: Array<{ id: string; codeHash: string }> = [];
    for (let index = 0; index < 10; index += 1) {
      const code = newOpaqueToken("piw_recovery_");
      rawCodes.push(code);
      storedCodes.push({
        id: newId(),
        codeHash: await argonHash(code, {
          algorithm: 2,
          memoryCost: 19_456,
          timeCost: 2,
          parallelism: 1,
          outputLen: 32,
        }),
      });
    }
    return { rawCodes, storedCodes };
  }

  async finishSetup(
    input: {
      challengeId: string;
      credential?: RegistrationResponseJSON;
      password: string;
      totpCode: string;
      deviceName?: string;
    },
    context: AuthContext,
  ): Promise<IssuedSession & { recoveryCodes: string[] }> {
    const challenge = this.db.takeChallenge(input.challengeId, "setup", Date.now());
    if (!challenge) {
      throw new AuthError(400, "invalid_challenge", "Setup challenge expired");
    }
    const data = challengeData<SetupChallengeData>(challenge);
    const totpSecret = decryptString(data.encryptedTotpSecret, this.secrets.encryptionKey);
    if (input.password.length < 16 || input.password.length > 1024) {
      throw new AuthError(400, "weak_password", "Password must be between 16 and 1024 characters");
    }
    const verification = verifyTotpCode(totpSecret, input.totpCode, Date.now(), 1);
    if (!verification) {
      throw new AuthError(401, "invalid_totp", "Invalid authenticator code");
    }

    let verifiedCredential:
      | {
          id: string;
          publicKey: Uint8Array;
          counter: number;
          transports: string[];
          deviceType: string;
          backedUp: boolean;
        }
      | undefined;
    if (input.credential) {
      let registration: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        registration = await verifyRegistrationResponse({
          response: input.credential,
          expectedChallenge: challenge.challenge,
          expectedOrigin: this.config.publicOrigin.origin,
          expectedRPID: this.config.rpId,
          requireUserPresence: true,
          requireUserVerification: true,
        });
      } catch {
        throw new AuthError(401, "invalid_passkey", "Passkey registration failed");
      }
      if (!registration.verified) {
        throw new AuthError(401, "invalid_passkey", "Passkey registration failed");
      }
      verifiedCredential = {
        id: registration.registrationInfo.credential.id,
        publicKey: registration.registrationInfo.credential.publicKey,
        counter: registration.registrationInfo.credential.counter,
        transports: registration.registrationInfo.credential.transports ?? [],
        deviceType: registration.registrationInfo.credentialDeviceType,
        backedUp: registration.registrationInfo.credentialBackedUp,
      };
    }

    const [recovery, passwordHash] = await Promise.all([
      this.createRecoveryCodeHashes(),
      argonHash(input.password, {
        algorithm: 2,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
        outputLen: 32,
      }),
    ]);
    const now = Date.now();
    const user: StoredUser = {
      id: data.userId,
      username: this.config.username,
      displayName: this.config.displayName,
      passwordHash,
      totpSecret: data.encryptedTotpSecret,
      totpLastStep: verification.step,
      createdAt: now,
    };

    this.db.createUser(user);
    if (verifiedCredential) {
      this.db.createCredential({
        id: verifiedCredential.id,
        userId: user.id,
        publicKey: verifiedCredential.publicKey,
        counter: verifiedCredential.counter,
        transports: verifiedCredential.transports,
        deviceType: verifiedCredential.deviceType,
        backedUp: verifiedCredential.backedUp,
        name: input.deviceName?.trim() || "Primary passkey",
        createdAt: now,
        lastUsedAt: null,
      });
    }
    this.db.createRecoveryCodes(user.id, recovery.storedCodes, now);
    this.db.appendAudit("setup_completed", user.id, context.ip, context.userAgent, {
      passkey: Boolean(verifiedCredential),
    }, now);

    const session = this.createSession(user.id, context, now);
    return { ...session, recoveryCodes: recovery.rawCodes };
  }

  async startPasskeyLogin(context: AuthContext): Promise<{
    challengeId: string;
    options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
  }> {
    const user = this.getUser();
    if (!user) {
      throw new AuthError(409, "setup_required", "Gateway setup is required");
    }
    const credentials = this.db.listCredentials(user.id);
    if (credentials.length === 0) {
      throw new AuthError(409, "passkey_unavailable", "No passkey is registered");
    }
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      allowCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports as WebAuthnCredential["transports"],
      })),
      userVerification: "required",
      timeout: 60_000,
    });
    const challengeId = newId();
    this.db.deleteChallenges("passkey-login", user.id);
    this.db.createChallenge({
      id: challengeId,
      kind: "passkey-login",
      userId: user.id,
      challenge: options.challenge,
      data: { ip: context.ip, userAgent: context.userAgent },
      expiresAt: Date.now() + LOGIN_CHALLENGE_TTL_MS,
    });
    return { challengeId, options };
  }

  async finishPasskeyLogin(
    input: { challengeId: string; response: AuthenticationResponseJSON },
    context: AuthContext,
  ): Promise<IssuedSession> {
    const challenge = this.db.takeChallenge(input.challengeId, "passkey-login", Date.now());
    if (!challenge) {
      throw new AuthError(400, "invalid_challenge", "Authentication challenge expired");
    }
    const user = this.getUser();
    if (!user || challenge.userId !== user.id) {
      throw new AuthError(401, "invalid_credentials", "Authentication failed");
    }
    const storedCredential = this.db.getCredential(input.response.id);
    if (!storedCredential || storedCredential.userId !== user.id) {
      throw new AuthError(401, "invalid_credentials", "Authentication failed");
    }
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.config.publicOrigin.origin,
        expectedRPID: this.config.rpId,
        credential: credentialToWebAuthn(storedCredential),
        requireUserVerification: true,
      });
    } catch {
      throw new AuthError(401, "invalid_credentials", "Authentication failed");
    }
    if (!verification.verified) {
      throw new AuthError(401, "invalid_credentials", "Authentication failed");
    }
    const now = Date.now();
    this.db.updateCredentialCounter(
      storedCredential.id,
      verification.authenticationInfo.newCounter,
      now,
    );
    this.db.appendAudit("login_passkey", user.id, context.ip, context.userAgent, undefined, now);
    return this.createSession(user.id, context, now);
  }

  async startPasskeyRegistration(
    context: AuthContext,
    deviceName?: string,
  ): Promise<{
    challengeId: string;
    options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
  }> {
    const user = this.getUser();
    if (!user) {
      throw new AuthError(409, "setup_required", "Gateway setup is required");
    }
    const credentials = this.db.listCredentials(user.id);
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      userID: new TextEncoder().encode(user.id),
      userName: user.username,
      userDisplayName: user.displayName,
      attestationType: "none",
      excludeCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports as WebAuthnCredential["transports"],
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      timeout: 60_000,
    });
    const challengeId = newId();
    this.db.deleteChallenges("passkey-register", user.id);
    this.db.createChallenge({
      id: challengeId,
      kind: "passkey-register",
      userId: user.id,
      challenge: options.challenge,
      data: { deviceName: deviceName?.trim() || "Passkey" },
      expiresAt: Date.now() + SETUP_CHALLENGE_TTL_MS,
    });
    return { challengeId, options };
  }

  async finishPasskeyRegistration(
    input: {
      challengeId: string;
      response: RegistrationResponseJSON;
      deviceName?: string;
    },
    context: AuthContext,
  ): Promise<StoredCredential> {
    const challenge = this.db.takeChallenge(
      input.challengeId,
      "passkey-register",
      Date.now(),
    );
    const user = this.getUser();
    if (!challenge || !user || challenge.userId !== user.id) {
      throw new AuthError(400, "invalid_challenge", "Passkey challenge expired");
    }
    const data = challenge.data as { deviceName?: string };
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.config.publicOrigin.origin,
        expectedRPID: this.config.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
    } catch {
      throw new AuthError(401, "invalid_passkey", "Passkey registration failed");
    }
    if (!verification.verified) {
      throw new AuthError(401, "invalid_passkey", "Passkey registration failed");
    }
    const now = Date.now();
    const credential: StoredCredential = {
      id: verification.registrationInfo.credential.id,
      userId: user.id,
      publicKey: verification.registrationInfo.credential.publicKey,
      counter: verification.registrationInfo.credential.counter,
      transports: verification.registrationInfo.credential.transports ?? [],
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
      name: input.deviceName?.trim() || data.deviceName?.trim() || "Passkey",
      createdAt: now,
      lastUsedAt: null,
    };
    this.db.createCredential(credential);
    this.db.appendAudit("passkey_added", user.id, context.ip, context.userAgent, {
      credentialId: credential.id,
    }, now);
    return credential;
  }

  async finishPasswordTotpLogin(
    password: string,
    code: string,
    context: AuthContext,
  ): Promise<IssuedSession> {
    const user = this.getUser();
    if (!user?.totpSecret || !user.passwordHash) {
      throw new AuthError(
        409,
        "mfa_unavailable",
        "Password and authenticator login are not configured",
      );
    }
    if (!await argonVerify(user.passwordHash, password)) {
      throw new AuthError(401, "invalid_password", "Invalid password or authenticator code");
    }
    const secret = decryptString(user.totpSecret, this.secrets.encryptionKey);
    const verification = verifyTotpCode(secret, code, Date.now(), 1);
    if (!verification) {
      throw new AuthError(401, "invalid_totp", "Invalid password or authenticator code");
    }
    if (user.totpLastStep !== null && verification.step <= user.totpLastStep) {
      throw new AuthError(401, "replayed_totp", "Authenticator code was already used");
    }
    const now = Date.now();
    this.db.updateUserLastTotpStep(user.id, verification.step);
    this.db.appendAudit("login_totp", user.id, context.ip, context.userAgent, undefined, now);
    return this.createSession(user.id, context, now);
  }

  async finishRecoveryLogin(code: string, context: AuthContext): Promise<IssuedSession> {
    const user = this.getUser();
    if (!user) {
      throw new AuthError(409, "setup_required", "Gateway setup is required");
    }
    const recoveryCodes = this.db.listUnusedRecoveryCodes(user.id);
    for (const recoveryCode of recoveryCodes) {
      if (await argonVerify(recoveryCode.codeHash, code)) {
        const now = Date.now();
        this.db.markRecoveryCodeUsed(recoveryCode.id, now);
        this.db.appendAudit(
          "login_recovery_code",
          user.id,
          context.ip,
          context.userAgent,
          undefined,
          now,
        );
        return this.createSession(user.id, context, now);
      }
    }
    throw new AuthError(401, "invalid_recovery_code", "Invalid recovery code");
  }

  createSession(
    userId: string,
    context: AuthContext,
    now = Date.now(),
  ): IssuedSession {
    const user = this.db.getUserById(userId);
    if (!user) throw new AuthError(401, "invalid_user", "User no longer exists");
    const token = newOpaqueToken("piw_s_");
    const csrfToken = newOpaqueToken();
    const session: StoredSession = {
      id: newId(),
      userId,
      tokenHash: sha256(token),
      csrfHash: sha256(csrfToken),
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: now + this.config.sessionIdleMs,
      absoluteExpiresAt: now + this.config.sessionAbsoluteMs,
      ip: context.ip,
      userAgent: context.userAgent,
      revokedAt: null,
    };
    this.db.createSession(session);
    return { session, token, csrfToken, user };
  }

  authenticateSession(token: string | undefined, now = Date.now()): IssuedSession | null {
    if (!token?.startsWith("piw_s_")) return null;
    const session = this.db.getSessionByTokenHash(sha256(token));
    if (
      !session
      || session.revokedAt !== null
      || session.absoluteExpiresAt <= now
      || session.idleExpiresAt <= now
    ) {
      return null;
    }
    const user = this.db.getUserById(session.userId);
    if (!user) return null;
    this.db.touchSession(session.id, now, now + this.config.sessionIdleMs);
    return {
      session,
      token,
      csrfToken: "",
      user,
    };
  }

  authenticateApiToken(token: string | undefined, now = Date.now()): IssuedSession | null {
    if (!token?.startsWith("piw_a_")) return null;
    const stored = this.db.getApiTokenByHash(sha256(token));
    if (
      !stored
      || stored.revokedAt !== null
      || (stored.expiresAt !== null && stored.expiresAt <= now)
    ) {
      return null;
    }
    const user = this.db.getUserById(stored.userId);
    if (!user) return null;
    this.db.touchApiToken(stored.id, now);
    return {
      session: {
        id: `token:${stored.id}`,
        userId: user.id,
        tokenHash: stored.tokenHash,
        csrfHash: new Uint8Array(),
        createdAt: stored.createdAt,
        lastSeenAt: now,
        idleExpiresAt: now,
        absoluteExpiresAt: stored.expiresAt ?? Number.MAX_SAFE_INTEGER,
        ip: null,
        userAgent: null,
        revokedAt: null,
      },
      token,
      csrfToken: "",
      user,
    };
  }

  issueApiToken(
    name: string,
    expiresAt: number | null,
    now = Date.now(),
  ): { token: string; id: string } {
    const user = this.getUser();
    if (!user) throw new AuthError(409, "setup_required", "Gateway setup is required");
    const token = newOpaqueToken("piw_a_");
    const id = newId();
    this.db.createApiToken({
      id,
      userId: user.id,
      name: name.trim() || "API token",
      tokenHash: sha256(token),
      scopes: ["full"],
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    });
    this.db.appendAudit("api_token_created", user.id, null, null, { id, name }, now);
    return { token, id };
  }

  listApiTokens() {
    const user = this.getUser();
    if (!user) throw new AuthError(409, "setup_required", "Gateway setup is required");
    return this.db.listApiTokens(user.id);
  }

  revokeApiToken(id: string, now = Date.now()): boolean {
    const user = this.getUser();
    if (!user) throw new AuthError(409, "setup_required", "Gateway setup is required");
    return this.db.revokeApiToken(user.id, id, now);
  }

  listSessions(userId: string) {
    return this.db.listSessions(userId);
  }

  listCredentials(userId: string): StoredCredential[] {
    return this.db.listCredentials(userId);
  }

  revokeSession(userId: string, id: string, now = Date.now()): boolean {
    return this.db.revokeSession(userId, id, now);
  }

  revokeAllSessions(userId: string, exceptId?: string, now = Date.now()): number {
    return this.db.revokeAllSessions(userId, now, exceptId);
  }

  async setPassword(password: string): Promise<void> {
    const user = this.getUser();
    if (!user) throw new AuthError(409, "setup_required", "Gateway setup is required");
    if (password.length < 16 || password.length > 1024) {
      throw new AuthError(400, "weak_password", "Password must be between 16 and 1024 characters");
    }
    const passwordHash = await argonHash(password, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });
    this.db.updateUserPasswordHash(user.id, passwordHash);
    this.db.revokeAllSessions(user.id, Date.now());
    this.db.appendAudit("password_updated", user.id, null, null, undefined);
  }

  rotateTotpSecret(): { secret: string; uri: string } {
    const user = this.getUser();
    if (!user) throw new AuthError(409, "setup_required", "Gateway setup is required");
    const secret = generateTotpSecret();
    const now = Date.now();
    this.db.updateUserTotp(
      user.id,
      encryptString(secret, this.secrets.encryptionKey),
      null,
    );
    this.db.revokeAllSessions(user.id, now);
    this.db.appendAudit("totp_rotated", user.id, null, null, undefined, now);
    return {
      secret,
      uri: totpUri(secret, user.username, this.config.rpName),
    };
  }

  async regenerateRecoveryCodes(): Promise<string[]> {
    const user = this.getUser();
    if (!user) throw new AuthError(409, "setup_required", "Gateway setup is required");
    const recovery = await this.createRecoveryCodeHashes();
    const now = Date.now();
    this.db.deleteRecoveryCodes(user.id);
    this.db.createRecoveryCodes(user.id, recovery.storedCodes, now);
    this.db.appendAudit("recovery_codes_regenerated", user.id, null, null, undefined, now);
    return recovery.rawCodes;
  }

  deleteCredential(userId: string, id: string): boolean {
    return this.db.deleteCredential(userId, id);
  }

  verifyCsrf(session: StoredSession, token: string | undefined): boolean {
    if (!token) return false;
    return constantTimeEqual(sha256(token), session.csrfHash);
  }

  securityHeaders(): Record<string, string> {
    return securityHeadersForJson();
  }
}
