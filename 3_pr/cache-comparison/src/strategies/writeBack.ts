import { dbGet, dbUpsert } from "../db.js";
import { cacheKey, DIRTY_SET, getRedis } from "../redis.js";
import { config } from "../config.js";
import * as metrics from "../metrics.js";
import type { CacheStrategy } from "./types.js";

let flushTimer: ReturnType<typeof setInterval> | null = null;

async function flushDirtyBatch(): Promise<void> {
  const r = getRedis();
  const batch = config.writeBackFlushBatch;
  const ids: string[] = [];
  for (let i = 0; i < batch; i++) {
    const raw = await r.spop(DIRTY_SET);
    if (raw === null) break;
    ids.push(String(raw));
  }
  if (ids.length === 0) return;

  for (const id of ids) {
    const v = await r.get(cacheKey(id));
    if (v !== null) await dbUpsert(id, v);
  }
  metrics.incFlushRun();
  metrics.addKeysFlushed(ids.length);
  const remaining = await r.scard(DIRTY_SET);
  metrics.setDirtyCurrent(remaining);
}

export const writeBackStrategy: CacheStrategy = {
  name: "write-back",

  async get(id: string) {
    const r = getRedis();
    const cached = await r.get(cacheKey(id));
    if (cached !== null) {
      metrics.incCacheHit();
      return { value: cached };
    }
    metrics.incCacheMiss();
    const row = await dbGet(id);
    if (!row) return null;
    await r.set(cacheKey(id), row.value);
    return { value: row.value };
  },

  async set(id: string, value: string) {
    const r = getRedis();
    await r.set(cacheKey(id), value);
    await r.sadd(DIRTY_SET, id);
    const n = await r.scard(DIRTY_SET);
    metrics.setDirtyCurrent(n);
  },

  startBackgroundTasks() {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      void flushDirtyBatch().catch((e) => console.error("flushDirtyBatch", e));
    }, config.writeBackFlushIntervalMs);
  },

  stopBackgroundTasks() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  },
};

/** Сброс оставшихся грязных ключей в БД (при остановке сервера). */
export async function flushAllDirty(): Promise<void> {
  const r = getRedis();
  let guard = 0;
  while ((await r.scard(DIRTY_SET)) > 0 && guard++ < 10000) {
    await flushDirtyBatch();
  }
}
