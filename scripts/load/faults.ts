import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { args, local, type Fixture } from "./common.js";
const a = args(),
  phase = String(a.phase || "fixed"),
  output = path.resolve(
    String(a.output || `test-results/load/${phase}-faults.json`),
  );
if (!["baseline", "fixed"].includes(phase))
  throw new Error("Use --phase baseline|fixed");
const fixture: Fixture = JSON.parse(
  await readFile(path.join(local, "fixtures/fixture.json"), "utf8"),
);
const { password } = JSON.parse(
  await readFile(path.join(local, "environment.json"), "utf8"),
);
const env = {
  ...process.env,
  DOCKER_HOST:
    process.env.LOAD_DOCKER_HOST ||
    `unix://${process.env.HOME}/.colima/lark-load/docker.sock`,
  DOCKER_CONFIG: path.join(local, "docker"),
};
const exec = promisify(execFile),
  pool = new Pool({
    host: "127.0.0.1",
    port: 15432,
    user: "lark",
    database: "lark_load",
    password,
    max: 2,
    connectionTimeoutMillis: 3000,
  });
pool.on("error", () => {});
if (
  !(
    await pool.query(
      "SELECT data->>'loadTest' AS marker FROM competition WHERE id=1",
    )
  ).rows[0].marker
)
  throw new Error("Fixture database required");
