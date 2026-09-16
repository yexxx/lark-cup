import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { openDB } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { buildApp } from "../server/app.js";
import { Cache } from "../server/cache.js";
import { config } from "../server/config.js";
test("inflight cap returns 503 without queuing and recovers after requests finish", async () => {
  const db = await openDB({ memory: true });
  await migrate(db);
  const folder = await mkdtemp(path.join(tmpdir(), "lark-limits-"));
  const original = config.maxInflight;
  config.maxInflight = 2;
  const servers = await buildApp(db, {
    cache: new Cache(true),
    uploads: folder,
  });
  servers.app.get("/api/v1/test-slow", async () => {
    await new Promise((r) => setTimeout(r, 70));
    return { ok: true };
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => servers.app.inject("/api/v1/test-slow")),
    );
    assert.equal(results.filter((r) => r.statusCode === 200).length, 2);
    assert.equal(results.filter((r) => r.statusCode === 503).length, 3);
    assert.equal((await servers.app.inject("/api/v1/health")).statusCode, 200);
  } finally {
    config.maxInflight = original;
    await servers.close();
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});
