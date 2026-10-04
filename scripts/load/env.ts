import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { args, root, local } from "./common.js";
const a = args();
const command = String(a.command || "up");
await mkdir(local, { recursive: true });
for (const folder of ["fixtures", "metrics", "docker"])
  await mkdir(path.join(local, folder), { recursive: true });
const secretFile = path.join(local, "environment.json");
let secrets: { password: string };
try {
  secrets = JSON.parse(await readFile(secretFile, "utf8"));
} catch {
  secrets = { password: randomBytes(24).toString("hex") };
  await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600 });
}
await chmod(secretFile, 0o600);
const profile = String(a.profile || "default");
if (!["default", "capacity"].includes(profile))
  throw new Error("Use --profile default|capacity");
const source = path.resolve(root, String(a.source || "."));
const tag = String(a.tag || "fixed");
const env = {
  ...process.env,
  DOCKER_CONFIG: path.join(local, "docker"),
  DOCKER_HOST:
    process.env.LOAD_DOCKER_HOST ||
    `unix://${path.join(process.env.HOME!, ".colima/lark-load/docker.sock")}`,
  LOAD_DB_PASSWORD: secrets.password,
  LOAD_SOURCE: source,
  LOAD_TAG: tag,
  LOAD_PROFILE: profile,
  LOAD_IP_RATE:
    profile === "capacity" ? "1000000000" : tag === "baseline" ? "240" : "2400",
  LOAD_LOGIN_RATE: profile === "capacity" ? "1000000" : "60",
  LOAD_REGISTER_RATE: profile === "capacity" ? "1000000" : "10",
};
export function run(bin: string, argv: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(bin, argv, { cwd: root, env, stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`)),
    );
  });
}
const compose = ["-f", "deploy/compose.load.yaml", "-p", "lark-cup-load"];
if (command === "up") {
  let nginx = await readFile(path.join(source, "deploy/nginx.conf"), "utf8");
  if (profile === "capacity")
    nginx = nginx
      .replace("rate=10r/s", "rate=100000r/s")
      .replace(/burst=\d+ nodelay/g, "burst=100000 nodelay")
      .replace("worker_connections 256", "worker_connections 4096")
      .replace(
        "worker_processes 2;",
        "worker_processes 2;\nworker_rlimit_nofile 8192;",
      )
      .replace(/limit_conn per_ip \d+;/g, "limit_conn per_ip 10000;");
  await writeFile(path.join(local, "nginx.conf"), nginx);
  await run("docker-compose", [...compose, "up", "-d", "--build"]);
  await run("docker-compose", [...compose, "restart", "web"]);
  await writeFile(
    path.join(local, "active.json"),
    JSON.stringify({
      profile,
      source,
      tag,
      appOrigin: process.env.LOAD_APP_ORIGIN || "http://localhost:18080",
      previewOrigin:
        process.env.LOAD_PREVIEW_ORIGIN || "http://localhost:18081",
      date: new Date().toISOString(),
    }),
  );
} else if (command === "down")
  await run("docker-compose", [...compose, "down"]);
else if (command === "stop")
  await run("docker-compose", [...compose, "stop", String(a.service || "api")]);
else if (command === "seed")
  await run("docker-compose", [
    ...compose,
    "exec",
    "-T",
    "--user",
    "root",
    "api",
    "node",
    "--import",
    "tsx",
    "scripts/load/seed.ts",
    "--size",
    String(a.size || "small"),
    "--seed",
    String(a.seed || "1024"),
  ]);
else if (command === "restart")
  await run("docker-compose", [
    ...compose,
    "restart",
    String(a.service || "api"),
  ]);
else if (command === "multi") {
  const count = Number(a.shards || 4);
  if (!Number.isInteger(count) || count < 1 || count > 16)
    throw new Error("Use 1..16 shards");
  const out = path.join(root, "test-results/load");
  await mkdir(out, { recursive: true });
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      run("docker", [
        "run",
        "--rm",
        "--user",
        "root",
        "--network",
        "lark-cup-load_default",
        "-v",
        `${path.join(root, "scripts")}:/app/scripts:ro`,
        "-v",
        `${path.join(local, "fixtures")}:/fixtures:ro`,
        "-v",
        `${out}:/outputs`,
        `lark-cup-load-api:${tag}`,
        "node",
        "--import",
        "tsx",
        "scripts/load.ts",
        "--base",
        "http://web",
        "--preview",
        "http://web:8081",
        "--fixture",
        "/fixtures/fixture.json",
        "--scenario",
        String(a.scenario || "browse"),
        "--rate",
        String(a.rate || 1),
        "--shard",
        String(i),
        "--shards",
        String(count),
        "--warmup",
        String(a.warmup || 30),
        "--duration",
        String(a.duration || 180),
        "--output",
        `/outputs/${String(a.prefix || "default-multi")}-${i}.json`,
      ]),
    ),
  );
} else if (command === "exec") {
  const raw = process.argv.slice(process.argv.indexOf("--") + 1);
  if (!process.argv.includes("--") || !raw.length)
    throw new Error("Use --command exec -- SERVICE COMMAND...");
  await run("docker-compose", [...compose, "exec", "-T", ...raw]);
} else throw new Error("Unknown --command");
