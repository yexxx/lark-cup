import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { args, local } from "./common.js";
const a = args(),
  prefix = String(a.prefix || "baseline-default-multi"),
  count = Number(a.shards || 4),
  reports = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      readFile(`test-results/load/${prefix}-${i}.json`, "utf8").then(
        JSON.parse,
      ),
    ),
  );
const end = Math.max(...reports.map((r) => Date.parse(r.date))) + 2000,
  start =
    Math.min(
      ...reports.map(
        (r) =>
          Date.parse(r.date) - (r.durationSeconds + r.warmupSeconds) * 1000,
      ),
    ) - 2000;
const env = {
  ...process.env,
  DOCKER_HOST:
    process.env.LOAD_DOCKER_HOST ||
    `unix://${process.env.HOME}/.colima/lark-load/docker.sock`,
  DOCKER_CONFIG: path.join(local, "docker"),
};
const logs = await promisify(execFile)(
  "docker",
  [
    "logs",
    "--since",
    new Date(start).toISOString(),
    "--until",
    new Date(end).toISOString(),
    "lark-cup-load-web-1",
  ],
  { env, maxBuffer: 10000000 },
);
const sources: Record<string, number> = {};
for (const line of (logs.stdout + "\n" + logs.stderr).split("\n")) {
  const ip = line.match(/^(\d+\.\d+\.\d+\.\d+) .*"GET /)?.[1];
  if (ip) sources[ip] = (sources[ip] || 0) + 1;
}
const gateway = JSON.parse(
  (
    await promisify(execFile)(
      "docker",
      ["network", "inspect", "lark-cup-load_default"],
      { env },
    )
  ).stdout,
)[0].IPAM.Config[0].Gateway;
const output = String(a.output || `test-results/load/${prefix}-sources.json`),
  result = {
    since: new Date(start).toISOString(),
    until: new Date(end).toISOString(),
    sources,
    controlSource: gateway,
    independentSources: Object.keys(sources).filter((ip) => ip !== gateway)
      .length,
  };
await writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (result.independentSources < count)
  throw new Error("Insufficient actual proxy source IP evidence");
