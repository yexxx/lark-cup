import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import multipart from "@fastify/multipart";
import { z, ZodError } from "zod";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import sharp from "sharp";
import { validateHtmlUpload } from "./html-upload.js";
import {
  CoverService,
  coverUrl,
  type AutoCover,
  type CoverRenderer,
} from "./covers.js";
import { previewPolicy } from "./preview-policy.js";
import type { DB } from "./db.js";
import { Cache } from "./cache.js";
import { config } from "./config.js";
import { queuePasswordOperation } from "./password.js";
import {
  localAuth,
  cleanupSessions,
  requireUser,
  type AuthAdapter,
} from "./auth.js";
import {
  audit,
  castVote,
  checkWindow,
  dayInBeijing,
  fail,
  limitFor,
  nextDay,
  settings,
  settingsSchema,
  workSchema,
} from "./domain.js";

const uuid = (v: unknown) => z.uuid().parse(v);
const pagination = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  size: z.coerce.number().int().min(1).max(48).default(12),
  track: z.enum(["all", "classic"]).default("all"),
  sort: z.enum(["recommended", "latest", "votes"]).default("recommended"),
  q: z.string().trim().max(80).default(""),
});
const coverFields = `(SELECT revision FROM assets WHERE id=w.cover_id) AS cover_revision,(SELECT status FROM generated_covers WHERE cover_id=w.cover_id) AS cover_status`;
const counted = `SELECT w.*, ${coverFields}, COALESCE(v.total,0)::integer AS votes FROM works w LEFT JOIN (SELECT work_id, count(*) AS total FROM votes WHERE valid GROUP BY work_id) v ON v.work_id=w.id`;
const targeted = `SELECT w.*, ${coverFields}, (SELECT count(*)::integer FROM votes v WHERE v.work_id=w.id AND v.valid) AS votes FROM works w`;
const selectFields = (w: any, reveal = false) => ({
  id: w.id,
  number: Number(w.number),
  title: w.title,
  description: w.description,
  model: w.model,
  prompt: w.prompt,
  track: w.track,
  status: w.status,
  reason: w.reason,
  recommended: w.recommended,
  version: w.version,
  votes: Number(w.votes || 0),
  coverId: w.cover_id,
  htmlId: w.html_id,
  coverUrl: w.cover_id ? coverUrl(w.cover_id, w.cover_revision || 1) : null,
  coverMode: w.cover_status ? "auto" : w.cover_id ? "manual" : "auto",
  coverStatus:
    w.cover_status === "rendering" ? "pending" : w.cover_status || null,
  createdAt: w.created_at,
  updatedAt: w.updated_at,
  ...(reveal ? { ownerId: w.owner_id } : {}),
});

