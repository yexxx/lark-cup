import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { openDB, type DB } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { buildApp } from "../server/app.js";
import { Cache } from "../server/cache.js";
import {
  castVote,
  dayInBeijing,
  limitFor,
  settings,
} from "../server/domain.js";
let db: DB, servers: Awaited<ReturnType<typeof buildApp>>, folder: string;
let now = new Date("2026-09-16T10:00:00+08:00");
const owner = "test-author";
const admin = "admin";
let coverId: string, htmlId: string, workId: string;
const cookie = (id: string) => ({ cookie: `lark_demo=${id}` });
const base = {
  title: "测试：飞行中的百灵鸟",
  description: "点击鸣唱，飞行中振翅。",
  model: "Test Model",
  prompt: "创作飞行中唱歌的百灵鸟",
  track: "classic",
  coverId: null as string | null,
  htmlId: null as string | null,
};
async function login(id: string) {
  const r = await servers.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { id, name: id },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r;
}
async function create(track = "classic", status = "approved") {
  const id = randomUUID();
  await db.query(
    "INSERT INTO works(id,owner_id,track,title,description,model,prompt,status,cover_id,html_id) VALUES($1,$2,$3,$4,'d','m','p',$5,$6,$7)",
    [id, owner, track, `作品 ${id}`, status, coverId, htmlId],
  );
  return id;
}
async function multipart(
  bytes: Buffer,
  filename: string,
  mime: string,
  user = owner,
) {
  const boundary = "lark-test-boundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return servers.app.inject({
    method: "POST",
    url: "/api/v1/uploads",
    headers: {
      ...cookie(user),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
}
before(async () => {
  db = await openDB({ memory: true });
  await migrate(db);
  folder = await mkdtemp(path.join(tmpdir(), "lark-tests-"));
  servers = await buildApp(db, {
    cache: new Cache(true),
    uploads: folder,
    now: () => now,
  });
  await login(owner);
  await login(admin);
});
after(async () => {
  await servers?.close();
  await db?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});
test("migration is repeatable; auth adapter uses explicit demo identities", async () => {
  await migrate(db);
  const r = await servers.app.inject({
    url: "/api/v1/auth/me",
    headers: cookie(owner),
  });
  assert.equal(r.json().user.id, owner);
  assert.equal((await servers.app.inject("/api/v1/auth/me")).json().user, null);
});
test("upload detects actual image content and HTML, stores random filenames", async () => {
  const cover = await multipart(
    await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#ddcc88" },
    })
      .png()
      .toBuffer(),
    "../../unsafe.png",
    "image/png",
  );
  assert.equal(cover.statusCode, 200, cover.body);
  coverId = cover.json().id;
  const html = await multipart(
    Buffer.from(
      '<!doctype html><html><body><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg><script>window.test=1</script></body></html>',
    ),
    "../../bird.html",
    "text/html",
  );
  assert.equal(html.statusCode, 200, html.body);
  htmlId = html.json().id;
  const rows = (await db.query("SELECT filename FROM assets")).rows;
  assert.ok(rows.every((r) => /^[a-f0-9-]+\.(html|webp)$/.test(r.filename)));
});
test("SVG disguise, missing files and oversize uploads are rejected", async () => {
  assert.equal(
    (
      await multipart(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        "photo.png",
        "image/png",
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await multipart(
        Buffer.alloc(2 * 1024 * 1024 + 1),
        "large.png",
        "image/png",
      )
    ).statusCode,
    413,
  );
  assert.equal(
    (await multipart(Buffer.from("not html"), "bird.html", "text/html"))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await multipart(
        Buffer.alloc(5 * 1024 * 1024 + 1, 65),
        "large.html",
        "text/html",
      )
    ).statusCode,
    413,
  );
});
test("draft → submit → review; private preview token and public isolation headers", async () => {
  const r = await servers.app.inject({
    method: "POST",
    url: "/api/v1/works",
    headers: cookie(owner),
    payload: { ...base, coverId, htmlId },
  });
  assert.equal(r.statusCode, 200, r.body);
  workId = r.json().id;
  assert.equal(r.json().status, "draft");
  assert.equal(
    (await servers.app.inject(`/api/v1/works/${workId}`)).statusCode,
    404,
  );
  const own = await servers.app.inject({
    url: `/api/v1/works/${workId}`,
    headers: cookie(owner),
  });
  const url = new URL(own.json().previewUrl);
  assert.equal(
    (await servers.preview.inject(url.pathname + url.search)).statusCode,
    200,
  );
  assert.equal(
    (await servers.preview.inject(`/preview/${htmlId}`)).statusCode,
    404,
  );
  const sub = await servers.app.inject({
    method: "POST",
    url: `/api/v1/works/${workId}/submit`,
    headers: cookie(owner),
  });
  assert.equal(sub.statusCode, 200, sub.body);
  const review = await servers.app.inject({
    method: "POST",
    url: `/api/v1/admin/works/${workId}/review`,
    headers: cookie(admin),
    payload: { decision: "approved", reason: "", version: 1 },
  });
  assert.equal(review.statusCode, 200, review.body);
  const pub = await servers.app.inject(`/api/v1/works/${workId}`);
  assert.equal(pub.statusCode, 200);
  assert.equal(pub.json().ownerId, undefined);
  const pv = await servers.preview.inject(`/preview/${htmlId}`);
  assert.equal(pv.statusCode, 200);
  const csp = String(pv.headers["content-security-policy"]);
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-ancestors http:\/\/localhost:5173/);
  assert.ok(!csp.includes("allow-same-origin"));
  assert.equal(pv.headers["set-cookie"], undefined);
  assert.equal(
    (await servers.app.inject(`/preview/${htmlId}`)).statusCode,
    404,
  );
});
test("unauthorized users cannot edit or approve another work; foreign assets denied", async () => {
  await login("outsider");
  const edit = await servers.app.inject({
    method: "PUT",
    url: `/api/v1/works/${workId}`,
    headers: cookie("outsider"),
    payload: { ...base, coverId, htmlId, version: 1 },
  });
  assert.equal(edit.statusCode, 404);
  const approve = await servers.app.inject({
    method: "POST",
    url: `/api/v1/admin/works/${workId}/review`,
    headers: cookie(owner),
    payload: { decision: "approved", reason: "", version: 1 },
  });
  assert.equal(approve.statusCode, 403);
  const foreign = await servers.app.inject({
    method: "POST",
    url: "/api/v1/works",
    headers: cookie("outsider"),
    payload: { ...base, coverId, htmlId },
  });
  assert.equal(foreign.statusCode, 400);
});
test("idempotency and simultaneous votes charge quota once", async () => {
  await login("concurrent");
  const key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      castVote(db, "concurrent", workId, key, now),
    ),
  );
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(
    (
      await db.query("SELECT used FROM daily_quotas WHERE user_id=$1", [
        "concurrent",
      ])
    ).rows[0].used,
    1,
  );
  await assert.rejects(
    castVote(db, "concurrent", workId, randomUUID(), now),
    /今天已/,
  );
  const other = await create();
  await assert.rejects(castVote(db, "concurrent", other, key, now), /幂等键/);
});
test("single daily quota stops concurrent overrun", async () => {
  await login("quota-user");
  const s = await settings(db);
  await db.query("UPDATE competition SET data=$1 WHERE id=1", [
    JSON.stringify({ ...s, dailyLimit: 3 }),
  ]);
  const works = [];
  for (let i = 0; i < 5; i++) works.push(await create());
  const results = await Promise.allSettled(
    works.map((id) => castVote(db, "quota-user", id, randomUUID(), now)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(
    (
      await db.query(
        "SELECT used FROM daily_quotas WHERE user_id=$1 AND track='classic'",
        ["quota-user"],
      )
    ).rows[0].used,
    3,
  );
  await assert.rejects(castVote(db, "quota-user", await create(), randomUUID(), now), /已用完/);
});
test("Beijing midnight resets quota and per-work uniqueness", async () => {
  assert.equal(dayInBeijing(new Date("2026-09-16T15:59:59Z")), "2026-09-16");
  assert.equal(dayInBeijing(new Date("2026-09-16T16:00:00Z")), "2026-09-17");
  await castVote(
    db,
    "concurrent",
    workId,
    randomUUID(),
    new Date("2026-09-16T16:00:00Z"),
  );
  assert.equal(
    (
      await db.query("SELECT count(*) FROM votes WHERE user_id=$1", [
        "concurrent",
      ])
    ).rows[0].count,
    2,
  );
});
test("admin limit changes start next Beijing day", async () => {
  const s = await settings(db);
  const r = await servers.app.inject({
    method: "PUT",
    url: "/api/v1/admin/competition",
    headers: cookie(admin),
    payload: { ...s, dailyLimit: 7 },
  });
  assert.equal(r.statusCode, 200, r.body);
  const updated = await settings(db);
  assert.equal(limitFor(updated, "2026-09-16"), 3);
  assert.equal(limitFor(updated, "2026-09-17"), 7);
});
test("closed windows reject submissions and votes on server", async () => {
  const s = await settings(db);
  await db.query("UPDATE competition SET data=$1 WHERE id=1", [
    JSON.stringify({
      ...s,
      voteEnd: "2026-09-15T00:00:00+08:00",
      submissionEnd: "2026-09-15T00:00:00+08:00",
    }),
  ]);
  await assert.rejects(
    castVote(db, "outsider", workId, randomUUID(), now),
    /不在投票时间/,
  );
  const r = await servers.app.inject({
    method: "POST",
    url: "/api/v1/works",
    headers: cookie(owner),
    payload: base,
  });
  assert.equal(r.statusCode, 409);
  await db.query("UPDATE competition SET data=$1 WHERE id=1", [
    JSON.stringify(s),
  ]);
});
test("approved edit returns to draft; stale version fails; rejection/resubmit/withdraw work", async () => {
  const r = await servers.app.inject({
    method: "PUT",
    url: `/api/v1/works/${workId}`,
    headers: cookie(owner),
    payload: { ...base, coverId, htmlId, version: 1 },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, "draft");
  assert.equal(
    (await servers.app.inject(`/api/v1/works/${workId}`)).statusCode,
    404,
  );
  const stale = await servers.app.inject({
    method: "PUT",
    url: `/api/v1/works/${workId}`,
    headers: cookie(owner),
    payload: { ...base, coverId, htmlId, version: 1 },
  });
  assert.equal(stale.statusCode, 409);
  const track = await servers.app.inject({
    method: "PUT",
    url: `/api/v1/works/${workId}`,
    headers: cookie(owner),
    payload: { ...base, track: "open", coverId, htmlId, version: 2 },
  });
  assert.equal(track.statusCode, 400);
  await servers.app.inject({
    method: "POST",
    url: `/api/v1/works/${workId}/submit`,
    headers: cookie(owner),
  });
  let review = await servers.app.inject({
    method: "POST",
    url: `/api/v1/admin/works/${workId}/review`,
    headers: cookie(admin),
    payload: { decision: "rejected", reason: "补充说明", version: 2 },
  });
  assert.equal(review.statusCode, 200);
  const rejected = (
    await servers.app.inject({
      url: `/api/v1/works/${workId}`,
      headers: cookie(owner),
    })
  ).json();
  assert.equal(rejected.reason, "补充说明");
  assert.equal(
    (
      await servers.app.inject({
        method: "POST",
        url: `/api/v1/works/${workId}/submit`,
        headers: cookie(owner),
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await servers.app.inject({
        method: "POST",
        url: `/api/v1/works/${workId}/withdraw`,
        headers: cookie(owner),
      })
    ).statusCode,
    200,
  );
  await assert.rejects(
    castVote(db, "outsider", workId, randomUUID(), now),
    /未公开|撤回/,
  );
});
test("voiding votes is audited, reduces tally and does not refund quota", async () => {
  const v = (
    await db.query(
      "SELECT * FROM votes WHERE user_id=$1 ORDER BY created_at LIMIT 1",
      ["concurrent"],
    )
  ).rows[0];
  const r = await servers.app.inject({
    method: "POST",
    url: `/api/v1/admin/votes/${v.id}/void`,
    headers: cookie(admin),
    payload: { reason: "测试异常票" },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(
    (await db.query("SELECT valid FROM votes WHERE id=$1", [v.id])).rows[0]
      .valid,
    false,
  );
  assert.equal(
    (
      await db.query(
        "SELECT used FROM daily_quotas WHERE user_id='concurrent' AND day='2026-09-16'",
      )
    ).rows[0].used,
    1,
  );
  assert.equal(
    (await db.query("SELECT count(*) FROM audit_logs WHERE action='vote.void'"))
      .rows[0].count,
    1,
  );
});
test("disabled user cannot participate; self-disable prevented", async () => {
  const r = await servers.app.inject({
    method: "PATCH",
    url: "/api/v1/admin/users/outsider",
    headers: cookie(admin),
    payload: { status: "disabled" },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(
    (
      await servers.app.inject({
        url: "/api/v1/me/quota",
        headers: cookie("outsider"),
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await servers.app.inject({
        method: "PATCH",
        url: "/api/v1/admin/users/admin",
        headers: cookie(admin),
        payload: { status: "disabled" },
      })
    ).statusCode,
    409,
  );
});
test("leaderboard ties, pagination, search and CSV escaping", async () => {
  const r = await servers.app.inject("/api/v1/leaderboard?track=classic");
  assert.equal(r.statusCode, 200, r.body);
  const zero = r.json().items.filter((w: any) => w.votes === 0);
  assert.ok(zero.length >= 2);
  assert.equal(new Set(zero.map((w: any) => w.rank)).size, 1);
  const search = await servers.app.inject(
    "/api/v1/works?q=does-not-exist&page=1",
  );
  assert.equal(search.json().total, 0);
  const id = await create();
  await db.query("UPDATE works SET title=$2 WHERE id=$1", [
    id,
    '=HYPERLINK("evil")',
  ]);
  const csv = await servers.app.inject({
    url: "/api/v1/admin/export/works",
    headers: cookie(admin),
  });
  assert.equal(csv.statusCode, 200);
  assert.ok(csv.body.includes("'=HYPERLINK"));
  assert.equal(
    (await servers.app.inject("/api/v1/works?page=-1")).statusCode,
    400,
  );
});
test("cross-origin mutations are refused and path traversal cannot expose files", async () => {
  const r = await servers.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "https://evil.example" },
    payload: { id: "evil", name: "evil" },
  });
  assert.equal(r.statusCode, 403);
  assert.equal(
    (await servers.preview.inject("/preview/..%2F..%2F.env")).statusCode,
    400,
  );
  assert.equal((await servers.app.inject("/media/..%2F.env")).statusCode, 400);
});
test("cache coalesces concurrent rebuild and rate limiter recovers after expiry", async () => {
  const c = new Cache(true);
  let calls = 0;
  const result = await Promise.all(
    Array.from({ length: 10 }, () =>
      c.cached("test", 1, async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { ok: true };
      }),
    ),
  );
  assert.equal(calls, 1);
  assert.equal(result.length, 10);
  assert.equal(await c.take("short", 1, 1), true);
  assert.equal(await c.take("short", 1, 1), false);
  await new Promise((r) => setTimeout(r, 1050));
  assert.equal(await c.take("short", 1, 1), true);
  await c.close();
});
test("vote endpoint enforces identity rate cap", async () => {
  await login("rate-user");
  const id = await create();
  const key = randomUUID();
  let limited = false;
  for (let i = 0; i < 21; i++) {
    const r = await servers.app.inject({
      method: "POST",
      url: `/api/v1/works/${id}/votes`,
      headers: { ...cookie("rate-user"), "idempotency-key": key },
    });
    if (r.statusCode === 429) limited = true;
  }
  assert.equal(limited, true);
});
