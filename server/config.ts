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
  localDatabaseDir: path.resolve(
    process.env.LOCAL_DATABASE_DIR || ".local/postgres",
  ),
  poolMax: number("DB_POOL_MAX", 10),
  maxInflight: number("MAX_INFLIGHT", 32),
  maxUploads: number("MAX_UPLOADS", 2),
  maxPreviews: number("MAX_PREVIEWS", 8),
  requestTimeout: number("REQUEST_TIMEOUT_MS", 15000),
  listTtl: number("LIST_CACHE_SECONDS", 10),
  rankTtl: number("RANK_CACHE_SECONDS", 15),
  ipRate: number("IP_RATE_PER_MINUTE", 2400),
  voteRate: number("VOTE_RATE_PER_MINUTE", 20),
  uploadRate: number("UPLOAD_RATE_PER_MINUTE", 10),
  authSessionSeconds: number("AUTH_SESSION_SECONDS", 604800),
  authIdleSeconds: number("AUTH_IDLE_SECONDS", 86400),
  authLoginIpRate: number("AUTH_LOGIN_IP_PER_MINUTE", 60),
  authLoginAccountRate: number("AUTH_LOGIN_ACCOUNT_PER_MINUTE", 10),
  authRegisterRate: number("AUTH_REGISTER_IP_PER_MINUTE", 10),
  trustProxy: process.env.TRUST_PROXY === "true",
};
if (new URL(config.appOrigin).origin === new URL(config.previewOrigin).origin)
  throw new Error("Preview must use a separate origin");
