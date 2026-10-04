import { appendFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { openDB, type DB } from "../../server/db.js";
import { migrate } from "../../server/migrate.js";
import { buildApp } from "../../server/app.js";
import { config } from "../../server/config.js";
import { Cache } from "../../server/cache.js";
import { percentile } from "./common.js";
import * as password from "../../server/password.js";
if (process.env.LOAD_TEST_ISOLATED !== "1")
  throw new Error("Isolated load environment required");
const actual = await openDB();
const queries: number[] = [];
const instrument = (db: DB): DB => ({
  async query(sql, args) {
    const start = performance.now();
    try {
      return await db.query(sql, args);
    } finally {
      queries.push(performance.now() - start);
    }
  },
  transaction: (fn) => db.transaction((tx) => fn(instrument(tx))),
  close: () => db.close(),
  iterate: db.iterate?.bind(db),
});
const db = instrument(actual);
await migrate(db);
const cache = new Cache();
let cacheReads = 0,
  cacheHits = 0;
const get = cache.get.bind(cache);
cache.get = async (key) => {
  const value = await get(key);
  cacheReads++;
  if (value !== null) cacheHits++;
  return value;
};
const take = cache.take.bind(cache);
cache.take = (key, limit, seconds) =>
  take(
    key,
    key.startsWith("preview:") && config.ipRate >= 1000000 ? 1000000000 : limit,
    seconds,
  );
const servers = await buildApp(db, { logger: true, cache });
if (process.env.LOAD_CAPTURE_PREVIEW_HEADERS === "1")
  servers.preview.addHook("onRequest", async (req) => {
    await appendFile(
      "/app/load-metrics/preview-headers.jsonl",
      JSON.stringify({
        date: new Date().toISOString(),
        path: req.url.split("?")[0],
        cookiePresent: !!req.headers.cookie,
        authorizationPresent: !!req.headers.authorization,
        ip: req.ip,
      }) + "\n",
    );
  });
await servers.app.listen({ host: "0.0.0.0", port: config.port });
await servers.preview.listen({ host: "0.0.0.0", port: config.previewPort });
const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
let cpu = process.cpuUsage();
const timer = setInterval(() => {
  const ordered = queries.splice(0).sort((x, y) => x - y);
  const current = process.cpuUsage();
  const data = {
    date: new Date().toISOString(),
    nodeVersion: process.version,
    arch: process.arch,
    phase: process.env.LOAD_TAG,
    profile: process.env.LOAD_PROFILE,
    memory: process.memoryUsage(),
    cpuMicros: {
      user: current.user - cpu.user,
      system: current.system - cpu.system,
    },
    eventLoopP95Ms: delay.percentile(95) / 1e6,
    eventLoopMaxMs: delay.max / 1e6,
    queries: ordered.length,
    queryP95Ms: percentile(ordered, 0.95),
    cacheReads,
    cacheHits,
    uptimeSeconds: process.uptime(),
    capacity: (servers as any).metrics?.(),
    passwordBudget: (password as any).passwordBudget?.(),
  };
  cacheReads = 0;
  cacheHits = 0;
  cpu = current;
  delay.reset();
  void appendFile(
    process.env.LOAD_METRICS_FILE!,
    JSON.stringify(data) + "\n",
  ).catch((e) => console.error(e.message));
}, 5000);
timer.unref();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  delay.disable();
  await servers.close();
  await db.close();
}
process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
process.on("SIGINT", () => void stop().then(() => process.exit(0)));
