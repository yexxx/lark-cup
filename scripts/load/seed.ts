import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { openDB } from "../../server/db.js";
import { migrate } from "../../server/migrate.js";
import { hashPassword } from "../../server/password.js";
import { args, num, uuid, type Fixture } from "./common.js";
import { Redis } from "ioredis";
const a = args();
if (process.env.LOAD_TEST_ISOLATED !== "1")
  throw new Error("Isolated load environment required");
const db = await openDB();
try {
  if (
    (await db.query("SELECT current_database() AS name")).rows[0].name !==
    "lark_load"
  )
    throw new Error("Dedicated lark_load database required");
  await migrate(db);
  const large = a.size === "large",
    count = large ? 10000 : 1000,
    workCount = large ? 5000 : 500,
    votes = large ? 100000 : 5000;
  const seed = num(a, "seed", 1024);
  const password = "Load test password 2026 🔑";
  const hash = await hashPassword(password);
  const fixture: Fixture = {
    seed,
    password,
    createdAt: new Date().toISOString(),
    users: [],
    works: [],
    historicalVotes: votes,
  };
  const folder = "/app/load-fixtures",
    uploads = process.env.UPLOAD_DIR!;
  if (uploads !== "/app/data/uploads")
    throw new Error("Dedicated container upload directory required");
  await mkdir(folder, { recursive: true });
  await mkdir(uploads, { recursive: true });
  const previous = await readdir(uploads);
  if (previous.some((file) => !/^[a-f0-9-]{36}\.(html|webp)$/.test(file)))
    throw new Error("Unexpected files in fixture upload volume");
  for (let i = 0; i < previous.length; i += 128)
    await Promise.all(
      previous
        .slice(i, i + 128)
        .map((file) => unlink(path.join(uploads, file))),
    );
  await db.transaction(async (tx) => {
    await tx.query(
      "TRUNCATE audit_logs,reviews,work_versions,votes,daily_quotas,works,assets,auth_sessions,local_credentials,auth_identities,users RESTART IDENTITY CASCADE",
    );
    await tx.query("UPDATE competition SET data=data || $1::jsonb WHERE id=1", [
      JSON.stringify({
        loadTest: true,
        submissionStart: "2026-01-01T00:00:00+08:00",
        submissionEnd: "2036-12-31T23:59:59+08:00",
        voteStart: "2026-01-01T00:00:00+08:00",
        voteEnd: "2036-12-31T23:59:59+08:00",
        dailyLimit: 10,
        nextDailyLimit: null,
        limitEffectiveDate: null,
      }),
    ]);
    for (let i = 0; i < count; i++) {
      const token = randomBytes(32).toString("base64url");
      fixture.users.push({
        id: uuid(`${seed}:user:${i}`),
        username: `load_${seed}_${i}`,
        cookie: `lark_session=${token}`,
      });
    }
    for (let begin = 0; begin < count; begin += 500) {
      const batch = fixture.users.slice(begin, begin + 500).map((u, j) => ({
        ...u,
        role: begin + j === 0 ? "admin" : "user",
        tokenHash: createHash("sha256")
          .update(u.cookie.split("=")[1])
          .digest("hex"),
      }));
      const json = JSON.stringify(batch);
      await tx.query(
        "INSERT INTO users(id,name,role) SELECT x.id,x.username,x.role FROM jsonb_to_recordset($1::jsonb) AS x(id text,username text,role text)",
        [json],
      );
      await tx.query(
        "INSERT INTO auth_identities(provider,subject,user_id) SELECT 'local',x.username,x.id FROM jsonb_to_recordset($1::jsonb) AS x(id text,username text)",
        [json],
      );
      await tx.query(
        "INSERT INTO local_credentials(user_id,password_hash) SELECT x.id,$2 FROM jsonb_to_recordset($1::jsonb) AS x(id text)",
        [json, hash],
      );
      await tx.query(
        'INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at,last_seen_at) SELECT x."tokenHash",x.id,now(),now()+interval \'7 days\',now() FROM jsonb_to_recordset($1::jsonb) AS x(id text,"tokenHash" text)',
        [json],
      );
    }
    const cover = await sharp({
      create: { width: 480, height: 360, channels: 3, background: "#ffe173" },
    })
      .webp()
      .toBuffer();
    const html = Buffer.from(
      '<!doctype html><html><body><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="30" fill="gold"/><path d="M20 50L50 20L80 50"/></svg></body></html>',
    );
    const assets = [];
    for (let i = 0; i < workCount; i++) {
      const id = uuid(`${seed}:work:${i}`),
        coverId = uuid(`${seed}:cover:${i}`),
        htmlId = uuid(`${seed}:html:${i}`),
        owner = fixture.users[i % count].id;
      fixture.works.push({ id, coverId, htmlId });
      for (const [assetId, kind, ext, data, mime] of [
        [coverId, "cover", "webp", cover, "image/webp"],
        [htmlId, "html", "html", html, "text/html"],
      ] as const) {
        const filename = `${assetId}.${ext}`;
        await writeFile(path.join(uploads, filename), data);
        assets.push({
          id: assetId,
          owner,
          kind,
          filename,
          mime,
          bytes: data.length,
        });
      }
    }
    for (let begin = 0; begin < assets.length; begin += 500)
      await tx.query(
        "INSERT INTO assets(id,owner_id,kind,filename,mime,bytes) SELECT x.id,x.owner,x.kind,x.filename,x.mime,x.bytes FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,owner text,kind text,filename text,mime text,bytes integer)",
        [JSON.stringify(assets.slice(begin, begin + 500))],
      );
    for (let begin = 0; begin < workCount; begin += 500) {
      const rows = fixture.works.slice(begin, begin + 500).map((w, j) => ({
        ...w,
        owner: fixture.users[(begin + j) % count].id,
        title: `Load work ${begin + j}`,
      }));
      await tx.query(
        "INSERT INTO works(id,owner_id,track,title,description,model,prompt,cover_id,html_id,status) SELECT x.id,x.owner,'classic',x.title,'Load fixture','Load','SVG',x.\"coverId\",x.\"htmlId\",'approved' FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,owner text,title text,\"coverId\" uuid,\"htmlId\" uuid)",
        [JSON.stringify(rows)],
      );
    }
    await tx.query(
      "INSERT INTO votes(id,user_id,work_id,track,day,idempotency_key,created_at) SELECT md5('vote:'||i)::uuid,u.id,w.id,'classic','2026-09-01',md5('key:'||i)::uuid,'2026-09-01T10:00:00+08:00'::timestamptz FROM generate_series(0,$1::integer-1) i CROSS JOIN LATERAL (SELECT ($2::jsonb->(i%$4::integer)->>'id') AS id) u CROSS JOIN LATERAL (SELECT ($3::jsonb->((i%$4::integer*37+i/$4::integer)%$5::integer)->>'id')::uuid AS id) w",
      [
        votes,
        JSON.stringify(fixture.users.map((u) => ({ id: u.id }))),
        JSON.stringify(fixture.works),
        count,
        workCount,
      ],
    );
    await tx.query(
      "INSERT INTO daily_quotas(user_id,track,day,used) SELECT user_id,track,day,count(*) FROM votes GROUP BY user_id,track,day",
    );
    await tx.query(
      "INSERT INTO work_versions(work_id,version,snapshot) SELECT id,version,to_jsonb(works) FROM works",
    );
  });
  await db.query("ANALYZE");
  if (process.env.REDIS_URL) {
    const cache = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    cache.on("error", () => {});
    try {
      await cache.flushdb();
    } finally {
      cache.disconnect();
    }
  }
  await writeFile(path.join(folder, "fixture.json"), JSON.stringify(fixture), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      seed,
      users: count,
      works: workCount,
      votes,
      fixture: "/app/load-fixtures/fixture.json",
    }),
  );
} finally {
  await db.close();
}
