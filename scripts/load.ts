import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { args, num, rng, local, type Fixture } from "./load/common.js";
const a = args(),
  base = String(
    a.base || process.env.LOAD_BASE_URL || "http://localhost:18080",
  ),
  preview = String(a.preview || "http://localhost:18081");
for (const value of [base, preview])
  if (
    !["localhost", "127.0.0.1", "[::1]", "web", "api"].includes(
      new URL(value).hostname,
    )
  )
    throw new Error("An isolated local host is required");
const scenario = String(a.scenario || "cached");
if (
  !["cached", "database", "browse", "auth", "upload", "vote", "mixed"].includes(
    scenario,
  )
)
  throw new Error("Unknown --scenario");
const duration = num(a, "duration", 180, 1),
  warmup = num(a, "warmup", 30),
  rate = num(a, "rate", 5, 0.01),
  concurrency = num(a, "concurrency", 256, 1),
  covers = num(a, "covers", 1, 1),
  seed = num(a, "seed", 1024),
  shard = num(a, "shard", 0),
  shards = num(a, "shards", 1, 1);
if (!Number.isInteger(shards) || !Number.isInteger(shard) || shard >= shards)
  throw new Error("Invalid shard");
if (!Number.isInteger(concurrency) || !Number.isInteger(covers) || covers > 12)
  throw new Error("Use integer concurrency and 1..12 covers");
const origin = String(a.origin || "http://localhost:18080");
const fixture: Fixture = JSON.parse(
  await readFile(
    String(a.fixture || path.join(local, "fixtures/fixture.json")),
    "utf8",
  ),
);
const users = fixture.users.slice(1).filter((_, i) => i % shards === shard);
if (!users.length) throw new Error("Fixture account pool empty");
const availableVotes = users.length * 10;
const expectedVotes =
  (warmup + duration) *
  rate *
  (scenario === "mixed" ? 0.15 : scenario === "vote" ? 1 : 0);
if (expectedVotes * (scenario === "mixed" ? 1.05 : 1) > availableVotes)
  throw new Error(
    `Fixture vote budget insufficient: planned approximately ${Math.ceil(expectedVotes)}, available ${availableVotes}`,
  );
const random = rng(seed + shard);
const output = path.resolve(
  String(a.output || `test-results/load/${scenario}-${Date.now()}.json`),
);
type Stats = {
  count: number;
  success: number;
  codes: Record<string, number>;
  hist: Map<number, number>;
};
const summary = new Map<string, Stats>();
const actionCounts: Record<string, number> = {};
const successfulActionCounts: Record<string, number> = {};
let active = 0,
  peakActive = 0,
  planned = 0,
  started = 0,
  dropped = 0,
  completed = 0,
  success = 0,
  late = 0,
  voteIndex = 0,
  userIndex = 0;
