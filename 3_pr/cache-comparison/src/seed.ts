/**
 * Заполняет PostgreSQL одинаковым набором ключей для всех прогонов.
 * Опционально очищает ключи приложения в Redis.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { initDb, dbUpsert, truncateItems, closeDb } from "./db.js";
import { getRedis, redisFlushAppKeys, closeRedis } from "./redis.js";

const DEFAULT_KEYS = 500;

export async function runSeed(
  keys: number,
  options?: { skipRedisFlush?: boolean },
): Promise<void> {
  await initDb();
  await truncateItems();
  for (let i = 0; i < keys; i++) {
    const id = `k${i}`;
    await dbUpsert(id, `seed-${i}`);
  }
  if (!options?.skipRedisFlush) {
    await getRedis().ping();
    await redisFlushAppKeys();
  }
}

function parseArgs(): { keys: number; skipRedis: boolean } {
  let keys = DEFAULT_KEYS;
  let skipRedis = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--keys" && argv[i + 1]) {
      keys = Number(argv[++i]);
    }
    if (argv[i] === "--skip-redis-flush") skipRedis = true;
  }
  return { keys, skipRedis };
}

function isExecutedDirectly(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  const want = pathToFileURL(path.resolve(arg)).href;
  const have = import.meta.url;
  if (want === have) return true;
  if (process.platform === "win32" && want.toLowerCase() === have.toLowerCase()) return true;
  return false;
}

async function cliMain(): Promise<void> {
  const { keys, skipRedis } = parseArgs();
  await runSeed(keys, { skipRedisFlush: skipRedis });
  await closeDb();
  await closeRedis();
  console.log(`Seeded ${keys} items in PostgreSQL; Redis app keys cleared.`);
}

if (isExecutedDirectly()) {
  void cliMain().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
