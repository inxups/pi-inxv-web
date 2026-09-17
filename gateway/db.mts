import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string | null;
  readonly totpSecret: string | null;
  readonly totpLastStep: number | null;
  readonly createdAt: number;
}

export interface StoredCredential {
  readonly id: string;
  readonly userId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: string[];
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly name: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

export interface StoredSession {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: Uint8Array;
  readonly csrfHash: Uint8Array;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly revokedAt: number | null;
}

export interface StoredApiToken {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly tokenHash: Uint8Array;
  readonly scopes: string[];
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

export interface StoredChallenge {
  readonly id: string;
  readonly kind: string;
  readonly userId: string | null;
  readonly challenge: string;
  readonly data: unknown;
  readonly expiresAt: number;
}

function mapUser(row: Record<string, unknown>): StoredUser {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    passwordHash: row.password_hash === null ? null : String(row.password_hash),
    totpSecret: row.totp_secret === null ? null : String(row.totp_secret),
    totpLastStep: row.totp_last_step === null ? null : Number(row.totp_last_step),
    createdAt: Number(row.created_at),
  };
}

function mapCredential(row: Record<string, unknown>): StoredCredential {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    publicKey: new Uint8Array(row.public_key as Uint8Array),
    counter: Number(row.counter),
    transports: JSON.parse(String(row.transports)) as string[],
    deviceType: String(row.device_type),
    backedUp: Boolean(row.backed_up),
    name: String(row.name),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  };
}

function mapSession(row: Record<string, unknown>): StoredSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenHash: new Uint8Array(row.token_hash as Uint8Array),
    csrfHash: new Uint8Array(row.csrf_hash as Uint8Array),
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    idleExpiresAt: Number(row.idle_expires_at),
    absoluteExpiresAt: Number(row.absolute_expires_at),
    ip: row.ip === null ? null : String(row.ip),
    userAgent: row.user_agent === null ? null : String(row.user_agent),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

