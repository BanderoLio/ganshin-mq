import pg from "pg";
import type { Pool } from "pg";
import { config } from "./config.js";
import * as metrics from "./metrics.js";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
  }
  return pool;
}

export async function initDb(): Promise<void> {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** Полная очистка таблицы перед повторным сидом (одинаковое начальное состояние для каждого прогона). */
export async function truncateItems(): Promise<void> {
  await getPool().query("TRUNCATE items");
}

export async function dbGet(id: string): Promise<{ value: string; updated_at: string } | null> {
  metrics.incDbRead();
  const r = await getPool().query<{ value: string; updated_at: string }>(
    `SELECT value, updated_at::text AS updated_at FROM items WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function dbUpsert(id: string, value: string): Promise<void> {
  metrics.incDbWrite();
  await getPool().query(
    `INSERT INTO items (id, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [id, value],
  );
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
