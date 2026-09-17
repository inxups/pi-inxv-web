import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATEWAY_SCHEMA_VERSION,
  GatewayDatabase,
} from "../gateway/db.mts";

test("gateway state survives an offline backup and restore drill", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-gateway-backup-"));
  const source = join(root, "source");
  const backup = join(root, "backup");
  const restored = join(root, "restored");
  const newer = join(root, "newer");
  try {
    await mkdir(source);
    const database = new GatewayDatabase(join(source, "auth.db"));
    database.appendAudit("backup-drill", null, "127.0.0.1", "test", { ok: true }, 1_000);
    database.close();
    await writeFile(
      join(source, "secrets.json"),
      '{"fixture":"state-only"}\n',
      { mode: 0o600 },
    );
    await writeFile(
      join(source, "attestation.env"),
      "PI_WEB_GATEWAY_ATTESTATION_SECRET=fixture\n",
      { mode: 0o600 },
    );

    await cp(source, backup, { recursive: true });
    await cp(backup, restored, { recursive: true });

    const restoredDatabase = new GatewayDatabase(join(restored, "auth.db"));
    assert.equal(
      Number(
        restoredDatabase.db.prepare("PRAGMA user_version").get().user_version,
      ),
      GATEWAY_SCHEMA_VERSION,
    );
    assert.equal(restoredDatabase.listAudit(10)[0].event, "backup-drill");
    restoredDatabase.close();
    assert.equal(
      await readFile(join(restored, "secrets.json"), "utf8"),
      '{"fixture":"state-only"}\n',
    );
    assert.equal(
      await readFile(join(restored, "attestation.env"), "utf8"),
      "PI_WEB_GATEWAY_ATTESTATION_SECRET=fixture\n",
    );

    await cp(restored, newer, { recursive: true });
    const newerDatabase = new GatewayDatabase(join(newer, "auth.db"));
    newerDatabase.db.exec(`PRAGMA user_version = ${GATEWAY_SCHEMA_VERSION + 1}`);
    newerDatabase.close();
    assert.throws(
      () => new GatewayDatabase(join(newer, "auth.db")),
      /newer than supported schema/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