export async function buildApp(
  db: DB,
  options: {
    cache?: Cache;
    auth?: AuthAdapter;
    logger?: boolean;
    uploads?: string;
    now?: () => Date;
    coverRenderer?: CoverRenderer;
    startCoverWorker?: boolean;
  } = {},
) {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            "req.headers.cookie",
            "req.headers.authorization",
            "req.body.password",
            "req.body.currentPassword",
            "req.body.newPassword",
            "res.headers.set-cookie",
          ],
        }
      : false,
    trustProxy: config.trustProxy,
    bodyLimit: 128 * 1024,
    requestTimeout: config.requestTimeout,
    connectionTimeout: config.requestTimeout,
    keepAliveTimeout: 5000,
  });
  const preview = Fastify({
    logger: false,
    trustProxy: config.trustProxy,
    requestTimeout: config.requestTimeout,
    connectionTimeout: config.requestTimeout,
  });
  const cache = options.cache || new Cache();
  const uploads = options.uploads || config.uploads;
  const clock = options.now || (() => new Date());
  const auth = options.auth || localAuth(db, cache, clock);
  const previewSecret = process.env.PREVIEW_SECRET || randomUUID();
  await mkdir(uploads, { recursive: true });
  await cache.ready();
  const covers = new CoverService(
    db,
    uploads,
    options.coverRenderer,
    (error) => app.log.error(error, "Cover task failed"),
    undefined,
    () => cache.invalidatePublic(),
  );
  if (options.startCoverWorker !== false) covers.start();
  app.addHook("onClose", async () => covers.stop());
  const sessionCleanup = setInterval(() => {
    void cleanupSessions(db, clock()).catch((error) =>
      app.log.error(error, "Session cleanup failed"),
    );
  }, 3600000);
  sessionCleanup.unref();
  app.addHook("onClose", async () => clearInterval(sessionCleanup));
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  let inflight = 0;
  let activeUploads = 0;
  let activePreviews = 0;
  let activeExports = 0;
  const active = new WeakSet<FastifyRequest>();
  const uploading = new WeakSet<FastifyRequest>();
  const previewing = new WeakSet<FastifyRequest>();
  const handling = new WeakSet<FastifyRequest>();
  const release = (req: FastifyRequest) => {
    if (active.delete(req)) inflight--;
    if (uploading.delete(req)) activeUploads--;
    if (previewing.delete(req)) activePreviews--;
  };
  const takeBudget = async (
    req: FastifyRequest,
    reply: FastifyReply,
    key: string,
    limit: number,
  ) => {
    handling.add(req);
    try {
      const allowed = await cache.take(key, limit);
      if (req.raw.aborted || reply.raw.destroyed) fail(400, "请求已取消");
      return allowed;
    } finally {
      handling.delete(req);
      if (req.raw.aborted || reply.raw.destroyed) release(req);
    }
  };
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("Cache-Control", "no-store");
    if (inflight >= config.maxInflight)
      return reply
        .code(503)
        .header("Retry-After", "2")
        .send({ message: "服务器繁忙，请稍后再试" });
    inflight++;
    active.add(req);
    const disconnected = () => {
      if (!handling.has(req)) release(req);
    };
    req.raw.once("aborted", disconnected);
    reply.raw.once("close", disconnected);
    if (
      ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) &&
      req.headers.origin !== config.appOrigin
    )
      fail(403, "请求来源不允许");
    if (
      req.url.split("?")[0] === "/api/v1/health" ||
      req.url.startsWith("/media/")
    )
      return;
    if (!(await takeBudget(req, reply, `ip:${req.ip}`, config.ipRate)))
      return reply
        .code(429)
        .header("Retry-After", "60")
        .send({ message: "请求过于频繁，请稍后再试" });
  });
  for (const service of [app, preview]) {
    service.addHook("onResponse", async (req) => release(req));
    service.addHook("preHandler", async (req) => {
      handling.add(req);
    });
    service.addHook("onSend", async (req, reply, payload) => {
      handling.delete(req);
      if (reply.raw.destroyed) release(req);
      return payload;
    });
    service.addHook("onError", async (req, reply) => {
      handling.delete(req);
      if (reply.raw.destroyed) release(req);
    });
    service.addHook("onTimeout", async (req) => {
      if (!handling.has(req)) release(req);
    });
  }
  const errors = (error: any, req: any, reply: any) => {
    reply.type("application/json").removeHeader("Content-Disposition");
    if (error instanceof ZodError)
      return reply.code(400).send({
        message: error.issues
          .map((i: any) => `${i.path.join(".")}: ${i.message}`)
          .join("；"),
      });
    const unavailable =
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "EPIPE",
        "ETIMEDOUT",
        "ENOSPC",
        "57P01",
        "57P02",
        "57P03",
        "57014",
        "53300",
        "08006",
        "08003",
        "25P03",
      ].includes(error.code) ||
      /connection terminated|timeout exceeded when trying to connect/i.test(
        error.message || "",
      );
    const status =
      error.statusCode ||
      (error.code === "23505" ? 409 : unavailable ? 503 : 500);
    if (status === 429 || status === 503)
      reply.header("Retry-After", status === 429 ? "60" : "2");
    if (status >= 500) req.log.error(error);
    reply.code(status).send({
      message: status >= 500 ? "服务暂时不可用，请稍后再试" : error.message,
      ...(error.authCode ? { code: error.authCode } : {}),
      requestId: req.id,
    });
  };
  app.setErrorHandler(errors);
  preview.setErrorHandler(errors);
  const identify = (req: FastifyRequest, admin = false) =>
    requireUser(auth, req, admin);
  async function own(req: FastifyRequest, id: string, tx = db) {
    const user = await identify(req);
    const w = (await tx.query("SELECT * FROM works WHERE id=$1", [id])).rows[0];
    if (!w || w.owner_id !== user.id) fail(404, "未找到你的作品");
    return { user, w };
  }
  async function assetOwnership(
    tx: DB,
    id: string | null,
    user: string,
    kind: string,
  ) {
    if (
      id &&
      !(
        await tx.query(
          "SELECT id FROM assets WHERE id=$1 AND owner_id=$2 AND kind=$3 FOR UPDATE",
          [id, user, kind],
        )
      ).rows.length
    )
      fail(400, "文件不存在或不属于当前用户");
  }
  async function completeCover(
    tx: DB,
    b: {
      htmlId: string | null;
      coverId: string | null;
      coverMode?: "auto" | "manual";
    },
    owner: string,
  ) {
    await assetOwnership(tx, b.htmlId, owner, "html");
    await assetOwnership(tx, b.coverId, owner, "cover");
    const generated =
      b.coverId &&
      (
        await tx.query(
          "SELECT html_id FROM generated_covers WHERE cover_id=$1",
          [b.coverId],
        )
      ).rows[0];
    if (
      b.htmlId &&
      (b.coverMode === "auto" ||
        !b.coverId ||
        (b.coverMode !== "manual" && generated))
    )
      b.coverId = (await covers.ensure(b.htmlId, owner, tx)).id;
    else if (b.coverMode === "auto") b.coverId = null;
  }
  async function fileTransaction<T>(fn: (tx: DB) => Promise<T>) {
    const provisional: string[] = [];
    try {
      return await db.transaction(async (tx) => {
        const guarded: DB = {
          ...tx,
          query: async (sql, args) => {
            const result = await tx.query(sql, args);
            if (sql.startsWith("INSERT INTO generated_covers") && args)
              provisional.push(args[1]);
            return result;
          },
        };
        return fn(guarded);
      });
    } catch (error) {
      for (const id of provisional)
        await covers
          .removeUncommitted(id)
          .catch((cleanup) => app.log.error(cleanup));
      throw error;
    }
  }
  async function workResult(tx: DB, id: string) {
    return selectFields(
      (await tx.query(`${targeted} WHERE w.id=$1`, [id])).rows[0],
      true,
    );
  }
  function privateToken(id: string, expiry: number) {
    return createHmac("sha256", previewSecret)
      .update(`${id}:${expiry}`)
      .digest("hex");
  }

  app.get("/api/v1/health", async () => {
    await db.query("SELECT 1");
    await cache.set("health", "ok", 5);
    return { ok: true };
  });
  app.get("/api/v1/auth/me", async (req) => ({
    user: await auth.currentUser(req),
  }));
  app.post("/api/v1/auth/login", async (req, reply) => ({
    user: await queuePasswordOperation(() => auth.login(req, reply)),
  }));
  app.post("/api/v1/auth/register", async (req, reply) => ({
    user: await queuePasswordOperation(() => auth.register(req, reply)),
  }));
  app.post("/api/v1/auth/logout", async (req, reply) => {
    if (req.headers["x-lark-user"]) await requireUser(auth, req);
    await auth.logout(req, reply);
    return { ok: true };
  });
  app.post("/api/v1/auth/password", async (req, reply) => {
    await queuePasswordOperation(() => auth.changePassword(req, reply));
    return { ok: true };
  });
  app.get("/api/v1/competition", async () => {
    const s = await settings(db);
    return {
      ...s,
      effectiveDailyLimit: limitFor(s, dayInBeijing(clock())),
      serverTime: clock().toISOString(),
    };
  });
  app.get("/api/v1/stats", async () =>
    cache.cached(
      `stats:${await cache.publicVersion()}`,
      config.listTtl,
      async () =>
        (
          await db.query(
            "SELECT (SELECT count(*)::integer FROM works WHERE status='approved') AS works, (SELECT count(*)::integer FROM votes WHERE valid) AS votes, (SELECT count(DISTINCT owner_id)::integer FROM works WHERE status='approved') AS creators",
          )
        ).rows[0],
    ),
  );
  app.get("/api/v1/works", async (req) => {
    const p = pagination.parse(req.query);
    return cache.cached(
      `works:${await cache.publicVersion()}:${JSON.stringify(p)}`,
      config.listTtl,
      async () => {
        const args = [p.track, `%${p.q.replace(/[\\%_]/g, "\\$&")}%`];
        const where =
          "WHERE w.status='approved' AND ($1='all' OR w.track=$1) AND (w.title ILIKE $2 OR w.number::text ILIKE $2)";
        const order =
          p.sort === "votes"
            ? "votes DESC,w.created_at DESC,w.id"
            : p.sort === "latest"
              ? "w.created_at DESC,w.id"
              : "w.recommended DESC,votes DESC,w.created_at DESC,w.id";
        const rows = (
          await db.query(
            `${p.q ? targeted : counted} ${where} ORDER BY ${order} LIMIT $3 OFFSET $4`,
            [...args, p.size, (p.page - 1) * p.size],
          )
        ).rows;
        const total = Number(
          (await db.query(`SELECT count(*) FROM works w ${where}`, args))
            .rows[0].count,
        );
        return {
          items: rows.map((w) => selectFields(w)),
          total,
          page: p.page,
          pages: Math.max(1, Math.ceil(total / p.size)),
        };
      },
    );
  });
  app.get("/api/v1/leaderboard", async (req) => {
    const p = pagination.parse(req.query);
    return cache.cached(
      `rank:${await cache.publicVersion()}:${p.track}:${p.page}:${p.size}`,
      config.rankTtl,
      async () => {
        const rows = (
          await db.query(
            `SELECT ranked.* FROM (SELECT w.*,rank() OVER(PARTITION BY track ORDER BY votes DESC)::integer AS rank FROM (${counted} WHERE w.status='approved') w) ranked WHERE ($1='all' OR track=$1) ORDER BY track,rank,number LIMIT $2 OFFSET $3`,
            [p.track, p.size, (p.page - 1) * p.size],
          )
        ).rows;
        const total = Number(
          (
            await db.query(
              "SELECT count(*) FROM works WHERE status='approved' AND ($1='all' OR track=$1)",
              [p.track],
            )
          ).rows[0].count,
        );
        return {
          items: rows.map((w) => ({ ...selectFields(w), rank: w.rank })),
          total,
          pages: Math.max(1, Math.ceil(total / p.size)),
          updatedAt: clock().toISOString(),
        };
      },
    );
  });
  app.get("/api/v1/me/works", async (req) => {
    const user = await identify(req);
    return {
      items: (
        await db.query(
          `${targeted} WHERE w.owner_id=$1 ORDER BY w.updated_at DESC LIMIT 200`,
          [user.id],
        )
      ).rows.map((w) => selectFields(w, true)),
    };
  });
  app.get("/api/v1/me/quota", async (req) => {
    const user = await identify(req);
    const day = dayInBeijing(clock());
    const s = await settings(db);
    const usage = (
      await db.query(
        "SELECT track,used FROM daily_quotas WHERE user_id=$1 AND day=$2",
        [user.id, day],
      )
    ).rows;
    return {
      day,
      limit: limitFor(s, day),
      classic: usage.find((r) => r.track === "classic")?.used || 0,
      open: usage.find((r) => r.track === "open")?.used || 0,
      votedIds: (
        await db.query(
          "SELECT work_id FROM votes WHERE user_id=$1 AND day=$2",
          [user.id, day],
        )
      ).rows.map((r) => r.work_id),
    };
  });
  app.get("/api/v1/works/:id", async (req) => {
    const id = uuid((req.params as any).id);
    const w = (await db.query(`${targeted} WHERE w.id=$1`, [id])).rows[0];
    const user = await auth.currentUser(req);
    if (
      !w ||
      (w.status !== "approved" &&
        w.owner_id !== user?.id &&
        user?.role !== "admin")
    )
      fail(404, "作品尚未公开或已撤回");
    const s = await settings(db);
    const result: any = selectFields(
      w,
      clock() > new Date(s.voteEnd) ||
        w.owner_id === user?.id ||
        user?.role === "admin",
    );
    if (w.html_id) {
      const expiry = Date.now() + 300000;
      result.previewUrl = `${config.previewOrigin}/preview/${w.html_id}${w.status === "approved" ? "" : `?expires=${expiry}&token=${privateToken(w.html_id, expiry)}`}`;
    }
    return result;
  });
  app.post("/api/v1/uploads", async (req, reply) => {
    const user = await identify(req);
    if (!(await cache.take(`upload:${user.id}`, config.uploadRate)))
      fail(429, "上传过于频繁，请稍后再试");
    if (activeUploads >= config.maxUploads)
      return reply
        .code(503)
        .header("Retry-After", "3")
        .send({ message: "上传队列繁忙，请稍后再试" });
    activeUploads++;
    uploading.add(req);
    let filenameInput = "",
      data: Buffer | undefined;
    for await (const part of req.parts()) {
      if (part.type !== "file" || data) fail(400, "每次请上传一个文件");
      filenameInput = part.filename;
      data = await part.toBuffer();
      if (part.file.truncated) fail(413, "HTML 最大 5MB");
    }
    if (!data) fail(400, "请选择文件");
    let kind: string, mime: string, extension: string;
    if (/\.html?$/i.test(filenameInput)) {
      await validateHtmlUpload(data);
      kind = "html";
      mime = "text/html";
      extension = "html";
    } else {
      if (data.length > 2 * 1024 * 1024) fail(413, "封面最大 2MB");
      try {
        const metadata = await sharp(data, {
          limitInputPixels: 16000000,
        }).metadata();
        if (!["jpeg", "png", "webp"].includes(metadata.format || ""))
          fail(400, "封面仅支持 JPEG、PNG、WebP");
        data = await sharp(data, { limitInputPixels: 16000000 })
          .rotate()
          .resize({
            width: 1200,
            height: 900,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82 })
          .toBuffer();
      } catch {
        fail(400, "图片内容无效、格式不支持或分辨率过大");
      }
      kind = "cover";
      mime = "image/webp";
      extension = "webp";
    }
    const id = randomUUID();
    const filename = `${id}.${extension}`;
    const destination = path.join(uploads, filename);
    let autoCover: AutoCover | undefined;
    try {
      await writeFile(destination, data, { flag: "wx" });
      await db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO assets(id,owner_id,kind,filename,mime,bytes,managed) VALUES($1,$2,$3,$4,$5,$6,true)",
          [id, user.id, kind, filename, mime, data.length],
        );
        if (kind === "html") autoCover = await covers.ensure(id, user.id, tx);
      });
    } catch (e: any) {
      if (e.code !== "EEXIST")
        await unlink(destination).catch((cleanupError) => {
          if (cleanupError.code !== "ENOENT")
            req.log.error(cleanupError, "Upload cleanup failed");
        });
      if (autoCover)
        await unlink(path.join(uploads, `${autoCover.id}.webp`)).catch(
          () => {},
        );
      req.log.error(e, "Upload persistence failed");
      return reply
        .code(503)
        .header("Retry-After", "2")
        .send({
          message:
            e.code === "ENOSPC"
              ? "上传存储空间不足，请稍后重试"
              : "上传素材保存失败，请稍后重试",
          requestId: req.id,
        });
    }
    if (options.startCoverWorker !== false) covers.kick();
    return {
      id,
      kind,
      bytes: data.length,
      ...(autoCover ? { autoCover } : {}),
    };
  });
  app.get("/api/v1/uploads/:id/cover", async (req) => {
    const user = await identify(req);
    const cover = await covers.status(uuid((req.params as any).id), user.id);
    if (!cover) fail(404, "自动封面不存在");
    return cover;
  });
  app.post("/api/v1/uploads/:id/cover/retry", async (req) => {
    const user = await identify(req);
    if (!(await cache.take(`cover-retry:${user.id}`, 10)))
      fail(429, "重新生成过于频繁，请稍后再试");
    return covers.retry(uuid((req.params as any).id), user.id);
  });
  app.post("/api/v1/works", async (req) => {
    const user = await identify(req);
    const b = workSchema.parse(req.body);
    const competition = await settings(db);
    checkWindow(competition, "submission", clock());
    b.prompt = competition.prompt;
    const id = randomUUID();
    return fileTransaction(async (tx) => {
      await completeCover(tx, b, user.id);
      const w = (
        await tx.query(
          "INSERT INTO works(id,owner_id,track,title,description,model,prompt,cover_id,html_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            id,
            user.id,
            b.track,
            b.title,
            b.description,
            b.model,
            b.prompt,
            b.coverId,
            b.htmlId,
          ],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO work_versions(work_id,version,snapshot) VALUES($1,1,$2)",
        [id, JSON.stringify(w)],
      );
      return workResult(tx, w.id);
    });
  });
  app.put("/api/v1/works/:id", async (req) => {
    const id = uuid((req.params as any).id);
    const b = workSchema
      .extend({ version: z.number().int().positive() })
      .parse(req.body);
    const user = await identify(req);
    const competition = await settings(db);
    checkWindow(competition, "submission", clock());
    b.prompt = competition.prompt;
    const result = await fileTransaction(async (tx) => {
      const w = (
        await tx.query(
          "SELECT * FROM works WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [id, user.id],
        )
      ).rows[0];
      if (!w) fail(404, "未找到你的作品");
      if (w.version !== b.version) fail(409, "作品已更新，请刷新后再编辑");
      if (
        w.track !== b.track &&
        (await tx.query("SELECT id FROM votes WHERE work_id=$1 LIMIT 1", [id]))
          .rows.length
      )
        fail(409, "已有投票的作品不能更换赛道");
      await completeCover(tx, b, user.id);
      if (w.status === "approved" && !b.htmlId)
        fail(409, "公开作品需要 HTML 文件");
      const result = (
        await tx.query(
          "UPDATE works SET track=$2,title=$3,description=$4,model=$5,prompt=$6,cover_id=$7,html_id=$8,status=CASE WHEN status='approved' THEN 'approved' ELSE 'draft' END,reason='',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [
            id,
            b.track,
            b.title,
            b.description,
            b.model,
            b.prompt,
            b.coverId,
            b.htmlId,
          ],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO work_versions(work_id,version,snapshot) VALUES($1,$2,$3)",
        [id, result.version, JSON.stringify(result)],
      );
      return workResult(tx, result.id);
    });
    await cache.invalidatePublic().catch((error) => req.log.error(error));
    return result;
  });
  app.post("/api/v1/works/:id/submit", async (req) => {
    const id = uuid((req.params as any).id);
    const user = await identify(req);
    checkWindow(await settings(db), "submission", clock());
    const result = await fileTransaction(async (tx) => {
      const w = (
        await tx.query(
          "SELECT * FROM works WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [id, user.id],
        )
      ).rows[0];
      if (!w) fail(404, "未找到你的作品");
      if (!w.html_id) fail(409, "发布作品前，请上传 HTML 文件");
      const files = { htmlId: w.html_id, coverId: w.cover_id };
      await completeCover(tx, files, user.id);
      await tx.query(
        "UPDATE works SET status='approved',reason='',cover_id=$2,updated_at=now() WHERE id=$1",
        [id, files.coverId],
      );
      if (w.status !== "approved")
        await audit(tx, user.id, "work.publish", id, { version: w.version });
      return workResult(tx, id);
    });
    await cache.invalidatePublic().catch((error) => req.log.error(error));
    if (options.startCoverWorker !== false) covers.kick();
    return result;
  });
  app.post("/api/v1/works/:id/withdraw", async (req) => {
    const id = uuid((req.params as any).id);
    const { user } = await own(req, id);
    await db.query(
      "UPDATE works SET status='withdrawn',recommended=false,updated_at=now() WHERE id=$1 AND owner_id=$2",
      [id, user.id],
    );
    await cache.invalidatePublic().catch((error) => req.log.error(error));
    return { ok: true };
  });
  app.post("/api/v1/works/:id/votes", async (req) => {
    const user = await identify(req);
    if (!(await cache.take(`vote:${user.id}`, config.voteRate)))
      fail(429, "投票过于频繁，请稍后再试");
    const id = uuid((req.params as any).id);
    const key = uuid(req.headers["idempotency-key"]);
    return castVote(db, user.id, id, key, clock());
  });

  app.get("/media/:id", async (req, reply) => {
    const id = uuid((req.params as any).id);
    const a = (
      await db.query(
        "SELECT a.* FROM assets a WHERE a.id=$1 AND a.kind='cover'",
        [id],
      )
    ).rows[0];
    if (!a) fail(404, "图片不存在");
    const publicWork = (
      await db.query(
        "SELECT id FROM works WHERE cover_id=$1 AND status='approved' LIMIT 1",
        [id],
      )
    ).rows.length;
    if (!publicWork) {
      const u = await identify(req);
      if (u.id !== a.owner_id && u.role !== "admin") fail(404, "图片不存在");
    }
    return reply
      .type(a.mime)
      .header(
        "Cache-Control",
        publicWork ? "public, max-age=60" : "private, no-store",
      )
      .send(createReadStream(path.join(uploads, a.filename)));
  });
  preview.addHook("onRequest", async (_req, reply) => {
    if (inflight >= config.maxInflight || activePreviews >= config.maxPreviews)
      return reply
        .code(503)
        .header("Retry-After", "2")
        .send({ message: "服务器繁忙，请稍后再试" });
    inflight++;
    active.add(_req);
    activePreviews++;
    previewing.add(_req);
    const disconnected = () => {
      if (!handling.has(_req)) release(_req);
    };
    _req.raw.once("aborted", disconnected);
    reply.raw.once("close", disconnected);
    reply
      .header("Content-Security-Policy", previewPolicy(config.appOrigin))
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      )
      .header("Cache-Control", "no-store");
    if (!(await takeBudget(_req, reply, `preview:${_req.ip}`, 120)))
      fail(429, "预览请求过于频繁");
  });
  preview.get("/preview/:id", async (req, reply) => {
    const id = uuid((req.params as any).id);
    const a = (
      await db.query("SELECT a.* FROM assets a WHERE a.id=$1 AND kind='html'", [
        id,
      ])
    ).rows[0];
    if (!a) fail(404, "作品文件不存在");
    const approved = (
      await db.query(
        "SELECT id FROM works WHERE html_id=$1 AND status='approved' LIMIT 1",
        [id],
      )
    ).rows.length;
    if (!approved) {
      const q = req.query as any;
      const expiry = Number(q.expires);
      const supplied = String(q.token || "");
      const expected = privateToken(id, expiry);
      if (
        !Number.isFinite(expiry) ||
        expiry < Date.now() ||
        expiry > Date.now() + 300001 ||
        supplied.length !== expected.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
      )
        fail(404, "作品未公开或预览链接已过期");
    }
    return reply
      .type("text/html; charset=utf-8")
      .send(createReadStream(path.join(uploads, a.filename)));
  });
  app.get("/api/v1/admin/overview", async (req) => {
    await identify(req, true);
    return {
      ...(
        await db.query(
          "SELECT (SELECT count(*)::integer FROM works WHERE status='approved') AS published,(SELECT count(*)::integer FROM users) AS users,(SELECT count(*)::integer FROM votes WHERE valid) AS votes,(SELECT count(*)::integer FROM works) AS works",
        )
      ).rows[0],
      inflight,
      activeUploads,
      maxInflight: config.maxInflight,
      maxUploads: config.maxUploads,
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      cpu: process.cpuUsage(),
      uptimeSeconds: process.uptime(),
      covers: await covers.metrics(),
    };
  });
  app.get("/api/v1/admin/works", async (req) => {
    await identify(req, true);
    const p = pagination.parse(req.query);
    const state = z
      .enum(["all", "approved", "draft", "withdrawn"])
      .parse((req.query as any).status || "all");
    const rows = (
      await db.query(
        `${targeted} WHERE ($1='all' OR w.status=$1) ORDER BY w.updated_at DESC LIMIT $2 OFFSET $3`,
        [state, p.size, (p.page - 1) * p.size],
      )
    ).rows;
    const total = Number(
      (
        await db.query(
          "SELECT count(*) FROM works WHERE ($1='all' OR status=$1)",
          [state],
        )
      ).rows[0].count,
    );
    return {
      items: rows.map((w) => selectFields(w, true)),
      total,
      pages: Math.max(1, Math.ceil(total / p.size)),
    };
  });
  app.patch("/api/v1/admin/works/:id", async (req) => {
    const user = await identify(req, true);
    const id = uuid((req.params as any).id);
    const b = z
      .object({
        recommended: z.boolean().optional(),
        withdraw: z.boolean().optional(),
        reason: z.string().trim().max(1000).optional(),
      })
      .parse(req.body);
    const result = await db.transaction(async (tx) => {
      const w = (
        await tx.query("SELECT * FROM works WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!w) fail(404, "作品不存在");
      if (b.withdraw && !b.reason) fail(400, "下架需填写原因");
      if (b.recommended && w.status !== "approved")
        fail(409, "只能推荐公开作品");
      await tx.query(
        "UPDATE works SET recommended=$2,status=$3,reason=$4,updated_at=now() WHERE id=$1",
        [
          id,
          b.withdraw ? false : (b.recommended ?? w.recommended),
          b.withdraw ? "withdrawn" : w.status,
          b.withdraw ? b.reason : w.reason,
        ],
      );
      await audit(tx, user.id, "work.update", id, b);
      return { ok: true };
    });
    await cache.invalidatePublic().catch((error) => req.log.error(error));
    return result;
  });
  app.put("/api/v1/admin/competition", async (req) => {
    const user = await identify(req, true);
    const b = settingsSchema.parse(req.body);
    return db.transaction(async (tx) => {
      const old = (
        await tx.query("SELECT data FROM competition WHERE id=1 FOR UPDATE")
      ).rows[0].data;
      const current = limitFor(old, dayInBeijing(clock()));
      const updated = {
        ...b,
        dailyLimit: current,
        nextDailyLimit: b.dailyLimit,
        limitEffectiveDate: nextDay(clock()),
      };
      await tx.query("UPDATE competition SET data=$1 WHERE id=1", [
        JSON.stringify(updated),
      ]);
      await audit(tx, user.id, "competition.update", "1", {
        before: old,
        after: updated,
      });
      return updated;
    });
  });
  app.get("/api/v1/admin/users", async (req) => {
    await identify(req, true);
    const p = pagination.parse(req.query);
    const total = Number(
      (await db.query("SELECT count(*) FROM users")).rows[0].count,
    );
    return {
      items: (
        await db.query(
          "SELECT u.id,u.name,u.role,u.status,u.created_at,i.subject AS username FROM users u LEFT JOIN auth_identities i ON i.user_id=u.id AND i.provider='local' ORDER BY u.created_at DESC LIMIT $1 OFFSET $2",
          [p.size, (p.page - 1) * p.size],
        )
      ).rows,
      total,
      pages: Math.max(1, Math.ceil(total / p.size)),
    };
  });
  app.patch("/api/v1/admin/users/:id", async (req) => {
    const actor = await identify(req, true);
    const id = z
      .string()
      .max(48)
      .parse((req.params as any).id);
    const b = z
      .object({ status: z.enum(["active", "disabled"]) })
      .parse(req.body);
    if (id === actor.id) fail(409, "不能停用当前管理员");
    return db.transaction(async (tx) => {
      const r = await tx.query(
        "UPDATE users SET status=$2 WHERE id=$1 RETURNING id",
        [id, b.status],
      );
      if (!r.rows.length) fail(404, "用户不存在");
      if (b.status === "disabled")
        await tx.query("DELETE FROM auth_sessions WHERE user_id=$1", [id]);
      await audit(tx, actor.id, "user.status", id, b);
      return { ok: true };
    });
  });
  app.get("/api/v1/admin/votes", async (req) => {
    await identify(req, true);
    const p = pagination.parse(req.query);
    const total = Number(
      (await db.query("SELECT count(*) FROM votes")).rows[0].count,
    );
    return {
      items: (
        await db.query(
          "SELECT v.*,w.title FROM votes v JOIN works w ON w.id=v.work_id ORDER BY v.created_at DESC LIMIT $1 OFFSET $2",
          [p.size, (p.page - 1) * p.size],
        )
      ).rows,
      total,
      pages: Math.max(1, Math.ceil(total / p.size)),
    };
  });
  app.post("/api/v1/admin/votes/:id/void", async (req) => {
    const actor = await identify(req, true);
    const id = uuid((req.params as any).id);
    const b = z
      .object({ reason: z.string().trim().min(1).max(1000) })
      .parse(req.body);
    return db.transaction(async (tx) => {
      const r = await tx.query(
        "UPDATE votes SET valid=false,void_reason=$2 WHERE id=$1 AND valid RETURNING id",
        [id, b.reason],
      );
      if (!r.rows.length) fail(409, "记录不存在或已经作废");
      await audit(tx, actor.id, "vote.void", id, b);
      return { ok: true };
    });
  });
  app.get("/api/v1/admin/audit", async (req) => {
    await identify(req, true);
    const p = pagination.parse(req.query);
    const total = Number(
      (await db.query("SELECT count(*) FROM audit_logs")).rows[0].count,
    );
    return {
      items: (
        await db.query(
          "SELECT * FROM audit_logs ORDER BY id DESC LIMIT $1 OFFSET $2",
          [p.size, (p.page - 1) * p.size],
        )
      ).rows,
      total,
      pages: Math.max(1, Math.ceil(total / p.size)),
    };
  });
  app.get("/api/v1/admin/export/:kind", async (req, reply) => {
    const user = await identify(req, true);
    const kind = z.enum(["works", "votes"]).parse((req.params as any).kind);
    if (!(await cache.take(`export:${user.id}`, 2))) fail(429, "导出过于频繁");
    await audit(db, user.id, "export", kind);
    const escape = (v: unknown) =>
      `"${String(v ?? "")
        .replace(/^[=+@\-\t\r]/, "'$&")
        .replace(/"/g, '""')}"`;
    async function* rows() {
      if (activeExports >= 1) fail(503, "已有导出正在处理，请稍后再试");
      activeExports++;
      try {
        let first = true;
        const sql =
          kind === "works"
            ? `${counted} ORDER BY w.number`
            : "SELECT * FROM votes ORDER BY created_at,id";
        const batches = db.iterate
          ? db.iterate(sql)
          : (async function* () {
              yield (await db.query(sql)).rows;
            })();
        for await (const r of batches) {
          if (!r.length) continue;
          if (first) {
            yield "\uFEFF" + Object.keys(r[0]).map(escape).join(",") + "\r\n";
            first = false;
          }
          for (const row of r)
            yield Object.values(row).map(escape).join(",") + "\r\n";
        }
        if (first) yield "\uFEFF";
      } finally {
        activeExports--;
      }
    }
    return reply
      .header("Content-Disposition", `attachment; filename="${kind}.csv"`)
      .type("text/csv; charset=utf-8")
      .send(Readable.from(rows()));
  });
  return {
    app,
    preview,
    cache,
    covers,
    metrics: () => ({ inflight, activeUploads, activePreviews, activeExports }),
    close: async () => {
      await app.close();
      await preview.close();
      await cache.close();
    },
  };
}
