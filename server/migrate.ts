import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openDB, type DB } from "./db.js";
export async function migrate(db: DB) {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const root = new URL("./migrations/", import.meta.url);
  for (const file of (await readdir(root))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(71422026)");
      if (
        (
          await tx.query("SELECT name FROM schema_migrations WHERE name=$1", [
            file,
          ])
        ).rows.length
      )
        return;
      const sql = await readFile(new URL(file, root), "utf8");
      // Migrations contain plain SQL statements, no procedural function bodies.
      for (const statement of sql.split(";").filter((s) => s.trim()))
        await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations(name) VALUES($1)", [file]);
    });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await openDB();
  try {
    await migrate(db);
    console.log("Migrations applied");
  } finally {
    await db.close();
  }
}
