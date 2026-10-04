import test from "node:test";
import assert from "node:assert/strict";
import { validateHtml } from "../server/html.js";
import { api, upload, ApiError } from "../src/api.js";
import { Cache } from "../server/cache.js";
import { openDB } from "../server/db.js";
import { validateHtmlUpload } from "../server/html-upload.js";
import { migrate } from "../server/migrate.js";
import { buildApp } from "../server/app.js";
import { config } from "../server/config.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { queuePasswordOperation, passwordBudget } from "../server/password.js";
test("password admission bounds the queue, preserves order, and releases timed out waiters", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const order: number[] = [];
  const accepted = Array.from({ length: 8 }, (_, i) =>
    queuePasswordOperation(async () => {
      order.push(i);
      if (i < 2) await gate;
      return i;
    }),
  );
  assert.deepEqual(passwordBudget(), { active: 0, admitted: 2, waiting: 6 });
  await assert.rejects(
    queuePasswordOperation(async () => 9),
    { statusCode: 503 },
  );
  release();
  assert.deepEqual(await Promise.all(accepted), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  const held = new Promise<void>((r) => (release = r));
  const running = [
    queuePasswordOperation(() => held),
    queuePasswordOperation(() => held),
  ];
  try {
    await assert.rejects(
      queuePasswordOperation(async () => true),
      { statusCode: 503 },
    );
    assert.equal(passwordBudget().waiting, 0);
  } finally {
    release();
    await Promise.all(running);
  }
  assert.deepEqual(passwordBudget(), { active: 0, admitted: 0, waiting: 0 });
});
test("preview pressure leaves API capacity available and restores preview slots", async () => {
  const db = await openDB({ memory: true });
  await migrate(db);
  const folder = await mkdtemp(path.join(tmpdir(), "lark-preview-"));
  const previous = config.maxPreviews;
  config.maxPreviews = 2;
  const servers = await buildApp(db, {
    cache: new Cache(true),
    uploads: folder,
  });
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  servers.preview.get("/preview-held", async () => {
    await gate;
    return { ok: true };
  });
  try {
    const accepted = Array.from({ length: 2 }, () =>
      servers.preview.inject("/preview-held"),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      (await servers.preview.inject("/preview-held")).statusCode,
      503,
    );
    assert.equal((await servers.app.inject("/api/v1/health")).statusCode, 200);
    finish();
    await Promise.all(accepted);
    assert.equal(
      (await servers.preview.inject("/preview-held")).statusCode,
      200,
    );
  } finally {
    finish();
    config.maxPreviews = previous;
    await servers.close();
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});
test("disconnected handlers retain their budget until completion and release it afterwards", async () => {
  const db = await openDB({ memory: true });
  await migrate(db);
  const folder = await mkdtemp(path.join(tmpdir(), "lark-disconnect-"));
  const previous = config.maxInflight;
  config.maxInflight = 2;
  const servers = await buildApp(db, {
    cache: new Cache(true),
    uploads: folder,
  });
  let finish!: () => void;
  const held = new Promise<void>((r) => (finish = r));
  let entered = 0;
  let enteredAll!: () => void;
  const ready = new Promise<void>((r) => (enteredAll = r));
  servers.app.get("/api/v1/held", async () => {
    if (++entered === 2) enteredAll();
    await held;
    return { ok: true };
  });
  try {
    await servers.app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(servers.app.server.address() as any).port}`;
    const controllers = Array.from({ length: 2 }, () => new AbortController());
    const requests = controllers.map((controller) =>
      fetch(base + "/api/v1/held", { signal: controller.signal }).catch(
        () => null,
      ),
    );
    await ready;
    controllers.forEach((c) => c.abort());
    await Promise.all(requests);
    assert.equal((await fetch(base + "/api/v1/health")).status, 503);
    finish();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await fetch(base + "/api/v1/health")).status, 200);
  } finally {
    finish();
    config.maxInflight = previous;
    await servers.close();
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});
test("disconnection during rate admission retains capacity until admission finishes", async () => {
  const db = await openDB({ memory: true });
  await migrate(db);
  const folder = await mkdtemp(path.join(tmpdir(), "lark-admission-"));
  const previous = config.maxInflight;
  config.maxInflight = 2;
  const cache = new Cache(true);
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  let entered = 0,
    all!: () => void;
  const ready = new Promise<void>((r) => (all = r));
  cache.take = async () => {
    if (++entered === 2) all();
    await gate;
    return true;
  };
  const servers = await buildApp(db, { cache, uploads: folder });
  try {
    await servers.app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(servers.app.server.address() as any).port}`;
    const controllers = [new AbortController(), new AbortController()];
    const requests = controllers.map((c) =>
      fetch(base + "/api/v1/stats", { signal: c.signal }).catch(() => null),
    );
    await ready;
    controllers.forEach((c) => c.abort());
    await Promise.all(requests);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await fetch(base + "/api/v1/health")).status, 503);
    finish();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await fetch(base + "/api/v1/health")).status, 200);
    assert.equal(servers.metrics().inflight, 0);
  } finally {
    finish();
    config.maxInflight = previous;
    await servers.close();
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});
test("large HTML validation permits event-loop progress and retains SVG checks", async () => {
  const input = Buffer.from(
    "<!doctype html><html><body><svg>" +
      '<rect width="2" height="2"/>'.repeat(20000) +
      "</svg></body></html>",
  );
  let progressed = false;
  const tick = new Promise<void>((resolve) =>
    setTimeout(() => {
      progressed = true;
      resolve();
    }, 1),
  );
  const validation = validateHtmlUpload(input);
  assert.equal(
    await Promise.race([
      tick.then(() => "timer"),
      validation.then(() => "validation"),
    ]),
    "timer",
  );
  await validation;
  assert.equal(progressed, true);
  await validateHtmlUpload(
    Buffer.from(
      "<!doctype html><html><body><svg><circle/></svg><!--" +
        " ".repeat(5 * 1024 * 1024 - 150) +
        "--></body></html>",
    ),
  );
  await assert.rejects(
    validateHtmlUpload(
      Buffer.from(
        "<!doctype html><html><body>" + " ".repeat(150000) + "</body></html>",
      ),
    ),
    /SVG/,
  );
});
test("export iteration holds one snapshot while rows are added and changed", async () => {
  const db = await openDB({ memory: true });
  try {
    await db.query(
      "CREATE TABLE export_probe(id integer PRIMARY KEY, value text)",
    );
    await db.query(
      "INSERT INTO export_probe SELECT i,'original' FROM generate_series(1,501) i",
    );
    const iterator = db.iterate!("SELECT * FROM export_probe ORDER BY id")[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();
    assert.equal(first.value.length, 500);
    await db.query("INSERT INTO export_probe VALUES(0,'later')");
    await db.query("UPDATE export_probe SET value='changed' WHERE id=501");
    const second = await iterator.next();
    assert.deepEqual(second.value, [{ id: 501, value: "original" }]);
    assert.equal((await iterator.next()).done, true);
  } finally {
    await db.close();
  }
});
test("a second active export returns retryable JSON and releases its budget", async () => {
  const db = await openDB({ memory: true });
  await migrate(db);
  const folder = await mkdtemp(path.join(tmpdir(), "lark-export-"));
  const servers = await buildApp(db, {
    cache: new Cache(true),
    uploads: folder,
  });
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  db.iterate = async function* () {
    yield [{ id: "row", value: "original" }];
    await gate;
  };
  try {
    const registered = await servers.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { Origin: config.appOrigin },
      payload: {
        username: "export_admin",
        name: "Export Admin",
        password: "Export test password 2026 🔑",
      },
    });
    assert.equal(registered.statusCode, 200);
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [
      registered.json().user.id,
    ]);
    const cookie = String(registered.headers["set-cookie"]).split(";")[0];
    await servers.app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(servers.app.server.address() as any).port}`;
    const first = await fetch(base + "/api/v1/admin/export/votes", {
      headers: { Cookie: cookie },
    });
    assert.equal(first.status, 200);
    const reader = first.body!.getReader();
    await reader.read();
    const second = await fetch(base + "/api/v1/admin/export/votes", {
      headers: { Cookie: cookie },
    });
    assert.equal(second.status, 503);
    assert.equal(second.headers.get("retry-after"), "2");
    assert.equal(second.headers.get("content-disposition"), null);
    assert(second.headers.get("content-type")?.includes("application/json"));
    assert.equal(typeof (await second.json()).message, "string");
    finish();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(servers.metrics().activeExports, 0);
  } finally {
    finish();
    await servers.close();
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});
test("cache churn preserves authentication and user rate budgets", async () => {
  const c = new Cache(true);
  try {
    assert.equal(await c.take("user-budget", 2), true);
    assert.equal(await c.take("user-budget", 2), true);
    for (let i = 0; i < 5100; i++) await c.set(`cold-search:${i}`, "{}", 10);
    assert.equal(await c.take("user-budget", 2), false);
  } finally {
    await c.close();
  }
});
test("deep HTML has a bounded validation error and normal SVG remains valid", () => {
  const deep = Buffer.from(
    "<!doctype html><html><body>" +
      "<div>".repeat(5000) +
      '<svg><circle r="2"/></svg>' +
      "</div>".repeat(5000) +
      "</body></html>",
  );
  assert.throws(
    () => validateHtml(deep),
    (e: any) => e.statusCode === 400 && /层级/.test(e.message),
  );
  const templates = Buffer.from(
    "<!doctype html><html><body>" +
      "<template>".repeat(2000) +
      "<svg><circle/></svg>" +
      "</template>".repeat(2000) +
      "</body></html>",
  );
  assert.throws(
    () => validateHtml(templates),
    (e: any) => e.statusCode === 400 && /层级/.test(e.message),
  );
  assert.doesNotThrow(() =>
    validateHtml(
      Buffer.from(
        '<!doctype html><html><body><svg><circle r="2"/></svg></body></html>',
      ),
    ),
  );
});
test("HTML gateway overload responses retain HTTP status and a useful retry message", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<html>Service unavailable</html>", {
      status: 503,
      headers: { "Retry-After": "2", "Content-Type": "text/html" },
    });
  try {
    await assert.rejects(
      api("/works"),
      (e: any) =>
        e instanceof ApiError &&
        e.status === 503 &&
        /繁忙|不可用/.test(e.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("upload gateway overload retains its status and permits a later upload", async () => {
  const original = globalThis.XMLHttpRequest;
  let status = 503;
  class FakeXHR {
    status = status;
    responseText =
      status === 503 ? "<html>busy</html>" : '{"id":"asset","kind":"html"}';
    timeout = 0;
    upload = { onprogress: null };
    onload?: () => void;
    onloadend?: () => void;
    open() {}
    setRequestHeader() {}
    abort() {}
    send() {
      queueMicrotask(() => {
        this.onload?.();
        this.onloadend?.();
      });
    }
  }
  globalThis.XMLHttpRequest = FakeXHR as any;
  try {
    const file = new File(["<svg/>"], "bird.html");
    await assert.rejects(
      upload(file, () => {}),
      (e: any) =>
        e instanceof ApiError && e.status === 503 && /不可用/.test(e.message),
    );
    status = 200;
    assert.deepEqual(await upload(file, () => {}), {
      id: "asset",
      kind: "html",
    });
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});
