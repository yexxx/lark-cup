import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { args, local, num } from "./common.js";
const a = args(),
  prefix = String(a.prefix || "fixed"),
  stable = num(a, "stable", 64, 1),
  scenario = String(a.scenario || "mixed"),
  folder = path.resolve("test-results/load");
await mkdir(folder, { recursive: true });
const out = path.join(folder, `${prefix}-burst.json`);
const startedAt = Date.now();
await new Promise<void>((resolve, reject) => {
  const log = createWriteStream(out + ".log"),
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/load.ts",
        "--scenario",
        scenario,
        "--profile",
        "capacity",
        "--rate",
        String(stable * 3),
        "--warmup",
        "0",
        "--duration",
        "30",
        "--output",
        out,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on("exit", (c) => {
    log.end();
    c === 0 ? resolve() : reject(new Error("Burst generator failed"));
  });
});
const burst = JSON.parse(await readFile(out, "utf8"));
const drainMs = Math.max(0, Date.parse(burst.date) - startedAt - 30000);
const fixture = JSON.parse(
    await readFile(path.join(local, "fixtures/fixture.json"), "utf8"),
  ),
  t = performance.now();
let recovered = false,
  last: any,
  attempt = 0;
while (performance.now() - t + drainMs < 30000) {
  try {
    const responses = await Promise.all([
      fetch("http://localhost:18080/api/v1/works?size=12", {
        signal: AbortSignal.timeout(3000),
      }),
      fetch("http://localhost:18080/api/v1/auth/login", {
        method: "POST",
        headers: {
          Origin: "http://localhost:18080",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username:
            fixture.users[(100 + attempt++) % fixture.users.length].username,
          password: fixture.password,
        }),
        signal: AbortSignal.timeout(3000),
      }),
    ]);
    last = responses.map((r) => r.status);
    await Promise.all(responses.map((r) => r.text()));
    if (last.every((c: number) => c === 200)) {
      recovered = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const overview = await fetch("http://localhost:13001/api/v1/admin/overview", {
  headers: { Cookie: fixture.users[0].cookie },
});
const counters = await overview.json();
const result = {
  date: new Date().toISOString(),
  stableRate: stable,
  burstRate: stable * 3,
  scenario,
  drainMs,
  recovered,
  recoveryMs: Math.round(performance.now() - t + drainMs),
  lastStatus: last,
  activeUploads: counters.activeUploads,
  inflightDuringOverview: counters.inflight,
};
await writeFile(
  path.join(folder, `${prefix}-burst-recovery.json`),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
assert(recovered);
assert.equal(counters.activeUploads, 0);
assert.equal(counters.inflight, 1);
