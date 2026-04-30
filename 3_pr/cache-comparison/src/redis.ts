import { Redis } from "ioredis";
import { config } from "./config.js";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  }
  return client;
}

const KEY_PREFIX = "item:";
const DIRTY_SET = "dirty:items";

export function cacheKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

export async function redisFlushAppKeys(): Promise<void> {
  const r = getRedis();
  const keys = await r.keys(`${KEY_PREFIX}*`);
  if (keys.length) await r.del(...keys);
  await r.del(DIRTY_SET);
}

export { DIRTY_SET };

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
