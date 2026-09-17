import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATEWAY_SCHEMA_VERSION,
  GatewayDatabase,
} from "./db.mts";

test("initializes and reopens the current schema version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-gateway-db-"));
  const path = join(directory, "auth.db");
  try {
    const database = new GatewayDatabase(path);
    const version = database.db.prepare("PRAGMA user_version").get();
    assert.equal(Number(version.user_version), GATEWAY_SCHEMA_VERSION);
    database.close();

    const reopened = new GatewayDatabase(path);
    assert.equal(
      Number(reopened.db.prepare("PRAGMA user_version").get().user_version),
      GATEWAY_SCHEMA_VERSION,
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a database created by a newer gateway schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-gateway-db-future-"));
  const path = join(directory, "auth.db");
  try {
    const database = new GatewayDatabase(path);
    database.db.exec(`PRAGMA user_version = ${GATEWAY_SCHEMA_VERSION + 1}`);
    database.close();
    assert.throws(
      () => new GatewayDatabase(path),
      /newer than supported schema/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns recent audit rows newest first with parsed detail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-gateway-audit-"));
  const path = join(directory, "auth.db");
  try {
    const database = new GatewayDatabase(path);
    database.appendAudit("first", null, "127.0.0.1", "test", { value: 1 }, 1_000);
    database.appendAudit("second", null, null, null, ["value", 2], 2_000);
    const entries = database.listAudit(10);
    assert.equal(entries[0].event, "second");
    assert.deepEqual(entries[0].detail, ["value", 2]);
    assert.equal(entries[1].event, "first");
    assert.deepEqual(entries[1].detail, { value: 1 });
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
