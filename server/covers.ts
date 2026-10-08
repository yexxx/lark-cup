import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink, readdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { DB } from "./db.js";
import { config } from "./config.js";
import { fail } from "./domain.js";

export type AutoCover = {
  id: string;
  url: string;
  status: "pending" | "ready" | "fallback";
};
export type CoverRenderer = (
  html: Buffer,
  signal: AbortSignal,
) => Promise<Buffer>;
export const coverUrl = (id: string, revision = 1) =>
  `/media/${id}?v=${revision}`;
export async function placeholderCover() {
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="860" viewBox="0 0 1200 860"><rect width="1200" height="860" fill="#e4ecd6"/><circle cx="600" cy="395" r="180" fill="#c9dc9e"/><path d="M390 450Q490 240 660 325Q800 365 770 480Q650 570 500 480L390 520Z" fill="#355b45"/><path d="M550 390Q520 290 400 270Q430 400 550 440" fill="#a77546"/><circle cx="695" cy="365" r="12" fill="#f3e4bc"/><path d="M768 370L835 395L770 410" fill="#e0a454"/><path d="M535 480L520 555M635 490L650 555" stroke="#355b45" stroke-width="12"/><text x="600" y="675" text-anchor="middle" fill="#355b45" font-family="sans-serif" font-size="36">HTML + SVG</text></svg>`,
    ),
  )
    .webp({ quality: 82 })
    .toBuffer();
}

export const remoteRenderer: CoverRenderer = async (html, signal) => {
  const response = await fetch(`${config.rendererUrl}/render`, {
    method: "POST",
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: new Uint8Array(html),
    signal,
  });
  if (!response.ok)
    throw Object.assign(new Error(`Renderer returned ${response.status}`), {
      transient: response.status >= 500 || response.status === 429,
    });
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 2 * 1024 * 1024)
    throw new Error("Rendered cover is too large");
  return data;
};

export class CoverService {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<boolean>;
  private controller?: AbortController;
  private stopped = false;
  private lastCleanup = 0;
  constructor(
    private db: DB,
    private uploads: string,
    private render: CoverRenderer = remoteRenderer,
    private log: (error: unknown) => void = () => {},
    private now = () => new Date(),
    private changed = async () => {},
  ) {}

  start() {
    this.timer = setInterval(() => this.kick(), 2000);
    this.timer.unref();
    this.kick();
  }
  kick() {
    if (this.stopped || this.running) return;
    void this.runOnce().catch(this.log);
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller?.abort();
    await this.running?.catch(this.log);
  }

  async status(
    htmlId: string,
    owner: string,
    tx = this.db,
  ): Promise<AutoCover | null> {
    const row = (
      await tx.query(
        `SELECT j.cover_id,j.status,a.revision FROM generated_covers j JOIN assets h ON h.id=j.html_id JOIN assets a ON a.id=j.cover_id WHERE j.html_id=$1 AND h.owner_id=$2`,
        [htmlId, owner],
      )
    ).rows[0];
    return row
      ? {
          id: row.cover_id,
          url: coverUrl(row.cover_id, row.revision),
          status: row.status === "rendering" ? "pending" : row.status,
        }
      : null;
  }

  async removeUncommitted(id: string) {
    if (
      !(await this.db.query("SELECT id FROM assets WHERE id=$1", [id])).rows
        .length
    )
      await unlink(path.join(this.uploads, `${id}.webp`)).catch(this.log);
  }

  async ensure(htmlId: string, owner: string, tx: DB): Promise<AutoCover> {
    // Lock the source asset before creating its one-to-one cover or binding a work.
    const html = (
      await tx.query(
        "SELECT id FROM assets WHERE id=$1 AND owner_id=$2 AND kind='html' FOR UPDATE",
        [htmlId, owner],
      )
    ).rows[0];
    if (!html) fail(400, "HTML 文件不存在或不属于当前用户");
    const existing = await this.status(htmlId, owner, tx);
    if (existing) return existing;
    const id = randomUUID(),
      filename = `${id}.webp`;
    const image = await placeholderCover();
    await writeFile(path.join(this.uploads, filename), image, { flag: "wx" });
    try {
      await tx.query(
        "INSERT INTO assets(id,owner_id,kind,filename,mime,bytes,managed) VALUES($1,$2,'cover',$3,'image/webp',$4,true)",
        [id, owner, filename, image.length],
      );
      await tx.query(
        "INSERT INTO generated_covers(html_id,cover_id) VALUES($1,$2)",
        [htmlId, id],
      );
    } catch (error) {
      await unlink(path.join(this.uploads, filename)).catch(this.log);
      throw error;
    }
    return { id, url: coverUrl(id), status: "pending" };
  }

  async retry(htmlId: string, owner: string) {
    const result = await this.db.transaction(async (tx) => {
      const cover = await this.status(htmlId, owner, tx);
      if (!cover) {
        const html = (
          await tx.query(
            "SELECT id FROM assets WHERE id=$1 AND owner_id=$2 AND kind='html' FOR UPDATE",
            [htmlId, owner],
          )
        ).rows[0];
        if (!html) fail(404, "自动封面不存在");
        return this.ensure(htmlId, owner, tx);
      }
      await tx.query(
        "UPDATE generated_covers SET status='pending',failures=0,retries=0,next_attempt_at=$2,last_error='',updated_at=$2 WHERE html_id=$1 AND status IN ('fallback','ready') AND lease_token IS NULL",
        [htmlId, this.now()],
      );
      return (await this.status(htmlId, owner, tx))!;
    });
    this.kick();
    return result;
  }

  async metrics() {
    const rows = (
      await this.db.query(
        "SELECT status,count(*)::integer AS count FROM generated_covers GROUP BY status",
      )
    ).rows;
    const result = { pending: 0, active: 0, ready: 0, fallback: 0 };
    for (const row of rows) {
      const key =
        row.status === "rendering"
          ? "active"
          : (row.status as keyof typeof result);
      result[key as keyof typeof result] = Number(row.count);
    }
    return result;
  }

  runOnce(): Promise<boolean> {
    if (this.running) return this.running;
    if (this.stopped) return Promise.resolve(false);
    this.running = this.process().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async process() {
    const now = this.now();
    if (now.getTime() - this.lastCleanup > 300000) {
      this.lastCleanup = now.getTime();
      await this.cleanup();
    }
    const job = await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(71422027)");
      if (
        (
          await tx.query(
            "SELECT html_id FROM generated_covers WHERE status='rendering' AND lease_until>$1 LIMIT 1",
            [now],
          )
        ).rows.length
      )
        return null;
      const row = (
        await tx.query(
          `SELECT j.*,h.filename AS html_filename FROM generated_covers j JOIN assets h ON h.id=j.html_id WHERE (j.status IN ('pending','fallback') AND j.next_attempt_at<=$1 AND j.failures<3) OR (j.status='rendering' AND j.lease_until<=$1) ORDER BY j.next_attempt_at LIMIT 1 FOR UPDATE OF j`,
          [now],
        )
      ).rows[0];
      if (!row) return null;
      row.lease_token = randomUUID();
      await tx.query(
        "UPDATE generated_covers SET status='rendering',lease_token=$2,lease_until=$3,updated_at=$4 WHERE html_id=$1",
        [
          row.html_id,
          row.lease_token,
          new Date(now.getTime() + config.coverTimeout + 15000),
          now,
        ],
      );
      return row;
    });
    if (!job) return false;
    const controller = (this.controller = new AbortController());
    const timer = setTimeout(
      () => controller.abort(),
      config.coverTimeout + 1000,
    );
    let destination: string | undefined;
    try {
      const source = await readFile(path.join(this.uploads, job.html_filename));
      const result = await this.render(source, controller.signal);
      const image = await sharp(result, { limitInputPixels: 16000000 })
        .resize(1200, 860, { fit: "cover" })
        .webp({ quality: 82 })
        .toBuffer();
      const filename = `${randomUUID()}.webp`;
      destination = path.join(this.uploads, filename);
      await writeFile(destination, image, { flag: "wx" });
      const previous = await this.db.transaction(async (tx) => {
        const current = (
          await tx.query(
            "SELECT lease_token FROM generated_covers WHERE html_id=$1 FOR UPDATE",
            [job.html_id],
          )
        ).rows[0];
        if (current?.lease_token !== job.lease_token)
          throw new Error("Cover generation lease changed");
        const asset = (
          await tx.query("SELECT filename FROM assets WHERE id=$1 FOR UPDATE", [
            job.cover_id,
          ])
        ).rows[0];
        await tx.query(
          "UPDATE assets SET filename=$2,bytes=$3,revision=revision+1 WHERE id=$1",
          [job.cover_id, filename, image.length],
        );
        await tx.query(
          "UPDATE generated_covers SET status='ready',lease_token=NULL,lease_until=NULL,last_error='',updated_at=$2 WHERE html_id=$1",
          [job.html_id, this.now()],
        );
        return asset.filename;
      });
      destination = undefined;
      await unlink(path.join(this.uploads, previous)).catch(this.log);
      await this.changed().catch(this.log);
    } catch (error: any) {
      if (destination) await unlink(destination).catch(this.log);
      const transient =
        this.stopped ||
        error.transient ||
        error.name === "AbortError" ||
        error.cause?.code ||
        error.code === "ECONNREFUSED";
      const retries = job.retries + 1;
      await this.db.query(
        "UPDATE generated_covers SET status=CASE WHEN failures+$3>=3 THEN 'fallback' ELSE 'pending' END,failures=failures+$3,retries=retries+1,next_attempt_at=$4,lease_token=NULL,lease_until=NULL,last_error=$5,updated_at=$6 WHERE html_id=$1 AND lease_token=$2",
        [
          job.html_id,
          job.lease_token,
          transient ? 0 : 1,
          new Date(
            this.now().getTime() +
              Math.min(600000, 2000 * 2 ** Math.min(retries, 9)),
          ),
          String(error.message).slice(0, 1000),
          this.now(),
        ],
      );
      this.log(error);
    } finally {
      clearTimeout(timer);
      this.controller = undefined;
    }
    return true;
  }

  async cleanup() {
    const files = await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(71422028)");
      const candidates = (
        await tx.query(
          `SELECT a.id,a.filename FROM assets a WHERE a.managed AND a.created_at<$1 AND NOT EXISTS (SELECT 1 FROM works w WHERE w.html_id=a.id OR w.cover_id=a.id) AND NOT EXISTS (SELECT 1 FROM work_versions v WHERE v.snapshot->>'html_id'=a.id::text OR v.snapshot->>'cover_id'=a.id::text) AND NOT EXISTS (SELECT 1 FROM generated_covers j WHERE j.cover_id=a.id OR (j.html_id=a.id AND j.status='rendering' AND j.lease_until>$2)) ORDER BY a.created_at LIMIT 100 FOR UPDATE OF a`,
          [new Date(this.now().getTime() - 86400000), this.now()],
        )
      ).rows;
      const removed: string[] = [];
      for (const asset of candidates) {
        const job = (
          await tx.query(
            "SELECT cover_id FROM generated_covers WHERE html_id=$1 FOR UPDATE",
            [asset.id],
          )
        ).rows[0];
        if (job) {
          if (
            (
              await tx.query(
                `SELECT 1 FROM works WHERE cover_id=$1 UNION ALL SELECT 1 FROM work_versions WHERE snapshot->>'cover_id'=$1::text LIMIT 1`,
                [job.cover_id],
              )
            ).rows.length
          )
            continue;
          const cover = (
            await tx.query(
              "SELECT filename FROM assets WHERE id=$1 FOR UPDATE",
              [job.cover_id],
            )
          ).rows[0];
          await tx.query("DELETE FROM generated_covers WHERE html_id=$1", [
            asset.id,
          ]);
          await tx.query("DELETE FROM assets WHERE id=$1", [job.cover_id]);
          removed.push(cover.filename);
        }
        await tx.query("DELETE FROM assets WHERE id=$1", [asset.id]);
        removed.push(asset.filename);
      }
      return removed;
    });
    for (const file of files)
      await unlink(path.join(this.uploads, file)).catch(this.log);
    // Reconcile files left by a terminated upload or an interrupted cover revision.
    const retained = new Set(
      (await this.db.query("SELECT filename FROM assets")).rows.map(
        (row) => row.filename,
      ),
    );
    for (const file of await readdir(this.uploads)) {
      if (!/^[a-f0-9-]+\.(html|webp)$/.test(file) || retained.has(file))
        continue;
      const filename = path.join(this.uploads, file);
      const info = await stat(filename).catch(() => null);
      if (info && info.mtimeMs < this.now().getTime() - 86400000)
        await unlink(filename).catch(this.log);
    }
    return files.length;
  }
}
