import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.js";
export function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
export const dayInBeijing = (date = new Date()) =>
  new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
export const nextDay = (date = new Date()) =>
  dayInBeijing(new Date(date.getTime() + 86400000));
export const trackSchema = z.literal("classic").default("classic");
export const workSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(3000),
  model: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(10000),
  track: trackSchema,
  coverId: z.uuid().nullable(),
  htmlId: z.uuid().nullable(),
});
export const settingsSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    tagline: z.string().trim().min(1).max(100),
    description: z.string().max(2000),
    prompt: z.string().min(1).max(10000),
    rules: z.string().min(1).max(10000),
    prizes: z.string().max(5000),
    submissionStart: z.iso.datetime({ offset: true }),
    submissionEnd: z.iso.datetime({ offset: true }),
    voteStart: z.iso.datetime({ offset: true }),
    voteEnd: z.iso.datetime({ offset: true }),
    dailyLimit: z.number().int().min(1).max(100),
  })
  .refine(
    (s) =>
      new Date(s.submissionStart) < new Date(s.submissionEnd) &&
      new Date(s.voteStart) < new Date(s.voteEnd),
    "开始时间必须早于结束时间",
  );
export async function settings(db: DB) {
  return (await db.query("SELECT data FROM competition WHERE id=1")).rows[0]
    .data;
}
export function limitFor(s: any, day: string) {
  return s.limitEffectiveDate && day >= s.limitEffectiveDate
    ? s.nextDailyLimit
    : s.dailyLimit;
}
export function checkWindow(
  s: any,
  kind: "submission" | "vote",
  date = new Date(),
) {
  if (date < new Date(s[`${kind}Start`]) || date > new Date(s[`${kind}End`]))
    fail(409, kind === "vote" ? "当前不在投票时间内" : "当前不在报名时间内");
}
export async function audit(
  db: DB,
  actor: string,
  action: string,
  target: string,
  detail: unknown = {},
) {
  await db.query(
    "INSERT INTO audit_logs(actor_id,action,target,detail) VALUES($1,$2,$3,$4)",
    [actor, action, target, JSON.stringify(detail)],
  );
}
export async function castVote(
  db: DB,
  userId: string,
  workId: string,
  key: string,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    // Serialize one user's mutations so quota and idempotency remain consistent across API instances.
    const user = (
      await tx.query("SELECT status FROM users WHERE id=$1 FOR UPDATE", [
        userId,
      ])
    ).rows[0];
    if (!user || user.status !== "active") fail(403, "账户不可投票");
    const prior = (
      await tx.query(
        "SELECT id,work_id FROM votes WHERE user_id=$1 AND idempotency_key=$2",
        [userId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.work_id !== workId) fail(409, "幂等键已用于其他作品");
      return { id: prior.id, repeated: true };
    }
    const s = await settings(tx);
    checkWindow(s, "vote", now);
    const w = (
      await tx.query(
        "SELECT id,status,track FROM works WHERE id=$1 FOR SHARE",
        [workId],
      )
    ).rows[0];
    if (!w || w.status !== "approved") fail(404, "作品尚未公开或已撤回");
    const day = dayInBeijing(now);
    if (
      (
        await tx.query(
          "SELECT id FROM votes WHERE user_id=$1 AND work_id=$2 AND day=$3",
          [userId, workId, day],
        )
      ).rows.length
    )
      fail(409, "今天已为这个作品投票");
    await tx.query(
      "INSERT INTO daily_quotas(user_id,track,day) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [userId, w.track, day],
    );
    const updated = await tx.query(
      "UPDATE daily_quotas SET used=used+1 WHERE user_id=$1 AND track=$2 AND day=$3 AND used<$4 RETURNING used",
      [userId, w.track, day, limitFor(s, day)],
    );
    if (!updated.rows.length) fail(409, "今日选票已用完");
    const id = randomUUID();
    await tx.query(
      "INSERT INTO votes(id,user_id,work_id,track,day,idempotency_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, userId, workId, w.track, day, key, now],
    );
    return { id, repeated: false };
  });
}

