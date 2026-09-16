import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { openDB, type DB } from "./db.js";
import { migrate } from "./migrate.js";
import { castVote, settings } from "./domain.js";
import { config } from "./config.js";
import { demoDesigns, demoSvg, demoHtml } from "./demo-art.js";
export async function seed(db: DB, uploads = config.uploads) {
  await mkdir(uploads, { recursive: true });
  await db.query(
    "INSERT INTO users(id,name,role) VALUES('demo-creator','百灵鸟创作实验室','user'),('admin','赛事管理员','admin') ON CONFLICT DO NOTHING",
  );
  const existing = (
    await db.query(
      "SELECT * FROM works WHERE owner_id='demo-creator' ORDER BY number",
    )
  ).rows;
  const s = await settings(db);
  const ids: string[] = [];
  for (let i = 0; i < demoDesigns.length; i++) {
    const design = demoDesigns[i];
    const previous = existing[i];
    const id = previous?.id || randomUUID(),
      cover = previous?.cover_id || randomUUID(),
      html = previous?.html_id || randomUUID();
    ids.push(id);
    const coverBytes = await sharp(Buffer.from(demoSvg(design, false)))
      .webp({ quality: 90 })
      .toBuffer();
    const htmlText = demoHtml(design);
    await writeFile(path.join(uploads, `${cover}.webp`), coverBytes);
    await writeFile(path.join(uploads, `${html}.html`), htmlText);
    await db.transaction(async (tx) => {
      for (const [assetId, kind, filename, mime, bytes] of [
        [cover, "cover", `${cover}.webp`, "image/webp", coverBytes.length],
        [
          html,
          "html",
          `${html}.html`,
          "text/html",
          Buffer.byteLength(htmlText),
        ],
      ])
        await tx.query(
          "INSERT INTO assets(id,owner_id,kind,filename,mime,bytes) VALUES($1,'demo-creator',$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET bytes=EXCLUDED.bytes",
          [assetId, kind, filename, mime, bytes],
        );
      const w = (
        await tx.query(
          "INSERT INTO works(id,owner_id,track,title,description,model,prompt,cover_id,html_id,status,recommended) VALUES($1,'demo-creator','classic',$2,$3,$4,$5,$6,$7,'approved',$8) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,model=EXCLUDED.model,prompt=EXCLUDED.prompt,version=works.version+1,updated_at=now() RETURNING *",
          [
            id,
            design.title,
            "本地示例作品：百灵鸟、翅膀、天空和音符均使用 SVG 矢量元素绘制。打开作品可观看振翅飞行动画、暂停飞行或点击听鸟鸣。封面直接从同一份 SVG 生成。",
            "SVG Motion Study",
            s.prompt,
            cover,
            html,
            i === 0 || i === 2,
          ],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO work_versions(work_id,version,snapshot) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [id, w.version, JSON.stringify(w)],
      );
    });
  }
  for (let n = 1; n <= 12; n++) {
    const user = `demo-voter-${n}`;
    await db.query(
      "INSERT INTO users(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [user, `示例观众 ${n}`],
    );
    for (let i = 0; i < ids.length; i++)
      if (
        (n + i) % 3 !== 0 &&
        !(
          await db.query(
            "SELECT id FROM votes WHERE user_id=$1 AND work_id=$2 AND day='2026-09-16'",
            [user, ids[i]],
          )
        ).rows.length
      )
        await castVote(
          db,
          user,
          ids[i],
          randomUUID(),
          new Date("2026-09-16T10:00:00+08:00"),
        );
  }
  console.log(
    "Seeded 8 native SVG animation demos inside HTML; covers rendered from the same SVG. Existing votes retained.",
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await openDB();
  try {
    await migrate(db);
    await seed(db);
  } finally {
    await db.close();
  }
}
