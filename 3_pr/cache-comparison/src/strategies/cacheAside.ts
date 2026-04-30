import { dbGet, dbUpsert } from "../db.js";
import { cacheKey, getRedis } from "../redis.js";
import * as metrics from "../metrics.js";
import type { CacheStrategy } from "./types.js";

export const cacheAsideStrategy: CacheStrategy = {
  name: "cache-aside",

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
    await dbUpsert(id, value);
    await getRedis().del(cacheKey(id));
  },
};
