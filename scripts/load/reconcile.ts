import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Pool } from "pg";
import { args, local } from "./common.js";
const a = args(),
  output = path.resolve(
    String(a.output || "test-results/load/reconciliation.json"),
  );
const { password } = JSON.parse(
  await readFile(path.join(local, "environment.json"), "utf8"),
);
const pool = new Pool({
  host: "127.0.0.1",
  port: 15432,
  user: "lark",
  database: "lark_load",
  password,
  max: 2,
});
const env = {
  ...process.env,
  DOCKER_HOST:
    process.env.LOAD_DOCKER_HOST ||
    `unix://${process.env.HOME}/.colima/lark-load/docker.sock`,
  DOCKER_CONFIG: path.join(local, "docker"),
};
try {
  assert(
    (
      await pool.query(
        "SELECT data->>'loadTest' AS marker FROM competition WHERE id=1",
      )
    ).rows[0].marker,
  );
  const code =
    "const fs=require('fs');console.log(JSON.stringify(fs.readdirSync('/app/data/uploads').map(name=>({name,bytes:fs.statSync('/app/data/uploads/'+name).size}))));";
  const files: { name: string; bytes: number }[] = JSON.parse(
    (
      await promisify(execFile)(
        "docker",
        ["exec", "lark-cup-load-api-1", "node", "-e", code],
        { env, maxBuffer: 5000000 },
      )
    ).stdout,
  );
  const assets = (await pool.query("SELECT filename,bytes FROM assets")).rows,
    byName = new Map(files.map((f) => [f.name, f.bytes]));
  const names = new Set(assets.map((a) => a.filename));
  const missing = assets.filter((a) => !byName.has(a.filename)),
    sizes = assets.filter(
      (a) => byName.has(a.filename) && byName.get(a.filename) !== a.bytes,
    ),
    orphans = files.filter((f) => !names.has(f.name));
  const mismatches = (
    await pool.query(
      "SELECT count(*)::integer AS n FROM daily_quotas q FULL JOIN (SELECT user_id,track,day,count(*)::integer AS used FROM votes GROUP BY user_id,track,day) v USING(user_id,track,day) WHERE COALESCE(q.used,0)<>COALESCE(v.used,0)",
    )
  ).rows[0].n;
  const badOwners = (
    await pool.query(
      "SELECT count(*)::integer AS n FROM works w JOIN assets a ON a.id=w.cover_id OR a.id=w.html_id WHERE w.owner_id<>a.owner_id",
    )
  ).rows[0].n;
  const quotaOver = (
    await pool.query(
      "SELECT count(*)::integer AS n FROM daily_quotas WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date AND used>10",
    )
  ).rows[0].n;
  const missingAudits = (
    await pool.query(
      "SELECT count(*)::integer AS n FROM reviews r WHERE NOT EXISTS(SELECT 1 FROM audit_logs a WHERE a.action='review' AND a.target=r.work_id::text AND a.actor_id=r.actor_id AND a.detail->>'version'=r.version::text AND a.detail->>'decision'=r.decision AND a.detail->>'reason'=r.reason)",
    )
  ).rows[0].n;
  const duplicateVotes = (
    await pool.query(
      "SELECT count(*)::integer AS n FROM (SELECT user_id,work_id,day FROM votes GROUP BY user_id,work_id,day HAVING count(*)>1) d",
    )
  ).rows[0].n;
  const result = {
    date: new Date().toISOString(),
    files: files.length,
    assets: assets.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    missing: missing.length,
    sizeMismatches: sizes.length,
    orphans: orphans.length,
    quotaMismatches: mismatches,
    quotaOver,
    badOwners,
    missingAudits,
    duplicateVotes,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.equal(
    result.missing +
      result.sizeMismatches +
      result.orphans +
      result.quotaMismatches +
      quotaOver +
      badOwners +
      missingAudits +
      duplicateVotes,
    0,
  );
} finally {
  await pool.end();
}
