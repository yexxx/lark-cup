import { readFile, mkdir, appendFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { args, local } from "./common.js";
const a = args(),
  output = String(a.output || "test-results/load/resources.jsonl");
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
  connectionTimeoutMillis: 2000,
  statement_timeout: 2000,
});
pool.on("error", () => {});
const redis = new Redis("redis://127.0.0.1:16379", {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
redis.on("error", () => {});
const exec = promisify(execFile),
  env = {
    ...process.env,
    DOCKER_HOST:
      process.env.LOAD_DOCKER_HOST ||
      `unix://${process.env.HOME}/.colima/lark-load/docker.sock`,
    DOCKER_CONFIG: path.join(local, "docker"),
  };
await mkdir(path.dirname(output), { recursive: true });
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
while (!stopping) {
  const started = Date.now();
  const [containers, database, cache, sockets] = await Promise.allSettled([
    exec(
      "docker",
      [
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
        "lark-cup-load-api-1",
        "lark-cup-load-db-1",
        "lark-cup-load-redis-1",
        "lark-cup-load-web-1",
      ],
      { env, timeout: 4000, maxBuffer: 50000 },
    ),
    pool.query(
      "SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()) AS connections,(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters,(SELECT json_build_object('commits',xact_commit,'rollbacks',xact_rollback,'deadlocks',deadlocks,'read_ms',blk_read_time,'write_ms',blk_write_time) FROM pg_stat_database WHERE datname=current_database()) AS counters,(SELECT count(*) FROM assets) AS assets,(SELECT sum(bytes) FROM assets) AS asset_bytes,(SELECT count(*) FROM auth_sessions) AS sessions,(SELECT count(*) FROM auth_sessions WHERE expires_at<=now()) AS expired_sessions",
    ),
    redis.info(),
    exec(
      "docker",
      ["exec", "lark-cup-load-web-1", "cat", "/proc/net/sockstat"],
      { env, timeout: 4000, maxBuffer: 10000 },
    ),
  ]);
  const info =
    cache.status === "fulfilled"
      ? Object.fromEntries(
          cache.value
            .split("\r\n")
            .filter((s) =>
              /^(used_memory:|used_memory_rss:|evicted_keys:|keyspace_hits:|keyspace_misses:|connected_clients:|total_error_replies:)/.test(
                s,
              ),
            )
            .map((s) => s.split(":")),
        )
      : { error: cache.reason.message };
  await appendFile(
    output,
    JSON.stringify({
      date: new Date().toISOString(),
      containers:
        containers.status === "fulfilled"
          ? containers.value.stdout
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((s) => JSON.parse(s))
          : { error: containers.reason.message },
      database:
        database.status === "fulfilled"
          ? database.value.rows[0]
          : { error: database.reason.message },
      redis: info,
      sockets:
        sockets.status === "fulfilled"
          ? sockets.value.stdout
          : { error: sockets.reason.message },
    }) + "\n",
  );
  await new Promise((r) =>
    setTimeout(r, Math.max(1, 5000 - (Date.now() - started))),
  );
}
await pool.end();
redis.disconnect();