let fixtureBudgetExhaustions = 0;
const examples: { kind: string; status: number; message: string }[] = [];
const scheduleHistogram = new Map<number, number>();
const observe = (h: Map<number, number>, v: number) => {
  const n = Math.ceil(v);
  h.set(n, (h.get(n) || 0) + 1);
};
function quantile(h: Map<number, number>, q: number) {
  const entries = [...h].sort((x, y) => x[0] - y[0]);
  const target = Math.ceil(entries.reduce((n, e) => n + e[1], 0) * q);
  let n = 0;
  for (const [ms, count] of entries) {
    n += count;
    if (n >= target) return ms;
  }
  return null;
}
function record(kind: string, status: number, ms: number, measured: boolean) {
  if (!measured) return;
  let s = summary.get(kind);
  if (!s) {
    s = { count: 0, success: 0, codes: {}, hist: new Map() };
    summary.set(kind, s);
  }
  s.count++;
  s.success += status >= 200 && status < 300 ? 1 : 0;
  s.codes[status] = (s.codes[status] || 0) + 1;
  observe(s.hist, ms);
}
async function request(
  url: string,
  kind: string,
  measured: boolean,
  options: RequestInit = {},
  user?: Fixture["users"][number],
) {
  const headers = new Headers(options.headers);
  headers.set("Origin", origin);
  if (user) {
    headers.set("Cookie", user.cookie);
    headers.set("X-Lark-User", user.id);
  }
  const t = performance.now();
  let status = 0;
  try {
    const r = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(20000),
    });
    status = r.status;
    const text = await r.text();
    if (!r.ok) throw new Error(text.slice(0, 200));
    return {
      data: r.headers.get("content-type")?.includes("application/json")
        ? JSON.parse(text)
        : text,
      cookie: r.headers
        .getSetCookie()
        .find((v) => v.startsWith("lark_session="))
        ?.split(";")[0],
    };
  } catch (e) {
    if (measured && examples.length < 12)
      examples.push({
        kind,
        status,
        message: (e as Error).message.slice(0, 200),
      });
    throw e;
  } finally {
    record(kind, status, performance.now() - t, measured);
  }
}
const json = (body: unknown) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const htmlSource =
  '<!doctype html><html><body><svg><circle r="30"/></svg></body></html>';
const htmlBytes = num(
  a,
  "html-bytes",
  Buffer.byteLength(htmlSource),
  Buffer.byteLength(htmlSource),
);
if (
  !Number.isInteger(htmlBytes) ||
  htmlBytes > 5 * 1024 * 1024 ||
  (htmlBytes > htmlSource.length && htmlBytes < htmlSource.length + 7)
)
  throw new Error("Invalid HTML payload size");
const html = new Blob(
  [
    htmlBytes === htmlSource.length
      ? htmlSource
      : htmlSource.replace(
          "</body>",
          "<!--" + " ".repeat(htmlBytes - htmlSource.length - 7) + "--></body>",
        ),
  ],
  { type: "text/html" },
);
const cover = new Blob(
  [
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1xkAAAAASUVORK5CYII=",
      "base64",
    ),
  ],
  { type: "image/png" },
);
async function action(
  kind: string,
  measured: boolean,
  caseRandom: () => number,
) {
  const random = caseRandom,
    user = users[userIndex++ % users.length],
    w = fixture.works[Math.floor(random() * fixture.works.length)];
  if (kind === "cached")
    await request(
      base +
        [
          "/api/v1/works?size=12",
          "/api/v1/leaderboard?size=12",
          "/api/v1/stats",
        ][Math.floor(random() * 3)],
      "read",
      measured,
    );
  else if (kind === "database") {
    const q =
      `Load work ${Math.floor(random() * fixture.works.length)}`.replace(
        /[a-z]/gi,
        (c) => (random() < 0.5 ? c.toLowerCase() : c.toUpperCase()),
      );
    await request(
      `${base}/api/v1/works?q=${encodeURIComponent(q)}&size=48&page=1`,
      "read",
      measured,
    );
  } else if (kind === "browse") {
    const list = await request(
      `${base}/api/v1/works?size=12`,
      "read",
      measured,
    );
    if (covers === 1)
      await request(`${base}/media/${w.coverId}`, "media", measured);
    else
      await Promise.all(
        list.data.items
          .slice(0, covers)
          .map((item: any) => request(base + item.coverUrl, "media", measured)),
      );
    if (random() < 0.3) {
      await request(`${base}/api/v1/works/${w.id}`, "read", measured, {}, user);
      await request(`${preview}/preview/${w.htmlId}`, "preview", measured);
    }
  } else if (kind === "auth") {
    const login = await request(`${base}/api/v1/auth/login`, "auth", measured, {
      method: "POST",
      ...json({ username: user.username, password: fixture.password }),
    });
    const signed = { ...user, cookie: login.cookie! };
    await request(`${base}/api/v1/auth/me`, "read", measured, {}, signed);
    await request(
      `${base}/api/v1/auth/logout`,
      "auth",
      measured,
      { method: "POST" },
      signed,
    );
  } else if (kind === "vote") {
    const i = voteIndex++,
      u = users[i % users.length],
      round = Math.floor(i / users.length);
    if (round >= 10) throw new Error("Fixture daily vote budget exhausted");
    const target = fixture.works[round % fixture.works.length];
    await request(
      `${base}/api/v1/works/${target.id}/votes`,
      "vote",
      measured,
      { method: "POST", headers: { "Idempotency-Key": randomUUID() } },
      u,
    );
    await request(`${base}/api/v1/me/quota`, "read", measured, {}, u);
  } else if (kind === "upload") {
    const assets: string[] = [];
    for (const [blob, filename] of [
      [cover, "cover.png"],
      [html, "bird.html"],
    ] as const) {
      const form = new FormData();
      form.set("file", blob, filename);
      assets.push(
        (
          await request(
            `${base}/api/v1/uploads`,
            "upload",
            measured,
            { method: "POST", body: form },
            user,
          )
        ).data.id,
      );
    }
    const created = await request(
      `${base}/api/v1/works`,
      "write",
      measured,
      {
        method: "POST",
        ...json({
          title: `Load submission ${seed}`,
          description: "Load lifecycle",
          model: "Load",
          prompt: "SVG",
          coverId: assets[0],
          htmlId: assets[1],
        }),
      },
      user,
    );
    await request(
      `${base}/api/v1/works/${created.data.id}/submit`,
      "write",
      measured,
      { method: "POST" },
      user,
    );
    await request(
      `${base}/api/v1/admin/works/${created.data.id}/review`,
      "write",
      measured,
      {
        method: "POST",
        ...json({ decision: "approved", reason: "", version: 1 }),
      },
      fixture.users[0],
    );
  }
}
const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
const start = performance.now(),
  measuredStart = start + warmup * 1000,
  end = measuredStart + duration * 1000,
  running = new Set<Promise<void>>();
