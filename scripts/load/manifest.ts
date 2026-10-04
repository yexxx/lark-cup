import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { args, local, root } from "./common.js";
const a = args(),
  exec = promisify(execFile),
  output = String(a.output || "test-results/load/environment-manifest.json");
const env = {
  ...process.env,
  DOCKER_HOST:
    process.env.LOAD_DOCKER_HOST ||
    `unix://${process.env.HOME}/.colima/lark-load/docker.sock`,
  DOCKER_CONFIG: path.join(local, "docker"),
};
const commands = [
  ["git", ["rev-parse", "HEAD"]],
  ["sw_vers", ["-productVersion"]],
  ["sysctl", ["-n", "machdep.cpu.brand_string"]],
  ["sysctl", ["-n", "hw.memsize"]],
  ["docker", ["--version"]],
  ["docker-compose", ["version"]],
  ["colima", ["version"]],
  ["docker", ["version", "--format", "{{json .Server}}"]],
  [
    "docker",
    [
      "inspect",
      "lark-cup-load-api-1",
      "lark-cup-load-web-1",
      "lark-cup-load-db-1",
      "lark-cup-load-redis-1",
    ],
  ],
] as const;
const results = await Promise.allSettled(
  commands.map(([bin, argv]) =>
    exec(bin, [...argv], { env, maxBuffer: 100000 }),
  ),
);
const get = (i: number) => {
  const r = results[i];
  if (r.status === "rejected") throw r.reason;
  return r.value.stdout.trim();
};
const containers = JSON.parse(get(8)).map((c: any) => ({
  name: c.Name,
  image: c.Config.Image,
  imageId: c.Image,
  state: c.State,
  restarts: c.RestartCount,
  resources: {
    cpus: c.HostConfig.NanoCpus / 1e9,
    memoryBytes: c.HostConfig.Memory,
    pidsLimit: c.HostConfig.PidsLimit,
    logging: c.HostConfig.LogConfig,
  },
  capacityEnvironment: Object.fromEntries(
    c.Config.Env.filter((entry: string) =>
      /^(NODE_ENV|DB_POOL_MAX|MAX_INFLIGHT|MAX_UPLOADS|MAX_PREVIEWS|IP_RATE_PER_MINUTE|AUTH_LOGIN_IP_PER_MINUTE|AUTH_REGISTER_IP_PER_MINUTE|LOAD_TAG|LOAD_PROFILE|LOAD_TEST_ISOLATED)=/.test(
        entry,
      ),
    ).map((entry: string) => {
      const split = entry.indexOf("=");
      return [entry.slice(0, split), entry.slice(split + 1)];
    }),
  ),
  ports: c.NetworkSettings.Ports,
  addresses: Object.fromEntries(
    Object.entries<any>(c.NetworkSettings.Networks).map(([name, n]) => [
      name,
      n.IPAddress,
    ]),
  ),
}));
const active = JSON.parse(
  await readFile(path.join(local, "active.json"), "utf8"),
);
const sourceFiles = [
  "server/app.ts",
  "server/auth.ts",
  "server/password.ts",
  "server/cache.ts",
  "server/db.ts",
  "server/config.ts",
  "server/html.ts",
  "server/html-upload.ts",
  "server/html-worker.ts",
  "src/api.ts",
  "deploy/nginx.conf",
  "deploy/nginx.tls.conf",
  "Dockerfile",
  "package-lock.json",
];
const sourceSha256: Record<string, string> = {};
for (const file of sourceFiles) {
  try {
    sourceSha256[file] = createHash("sha256")
      .update(await readFile(path.join(active.source, file)))
      .digest("hex");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
}
const manifest = {
  date: new Date().toISOString(),
  baselineCommit: get(0),
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    osVersion: get(1),
    cpu: get(2),
    memoryBytes: Number(get(3)),
  },
  versions: {
    docker: get(4),
    compose: get(5),
    colima: get(6),
    engine: JSON.parse(get(7)),
  },
  active,
  sourceSha256,
  testFilesSha256: Object.fromEntries(
    await Promise.all(
      [
        "deploy/compose.load.yaml",
        ".local/load/nginx.conf",
        "scripts/load/soak.ts",
        "scripts/load/server.ts",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(path.join(root, file)))
          .digest("hex"),
      ]),
    ),
  ),
  generatorSha256: createHash("sha256")
    .update(await readFile(path.join(root, "scripts/load.ts")))
    .digest("hex"),
  vm: { cpu: 4, memoryGiB: 8, diskGiB: 40, type: "vz", mount: "virtiofs" },
  containers,
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(manifest, null, 2));
console.log(
  JSON.stringify({
    output,
    containers: containers.length,
    baselineCommit: manifest.baselineCommit,
  }),
);
