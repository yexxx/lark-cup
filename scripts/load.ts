import { writeFile, mkdir } from "node:fs/promises";
const base = process.env.LOAD_BASE_URL || "http://localhost:3001";
const parsed = new URL(base);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
  throw new Error("Load testing is restricted to local hosts");
const results = [];
for (const concurrency of [1, 5, 10]) {
  const latencies: number[] = [];
  const codes: Record<string, number> = {};
  const start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let i = 0; i < 4; i++) {
        const t = performance.now();
        const r = await fetch(`${base}/api/v1/works?size=12`, {
          signal: AbortSignal.timeout(5000),
        });
        await r.arrayBuffer();
        latencies.push(performance.now() - t);
        codes[r.status] = (codes[r.status] || 0) + 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "admin", name: "赛事管理员" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
  const resource = await fetch(`${base}/api/v1/admin/overview`, {
    headers: { cookie },
  }).then((r) => r.json());
  const result = {
    concurrency,
    requests: latencies.length,
    statusCodes: codes,
    p50Ms: +latencies[Math.floor(latencies.length * 0.5)].toFixed(2),
    p95Ms:
      +latencies[
        Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))
      ].toFixed(2),
    elapsedMs: Math.round(performance.now() - start),
    memoryMB: resource.memoryMB,
    inflight: resource.inflight,
    activeUploads: resource.activeUploads,
  };
  results.push(result);
  console.log(JSON.stringify(result));
  await new Promise((resolve) => setTimeout(resolve, 300));
}
await mkdir("test-results", { recursive: true });
await writeFile(
  "test-results/load.json",
  JSON.stringify({ date: new Date().toISOString(), base, results }, null, 2),
);
