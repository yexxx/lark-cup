import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import sharp from "sharp";
import { args, local, type Fixture } from "./common.js";
const a = args(),
  base = String(a.base || "http://localhost:13001"),
  preview = String(a.preview || "http://localhost:13002"),
  origin = String(a.origin || "http://localhost:18080");
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Local isolated target required");
const fixture: Fixture = JSON.parse(
  await readFile(path.join(local, "fixtures/fixture.json"), "utf8"),
);
const { password } = JSON.parse(
  await readFile(path.join(local, "environment.json"), "utf8"),
);
const pool = new Pool({
  host: "127.0.0.1",
  port: 15432,
  user: "lark",
  database: "lark_load",
  password,
  max: 3,
  connectionTimeoutMillis: 3000,
});
pool.on("error", () => {});
if (
  (await pool.query("SELECT current_database() AS name")).rows[0].name !==
    "lark_load" ||
  !(
    await pool.query(
      "SELECT data->>'loadTest' AS marker FROM competition WHERE id=1",
    )
  ).rows[0].marker
)
  throw new Error("Dedicated fixture database required");
const output = path.resolve(
  String(a.output || "test-results/load/checks.json"),
);
await mkdir(path.dirname(output), { recursive: true });
const results: {
  name: string;
  passed: boolean;
  ms: number;
  details?: unknown;
  error?: string;
}[] = [];
async function check(name: string, fn: () => Promise<unknown>) {
  const t = performance.now();
  try {
    const details = await fn();
    results.push({ name, passed: true, ms: performance.now() - t, details });
  } catch (e) {
    results.push({
      name,
      passed: false,
      ms: performance.now() - t,
      error: (e as Error).message.slice(0, 1500),
    });
  }
  await writeFile(
    output,
    JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
  );
  console.log(JSON.stringify(results.at(-1)));
}
type User = { id: string; cookie: string; username?: string };
async function call(
  url: string,
  user?: User,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = { Origin: origin };
  if (user) {
    headers.Cookie = user.cookie;
    headers["X-Lark-User"] = user.id;
  }
  Object.assign(headers, extra);
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await fetch(base + url, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(20000),
    }),
    text = await r.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data, headers: r.headers };
}
async function fresh(label: string) {
  const r = await call("/api/v1/auth/register", undefined, "POST", {
    username: `load_${label}_${Date.now()}`,
    name: `Load ${label}`,
    password: fixture.password,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return {
    id: r.data.user.id,
    cookie: r.headers
      .getSetCookie()
      .find((s) => s.startsWith("lark_session="))!
      .split(";")[0],
  };
}
async function upload(data: Buffer, name: string, user: User) {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(data)]), name);
  return call("/api/v1/uploads", user, "POST", form);
}
const admin = fixture.users[0],
  author = await fresh("author"),
  other = await fresh("other");
