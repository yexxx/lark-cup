import type { FastifyRequest, FastifyReply } from "fastify";
import type { DB } from "./db.js";
import { z } from "zod";
import { fail } from "./domain.js";
import { config } from "./config.js";
export interface User {
  id: string;
  name: string;
  role: "user" | "admin";
  status: "active" | "disabled";
}
export interface AuthAdapter {
  currentUser(req: FastifyRequest): Promise<User | null>;
  login(req: FastifyRequest, reply: FastifyReply): Promise<User>;
  logout(reply: FastifyReply): void;
}
/** Replace this adapter with your identity provider. Demo identities are deliberately public. */
export function demoAuth(db: DB): AuthAdapter {
  const cookie = (req: FastifyRequest) =>
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("lark_demo="))
      ?.slice(10);
  return {
    async currentUser(req) {
      const id = cookie(req);
      if (!id || !/^[a-zA-Z0-9_-]{1,48}$/.test(id)) return null;
      return (
        (
          await db.query<User>(
            "SELECT id,name,role,status FROM users WHERE id=$1",
            [id],
          )
        ).rows[0] || null
      );
    },
    async login(req, reply) {
      const { id, name } = z
        .object({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/),
          name: z.string().trim().min(1).max(40),
        })
        .parse(req.body);
      const user = (
        await db.query<User>(
          `INSERT INTO users(id,name,role) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,role,status`,
          [id, name, id === "admin" ? "admin" : "user"],
        )
      ).rows[0];
      if (user.status !== "active") fail(403, "账户已停用");
      reply.header(
        "Set-Cookie",
        `lark_demo=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${config.appOrigin.startsWith("https:") ? "; Secure" : ""}`,
      );
      return user;
    },
    logout(reply) {
      reply.header(
        "Set-Cookie",
        "lark_demo=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      );
    },
  };
}
export async function requireUser(
  auth: AuthAdapter,
  req: FastifyRequest,
  admin = false,
) {
  const user = await auth.currentUser(req);
  if (!user) fail(401, "请先选择登录身份");
  if (user!.status !== "active") fail(403, "账户已停用");
  if (admin && user!.role !== "admin") fail(403, "需要管理员身份");
  return user!;
}
