import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import sharp from "sharp";
import { openDB, type DB } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { buildApp } from "../server/app.js";
import { Cache } from "../server/cache.js";
import { config } from "../server/config.js";
import { CoverService } from "../server/covers.js";
import { renderInProcess, buildRenderer } from "../server/cover-renderer.js";
import { htmlFile, pastedFile } from "../src/uploads.js";

let db: DB, folder: string, app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string, owner: string, outsider: string;
let renderFailure: Error | undefined;
const originalUploadRate = config.uploadRate;
const source =
  '<!doctype html><html><body style="background:#224488"><svg><rect width="100" height="100" fill="red"/></svg></body></html>';
const headers = () => ({ origin: config.appOrigin, cookie });
const post = (url: string, payload?: unknown) =>
  app.app.inject({
    method: "POST",
    url: `/api/v1${url}`,
    payload: payload as any,
    headers: headers(),
  });
async function upload() {
  const boundary = "cover-test";
  const result = await app.app.inject({
    method: "POST",
    url: "/api/v1/uploads",
    headers: {
      ...headers(),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bird.html"\r\nContent-Type: text/html\r\n\r\n${source}\r\n--${boundary}--\r\n`,
    ),
  });
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
}
before(async () => {
  config.uploadRate = 100;
  db = await openDB({ memory: true });
  await migrate(db);
  folder = await mkdtemp(path.join(tmpdir(), "lark-covers-"));
  app = await buildApp(db, {
    cache: new Cache(true),
    uploads: folder,
    startCoverWorker: false,
    coverRenderer: async () => {
      if (renderFailure) throw renderFailure;
      return sharp({
        create: {
          width: 1200,
          height: 860,
          channels: 3,
          background: "#224488",
        },
      })
        .png()
        .toBuffer();
    },
  });
  for (const username of ["cover_owner", "cover_outsider"]) {
    const result = await app.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: config.appOrigin },
      payload: { username, name: username, password: "test1234" },
    });
    assert.equal(result.statusCode, 200, result.body);
    const token = ([] as string[])
      .concat(result.headers["set-cookie"] || [])
      .find((s) => s.startsWith("lark_session="))!
      .split(";")[0];
    if (username === "cover_owner") {
      cookie = token;
      owner = result.json().user.id;
    } else outsider = token;
  }
});
after(async () => {
  config.uploadRate = originalUploadRate;
  await app?.close();
  await db?.close();
  await rm(folder, { recursive: true, force: true });
});

test("HTML upload creates an owned placeholder, optional metadata publishes directly and cached lists refresh", async () => {
  await app.app.inject("/api/v1/works");
  const media = await upload();
  assert.equal(media.autoCover.status, "pending");
  const image = await app.app.inject({
    url: media.autoCover.url,
    headers: headers(),
  });
  assert.equal(image.statusCode, 200);
  assert.equal((await sharp(image.rawPayload).metadata()).width, 1200);
  const work = await post("/works", {
    title: "只有名称和 HTML",
    prompt: "SVG",
    htmlId: media.id,
  });
  assert.equal(work.statusCode, 200, work.body);
  assert.equal(work.json().description, "");
  assert.equal(work.json().model, "");
  assert.equal(work.json().coverId, media.autoCover.id);
  assert.equal(work.json().coverMode, "auto");
  const publish = await post(`/works/${work.json().id}/submit`);
  assert.equal(publish.statusCode, 200, publish.body);
  assert.equal(publish.json().status, "approved");
  assert.equal(
    (await app.app.inject(`/api/v1/works/${work.json().id}`)).statusCode,
    200,
  );
  assert.ok(
    (await app.app.inject("/api/v1/works"))
      .json()
      .items.some((w: any) => w.id === work.json().id),
  );
  assert.equal((await post(`/works/${work.json().id}/submit`)).statusCode, 200);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer AS n FROM audit_logs WHERE action='work.publish' AND target=$1",
        [work.json().id],
      )
    ).rows[0].n,
    1,
  );
  const query = `/api/v1/uploads/${media.id}/cover`;
  assert.equal((await app.app.inject(query)).statusCode, 401);
  assert.equal(
    (
      await app.app.inject({
        url: query,
        headers: { origin: config.appOrigin, cookie: outsider },
      })
    ).statusCode,
    404,
  );
  const generated = await app.covers.runOnce();
  assert.equal(generated, true);
  const ready = (
    await app.app.inject({ url: query, headers: headers() })
  ).json();
  assert.equal(ready.status, "ready");
  assert.equal(ready.id, media.autoCover.id);
  assert.notEqual(ready.url, media.autoCover.url);
  const current = (
    await app.app.inject(`/api/v1/works/${work.json().id}`)
  ).json();
  assert.equal(current.coverUrl, ready.url);
  assert.equal(current.version, 1);
  assert.equal(current.status, "approved");
  assert.equal(
    (await app.app.inject(`/api/v1/preview/${media.id}`)).statusCode,
    404,
  );
});

