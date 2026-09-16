import path from "node:path";
const number = (key: string, fallback: number) => {
  const n = Number(process.env[key] ?? fallback);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid ${key}`);
  return n;
};
export const config = {
  port: number("PORT", 3001),
  previewPort: number("PREVIEW_PORT", 3002),
  appOrigin: process.env.APP_ORIGIN || "http://localhost:5173",
  previewOrigin: process.env.PREVIEW_ORIGIN || "http://localhost:3002",
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  uploads: path.resolve(process.env.UPLOAD_DIR || ".local/uploads"),
  poolMax: number("DB_POOL_MAX", 10),
  maxInflight: number("MAX_INFLIGHT", 32),
  maxUploads: number("MAX_UPLOADS", 2),
  requestTimeout: number("REQUEST_TIMEOUT_MS", 15000),
  listTtl: number("LIST_CACHE_SECONDS", 10),
  rankTtl: number("RANK_CACHE_SECONDS", 15),
  ipRate: number("IP_RATE_PER_MINUTE", 240),
  voteRate: number("VOTE_RATE_PER_MINUTE", 20),
  uploadRate: number("UPLOAD_RATE_PER_MINUTE", 10),
  trustProxy: process.env.TRUST_PROXY === "true",
};
if (new URL(config.appOrigin).origin === new URL(config.previewOrigin).origin)
  throw new Error("Preview must use a separate origin");
