import { loadEnvFileSync } from "./env-load.js";

loadEnvFileSync();

export type CacheStrategyName = "cache-aside" | "write-through" | "write-back";

const strategyRaw = (process.env.CACHE_STRATEGY ?? "cache-aside").toLowerCase();
if (!["cache-aside", "write-through", "write-back"].includes(strategyRaw)) {
  throw new Error(`Invalid CACHE_STRATEGY: ${strategyRaw}`);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://cacheuser:cachepass@localhost:5433/cachedb",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  cacheStrategy: strategyRaw as CacheStrategyName,
  writeBackFlushIntervalMs: Number(process.env.WRITEBACK_FLUSH_INTERVAL_MS ?? 500),
  writeBackFlushBatch: Number(process.env.WRITEBACK_FLUSH_BATCH ?? 50),
};
