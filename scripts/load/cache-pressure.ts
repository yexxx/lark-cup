import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Redis } from "ioredis";
import { args, root, local } from "./common.js";
const a = args(),
  source = path.resolve(root, String(a.source || ".")),
  output = path.resolve(
    String(a.output || "test-results/load/cache-pressure.json"),
  );
const exec = promisify(execFile),
  name = `lark-load-cache-pressure-${process.pid}`,
  env = {
    ...process.env,
    DOCKER_HOST:
      process.env.LOAD_DOCKER_HOST ||
      `unix://${process.env.HOME}/.colima/lark-load/docker.sock`,
    DOCKER_CONFIG: path.join(local, "docker"),
  };
await mkdir(path.dirname(output), { recursive: true });
await exec(
  "docker",
  [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "lark-cup-load-owned=true",
    "-p",
    "127.0.0.1:26379:6379",
    "--memory",
    "64m",
    "--cpus",
    "0.2",
    "redis:7-alpine",
    "redis-server",
    "--maxmemory",
    "8mb",
    "--maxmemory-policy",
    "volatile-lru",
  ],
  { env },
);
let cache: any, redis: Redis | undefined;
try {
  process.env.REDIS_URL = "redis://127.0.0.1:26379";
  const { Cache } = await import(
    pathToFileURL(path.join(source, "server/cache.ts")).href
  );
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => {});
  await redis.ping();
  cache = new Cache();
  await cache.ready();
  for (let i = 0; i < 100; i++) {
    await cache.take(`retained-budget:${i}`, 2);
    await cache.take(`retained-budget:${i}`, 2);
  }
  await new Promise((r) => setTimeout(r, 2100));
  for (let i = 0; i < 3000; i++)
    await cache.set(`pressure:${i}`, "x".repeat(8192), 60);
  let restored = 0;
  for (let i = 0; i < 100; i++)
    if (await cache.take(`retained-budget:${i}`, 2)) restored++;
  const result = {
    date: new Date().toISOString(),
    source,
    restoredBudgets: restored,
    testedBudgets: 100,
    parallelAllowed: (
      await Promise.all(
        Array.from({ length: 20 }, () => cache.take("parallel-check", 2)),
      )
    ).filter(Boolean).length,
    evictedKeys: Number(
      (await redis.info("stats")).match(/evicted_keys:(\d+)/)?.[1],
    ),
  };
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (cache) await cache.close();
  redis?.disconnect();
  await exec("docker", ["rm", "-f", name], { env });
}
