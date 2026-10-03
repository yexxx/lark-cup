import type { FastifyRequest, FastifyReply } from "fastify";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { DB } from "./db.js";
import type { Cache } from "./cache.js";
import { z } from "zod";
import { fail, audit } from "./domain.js";
import { config } from "./config.js";
import {
  hashPassword,
  verifyPassword,
  usernameSchema,
  passwordSchema,
} from "./password.js";
export interface User {
  id: string;
  name: string;
  role: "user" | "admin";
  status: "active" | "disabled";
}
export interface AuthAdapter {
  currentUser(req: FastifyRequest): Promise<User | null>;
  login(req: FastifyRequest, reply: FastifyReply): Promise<User>;
  register(req: FastifyRequest, reply: FastifyReply): Promise<User>;
  logout(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  changePassword(req: FastifyRequest, reply: FastifyReply): Promise<void>;
}
const fields = "id,name,role,status";
const loginSchema = z.strictObject({
  username: usernameSchema,
  password: passwordSchema,
});
const registerSchema = loginSchema.extend({
  name: z.string().trim().min(1).max(40),
});
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
function sessionToken(req: FastifyRequest) {
  const matches =
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("lark_session=")) || [];
  if (matches.length !== 1) return null;
  const value = matches[0].slice("lark_session=".length);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function setCookie(reply: FastifyReply, token = "") {
  const flags = `Path=/; HttpOnly; SameSite=Lax${config.appOrigin.startsWith("https:") ? "; Secure" : ""}`;
  reply.header("Set-Cookie", [
    `lark_session=${token}; ${flags}; Max-Age=${token ? config.authSessionSeconds : 0}`,
    `lark_demo=; ${flags}; Max-Age=0`,
  ]);
}
/** Identity providers resolve verified subjects to stable competition user IDs. */
export async function resolveIdentity(
  db: DB,
  provider: string,
  subject: string,
): Promise<User | null> {
  return (
    (
      await db.query<User>(
        `SELECT u.id,u.name,u.role,u.status FROM auth_identities i JOIN users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2`,
        [provider, subject],
      )
    ).rows[0] || null
  );
}
export async function createLocalAccount(
  db: DB,
  input: { username: string; name: string; password: string },
  role: User["role"] = "user",
  onCreated?: (tx: DB, user: User) => Promise<void>,
) {
  const b = registerSchema.parse(input);
  if (await resolveIdentity(db, "local", b.username))
    fail(409, "用户名已被使用");
  const hash = await hashPassword(b.password);
  try {
    return await db.transaction(async (tx) => {
      const user = (
        await tx.query<User>(
          `INSERT INTO users(id,name,role) VALUES($1,$2,$3) RETURNING ${fields}`,
          [randomUUID(), b.name, role],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO auth_identities(provider,subject,user_id) VALUES('local',$1,$2)",
        [b.username, user.id],
      );
      await tx.query(
        "INSERT INTO local_credentials(user_id,password_hash) VALUES($1,$2)",
        [user.id, hash],
      );
      await audit(tx, user.id, "account.create", user.id, {
        provider: "local",
        role,
      });
      await onCreated?.(tx, user);
      return user;
    });
  } catch (error: any) {
    if (error.code === "23505") fail(409, "用户名已被使用");
    throw error;
  }
}
export async function resetLocalPassword(
  db: DB,
  username: string,
  password: string,
) {
  const user = await resolveIdentity(
    db,
    "local",
    usernameSchema.parse(username),
  );
  if (!user) fail(404, "用户不存在");
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
    await tx.query(
      "UPDATE local_credentials SET password_hash=$2 WHERE user_id=$1",
      [user.id, hash],
    );
    await tx.query("DELETE FROM auth_sessions WHERE user_id=$1", [user.id]);
    await audit(tx, user.id, "account.password.reset", user.id, {
      source: "server-command",
    });
  });
}
export async function cleanupSessions(db: DB, now = new Date()) {
  await db.query(
    "DELETE FROM auth_sessions WHERE expires_at <= $1 OR last_seen_at <= $2",
    [now, new Date(now.getTime() - config.authIdleSeconds * 1000)],
  );
}
export function createSessionStore(db: DB, clock = () => new Date()) {
  const identified = new WeakMap<FastifyRequest, Promise<User | null>>();
  async function createSession(tx: DB, req: FastifyRequest, userId: string) {
    const token = randomBytes(32).toString("base64url");
    const now = clock();
    const previous = sessionToken(req);
    if (previous)
      await tx.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
        digest(previous),
      ]);
    await tx.query(
      "INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES($1,$2,$3,$4,$3)",
      [
        digest(token),
        userId,
        now,
        new Date(now.getTime() + config.authSessionSeconds * 1000),
      ],
    );
    return token;
  }
  return {
    currentUser(req: FastifyRequest) {
      if (identified.has(req)) return identified.get(req)!;
      const read = (async () => {
        const token = sessionToken(req);
        if (!token) return null;
        const now = clock();
        return (
          (
            await db.query<User>(
              `UPDATE auth_sessions s SET last_seen_at=$2 FROM users u WHERE s.token_hash=$1 AND u.id=s.user_id AND u.status='active' AND s.expires_at>$2 AND s.last_seen_at>$3 RETURNING u.id,u.name,u.role,u.status`,
              [
                digest(token),
                now,
                new Date(now.getTime() - config.authIdleSeconds * 1000),
              ],
            )
          ).rows[0] || null
        );
      })();
      identified.set(req, read);
      return read;
    },
    create: createSession,
    async establish(req: FastifyRequest, reply: FastifyReply, userId: string) {
      const result = await db.transaction(async (tx) => {
        const user = (
          await tx.query<User>(
            `SELECT ${fields} FROM users WHERE id=$1 FOR UPDATE`,
            [userId],
          )
        ).rows[0];
        if (!user || user.status !== "active") fail(403, "账户已停用");
        return { user, token: await createSession(tx, req, user.id) };
      });
      setCookie(reply, result.token);
      return result.user;
    },
    async logout(req: FastifyRequest, reply: FastifyReply) {
      const token = sessionToken(req);
      if (token)
        await db.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
          digest(token),
        ]);
      setCookie(reply);
    },
  };
}
export function localAuth(
  db: DB,
  cache: Cache,
  clock = () => new Date(),
): AuthAdapter {
  const sessions = createSessionStore(db, clock);
  const adapter: AuthAdapter = {
    currentUser: sessions.currentUser,
    async register(req, reply) {
      if (
        !(await cache.take(`auth-register:${req.ip}`, config.authRegisterRate))
      )
        fail(429, "注册过于频繁，请稍后再试");
      const b = registerSchema.parse(req.body);
      let token = "";
      const user = await createLocalAccount(db, b, "user", async (tx, user) => {
        token = await sessions.create(tx, req, user.id);
      });
      setCookie(reply, token);
      return user;
    },
    async login(req, reply) {
      const b = loginSchema.parse(req.body);
      if (
        !(await cache.take(
          `auth-login-ip:${req.ip}`,
          config.authLoginIpRate,
        )) ||
        !(await cache.take(
          `auth-login-account:${b.username}`,
          config.authLoginAccountRate,
        ))
      )
        fail(429, "登录过于频繁，请稍后再试");
      const record = (
        await db.query<User & { password_hash: string }>(
          `SELECT u.id,u.name,u.role,u.status,c.password_hash FROM auth_identities i JOIN users u ON u.id=i.user_id JOIN local_credentials c ON c.user_id=u.id WHERE i.provider='local' AND i.subject=$1`,
          [b.username],
        )
      ).rows[0];
      if (!(await verifyPassword(b.password, record?.password_hash)) || !record)
        fail(401, "用户名或密码错误");
      const result = await db.transaction(async (tx) => {
        const user = (
          await tx.query<User>(
            `SELECT ${fields} FROM users WHERE id=$1 FOR UPDATE`,
            [record.id],
          )
        ).rows[0];
        const credentials = (
          await tx.query(
            "SELECT password_hash FROM local_credentials WHERE user_id=$1",
            [user.id],
          )
        ).rows[0];
        if (credentials.password_hash !== record.password_hash)
          fail(401, "用户名或密码错误");
        if (user.status !== "active") fail(403, "账户已停用");
        const token = await sessions.create(tx, req, user.id);
        return { user, token };
      });
      setCookie(reply, result.token);
      return result.user;
    },
    logout: sessions.logout,
    async changePassword(req, reply) {
      const user = await requireUser(adapter, req);
      if (
        !(await cache.take(
          `auth-password:${user.id}`,
          config.authLoginAccountRate,
        ))
      )
        fail(429, "操作过于频繁，请稍后再试");
      const b = z
        .strictObject({
          currentPassword: passwordSchema,
          newPassword: passwordSchema,
        })
        .parse(req.body);
      const old = (
        await db.query(
          "SELECT password_hash FROM local_credentials WHERE user_id=$1",
          [user.id],
        )
      ).rows[0];
      if (!(await verifyPassword(b.currentPassword, old?.password_hash)))
        fail(401, "当前密码错误");
      const hash = await hashPassword(b.newPassword);
      await db.transaction(async (tx) => {
        const current = (
          await tx.query<User>(
            `SELECT ${fields} FROM users WHERE id=$1 FOR UPDATE`,
            [user.id],
          )
        ).rows[0];
        if (current.status !== "active") fail(403, "账户已停用");
        const credentials = (
          await tx.query(
            "SELECT password_hash FROM local_credentials WHERE user_id=$1",
            [user.id],
          )
        ).rows[0];
        const token = sessionToken(req);
        const now = clock();
        const session =
          token &&
          (
            await tx.query(
              "SELECT token_hash FROM auth_sessions WHERE token_hash=$1 AND expires_at>$2 AND last_seen_at>$3",
              [
                digest(token),
                now,
                new Date(now.getTime() - config.authIdleSeconds * 1000),
              ],
            )
          ).rows[0];
        if (!session || credentials.password_hash !== old.password_hash)
          fail(401, "登录状态已更新，请重新登录");
        await tx.query(
          "UPDATE local_credentials SET password_hash=$2 WHERE user_id=$1",
          [user.id, hash],
        );
        await tx.query("DELETE FROM auth_sessions WHERE user_id=$1", [user.id]);
        await audit(tx, user.id, "account.password.change", user.id, {});
      });
      setCookie(reply);
    },
  };
  return adapter;
}
export async function requireUser(
  auth: AuthAdapter,
  req: FastifyRequest,
  admin = false,
) {
  const user = await auth.currentUser(req);
  if (!user) fail(401, "请先登录", "AUTH_EXPIRED");
  if (req.headers["x-lark-user"] && req.headers["x-lark-user"] !== user!.id)
    fail(409, "登录状态已改变，请刷新", "AUTH_CHANGED");
  if (user!.status !== "active") fail(403, "账户已停用");
  if (admin && user!.role !== "admin") fail(403, "需要管理员身份");
  return user!;
}
