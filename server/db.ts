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
    const wrap = (client: any): DB => ({
      query: async (sql, args) => {
        const r = await client.query(sql, args);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      },
      transaction: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const result = await fn(wrap(c));
          await c.query("COMMIT");
          return result;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    });
    return wrap(pool);
  }
  if (process.env.NODE_ENV === "production" && !options.memory)
    throw new Error("DATABASE_URL is required in production");
  if (!options.memory) await mkdir(".local", { recursive: true });
  const pg = new PGlite(options.memory ? undefined : ".local/postgres");
  await pg.waitReady;
  const wrap = (client: any): DB => ({
    query: async (sql, args) => {
      const r = await client.query(sql, args);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  });
  return wrap(pg);
}
