import { createHash } from "node:crypto";
import path from "node:path";
export const root = path.resolve(import.meta.dirname, "../..");
export const local = path.join(root, ".local/load");
export const args = () => {
  const result: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") break;
    if (!argv[i].startsWith("--"))
      throw new Error(`Unexpected argument ${argv[i]}`);
    const [key, inline] = argv[i].slice(2).split("=", 2);
    result[key] =
      inline ??
      (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
  }
  return result;
};
export function num(
  a: Record<string, string | boolean>,
  key: string,
  fallback: number,
  min = 0,
) {
  const n = Number(a[key] ?? fallback);
  if (!Number.isFinite(n) || n < min) throw new Error(`Invalid --${key}`);
  return n;
}
export function uuid(label: string) {
  const s = createHash("sha256").update(label).digest("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
}
export function rng(seed: number) {
  let state = seed | 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) | 0;
    return (state >>> 0) / 4294967296;
  };
}
export const percentile = (sorted: number[], q: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]
    : null;
export type Fixture = {
  seed: number;
  password: string;
  createdAt: string;
  users: { id: string; username: string; cookie: string }[];
  works: { id: string; coverId: string; htmlId: string }[];
  historicalVotes: number;
};
export function passesSLO(r: any) {
  return (
    !r.fixtureBudgetExhaustions &&
    !r.execution?.executionPauses &&
    r.actionSuccessRate >= 0.99 &&
    Object.entries<number>(r.actionCounts).every(
      ([kind, count]) =>
        !count || (r.successfulActionCounts[kind] || 0) / count >= 0.99,
    ) &&
    Object.entries<any>(r.requests).every(([kind, s]) => {
      const unexpected = Object.entries<number>(s.statusCodes)
        .filter(([code]) => code === "0" || (+code >= 500 && code !== "503"))
        .reduce((n, [, count]) => n + count, 0);
      const limit =
        kind === "auth"
          ? 2000
          : kind === "upload"
            ? 5000
            : kind === "vote"
              ? 800
              : 300;
      return unexpected / s.count <= 0.001 && s.p95Ms <= limit;
    }) &&
    r.scheduling.over100Ms / r.planned <= 0.01
  );
}
