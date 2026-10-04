import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { args, num, passesSLO } from "./common.js";
const a = args(),
  prefix = String(a.prefix || "capacity"),
  size = String(a.size || "small");
const folder = path.resolve("test-results/load");
await mkdir(folder, { recursive: true });
async function command(file: string, argv: string[], log: string) {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(log),
      p = spawn(process.execPath, ["--import", "tsx", file, ...argv], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    p.stdout.pipe(stream);
    p.stderr.pipe(stream);
    p.on("error", reject);
    p.on("exit", (code) => {
      stream.end();
      code === 0
        ? resolve()
        : reject(new Error(`${file} exited ${code}; ${log}`));
    });
  });
}
const results: any[] = [];
const passes = passesSLO;

for (const scenario of String(a.scenarios || "cached,database,mixed").split(
  ",",
)) {
  if (scenario !== "cached")
    await command(
      "scripts/load/env.ts",
      ["--command", "restart", "--service", "api"],
      path.join(folder, `${prefix}-${size}-${scenario}-restart.log`),
    );
  let rate = num(
      a,
      "start-rate",
      scenario === "cached" ? 1600 : scenario === "database" ? 160 : 16,
      0.01,
    ),
    failures = 0,
    stable = num(a, "known-stable", 0),
    firstFailed = 0;
  const maxRate = num(
    a,
    "max-rate",
    scenario === "mixed" && size === "small" ? 300 : 25600,
    1,
  );
  const stage = async (rate: number) => {
    if (scenario === "mixed" || scenario === "upload")
      await command(
        "scripts/load/env.ts",
        ["--command", "seed", "--size", size],
        path.join(folder, `${prefix}-${size}-seed.log`),
      );
    const out = path.join(folder, `${prefix}-${size}-${scenario}-${rate}.json`);
    await command(
      "scripts/load.ts",
      [
        "--scenario",
        scenario,
        "--profile",
        "capacity",
        "--rate",
        String(rate),
        "--warmup",
        String(num(a, "warmup", 30)),
        "--duration",
        String(num(a, "duration", 180)),
        "--seed",
        "1024",
        ...(a["html-bytes"] ? ["--html-bytes", String(a["html-bytes"])] : []),
        "--output",
        out,
      ],
      out + ".log",
    );
    const r = JSON.parse(await readFile(out, "utf8"));
    r.passed = passes(r);
    results.push(r);
    console.log(
      JSON.stringify({
        prefix,
        size,
        scenario,
        rate,
        success: r.actionSuccessRate,
        requestsPerSecond: r.requestsPerSecond,
        passed: r.passed,
        p95: Object.fromEntries(
          Object.entries<any>(r.requests).map(([k, s]) => [k, s.p95Ms]),
        ),
      }),
    );
    return r.passed;
  };
  while (rate <= maxRate && failures < 2) {
    if (await stage(rate)) {
      stable = rate;
      failures = 0;
      firstFailed = 0;
    } else {
      failures++;
      if (!firstFailed) firstFailed = rate;
    }
    if (rate === maxRate) break;
    rate = Math.min(rate * 2, maxRate);
  }
  for (let i = 0; i < num(a, "refine", 1) && stable && firstFailed; i++) {
    const candidate = (stable + firstFailed) / 2;
    if (await stage(candidate)) stable = candidate;
    else firstFailed = candidate;
  }
  while (stable) {
    const out = path.join(folder, `${prefix}-${size}-${scenario}-confirm.json`);
    if (scenario === "mixed" || scenario === "upload")
      await command(
        "scripts/load/env.ts",
        ["--command", "seed", "--size", size],
        out + ".seed.log",
      );
    await command(
      "scripts/load.ts",
      [
        "--scenario",
        scenario,
        "--profile",
        "capacity",
        "--rate",
        String(stable),
        "--warmup",
        "30",
        "--duration",
        String(num(a, "confirm-duration", 300)),
        ...(a["html-bytes"] ? ["--html-bytes", String(a["html-bytes"])] : []),
        "--output",
        out,
      ],
      out + ".log",
    );
    const r = JSON.parse(await readFile(out, "utf8"));
    results.push({ ...r, passed: passes(r), confirmation: true });
    await writeFile(
      path.join(folder, `${prefix}-${size}-${scenario}-confirm-${stable}.json`),
      JSON.stringify({ ...r, passed: passes(r), confirmation: true }, null, 2),
    );
    if (passes(r)) break;
    stable = stable > 1 ? stable / 2 : 0;
  }
  await writeFile(
    path.join(folder, `${prefix}-${size}-suite.json`),
    JSON.stringify(results, null, 2),
  );
}