test("HTML replacement refreshes automatic covers and preserves manual covers", async () => {
  const first = await upload(),
    second = await upload();
  const initial = (
    await post("/works", { title: "替换封面", prompt: "SVG", htmlId: first.id })
  ).json();
  const update = (payload: unknown) =>
    app.app.inject({
      method: "PUT",
      url: `/api/v1/works/${initial.id}`,
      payload: payload as any,
      headers: headers(),
    });
  const automatic = await update({
    title: "替换封面",
    prompt: "SVG",
    htmlId: second.id,
    coverId: first.autoCover.id,
    version: 1,
  });
  assert.equal(automatic.statusCode, 200, automatic.body);
  assert.equal(automatic.json().coverId, second.autoCover.id);
  // An ordinary cover asset represents an explicit author selection.
  const manual = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const boundary = "manual-cover";
  const result = await app.app.inject({
    method: "POST",
    url: "/api/v1/uploads",
    headers: {
      ...headers(),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cover.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      manual,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  assert.equal(result.statusCode, 200, result.body);
  const custom = await update({
    title: "替换封面",
    prompt: "SVG",
    htmlId: first.id,
    coverId: result.json().id,
    coverMode: "manual",
    version: 2,
  });
  assert.equal(custom.statusCode, 200, custom.body);
  assert.equal(custom.json().coverMode, "manual");
  await app.covers.runOnce();
  await app.covers.runOnce();
  assert.equal(
    (
      await app.app.inject({
        url: `/api/v1/works/${initial.id}`,
        headers: headers(),
      })
    ).json().coverId,
    result.json().id,
  );
  const switched = await update({
    title: "替换封面",
    prompt: "SVG",
    htmlId: first.id,
    coverMode: "auto",
    version: 3,
  });
  assert.equal(switched.json().coverId, first.autoCover.id);
});

test("failed renders permit publication, recover after restart and bound repeated content failures", async () => {
  const media = await upload();
  renderFailure = Object.assign(new Error("service unavailable"), {
    transient: true,
  });
  await app.covers.runOnce();
  const work = await post("/works", {
    title: "服务故障仍可发布",
    prompt: "SVG",
    htmlId: media.id,
    description: "  ",
    model: " ",
  });
  assert.equal(work.statusCode, 200, work.body);
  assert.equal((await post(`/works/${work.json().id}/submit`)).statusCode, 200);
  assert.equal((await app.app.inject("/api/v1/health")).statusCode, 200);
  let job = (
    await db.query("SELECT * FROM generated_covers WHERE html_id=$1", [
      media.id,
    ])
  ).rows[0];
  assert.equal(job.status, "pending");
  assert.equal(job.failures, 0);
  await db.query(
    "UPDATE generated_covers SET status='rendering',lease_until=now()-interval '1 minute' WHERE html_id=$1",
    [media.id],
  );
  renderFailure = undefined;
  const recovered = new CoverService(db, folder, async () =>
    sharp({
      create: { width: 30, height: 30, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer(),
  );
  assert.equal(await recovered.runOnce(), true);
  await recovered.stop();
  assert.equal(
    (
      await db.query("SELECT status FROM generated_covers WHERE html_id=$1", [
        media.id,
      ])
    ).rows[0].status,
    "ready",
  );
  const invalid = await upload();
  renderFailure = new Error("content timed out");
  for (let i = 0; i < 3; i++) {
    await db.query(
      "UPDATE generated_covers SET next_attempt_at=now()-interval '1 second' WHERE html_id=$1",
      [invalid.id],
    );
    assert.equal(await app.covers.runOnce(), true);
  }
  job = (
    await db.query("SELECT * FROM generated_covers WHERE html_id=$1", [
      invalid.id,
    ])
  ).rows[0];
  assert.equal(job.failures, 3);
  assert.equal(job.status, "fallback");
  assert.equal(await app.covers.runOnce(), false);
  renderFailure = undefined;
  const retry = await post(`/uploads/${invalid.id}/cover/retry`);
  assert.equal(retry.statusCode, 200, retry.body);
  await app.covers.runOnce();
});

test("abandoned uploaded pairs are cleaned and work version references retain files", async () => {
  const orphan = await upload(),
    historical = await upload(),
    replacement = await upload();
  const work = (
    await post("/works", {
      title: "保留历史",
      prompt: "SVG",
      htmlId: historical.id,
    })
  ).json();
  const changed = await app.app.inject({
    method: "PUT",
    url: `/api/v1/works/${work.id}`,
    headers: headers(),
    payload: {
      title: "新版本",
      prompt: "SVG",
      htmlId: replacement.id,
      version: 1,
    },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  await db.query(
    "UPDATE assets SET created_at=now()-interval '2 days' WHERE id IN ($1,$2,$3,$4)",
    [orphan.id, orphan.autoCover.id, historical.id, historical.autoCover.id],
  );
  assert.equal(await app.covers.cleanup(), 2);
  assert.equal(
    (await db.query("SELECT id FROM assets WHERE id=$1", [orphan.id])).rows
      .length,
    0,
  );
  assert.equal(
    (await db.query("SELECT id FROM assets WHERE id=$1", [historical.id])).rows
      .length,
    1,
  );
  const files = await readdir(folder),
    records = (await db.query("SELECT filename FROM assets")).rows;
  assert.deepEqual(files.sort(), records.map((r) => r.filename).sort());
});

test("database leases serialize workers while API reads remain available", async () => {
  while (await app.covers.runOnce()) {}
  await upload();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const render = async () => {
    entered();
    await gate;
    return sharp({
      create: { width: 30, height: 30, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
  };
  const a = new CoverService(db, folder, render),
    b = new CoverService(db, folder, render);
  try {
    const active = a.runOnce();
    await ready;
    assert.equal(await b.runOnce(), false);
    assert.equal((await app.app.inject("/api/v1/health")).statusCode, 200);
    assert.equal((await a.metrics()).active, 1);
    release();
    assert.equal(await active, true);
  } finally {
    release();
    await a.stop();
    await b.stop();
  }
});

test("transaction rollback removes uploaded and newly generated files", async () => {
  const failing: DB = {
    ...db,
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await fn(tx);
        throw new Error("simulated commit failure");
      }),
  };
  const broken = await buildApp(failing, {
    cache: new Cache(true),
    uploads: folder,
    startCoverWorker: false,
  });
  try {
    const beforeFiles = (await readdir(folder)).sort();
    const boundary = "rollback-upload";
    const result = await broken.app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: {
        ...headers(),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bird.html"\r\nContent-Type: text/html\r\n\r\n${source}\r\n--${boundary}--\r\n`,
      ),
    });
    assert.equal(result.statusCode, 503);
    assert.match(result.json().message, /上传素材保存失败/);
    assert.deepEqual((await readdir(folder)).sort(), beforeFiles);
    const id = randomUUID(),
      filename = `${id}.html`;
    await writeFile(path.join(folder, filename), source);
    await db.query(
      "INSERT INTO assets(id,owner_id,kind,filename,mime,bytes) VALUES($1,$2,'html',$3,'text/html',$4)",
      [id, owner, filename, source.length],
    );
    const create = await broken.app.inject({
      method: "POST",
      url: "/api/v1/works",
      headers: headers(),
      payload: { title: "事务回滚", prompt: "SVG", htmlId: id },
    });
    assert.equal(create.statusCode, 500);
    assert.equal(
      (
        await db.query(
          "SELECT html_id FROM generated_covers WHERE html_id=$1",
          [id],
        )
      ).rows.length,
      0,
    );
    assert.deepEqual(
      (await readdir(folder)).sort(),
      [...beforeFiles, filename].sort(),
    );
  } finally {
    await broken.close();
  }
});

test("direct publication migration exposes pending works, restores returned drafts and preserves manual covers", async () => {
  const media = await upload();
  const pending = (
    await post("/works", {
      title: "迁移待审作品",
      prompt: "SVG",
      htmlId: media.id,
    })
  ).json();
  const returned = (
    await post("/works", {
      title: "迁移退回作品",
      prompt: "SVG",
      htmlId: media.id,
    })
  ).json();
  await db.query("UPDATE works SET status='pending' WHERE id=$1", [pending.id]);
  await db.query(
    "UPDATE works SET status='rejected',reason='历史反馈' WHERE id=$1",
    [returned.id],
  );
  await db.query(
    "DELETE FROM schema_migrations WHERE name='006_direct_publish.sql'",
  );
  await migrate(db);
  await migrate(db);
  const visible = (await app.app.inject(`/api/v1/works/${pending.id}`)).json();
  assert.equal(visible.status, "approved");
  assert.equal(visible.coverId, pending.coverId);
  const draft = (
    await app.app.inject({
      url: `/api/v1/works/${returned.id}`,
      headers: headers(),
    })
  ).json();
  assert.equal(draft.status, "draft");
  assert.equal(draft.reason, "历史反馈");
  assert.equal(
    (
      await app.app.inject({
        method: "POST",
        url: `/api/v1/admin/works/${pending.id}/review`,
        headers: headers(),
        payload: { decision: "approved" },
      })
    ).statusCode,
    404,
  );
});

test("clipboard accepts source, files and images and rejects multiple files and size limits", () => {
  const data = (files: File[], text = "") => ({
    files: files as unknown as FileList,
    getData: (kind: string) => (kind === "text/plain" ? text : ""),
  });
  assert.equal(pastedFile(data([], source), "html").name, "粘贴的作品.html");
  assert.equal(
    pastedFile(data([new File([source], "bird.htm")]), "html").name,
    "bird.htm",
  );
  assert.equal(
    pastedFile(
      data([new File(["png"], "image.png", { type: "image/png" })]),
      "cover",
    ).type,
    "image/png",
  );
  assert.throws(
    () =>
      pastedFile(
        data([new File([], "a.html"), new File([], "b.html")]),
        "html",
      ),
    /一个文件/,
  );
  assert.throws(() => htmlFile("hello"), /完整/);
  assert.throws(() => htmlFile(source + " ".repeat(5 * 1024 * 1024)), /5MB/);
  assert.throws(
    () =>
      pastedFile(
        data([new File([new Uint8Array(2 * 1024 * 1024 + 1)], "image.png")]),
        "cover",
      ),
    /2MB/,
  );
  assert.throws(() => pastedFile(data([]), "cover"), /点击选择/);
});

test("multiple uploads leave no assets and optional drafts preserve title and length validation", async () => {
  const boundary = "multiple-files";
  const files = (await readdir(folder)).sort();
  const result = await app.app.inject({
    method: "POST",
    url: "/api/v1/uploads",
    headers: {
      ...headers(),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.from(
      ["first", "second"]
        .map(
          (name) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}.html"\r\nContent-Type: text/html\r\n\r\n${source}\r\n`,
        )
        .join("") + `--${boundary}--\r\n`,
    ),
  });
  assert.equal(result.statusCode, 413);
  assert.deepEqual((await readdir(folder)).sort(), files);
  assert.equal(app.metrics().activeUploads, 0);
  assert.equal(
    (await post("/works", { title: "", prompt: "SVG" })).statusCode,
    400,
  );
  for (const fields of [
    { description: "a".repeat(3001) },
    { model: "a".repeat(101) },
  ])
    assert.equal(
      (await post("/works", { title: "长度检查", prompt: "SVG", ...fields }))
        .statusCode,
      400,
    );
  const draft = await post("/works", {
    title: "文件待补充",
    prompt: "SVG",
    coverId: null,
    description: "",
    model: "",
  });
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(draft.json().htmlId, null);
  assert.equal(
    (await post(`/works/${draft.json().id}/submit`)).statusCode,
    409,
  );
});

test("real Chromium captures CSS and script drawing offline and terminates runaway content", async () => {
  let externalRequests = 0;
  const external = createServer((_req, res) => {
    externalRequests++;
    res.end("external resource");
  });
  await new Promise<void>((resolve) =>
    external.listen(0, "127.0.0.1", resolve),
  );
  const address = external.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const html = Buffer.from(
      `<!doctype html><html><body style="margin:0;background:red"><svg width="50" height="50" style="position:absolute;left:0;top:0"><rect width="40" height="50" fill="yellow"><animate attributeName="x" from="0" to="10" dur="1s" repeatCount="indefinite"/></rect></svg><canvas id="drawing" width="40" height="40" style="position:absolute;left:100px;top:100px"></canvas><img src="${origin}/image"><iframe src="file:///etc/passwd"></iframe><script>drawing.getContext('2d').fillStyle='#33aa44';drawing.getContext('2d').fillRect(0,0,40,40);setTimeout(()=>document.body.style.background='rgb(22,88,144)',100);fetch('${origin}/secret').catch(()=>{});new WebSocket('ws://127.0.0.1:${address.port}/ws');</script></body></html>`,
    );
    const image = await renderInProcess(html);
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.width, 1200);
    assert.equal(metadata.height, 860);
    const center = await sharp(image)
      .extract({ left: 600, top: 400, width: 1, height: 1 })
      .raw()
      .toBuffer();
    assert.ok(Math.abs(center[0] - 22) < 8);
    assert.ok(Math.abs(center[1] - 88) < 8);
    assert.ok(Math.abs(center[2] - 144) < 8);
    const svgPixel = await sharp(image)
      .extract({ left: 20, top: 20, width: 1, height: 1 })
      .raw()
      .toBuffer();
    assert.ok(svgPixel[0] > 240 && svgPixel[1] > 240 && svgPixel[2] < 15);
    const canvasPixel = await sharp(image)
      .extract({ left: 120, top: 120, width: 1, height: 1 })
      .raw()
      .toBuffer();
    assert.ok(
      Math.abs(canvasPixel[0] - 51) < 10 &&
        Math.abs(canvasPixel[1] - 170) < 10 &&
        Math.abs(canvasPixel[2] - 68) < 10,
    );
    assert.equal(externalRequests, 0);
    const started = Date.now();
    await assert.rejects(
      renderInProcess(
        Buffer.from(
          "<!doctype html><html><body><script>while(true){}</script></body></html>",
        ),
        2000,
      ),
      /timed out/,
    );
    assert.ok(Date.now() - started < 5000);
    assert.ok((await renderInProcess(html)).length > 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      external.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("renderer admits one job, keeps its health responsive and restores its slot", async () => {
  const renderer = buildRenderer();
  try {
    const first = renderer.inject({
      method: "POST",
      url: "/render",
      headers: { "content-type": "text/html" },
      payload: source,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const excess = await renderer.inject({
      method: "POST",
      url: "/render",
      headers: { "content-type": "text/html" },
      payload: source,
    });
    assert.equal(excess.statusCode, 503);
    assert.equal((await renderer.inject("/health")).json().active, 1);
    const result = await first;
    assert.equal(result.statusCode, 200, result.body.slice(0, 100));
    assert.equal((await renderer.inject("/health")).json().active, 0);
  } finally {
    await renderer.close();
  }
});

test("renderer returns retryable service errors and bounded content errors as JSON", async () => {
  for (const transient of [true, false]) {
    const renderer = buildRenderer(async () => {
      throw Object.assign(new Error("Render failed"), { transient });
    });
    try {
      const result = await renderer.inject({
        method: "POST",
        url: "/render",
        headers: { "content-type": "text/html" },
        payload: source,
      });
      assert.equal(result.statusCode, transient ? 503 : 422);
      assert.match(result.headers["content-type"]!, /application\/json/);
      assert.equal(result.json().message, "Cover rendering failed");
      assert.equal((await renderer.inject("/health")).json().active, 0);
    } finally {
      await renderer.close();
    }
  }
});