let htmlId: string, coverId: string, workId: string, largeHtmlId: string;
await check(
  "concurrent registration creates one complete account",
  async () => {
    const username = `load_race_${Date.now()}`;
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        call("/api/v1/auth/register", undefined, "POST", {
          username,
          name: "Race",
          password: fixture.password,
        }),
      ),
    );
    assert.equal(responses.filter((r) => r.status === 200).length, 1);
    assert(responses.every((r) => [200, 409, 503].includes(r.status)));
    const r = await pool.query(
      "SELECT count(*)::integer AS accounts FROM auth_identities i JOIN users u ON u.id=i.user_id JOIN local_credentials c ON c.user_id=u.id WHERE i.provider='local' AND i.subject=$1",
      [username],
    );
    assert.equal(r.rows[0].accounts, 1);
    return {
      codes: responses.reduce(
        (m: Record<number, number>, r) => (
          (m[r.status] = (m[r.status] || 0) + 1),
          m
        ),
        {},
      ),
    };
  },
);
await check(
  "login burst rejects excess password work and recovers",
  async () => {
    const responses = await Promise.all(
      fixture.users.slice(100, 120).map((u) =>
        call("/api/v1/auth/login", undefined, "POST", {
          username: u.username,
          password: fixture.password,
        }),
      ),
    );
    assert(responses.some((r) => r.status === 200));
    assert(responses.some((r) => r.status === 503));
    assert(responses.every((r) => [200, 503].includes(r.status)));
    const after = await call("/api/v1/auth/login", undefined, "POST", {
      username: fixture.users[120].username,
      password: fixture.password,
    });
    assert.equal(after.status, 200);
    return {
      accepted: responses.filter((r) => r.status === 200).length,
      busy: responses.filter((r) => r.status === 503).length,
      recovery: after.status,
    };
  },
);
await check(
  "failed login, identity binding, and cross-user writes",
  async () => {
    assert.equal(
      (
        await call("/api/v1/auth/login", undefined, "POST", {
          username: fixture.users[123].username,
          password: "Incorrect long password 2026",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/api/v1/auth/login", undefined, "POST", {
          username: "missing_load_account",
          password: fixture.password,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/api/v1/me/quota", author, "GET", undefined, {
          "X-Lark-User": other.id,
        })
      ).status,
      409,
    );
    assert.equal((await call("/api/v1/admin/overview", author)).status, 403);
    return {
      failedLogin: 401,
      missingAccount: 401,
      wrongIdentity: 409,
      adminIsolation: 403,
    };
  },
);
await check(
  "upload boundaries, structural limits, and image dimensions",
  async () => {
    const good = Buffer.from(
      '<!doctype html><html><body><svg><circle r="20"/></svg></body></html>',
    );
    const h = await upload(good, "bird.html", author);
    assert.equal(h.status, 200);
    htmlId = h.data.id;
    const image = await sharp({
      create: { width: 128, height: 96, channels: 3, background: "#ffe173" },
    })
      .png()
      .toBuffer();
    const c = await upload(image, "cover.png", author);
    assert.equal(c.status, 200);
    coverId = c.data.id;
    const deep = Buffer.from(
      "<!doctype html><html><body>" +
        "<div>".repeat(5000) +
        "<svg><circle/></svg>" +
        "</div>".repeat(5000) +
        "</body></html>",
    );
    assert.equal((await upload(deep, "deep.html", author)).status, 400);
    assert.equal(
      (
        await upload(
          Buffer.alloc(5 * 1024 * 1024 + 1, 65),
          "oversize.html",
          author,
        )
      ).status,
      413,
    );
    const huge = await sharp({
      create: { width: 4096, height: 4096, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    assert.equal((await upload(huge, "huge.png", author)).status, 400);
    return {
      htmlBytes: good.length,
      coverBytes: image.length,
      deepBytes: deep.length,
      imagePixels: 4096 * 4096,
    };
  },
);
await check(
  "large upload pressure leaves reads responsive and restores slots",
  async () => {
    const html = Buffer.from(
      "<!doctype html><html><body><svg><circle/></svg><!--" +
        " ".repeat(5 * 1024 * 1024 - 150) +
        "--></body></html>",
    );
    const uploads = Array.from({ length: 3 }, () =>
      upload(html, "large.html", other),
    );
    const reads = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const t = performance.now();
        const r = await call("/api/v1/works?size=12");
        return { status: r.status, ms: performance.now() - t };
      }),
    );
    const r = await Promise.all(uploads);
    largeHtmlId = r.find((x) => x.status === 200)?.data.id;
    assert(r.some((x) => x.status === 200));
    assert(r.some((x) => x.status === 503));
    assert(reads.every((x) => [200, 503].includes(x.status)));
    const stats = await call("/api/v1/admin/overview", admin);
    assert.equal(stats.status, 200);
    assert.equal(stats.data.activeUploads, 0);
    return {
      uploadCodes: r.map((x) => x.status),
      readMaxMs: Math.max(...reads.map((x) => x.ms)),
      activeUploads: stats.data.activeUploads,
    };
  },
);
await check(
  "repeated large HTML processing keeps process and upload budgets bounded",
  async () => {
    const dockerEnv = {
      ...process.env,
      DOCKER_HOST:
        process.env.LOAD_DOCKER_HOST ||
        `unix://${process.env.HOME}/.colima/lark-load/docker.sock`,
      DOCKER_CONFIG: path.join(local, "docker"),
    };
    const pids = async () =>
      Number(
        (
          await promisify(execFile)(
            "docker",
            [
              "exec",
              "lark-cup-load-api-1",
              "cat",
              "/sys/fs/cgroup/pids.current",
            ],
            { env: dockerEnv },
          )
        ).stdout.trim(),
      );
    const before = await pids();
    const html = Buffer.from(
      "<!doctype html><html><body><svg><circle/></svg><!--" +
        " ".repeat(5 * 1024 * 1024 - 150) +
        "--></body></html>",
    );
    for (let i = 0; i < 20; i++)
      assert.equal(
        (await upload(html, "repeated.html", fixture.users[100 + i])).status,
        200,
        `large upload ${i}`,
      );
    await new Promise((r) => setTimeout(r, 500));
    const after = await pids();
    assert(after <= before + 4, JSON.stringify({ before, after }));
    assert.equal(
      (await call("/api/v1/admin/overview", admin)).data.activeUploads,
      0,
    );
    return {
      uploads: 20,
      bytesPerUpload: html.length,
      pidsBefore: before,
      pidsAfter: after,
    };
  },
);
await check(
  "slow upload protection recovers after both clients disconnect",
  async () => {
    const { request } = await import("node:http"),
      held: ReturnType<typeof request>[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const boundary = `load-slow-${i}`,
          req = request(
            base + "/api/v1/uploads",
            {
              method: "POST",
              headers: {
                Origin: origin,
                Cookie: other.cookie,
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": "300000",
              },
            },
            (r) => r.resume(),
          );
        req.on("error", () => {});
        held.push(req);
        req.write(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.html"\r\nContent-Type: text/html\r\n\r\n<!doctype html><html>`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
      const busy = await upload(
        Buffer.from("<svg><circle/></svg>"),
        "extra.html",
        other,
      );
      assert.equal(busy.status, 503);
      assert.equal((await call("/api/v1/works?size=12")).status, 200);
    } finally {
      held.forEach((req) => req.destroy());
    }
    await new Promise((r) => setTimeout(r, 500));
    const stats = await call("/api/v1/admin/overview", admin);
    assert.equal(stats.data.activeUploads, 0);
    return {
      overflow: 503,
      reads: 200,
      activeUploads: stats.data.activeUploads,
    };
  },
);
await check(
  "real publication, owner isolation, optimistic editing, and publish race",
  async () => {
    const body = {
      title: "Load lifecycle",
      description: "Measured lifecycle",
      model: "Load",
      prompt: "SVG",
      coverId,
      htmlId,
    };
    assert.equal(
      (await call("/api/v1/works", other, "POST", body)).status,
      400,
    );
    const created = await call("/api/v1/works", author, "POST", body);
    assert.equal(created.status, 200);
    workId = created.data.id;
    const edits = await Promise.all(
      ["one", "two"].map((title) =>
        call(`/api/v1/works/${workId}`, author, "PUT", {
          ...body,
          title,
          version: 1,
        }),
      ),
    );
    assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (await call(`/api/v1/works/${workId}/submit`, author, "POST")).status,
      200,
    );
    const publications = await Promise.all(
      Array.from({ length: 2 }, () =>
        call(`/api/v1/works/${workId}/submit`, author, "POST"),
      ),
    );
    assert.deepEqual(
      publications.map((r) => r.status),
      [200, 200],
    );
    const r = await pool.query(
      "SELECT count(*)::integer AS n FROM audit_logs WHERE action='work.publish' AND target=$1",
      [workId],
    );
    assert.equal(r.rows[0].n, 1);
    assert.equal(
      (await call(`/api/v1/works/${workId}`, undefined, "GET")).data.ownerId,
      undefined,
    );
    return {
      editCodes: edits.map((r) => r.status),
      publishCodes: publications.map((r) => r.status),
    };
  },
);
await check(
  "published editing competes with publication and remains public",
  async () => {
    const body = {
      title: "Concurrent publication",
      description: "",
      model: "",
      prompt: "SVG",
      coverId,
      htmlId,
    };
    const created = await call("/api/v1/works", author, "POST", body);
    assert.equal(created.status, 200);
    const id = created.data.id;
    assert.equal(
      (await call(`/api/v1/works/${id}/submit`, author, "POST")).status,
      200,
    );
    const [edit, publication] = await Promise.all([
      call(`/api/v1/works/${id}`, author, "PUT", {
        ...body,
        title: "Updated published work",
        version: 1,
      }),
      call(`/api/v1/works/${id}/submit`, author, "POST"),
    ]);
    assert.equal(edit.status, 200);
    assert.equal(publication.status, 200);
    const state = (
      await pool.query("SELECT version,status,title FROM works WHERE id=$1", [
        id,
      ])
    ).rows[0];
    assert.equal(state.version, 2);
    assert.equal(state.status, "approved");
    assert.equal(state.title, "Updated published work");
    assert.equal((await call(`/api/v1/works/${id}`)).status, 200);
    return {
      edit: edit.status,
      publication: publication.status,
      currentVersion: 2,
      currentStatus: "approved",
    };
  },
);
await check(
  "slow preview consumers retain API capacity and release their slots",
  async () => {
    assert(largeHtmlId);
    const image = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#ffe173" },
    })
      .png()
      .toBuffer();
    const cover = await upload(image, "large-cover.png", other);
    assert.equal(cover.status, 200);
    const created = await call("/api/v1/works", other, "POST", {
      title: "Slow preview",
      description: "Load check",
      model: "Load",
      prompt: "SVG",
      htmlId: largeHtmlId,
      coverId: cover.data.id,
    });
    assert.equal(created.status, 200);
    assert.equal(
      (await call(`/api/v1/works/${created.data.id}/submit`, other, "POST"))
        .status,
      200,
    );
    const { stdout } = await promisify(execFile)(
      "docker",
      [
        "run",
        "--rm",
        "--label",
        "lark-cup-load-owned=true",
        "--network",
        "lark-cup-load_default",
        "--cpus",
        "0.1",
        "--memory",
        "64m",
        "--pids-limit",
        "32",
        "-v",
        `${path.resolve("scripts/load/slow-preview.py")}:/slow-preview.py:ro`,
        "-v",
        `${path.join(local, "fixtures/fixture.json")}:/fixture.json:ro`,
        "python:3.12-alpine",
        "python",
        "/slow-preview.py",
        largeHtmlId,
      ],
      {
        env: {
          ...process.env,
          DOCKER_HOST:
            process.env.LOAD_DOCKER_HOST ||
            `unix://${process.env.HOME}/.colima/lark-load/docker.sock`,
          DOCKER_CONFIG: path.join(local, "docker"),
        },
        timeout: 15000,
      },
    );
    const details = JSON.parse(stdout.trim());
    await writeFile(
      output.replace(/\.json$/, "-slow-preview.json"),
      JSON.stringify(details, null, 2),
    );
    assert.equal(details.healthStatus, 200, JSON.stringify(details));
    assert.equal(details.overviewStatus, 200, JSON.stringify(details));
    assert.equal(details.inflightDuringOverview, 9, JSON.stringify(details));
    assert.equal(
      details.previewCodes.filter((s: number) => s === 200).length,
      8,
    );
    assert.equal(
      details.previewCodes.filter((s: number) => s === 503).length,
      24,
    );
    assert.equal(details.recoveredInflightDuringOverview, 1);
    return details;
  },
);
await check(
  "concurrent voting preserves idempotency and daily quota",
  async () => {
    const voter = await fresh("idem"),
      key = randomUUID();
    const votes = await Promise.all(
      Array.from({ length: 8 }, () =>
        call(`/api/v1/works/${workId}/votes`, voter, "POST", undefined, {
          "Idempotency-Key": key,
        }),
      ),
    );
    assert(votes.every((r) => r.status === 200));
    assert.equal(new Set(votes.map((r) => r.data.id)).size, 1);
    assert.equal((await call("/api/v1/me/quota", voter)).data.classic, 1);
    const quotaVoter = await fresh("quota");
    const attempts = await Promise.all(
      fixture.works.slice(0, 15).map((w) =>
        call(`/api/v1/works/${w.id}/votes`, quotaVoter, "POST", undefined, {
          "Idempotency-Key": randomUUID(),
        }),
      ),
    );
    assert.equal(attempts.filter((r) => r.status === 200).length, 10);
    assert(attempts.every((r) => [200, 409].includes(r.status)));
    assert.equal((await call("/api/v1/me/quota", quotaVoter)).data.classic, 10);
    return {
      idempotentResponses: votes.length,
      storedVotes: 1,
      quotaAccepted: 10,
      quotaRejected: 5,
    };
  },
);
await check(
  "withdrawal competes safely with votes and voiding remains audited",
  async () => {
    const responses = await Promise.all([
      ...fixture.users.slice(500, 520).map((u) =>
        call(`/api/v1/works/${workId}/votes`, u, "POST", undefined, {
          "Idempotency-Key": randomUUID(),
        }),
      ),
      call(`/api/v1/works/${workId}/withdraw`, author, "POST"),
    ]);
    assert(responses.every((r) => [200, 404].includes(r.status)));
    assert.equal(
      (
        await call(`/api/v1/works/${workId}/votes`, other, "POST", undefined, {
          "Idempotency-Key": randomUUID(),
        })
      ).status,
      404,
    );
    const vote = (
      await pool.query(
        "SELECT id FROM votes WHERE work_id=$1 AND valid LIMIT 1",
        [workId],
      )
    ).rows[0];
    assert(vote);
    assert.equal(
      (
        await call(`/api/v1/admin/votes/${vote.id}/void`, admin, "POST", {
          reason: "Load check",
        })
      ).status,
      200,
    );
    const audit = (
      await pool.query(
        "SELECT count(*)::integer AS n FROM audit_logs WHERE action='vote.void' AND target=$1",
        [vote.id],
      )
    ).rows[0];
    assert.equal(audit.n, 1);
    return {
      acceptedVotes: responses.slice(0, 20).filter((r) => r.status === 200)
        .length,
      auditCount: audit.n,
    };
  },
);
await check("private preview signatures and cross-origin writes", async () => {
  const r = await call(`/api/v1/works/${workId}`, author);
  assert.equal(r.status, 200);
  const target = new URL(r.data.previewUrl);
  const signed = preview + target.pathname + target.search;
  assert.equal((await fetch(signed)).status, 200);
  assert.equal((await fetch(preview + target.pathname)).status, 404);
  assert.equal(
    (await fetch(signed.replace(/token=[^&]+/, "token=invalid"))).status,
    404,
  );
  assert.equal(
    (
      await call("/api/v1/auth/logout", author, "POST", undefined, {
        Origin: "https://untrusted.invalid",
      })
    ).status,
    403,
  );
  const publicPreview = await fetch(
    `${preview}/preview/${fixture.works[0].htmlId}`,
  );
  assert.equal(publicPreview.status, 200);
  assert(
    publicPreview.headers
      .get("content-security-policy")
      ?.includes("sandbox allow-scripts"),
  );
  return { signed: 200, unsigned: 404, forged: 404, crossOrigin: 403 };
});
await check(
  "CSV export keeps one snapshot during concurrent backdated writes",
  async () => {
    const before = Number(
      (await pool.query("SELECT count(*) AS n FROM votes")).rows[0].n,
    );
    const r = await fetch(base + "/api/v1/admin/export/votes", {
      headers: { Origin: origin, Cookie: admin.cookie },
    });
    assert.equal(r.status, 200);
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let csv = "";
    while (!csv.includes("\r\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      csv += decoder.decode(chunk.value, { stream: true });
    }
    const inserted = randomUUID();
    try {
      await pool.query(
        "INSERT INTO votes(id,user_id,work_id,track,day,idempotency_key,created_at) VALUES($1,$2,$3,'classic','2020-01-01',$4,'2020-01-01')",
        [inserted, admin.id, fixture.works[0].id, randomUUID()],
      );
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        csv += decoder.decode(chunk.value, { stream: true });
      }
      csv += decoder.decode();
      const rows = csv
        .replace(/^\uFEFF/, "")
        .trim()
        .split("\r\n")
        .slice(1);
      const ids = rows.map((line) => line.split(",")[0]);
      assert.equal(rows.length, before);
      assert.equal(new Set(ids).size, before);
      assert(!csv.includes(inserted));
      return {
        expectedRows: before,
        exportedRows: rows.length,
        uniqueRows: new Set(ids).size,
      };
    } finally {
      await pool.query("DELETE FROM votes WHERE id=$1", [inserted]);
    }
  },
);
await check(
  "deep paging and simultaneous cold cache rebuild remain bounded",
  async () => {
    for (const url of [
      "/api/v1/works?page=10000&size=48",
      "/api/v1/leaderboard?page=10000&size=48",
      "/api/v1/admin/works?page=10000&size=48",
      "/api/v1/admin/votes?page=10000&size=48",
      "/api/v1/admin/users?page=10000&size=48",
    ]) {
      const r = await call(url, admin);
      assert.equal(r.status, 200);
      assert.equal(r.data.items.length, 0);
    }
    assert.equal((await call("/api/v1/works?page=10001")).status, 400);
    const q = encodeURIComponent("cold batch " + Date.now());
    const t = performance.now();
    const responses = await Promise.all(
      Array.from({ length: 24 }, () => call("/api/v1/works?q=" + q)),
    );
    assert(responses.every((r) => r.status === 200));
    return {
      deepPage: 10000,
      coldReaders: responses.length,
      elapsedMs: performance.now() - t,
    };
  },
);
await check(
  "credential changes, disable, and unrelated sessions stay isolated",
  async () => {
    const u = fixture.users[50];
    const login = await call("/api/v1/auth/login", undefined, "POST", {
      username: u.username,
      password: fixture.password,
    });
    assert.equal(login.status, 200);
    const session = {
      ...u,
      cookie: login.headers
        .getSetCookie()
        .find((s) => s.startsWith("lark_session="))!
        .split(";")[0],
    };
    const passwordChange = await call(
      "/api/v1/auth/password",
      session,
      "POST",
      {
        currentPassword: fixture.password,
        newPassword: "Updated load password 2026 🔑",
      },
    );
    assert.equal(passwordChange.status, 200);
    assert.equal((await call("/api/v1/auth/me", u)).data.user, null);
    assert.equal((await call("/api/v1/auth/me", session)).data.user, null);
    assert.equal(
      (await call("/api/v1/auth/me", fixture.users[51])).data.user.id,
      fixture.users[51].id,
    );
    const disabled = fixture.users[52];
    assert.equal(
      (
        await call(`/api/v1/admin/users/${disabled.id}`, admin, "PATCH", {
          status: "disabled",
        })
      ).status,
      200,
    );
    assert.equal((await call("/api/v1/auth/me", disabled)).data.user, null);
    await call(`/api/v1/admin/users/${disabled.id}`, admin, "PATCH", {
      status: "active",
    });
    assert.equal((await call("/api/v1/auth/me", disabled)).data.user, null);
    return {
      passwordChange: 200,
      revokedDevices: 2,
      unrelatedSession: "active",
      disabledSession: "revoked",
    };
  },
);
await check(
  "disabling an account wins its queued vote race without consuming quota",
  async () => {
    const user = await fresh("stoprace"),
      connection = await pool.connect();
    let disable: Promise<any> | undefined;
    const votes: Promise<any>[] = [];
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        user.id,
      ]);
      disable = call(`/api/v1/admin/users/${user.id}`, admin, "PATCH", {
        status: "disabled",
      });
      let waiting = false;
      for (let i = 0; i < 20; i++) {
        waiting =
          Number(
            (
              await pool.query(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE users SET status%'",
              )
            ).rows[0].n,
          ) > 0;
        if (waiting) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert(
        waiting,
        "Disable must acquire the first place in the row lock queue",
      );
      for (const work of fixture.works.slice(0, 12))
        votes.push(
          call(`/api/v1/works/${work.id}/votes`, user, "POST", undefined, {
            "Idempotency-Key": randomUUID(),
          }),
        );
      await new Promise((r) => setTimeout(r, 100));
      await connection.query("COMMIT");
      assert.equal((await disable).status, 200);
      const codes = (await Promise.all(votes)).map((r) => r.status);
      assert(
        codes.every((code) => [401, 403].includes(code)),
        JSON.stringify(codes),
      );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) AS n FROM votes WHERE user_id=$1",
              [user.id],
            )
          ).rows[0].n,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT COALESCE(sum(used),0) AS n FROM daily_quotas WHERE user_id=$1",
              [user.id],
            )
          ).rows[0].n,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) AS n FROM audit_logs WHERE action='user.status' AND target=$1",
              [user.id],
            )
          ).rows[0].n,
        ),
        1,
      );
      return {
        voteCodes: codes,
        storedVotes: 0,
        quotaUsed: 0,
        disableAudits: 1,
      };
    } finally {
      await connection.query("ROLLBACK").catch(() => {});
      connection.release();
      await disable?.catch(() => {});
      await Promise.allSettled(votes);
    }
  },
);
await check("vote quota and ownership reconciliation", async () => {
  const r = await pool.query(
    "SELECT count(*)::integer AS mismatches FROM daily_quotas q FULL JOIN (SELECT user_id,track,day,count(*)::integer AS used FROM votes GROUP BY user_id,track,day) v USING(user_id,track,day) WHERE COALESCE(q.used,0)<>COALESCE(v.used,0)",
  );
  assert.equal(r.rows[0].mismatches, 0);
  const asset = (
    await pool.query(
      "SELECT count(*)::integer AS bad FROM works w JOIN assets a ON a.id=w.cover_id OR a.id=w.html_id WHERE a.owner_id<>w.owner_id",
    )
  ).rows[0];
  assert.equal(asset.bad, 0);
  const over = (
    await pool.query(
      "SELECT count(*)::integer AS n FROM daily_quotas WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date AND used>10",
    )
  ).rows[0];
  assert.equal(over.n, 0);
  return { quotaMismatches: 0, wrongAssetOwners: 0, overQuota: 0 };
});
await check(
  "successful mutations have their required audit records",
  async () => {
    const changes = (
      await pool.query(
        "SELECT action,target,count(*)::integer AS n FROM audit_logs WHERE action IN ('account.create','account.password.change','user.status','work.publish','vote.void') GROUP BY action,target",
      )
    ).rows;
    assert(
      changes.some(
        (r) => r.action === "account.create" && r.target === author.id,
      ),
    );
    assert(
      changes.some(
        (r) =>
          r.action === "account.password.change" &&
          r.target === fixture.users[50].id,
      ),
    );
    assert(
      changes.some(
        (r) =>
          r.action === "user.status" &&
          r.target === fixture.users[52].id &&
          r.n === 2,
      ),
    );
    assert(
      changes.some(
        (r) => r.action === "work.publish" && r.target === workId && r.n === 1,
      ),
    );
    return {
      checkedActions: 5,
      publishAuditCount: 1,
      disableAndEnableAuditCount: 2,
    };
  },
);
await pool.end();
process.exitCode = results.every((r) => r.passed) ? 0 : 1;
