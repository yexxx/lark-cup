import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { args } from "./common.js";
const a = args(),
  prefix = String(a.prefix || "fixed-default"),
  folder = path.resolve("test-results/load");
await mkdir(folder, { recursive: true });
async function run(file: string, argv: string[], name: string) {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path.join(folder, name + ".log")),
      child = spawn(process.execPath, ["--import", "tsx", file, ...argv], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    child.stdout.pipe(stream);
    child.stderr.pipe(stream);
    child.on("exit", (code) => {
      stream.end();
      code === 0 ? resolve() : reject(new Error(name + " failed"));
    });
  });
}
await run(
  "scripts/load.ts",
  [
    "--scenario",
    "browse",
    "--rate",
    "5",
    "--warmup",
    "30",
    "--duration",
    "180",
    "--output",
    path.join(folder, prefix + "-shared-ip.json"),
  ],
  prefix + "-shared-ip",
);
await run(
  "scripts/load/env.ts",
  [
    "--command",
    "multi",
    "--tag",
    String(a.tag || "fixed"),
    "--prefix",
    prefix + "-multi",
  ],
  prefix + "-multi",
);
await run(
  "scripts/load.ts",
  [
    "--scenario",
    "auth",
    "--rate",
    "2",
    "--warmup",
    "0",
    "--duration",
    "40",
    "--output",
    path.join(folder, prefix + "-login-ip.json"),
  ],
  prefix + "-login-ip",
);
const loginProtection = JSON.parse(
  await readFile(path.join(folder, prefix + "-login-ip.json"), "utf8"),
);
assert(loginProtection.requests.auth.statusCodes["429"] > 0);
await run(
  "scripts/load.ts",
  [
    "--scenario",
    "cached",
    "--rate",
    "50",
    "--warmup",
    "0",
    "--duration",
    "10",
    "--output",
    path.join(folder, prefix + "-gateway.json"),
  ],
  prefix + "-gateway",
);
const gateway = JSON.parse(
  await readFile(path.join(folder, prefix + "-gateway.json"), "utf8"),
);
assert(gateway.requests.read.statusCodes["429"] > 0);
await new Promise((r) => setTimeout(r, 2000));
const gatewayRecovery = await fetch(
  "http://localhost:18080/api/v1/works?size=12",
);
assert.equal(gatewayRecovery.status, 200);
await gatewayRecovery.text();
const t = performance.now();
await run(
  "scripts/load.ts",
  [
    "--scenario",
    "cached",
    "--base",
    "http://localhost:13001",
    "--preview",
    "http://localhost:13002",
    "--rate",
    "60",
    "--warmup",
    "0",
    "--duration",
    "50",
    "--output",
    path.join(folder, prefix + "-ip-limit.json"),
  ],
  prefix + "-ip-limit",
);
const rate = JSON.parse(
  await readFile(path.join(folder, prefix + "-ip-limit.json"), "utf8"),
);
assert(rate.requests.read.statusCodes["429"] > 0);
const limited = await fetch("http://localhost:13001/api/v1/works?size=12");
assert.equal(limited.status, 429);
assert.equal(limited.headers.get("retry-after"), "60");
assert.equal(typeof (await limited.json()).message, "string");
await new Promise((r) =>
  setTimeout(r, Math.max(1, 61000 - (performance.now() - t))),
);
const restored = await fetch("http://localhost:13001/api/v1/works?size=12");
assert.equal(restored.status, 200);
await restored.text();
const result = {
  date: new Date().toISOString(),
  gatewayRejected: gateway.requests.read.statusCodes["429"],
  gatewayRecoveryStatus: gatewayRecovery.status,
  ipAccepted: rate.requests.read.success,
  ipRejected: rate.requests.read.statusCodes["429"],
  ipWindowRecoveryMs: Math.round(performance.now() - t),
  restored: restored.status,
};
await writeFile(
  path.join(folder, prefix + "-protection.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