await mkdir(path.dirname(output), { recursive: true });
const results: any[] = [];
async function docker(argv: string[], extraEnv: Record<string, string> = {}) {
  return exec("docker", argv, {
    env: { ...env, ...extraEnv },
    timeout: 60000,
    maxBuffer: 300000,
  });
}
async function guard(service: string) {
  const r = await docker([
    "inspect",
    "--format",
    '{{index .Config.Labels "com.docker.compose.project"}}',
    `lark-cup-load-${service}-1`,
  ]);
  assert.equal(r.stdout.trim(), "lark-cup-load");
}
async function check(name: string, fn: () => Promise<unknown>) {
  const t = performance.now();
  try {
    results.push({
      name,
      passed: true,
      details: await fn(),
      ms: performance.now() - t,
    });
  } catch (e) {
    results.push({
      name,
      passed: false,
      error: (e as Error).message.slice(0, 2000),
      ms: performance.now() - t,
    });
  }
  await writeFile(
    output,
    JSON.stringify({ date: new Date().toISOString(), phase, results }, null, 2),
  );
  console.log(JSON.stringify(results.at(-1)));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function response(url: string, options: RequestInit = {}) {
  try {
    const r = await fetch(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(18000),
    });
    const text = await r.text();
    return { status: r.status, text, retryAfter: r.headers.get("retry-after") };
  } catch (e) {
    return { status: 0, text: (e as Error).message, retryAfter: null };
  }
}
async function recover() {
  const t = performance.now();
  while (performance.now() - t < 30000) {
    const responses = await Promise.all(
      ["/api/v1/health", "/api/v1/works?size=12"].map((route) =>
        response("http://localhost:13001" + route, {
          signal: AbortSignal.timeout(3000),
        }),
      ),
    );
    if (responses.every((r) => r.status === 200))
      return Math.round(performance.now() - t);
    await sleep(250);
  }
  throw new Error("Health recovery exceeded 30s");
}
await check("Redis outage fails closed and reconnects", async () => {
  await guard("redis");
  await docker(["stop", "-t", "1", "lark-cup-load-redis-1"]);
  let failure;
  try {
    failure = await response("http://localhost:13001/api/v1/works?size=12");
    assert([500, 503].includes(failure.status));
    if (phase === "fixed") {
      assert.equal(failure.status, 503);
      assert.equal(failure.retryAfter, "2");
    }
  } finally {
    await docker(["start", "lark-cup-load-redis-1"]);
  }
  const recoveryMs = await recover();
  return {
    status: failure!.status,
    retryAfter: failure!.retryAfter,
    recoveryMs,
  };
});
await check(
  "PostgreSQL stop preserves the API process and reconnects",
  async () => {
    await guard("db");
    const { request } = await import("node:http");
    const pausedExport = request(
      "http://localhost:13001/api/v1/admin/export/votes",
      { headers: { Cookie: fixture.users[0].cookie } },
    );
    pausedExport.on("error", () => {});
    const exportReady = new Promise<void>((resolve, reject) => {
      pausedExport.on("response", (r) => {
        r.pause();
        r.statusCode === 200
          ? resolve()
          : reject(new Error("Export setup status " + r.statusCode));
      });
      pausedExport.once("error", reject);
    });
    pausedExport.end();
    try {
      await exportReady;
      await sleep(500);
      const idleExports = Number(
        (
          await pool.query(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE state='idle in transaction' AND query LIKE 'FETCH 500 FROM export_rows%'",
          )
        ).rows[0].n,
      );
      if (phase === "fixed")
        assert(
          idleExports > 0,
          "An export cursor must be borrowed during the outage",
        );
      if (phase === "fixed") {
        const otherAdmin = fixture.users[1],
          oldRole = (
            await pool.query("SELECT role FROM users WHERE id=$1", [
              otherAdmin.id,
            ])
          ).rows[0].role;
        await pool.query("UPDATE users SET role='admin' WHERE id=$1", [
          otherAdmin.id,
        ]);
        try {
          const busy = await response(
            "http://localhost:13001/api/v1/admin/export/votes",
            { headers: { Cookie: otherAdmin.cookie } },
          );
          assert.equal(busy.status, 503);
          assert.equal(busy.retryAfter, "2");
          assert.equal(typeof JSON.parse(busy.text).message, "string");
        } finally {
          await pool.query("UPDATE users SET role=$2 WHERE id=$1", [
            otherAdmin.id,
            oldRole,
          ]);
        }
      }
      await docker(["stop", "-t", "1", "lark-cup-load-db-1"]);
      let during;
      try {
        during = await response("http://localhost:13001/api/v1/health");
        assert([0, 500, 503].includes(during.status));
        if (phase === "fixed") assert.equal(during.status, 503);
      } finally {
        await docker(["start", "lark-cup-load-db-1"]);
        pausedExport.destroy();
      }
      const recoveryMs = await recover();
      const state = await docker([
        "inspect",
        "--format",
        "{{.State.Running}} {{.RestartCount}}",
        "lark-cup-load-api-1",
      ]);
      assert.equal(state.stdout.trim().split(" ")[0], "true");
      return {
        status: during!.status,
        recoveryMs,
        apiState: state.stdout.trim(),
        idleExportCursors: idleExports,
      };
    } finally {
      pausedExport.destroy();
    }
  },
);
await docker(["start", "lark-cup-load-api-1"]);
await recover();
await check(
  "database pause plus idempotent retry stores one vote",
  async () => {
    await guard("db");
    const work = fixture.works.at(-1)!,
      key = randomUUID();
    const candidate = (
      await pool.query(
        "SELECT u.id FROM users u WHERE u.id=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.user_id=u.id AND v.work_id=$2 AND v.valid) ORDER BY u.id LIMIT 1",
        [fixture.users.slice(-300).map((u) => u.id), work.id],
      )
    ).rows[0];
    assert(candidate, "Fresh voter required for fault retry");
    const user = fixture.users.find((u) => u.id === candidate.id)!;
    const url = `http://localhost:13001/api/v1/works/${work.id}/votes`,
      options = {
        method: "POST",
        headers: {
          Origin: "http://localhost:18080",
          Cookie: user.cookie,
          "X-Lark-User": user.id,
          "Idempotency-Key": key,
        },
      };
    await docker(["pause", "lark-cup-load-db-1"]);
    const pending = response(url, {
      ...options,
      signal: AbortSignal.timeout(100),
    });
    try {
      await sleep(1200);
    } finally {
      await docker(["unpause", "lark-cup-load-db-1"]);
    }
    const first = await pending;
    await sleep(1000);
    const second = await response(url, options);
    assert.equal(first.status, 0);
    assert.equal(second.status, 200);
    const rows = (
      await pool.query(
        "SELECT count(*)::integer AS n FROM votes WHERE user_id=$1 AND idempotency_key=$2",
        [user.id, key],
      )
    ).rows[0];
    assert.equal(rows.n, 1);
    return { first: first.status, retry: second.status, storedVotes: rows.n };
  },
);
await check("API restart retains independent database sessions", async () => {
  await guard("api");
  await docker(["restart", "-t", "5", "lark-cup-load-api-1"]);
  const recoveryMs = await recover();
  const codes = [];
  for (const user of fixture.users.slice(60, 62)) {
    const r = await response("http://localhost:13001/api/v1/auth/me", {
      headers: { Cookie: user.cookie },
    });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).user.id, user.id);
    codes.push(r.status);
  }
  return { recoveryMs, sessions: codes };
});
await check(
  "bounded upload disk failure leaves no partial files or metadata",
  async () => {
    const name = `lark-load-disk-${phase}`;
    const dbUrl = `postgres://lark:${password}@db:5432/lark_load`;
    const faultEnv = {
      DATABASE_URL: dbUrl,
      REDIS_URL: "redis://redis:6379",
      APP_ORIGIN: "http://localhost:18080",
      PREVIEW_ORIGIN: "http://localhost:23002",
      UPLOAD_DIR: "/app/data/uploads",
      NODE_ENV: "production",
      IP_RATE_PER_MINUTE: "1000000",
    };
    await docker(
      [
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "lark-cup-load_default",
        "--memory",
        "1536m",
        "--cpus",
        "1.5",
        "--tmpfs",
        "/app/data/uploads:rw,size=1m,uid=1000,gid=1000",
        "-p",
        "127.0.0.1:23001:3001",
        ...Object.keys(faultEnv).flatMap((k) => ["--env", k]),
        `lark-cup-load-api:${phase}`,
      ],
      faultEnv,
    );
    try {
      let ready = false;
      for (let i = 0; i < 80; i++) {
        if (
          (await response("http://localhost:23001/api/v1/health")).status ===
          200
        ) {
          ready = true;
          break;
        }
        await sleep(250);
      }
      assert(ready);
      const owner = fixture.users[80],
        before = Number(
          (
            await pool.query(
              "SELECT count(*) AS n FROM assets WHERE owner_id=$1",
              [owner.id],
            )
          ).rows[0].n,
        );
      const blob = new Blob([
        "<!doctype html><html><body><svg><circle/></svg><!--",
        " ".repeat(1600000),
        "--></body></html>",
      ]);
      const form = new FormData();
      form.set("file", blob, "disk.html");
      const r = await response("http://localhost:23001/api/v1/uploads", {
        method: "POST",
        headers: { Origin: "http://localhost:18080", Cookie: owner.cookie },
        body: form,
      });
      const files = await docker([
        "exec",
        name,
        "sh",
        "-c",
        "find /app/data/uploads -type f | wc -l",
      ]);
      const fileCount = Number(files.stdout.trim());
      const after = Number(
        (
          await pool.query(
            "SELECT count(*) AS n FROM assets WHERE owner_id=$1",
            [owner.id],
          )
        ).rows[0].n,
      );
      assert.equal(after, before);
      assert([500, 503].includes(r.status));
      if (phase === "fixed") {
        assert.equal(r.status, 503);
        assert.equal(fileCount, 0);
      }
      return {
        status: r.status,
        partialFiles: fileCount,
        newAssetRows: after - before,
      };
    } finally {
      await docker(["rm", "-f", name]);
    }
  },
);
await check("aborted upload releases its slots", async () => {
  const { request } = await import("node:http");
  const user = fixture.users[90],
    boundary = "load-abort-boundary";
  await new Promise<void>((resolve) => {
    const req = request(
      "http://localhost:13001/api/v1/uploads",
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:18080",
          Cookie: user.cookie,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": "300000",
        },
      },
      (res) => res.resume(),
    );
    req.on("error", () => {});
    req.write(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.html"\r\nContent-Type: text/html\r\n\r\n<!doctype html><html>`,
    );
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 100);
  });
  await sleep(500);
  const r = await response("http://localhost:13001/api/v1/admin/overview", {
    headers: { Cookie: fixture.users[0].cookie },
  });
  assert.equal(r.status, 200);
  const data = JSON.parse(r.text);
  assert.equal(data.activeUploads, 0);
  assert.equal(data.inflight, 1);
  return {
    activeUploads: data.activeUploads,
    inflightDuringOverview: data.inflight,
  };
});
// Always undo paused/stopped dependencies, including failed assertions.
for (const service of ["db", "redis"])
  await docker(["start", `lark-cup-load-${service}-1`]).catch(() => {});
await pool.end();
process.exitCode = results.every((r) => r.passed) ? 0 : 1;
