import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { fail } from "./domain.js";

export const usernameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-zA-Z0-9_-]{3,32}$/,
    "用户名需要 3～32 位英文字母、数字、下划线或短横线",
  )
  .transform((s) => s.toLowerCase());
export const passwordSchema = z.string().refine((s) => {
  const length = [...s].length;
  return length >= 15 && length <= 128;
}, "密码需要 15～128 个字符");
const N = 131072,
  r = 8,
  p = 1;
let active = 0;
async function derive(password: string, salt: Buffer) {
  if (active >= 2) fail(503, "登录服务繁忙，请稍后再试");
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        64,
        { N, r, p, maxmem: 192 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      );
    });
  } finally {
    active--;
  }
}
export async function hashPassword(password: string) {
  passwordSchema.parse(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}
const dummy = `scrypt$${N}$${r}$${p}$${"0".repeat(32)}$${"0".repeat(128)}`;
export async function verifyPassword(password: string, encoded?: string) {
  const parts = (encoded || dummy).split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    parts[1] !== String(N) ||
    parts[2] !== String(r) ||
    parts[3] !== String(p) ||
    !/^[a-f0-9]{32}$/.test(parts[4]) ||
    !/^[a-f0-9]{128}$/.test(parts[5])
  )
    throw new Error("Invalid password hash");
  const key = await derive(password, Buffer.from(parts[4], "hex"));
  return timingSafeEqual(key, Buffer.from(parts[5], "hex")) && !!encoded;
}