export class GatewayDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT,
        totp_secret TEXT,
        totp_last_step INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS credentials_user_id_idx
        ON credentials(user_id);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL UNIQUE,
        csrf_hash BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        idle_expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT,
        revoked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS sessions_user_id_idx
        ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        challenge TEXT NOT NULL,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS challenges_expires_at_idx
        ON challenges(expires_at);

      CREATE TABLE IF NOT EXISTS bootstrap_codes (
        id TEXT PRIMARY KEY,
        code_hash BLOB NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS recovery_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS recovery_codes_user_id_idx
        ON recovery_codes(user_id);

      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash BLOB NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_used_at INTEGER,
        revoked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx
        ON api_tokens(user_id);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        event TEXT NOT NULL,
        user_id TEXT,
        ip TEXT,
        user_agent TEXT,
        detail TEXT
      );

      CREATE INDEX IF NOT EXISTS audit_log_timestamp_idx
        ON audit_log(timestamp);
    `);
  }

  close(): void {
    this.db.close();
  }

  userCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as Record<string, unknown>;
    return Number(row.count);
  }

  getUserByUsername(username: string): StoredUser | null {
    const row = this.db.prepare(
      "SELECT * FROM users WHERE username = ?",
    ).get(username) as Record<string, unknown> | undefined;
    return row ? mapUser(row) : null;
  }

  getUserById(id: string): StoredUser | null {
    const row = this.db.prepare(
      "SELECT * FROM users WHERE id = ?",
    ).get(id) as Record<string, unknown> | undefined;
    return row ? mapUser(row) : null;
  }

  createUser(user: StoredUser): void {
    this.db.prepare(`
      INSERT INTO users (
        id, username, display_name, password_hash, totp_secret, totp_last_step, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.username,
      user.displayName,
      user.passwordHash,
      user.totpSecret,
      user.totpLastStep,
      user.createdAt,
    );
  }

  updateUserTotp(userId: string, encryptedSecret: string, lastStep: number | null): void {
    this.db.prepare(
      "UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ?",
    ).run(encryptedSecret, lastStep, userId);
  }

  updateUserLastTotpStep(userId: string, step: number): void {
    this.db.prepare(
      "UPDATE users SET totp_last_step = ? WHERE id = ?",
    ).run(step, userId);
  }

  updateUserPasswordHash(userId: string, passwordHash: string | null): void {
    this.db.prepare(
      "UPDATE users SET password_hash = ? WHERE id = ?",
    ).run(passwordHash, userId);
  }

  listCredentials(userId: string): StoredCredential[] {
    const rows = this.db.prepare(
      "SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at ASC",
    ).all(userId) as Record<string, unknown>[];
    return rows.map(mapCredential);
  }

  getCredential(id: string): StoredCredential | null {
    const row = this.db.prepare(
      "SELECT * FROM credentials WHERE id = ?",
    ).get(id) as Record<string, unknown> | undefined;
    return row ? mapCredential(row) : null;
  }

  createCredential(credential: StoredCredential): void {
    this.db.prepare(`
      INSERT INTO credentials (
        id, user_id, public_key, counter, transports, device_type, backed_up,
        name, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      credential.id,
      credential.userId,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports),
      credential.deviceType,
      credential.backedUp ? 1 : 0,
      credential.name,
      credential.createdAt,
      credential.lastUsedAt,
    );
  }

  updateCredentialCounter(id: string, counter: number, lastUsedAt: number): void {
    this.db.prepare(
      "UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?",
    ).run(counter, lastUsedAt, id);
  }

  deleteCredential(userId: string, id: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM credentials WHERE id = ? AND user_id = ?",
    ).run(id, userId);
    return Number(result.changes) > 0;
  }

  createSession(session: StoredSession): void {
    this.db.prepare(`
      INSERT INTO sessions (
        id, user_id, token_hash, csrf_hash, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at, ip, user_agent, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.userId,
      session.tokenHash,
      session.csrfHash,
      session.createdAt,
      session.lastSeenAt,
      session.idleExpiresAt,
      session.absoluteExpiresAt,
      session.ip,
      session.userAgent,
      session.revokedAt,
    );
  }

  getSessionByTokenHash(tokenHash: Uint8Array): StoredSession | null {
    const row = this.db.prepare(
      "SELECT * FROM sessions WHERE token_hash = ?",
    ).get(tokenHash) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : null;
  }

  touchSession(id: string, now: number, idleExpiresAt: number): void {
    this.db.prepare(
      "UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?",
    ).run(now, idleExpiresAt, id);
  }

  revokeSession(userId: string, id: string, now: number): boolean {
    const result = this.db.prepare(`
      UPDATE sessions
      SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(now, id, userId);
    return Number(result.changes) > 0;
  }

  revokeAllSessions(userId: string, now: number, exceptId?: string): number {
    const result = exceptId
      ? this.db.prepare(`
          UPDATE sessions
          SET revoked_at = ?
          WHERE user_id = ? AND id <> ? AND revoked_at IS NULL
        `).run(now, userId, exceptId)
      : this.db.prepare(`
          UPDATE sessions
          SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL
        `).run(now, userId);
    return Number(result.changes);
  }

  listSessions(userId: string): StoredSession[] {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY last_seen_at DESC
    `).all(userId) as Record<string, unknown>[];
    return rows.map(mapSession);
  }

  pruneExpired(now: number): void {
    this.db.prepare("DELETE FROM challenges WHERE expires_at <= ?").run(now);
    this.db.prepare(
      "DELETE FROM bootstrap_codes WHERE expires_at <= ? OR used_at IS NOT NULL",
    ).run(now);
    this.db.prepare(`
      DELETE FROM sessions
      WHERE revoked_at IS NOT NULL OR absolute_expires_at <= ? OR idle_expires_at <= ?
    `).run(now, now);
    this.db.prepare(
      "DELETE FROM audit_log WHERE timestamp < ?",
    ).run(now - 90 * 24 * 60 * 60 * 1000);
  }

  createChallenge(challenge: StoredChallenge): void {
    this.db.prepare(`
      INSERT INTO challenges (id, kind, user_id, challenge, data, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      challenge.id,
      challenge.kind,
      challenge.userId,
      challenge.challenge,
      JSON.stringify(challenge.data),
      challenge.expiresAt,
    );
  }

  deleteChallenges(kind: string, userId: string | null): void {
    if (userId === null) {
      this.db.prepare("DELETE FROM challenges WHERE kind = ? AND user_id IS NULL").run(kind);
      return;
    }
    this.db.prepare("DELETE FROM challenges WHERE kind = ? AND user_id = ?").run(kind, userId);
  }

  takeChallenge(id: string, kind: string, now: number): StoredChallenge | null {
    const row = this.db.prepare(`
      SELECT * FROM challenges WHERE id = ? AND kind = ? AND expires_at > ?
    `).get(id, kind, now) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM challenges WHERE id = ?").run(id);
    return {
      id: String(row.id),
      kind: String(row.kind),
      userId: row.user_id === null ? null : String(row.user_id),
      challenge: String(row.challenge),
      data: JSON.parse(String(row.data)) as unknown,
      expiresAt: Number(row.expires_at),
    };
  }

  createBootstrapCode(
    id: string,
    codeHash: Uint8Array,
    createdAt: number,
    expiresAt: number,
  ): void {
    this.db.prepare(`
      INSERT INTO bootstrap_codes (id, code_hash, created_at, expires_at, used_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run(id, codeHash, createdAt, expiresAt);
  }

  findBootstrapCodeByHash(codeHash: Uint8Array, now: number): { id: string } | null {
    const row = this.db.prepare(`
      SELECT id FROM bootstrap_codes
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
    `).get(codeHash, now) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id) } : null;
  }

  markBootstrapCodeUsed(id: string, now: number): void {
    this.db.prepare(
      "UPDATE bootstrap_codes SET used_at = ? WHERE id = ? AND used_at IS NULL",
    ).run(now, id);
  }

  createRecoveryCodes(
    userId: string,
    codes: Array<{ id: string; codeHash: string }>,
    createdAt: number,
  ): void {
    const statement = this.db.prepare(`
      INSERT INTO recovery_codes (id, user_id, code_hash, created_at, used_at)
      VALUES (?, ?, ?, ?, NULL)
    `);
    for (const code of codes) {
      statement.run(code.id, userId, code.codeHash, createdAt);
    }
  }

  listUnusedRecoveryCodes(userId: string): Array<{ id: string; codeHash: string }> {
    const rows = this.db.prepare(`
      SELECT id, code_hash FROM recovery_codes
      WHERE user_id = ? AND used_at IS NULL
    `).all(userId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      codeHash: String(row.code_hash),
    }));
  }

  markRecoveryCodeUsed(id: string, now: number): void {
    this.db.prepare(
      "UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL",
    ).run(now, id);
  }

  deleteRecoveryCodes(userId: string): void {
    this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
  }

  createApiToken(token: StoredApiToken): void {
    this.db.prepare(`
      INSERT INTO api_tokens (
        id, user_id, name, token_hash, scopes, created_at,
        expires_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      token.id,
      token.userId,
      token.name,
      token.tokenHash,
      JSON.stringify(token.scopes),
      token.createdAt,
      token.expiresAt,
      token.lastUsedAt,
      token.revokedAt,
    );
  }

  getApiTokenByHash(tokenHash: Uint8Array): StoredApiToken | null {
    const row = this.db.prepare(
      "SELECT * FROM api_tokens WHERE token_hash = ?",
    ).get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      name: String(row.name),
      tokenHash: new Uint8Array(row.token_hash as Uint8Array),
      scopes: JSON.parse(String(row.scopes)) as string[],
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    };
  }

  touchApiToken(id: string, now: number): void {
    this.db.prepare(
      "UPDATE api_tokens SET last_used_at = ? WHERE id = ?",
    ).run(now, id);
  }

  listApiTokens(userId: string): StoredApiToken[] {
    const rows = this.db.prepare(`
      SELECT * FROM api_tokens
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC
    `).all(userId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      name: String(row.name),
      tokenHash: new Uint8Array(row.token_hash as Uint8Array),
      scopes: JSON.parse(String(row.scopes)) as string[],
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    }));
  }

  revokeApiToken(userId: string, id: string, now: number): boolean {
    const result = this.db.prepare(`
      UPDATE api_tokens
      SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(now, id, userId);
    return Number(result.changes) > 0;
  }

  appendAudit(
    event: string,
    userId: string | null,
    ip: string | null,
    userAgent: string | null,
    detail: unknown,
    now = Date.now(),
  ): void {
    this.db.prepare(`
      INSERT INTO audit_log (
        timestamp, event, user_id, ip, user_agent, detail
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      now,
      event,
      userId,
      ip,
      userAgent,
      detail === undefined ? null : JSON.stringify(detail),
    );
  }
}
