import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { readFile, writeFile, rename, copyFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";
import { args, local, num, passesSLO } from "./common.js";
const a = args(),
  prefix = String(a.prefix || "fixed-soak"),
  duration = num(a, "duration", 3600, 1),
  folder = path.resolve("test-results/load");
const stable = JSON.parse(
  await readFile(
    String(
      a["stable-file"] || "test-results/load/fixed-large-mixed-confirm.json",
    ),
    "utf8",
  ),
);
assert.equal(stable.scenario, "mixed");
assert(passesSLO(stable), "Confirmed capacity must meet every business SLO");
const rate = stable.targetActionsPerSecond * 0.7;
assert(
  (duration + 30) * rate * 0.15 <= 99990 * 0.9,
  "Increase the account fixture for the planned vote budget",
);
const active = JSON.parse(
  await readFile(path.join(local, "active.json"), "utf8"),
);
assert.equal(active.tag, "fixed");
assert.equal(active.profile, "capacity");
await mkdir(folder, { recursive: true });
async function run(file: string, argv: string[], name: string) {
  await new Promise<void>((resolve, reject) => {
    const log = createWriteStream(path.join(folder, name + ".log")),
      child = spawn(process.execPath, ["--import", "tsx", file, ...argv], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("error", reject);
    child.once("close", (code) => {
      log.end(() => {
        code === 0 ? resolve() : reject(new Error(name + " failed"));
      });
    });
  });
}
const env = {
  ...process.env,
  DOCKER_HOST:
    process.env.LOAD_DOCKER_HOST ||
    `unix://${process.env.HOME}/.colima/lark-load/docker.sock`,
  DOCKER_CONFIG: path.join(local, "docker"),
};
const exec = promisify(execFile);
await run(
  "scripts/load/env.ts",
  ["--command", "seed", "--size", "large"],
  prefix + "-seed",
);
await run(
  "scripts/load/env.ts",
  ["--command", "stop", "--service", "api"],
  prefix + "-stop",
);
await rename(
  path.join(local, "metrics/server.jsonl"),
  path.join(folder, prefix + "-prior-server.jsonl"),
).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
});
await run(
  "scripts/load/env.ts",
  ["--command", "restart", "--service", "api"],
  prefix + "-restart",
);
for (let attempt = 0; ; attempt++) {
  try {
    const health = await fetch("http://localhost:13001/api/v1/health", {
      signal: AbortSignal.timeout(1000),
    });
    await health.text();
    if (health.ok) break;
  } catch {}
  assert(attempt < 40, "API startup failed");
  await new Promise((r) => setTimeout(r, 250));
}
const { password } = JSON.parse(
  await readFile(path.join(local, "environment.json"), "utf8"),
);
const pool = new Pool({
  host: "127.0.0.1",
  port: 15432,
  user: "lark",
  database: "lark_load",
  password,
  max: 2,
});
pool.on("error", () => {});
const fixture = JSON.parse(
  await readFile(path.join(local, "fixtures/fixture.json"), "utf8"),
);
assert(
  (
    await pool.query(
      "SELECT data->>'loadTest' AS marker FROM competition WHERE id=1",
    )
  ).rows[0].marker,
);
const sentinels = [
  randomBytes(32).toString("hex"),
  randomBytes(32).toString("hex"),
];
for (const token of sentinels)
  await pool.query(
    "INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES($1,$2,now()-INTERVAL '8 days',now()-INTERVAL '1 day',now()-INTERVAL '2 days')",
    [token, fixture.users[0].id],
  );
const containerStates = async () =>
  JSON.parse(
    (
      await exec(
        "docker",
        [
          "inspect",
          "lark-cup-load-api-1",
          "lark-cup-load-db-1",
          "lark-cup-load-redis-1",
          "lark-cup-load-web-1",
        ],
        { env },
      )
    ).stdout,
  );