const startedWall = Date.now();
let lastTick = start,
  lastWallTick = startedWall,
  maxTickGapMs = 0,
  executionPauses = 0;
const tick = (now: number) => {
  const gap = now - lastTick;
  const wallNow = Date.now(),
    wallGap = wallNow - lastWallTick;
  maxTickGapMs = Math.max(maxTickGapMs, gap);
  if (gap > 5000 || Math.abs(wallGap - gap) > 5000) executionPauses++;
  lastTick = now;
  lastWallTick = wallNow;
};
let totalScheduled = 0;
const cpuStart = process.cpuUsage();
const progress = setInterval(
  () =>
    console.log(
      JSON.stringify({
        progress: true,
        scenario,
        elapsedSeconds: Math.round((performance.now() - start) / 1000),
        planned,
        started,
        dropped,
        completed,
        success,
        active,
      }),
    ),
  30000,
);
progress.unref();
while (performance.now() < end) {
  const now = performance.now(),
    due = Math.min(
      Math.floor(((now - start) * rate) / 1000) + 1,
      Math.ceil((warmup + duration) * rate),
    );
  tick(now);
  while (totalScheduled < due) {
    const scheduled = start + (totalScheduled++ * 1000) / rate,
      measured = scheduled >= measuredStart;
    if (measured) {
      planned++;
      observe(scheduleHistogram, now - scheduled);
      if (now - scheduled > 100) late++;
    }
    if (active >= concurrency) {
      if (measured) dropped++;
      continue;
    }
    if (measured) started++;
    active++;
    peakActive = Math.max(peakActive, active);
    let caseSeed = seed ^ totalScheduled ^ Math.imul(shard, 2654435761);
    caseSeed = Math.imul(caseSeed ^ (caseSeed >>> 16), 0x7feb352d);
    caseSeed = Math.imul(caseSeed ^ (caseSeed >>> 15), 0x846ca68b);
    caseSeed ^= caseSeed >>> 16;
    const caseRandom = scenario === "mixed" ? rng(caseSeed) : random;
    const choice =
      scenario === "mixed"
        ? ((v: number) =>
            v < 0.7
              ? "browse"
              : v < 0.85
                ? "vote"
                : v < 0.95
                  ? "upload"
                  : "auth")(caseRandom())
        : scenario;
    if (measured) actionCounts[choice] = (actionCounts[choice] || 0) + 1;
    const p = action(choice, measured, caseRandom)
      .then(
        () => {
          if (measured) {
            success++;
            successfulActionCounts[choice] =
              (successfulActionCounts[choice] || 0) + 1;
          }
        },
        (e) => {
          if ((e as Error).message === "Fixture daily vote budget exhausted")
            fixtureBudgetExhaustions++;
          if (measured && examples.length < 12)
            examples.push({
              kind: choice,
              status: 0,
              message: (e as Error).message.slice(0, 200),
            });
        },
      )
      .finally(() => {
        active--;
        if (measured) completed++;
        running.delete(p);
      });
    running.add(p);
  }
  await new Promise((r) =>
    setTimeout(
      r,
      Math.max(
        1,
        Math.min(
          10,
          start + (totalScheduled * 1000) / rate - performance.now(),
        ),
      ),
    ),
  );
}
tick(performance.now());
const unissuedAtDeadline = Math.max(
  0,
  Math.ceil((warmup + duration) * rate) - Math.ceil(warmup * rate) - planned,
);
planned += unissuedAtDeadline;
dropped += unissuedAtDeadline;
await Promise.all(running);
clearInterval(progress);
delay.disable();
const requests = Object.fromEntries(
  [...summary].map(([kind, s]) => [
    kind,
    {
      count: s.count,
      success: s.success,
      statusCodes: s.codes,
      p50Ms: quantile(s.hist, 0.5),
      p95Ms: quantile(s.hist, 0.95),
      p99Ms: quantile(s.hist, 0.99),
    },
  ]),
);
const requestCount = [...summary.values()].reduce((n, s) => n + s.count, 0);
const result = {
  date: new Date().toISOString(),
  scenario,
  profile: a.profile || "default",
  seed,
  shard,
  shards,
  base,
  coversPerBrowse: covers,
  uploadPayload: { htmlBytes: html.size, coverBytes: cover.size },
  fixture: {
    users: fixture.users.length,
    works: fixture.works.length,
    historicalVotes: fixture.historicalVotes,
  },
  durationSeconds: duration,
  warmupSeconds: warmup,
  targetActionsPerSecond: rate,
  planned,
  started,
  dropped,
  unissuedAtDeadline,
  completed,
  fixtureBudgetExhaustions,
  execution: {
    startedAt: new Date(startedWall).toISOString(),
    wallElapsedSeconds: (Date.now() - startedWall) / 1000,
    monotonicElapsedSeconds: (performance.now() - start) / 1000,
    maxTickGapMs,
    executionPauses,
  },
  actionCounts,
  successfulActionCounts,
  actionSuccessRates: Object.fromEntries(
    Object.entries(actionCounts).map(([kind, count]) => [
      kind,
      (successfulActionCounts[kind] || 0) / count,
    ]),
  ),
  successfulActions: success,
  actionSuccessRate: planned ? success / planned : 0,
  requestsPerSecond: requestCount / duration,
  successfulActionsPerSecond: success / duration,
  peakActive,
  scheduling: {
    p95Ms: quantile(scheduleHistogram, 0.95),
    p99Ms: quantile(scheduleHistogram, 0.99),
    over100Ms: late,
  },
  generator: {
    cpuMicros: process.cpuUsage(cpuStart),
    memory: process.memoryUsage(),
    eventLoopP95Ms: delay.percentile(95) / 1e6,
  },
  requests,
  examples,
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, examples: undefined }));
if (executionPauses) process.exitCode = 2;
