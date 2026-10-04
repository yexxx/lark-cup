import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { config } from "./config.js";
import { mkdir } from "node:fs/promises";
export interface DB {
  query<T = any>(
    sql: string,
    args?: any[],
  ): Promise<{ rows: T[]; rowCount: number }>;
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T>;
  iterate?(sql: string): AsyncIterable<any[]>;
  close(): Promise<void>;
}
export async function openDB(options: { memory?: boolean } = {}): Promise<DB> {
  if (config.databaseUrl && !options.memory) {
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.poolMax,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      statement_timeout: 10000,
      idle_in_transaction_session_timeout: 15000,
    });
    pool.on("error", (error) => {
      console.error("PostgreSQL idle connection error:", error.message);
    });
    const wrap = (client: any): DB => ({
      query: async (sql, args) => {
        const r = await client.query(sql, args);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      },
      transaction: async (fn) => {
        const c = await pool.connect();
        let connectionError: Error | undefined;
        const onError = (error: Error) => {
          connectionError = error;
          console.error("PostgreSQL borrowed connection error:", error.message);
        };
        c.on("error", onError);
        try {
          await c.query("BEGIN");
          const result = await fn(wrap(c));
          await c.query("COMMIT");
          return result;
        } catch (e) {
          await c.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          c.removeListener("error", onError);
          c.release(connectionError);
        }
      },
      async *iterate(sql) {
        const client = await pool.connect();
        let connectionError: Error | undefined;
        const onError = (error: Error) => {
          connectionError = error;
          console.error("PostgreSQL export connection error:", error.message);
        };
        client.on("error", onError);
        let committed = false;
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          await client.query(`DECLARE export_rows NO SCROLL CURSOR FOR ${sql}`);
          while (true) {
            const result = await client.query("FETCH 500 FROM export_rows");
            if (!result.rows.length) break;
            yield result.rows;
          }
          await client.query("COMMIT");
          committed = true;
        } finally {
          if (!committed) await client.query("ROLLBACK").catch(() => {});
          client.removeListener("error", onError);
          client.release(connectionError);
        }
      },
      close: () => pool.end(),
    });
    return wrap(pool);
  }
  if (process.env.NODE_ENV === "production" && !options.memory)
    throw new Error("DATABASE_URL is required in production");
  if (!options.memory)
    await mkdir(config.localDatabaseDir, { recursive: true });
  const pg = new PGlite(options.memory ? undefined : config.localDatabaseDir);
  await pg.waitReady;
  const wrap = (client: any): DB => ({
    query: async (sql, args) => {
      const r = await client.query(sql, args);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    async *iterate(sql) {
      const rows = (await client.query(sql)).rows;
      for (let i = 0; i < rows.length; i += 500) yield rows.slice(i, i + 500);
    },
    close: () => pg.close(),
  });
  return wrap(pg);
}
