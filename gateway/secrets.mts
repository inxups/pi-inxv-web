import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface StoredGatewaySecrets {
  readonly version: 1;
  readonly encryptionKey: string;
  readonly attestationSecret: string;
}

export interface GatewaySecrets {
  readonly encryptionKey: Buffer;
  readonly attestationSecret: string;
}

function parseStoredSecrets(value: unknown): GatewaySecrets {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid gateway secret file");
  }
  const stored = value as Partial<StoredGatewaySecrets>;
  if (stored.version !== 1) {
    throw new Error("Unsupported gateway secret file version");
  }
  if (typeof stored.encryptionKey !== "string" || typeof stored.attestationSecret !== "string") {
    throw new Error("Invalid gateway secret file fields");
  }

  const encryptionKey = Buffer.from(stored.encryptionKey, "base64url");
  if (encryptionKey.length !== 32) {
    throw new Error("Gateway encryption key must be 32 bytes");
  }
  if (stored.attestationSecret.length < 32) {
    throw new Error("Gateway attestation secret is too short");
  }
  return { encryptionKey, attestationSecret: stored.attestationSecret };
}

export async function loadOrCreateGatewaySecrets(path: string): Promise<GatewaySecrets> {
  try {
    const raw = await readFile(path, "utf8");
    await chmod(path, 0o600);
    return parseStoredSecrets(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stored: StoredGatewaySecrets = {
    version: 1,
    encryptionKey: randomBytes(32).toString("base64url"),
    attestationSecret: randomBytes(32).toString("base64url"),
  };
  const temporaryPath = join(
    directory,
    `.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
  return parseStoredSecrets(stored);
}