const containersBefore = await containerStates();
const before = containersBefore[0].State;
const beforeOverview = await fetch(
  "http://localhost:13001/api/v1/admin/overview",
  { headers: { Cookie: fixture.users[0].cookie } },
);
const beforeUptime = (await beforeOverview.json()).uptimeSeconds;
const stream = createWriteStream(path.join(folder, prefix + "-collector.log"));
const collector = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "scripts/load/collect.ts",
    "--output",
    path.join(folder, prefix + "-resources.jsonl"),
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
collector.stdout.pipe(stream);
collector.stderr.pipe(stream);
const collected = once(collector, "exit");
let load: any;
try {
  await writeFile(
    path.join(local, "phase.json"),
    JSON.stringify({
      phase: prefix,
      date: new Date().toISOString(),
      rate,
      duration,
    }),
  );
  await run(
    "scripts/load.ts",
    [
      "--scenario",
      "mixed",
      "--profile",
      "capacity",
      "--rate",
      String(rate),
      "--warmup",
      "30",
      "--duration",
      String(duration),
      "--seed",
      "1024",
      "--html-bytes",
      String(stable.uploadPayload?.htmlBytes || 68),
      "--output",
      path.join(folder, prefix + ".json"),
    ],
    prefix,
  );
  load = JSON.parse(
    await readFile(path.join(folder, prefix + ".json"), "utf8"),
  );
  await new Promise((r) => setTimeout(r, 6000));
  const containersAfter = await containerStates();
  const after = containersAfter[0].State,
    expiredAfter = Number(
      (
        await pool.query(
          "SELECT count(*) AS n FROM auth_sessions WHERE token_hash=ANY($1::text[])",
          [sentinels],
        )
      ).rows[0].n,
    );
  const overview = await fetch("http://localhost:13001/api/v1/admin/overview", {
      headers: { Cookie: fixture.users[0].cookie },
    }),
    counters = await overview.json();
  const serverMetrics = (
    await readFile(path.join(local, "metrics/server.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const idleMetrics = serverMetrics.at(-1);
  const containers = containersAfter.map((container: any, index: number) => ({
    name: container.Name,
    running: container.State.Running,
    oomKilled: container.State.OOMKilled,
    restartsBefore: containersBefore[index].RestartCount,
    restartsAfter: container.RestartCount,
    startedAtBefore: containersBefore[index].State.StartedAt,
    startedAtAfter: container.State.StartedAt,
  }));
  const summary = {
    date: new Date().toISOString(),
    stableRate: stable.targetActionsPerSecond,
    rate,
    duration,
    passed: passesSLO(load),
    before,
    after,
    expiredBefore: 2,
    expiredAfter,
    activeUploads: counters.activeUploads,
    inflightDuringOverview: counters.inflight,
    observedApiUptimeSeconds: counters.uptimeSeconds - beforeUptime,
    idleCapacity: idleMetrics?.capacity,
    idlePasswordBudget: idleMetrics?.passwordBudget,
    serverSamples: serverMetrics.length,
    containers,
  };
  await writeFile(
    path.join(folder, prefix + "-acceptance.json"),
    JSON.stringify(summary, null, 2),
  );
  assert(summary.passed, "Soak business SLO failed");
  assert(after.Running && !after.OOMKilled);
  assert.equal(after.StartedAt, before.StartedAt);
  assert.equal(counters.activeUploads, 0);
  assert.equal(counters.inflight, 1);
  for (const container of containers) {
    assert(container.running && !container.oomKilled, container.name);
    assert.equal(
      container.restartsAfter,
      container.restartsBefore,
      container.name,
    );
    assert.equal(
      container.startedAtAfter,
      container.startedAtBefore,
      container.name,
    );
  }
  assert(
    idleMetrics && Date.now() - Date.parse(idleMetrics.date) < 10000,
    "Fresh internal metrics required",
  );
  assert.deepEqual(idleMetrics.capacity, {
    inflight: 0,
    activeUploads: 0,
    activePreviews: 0,
    activeExports: 0,
  });
  assert.deepEqual(idleMetrics.passwordBudget, {
    active: 0,
    admitted: 0,
    waiting: 0,
  });
  assert(
    counters.uptimeSeconds - beforeUptime >= duration,
    "API must remain active for the measured soak duration",
  );
  if (duration >= 3600)
    assert.equal(expiredAfter, 0, "Hourly session cleanup must complete");
  await run(
    "scripts/load/reconcile.ts",
    ["--output", path.join(folder, prefix + "-reconciliation.json")],
    prefix + "-reconciliation",
  );
} finally {
  collector.kill("SIGTERM");
  await collected;
  stream.end();
  await pool.end();
  await copyFile(
    path.join(local, "metrics/server.jsonl"),
    path.join(folder, prefix + "-server.jsonl"),
  );
}
console.log(
  JSON.stringify({ prefix, rate, duration, passed: passesSLO(load) }),
);
