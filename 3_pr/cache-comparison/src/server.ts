import Fastify from "fastify";
import { config } from "./config.js";
import { initDb, closeDb } from "./db.js";
import { getRedis, closeRedis } from "./redis.js";
import { createStrategy } from "./strategies/factory.js";
import * as metrics from "./metrics.js";
import { flushAllDirty } from "./strategies/writeBack.js";

const strategy = createStrategy(config.cacheStrategy);
strategy.startBackgroundTasks?.();

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, strategy: config.cacheStrategy }));

app.post("/metrics/reset", async (_req, reply) => {
  metrics.resetMetrics();
  reply.code(204).send();
});

app.get("/metrics", async () => metrics.getMetrics());

app.get<{ Params: { id: string } }>("/item/:id", async (req, reply) => {
  const row = await strategy.get(req.params.id);
  if (!row) {
    reply.code(404).send({ error: "not_found" });
    return;
  }
  return { id: req.params.id, value: row.value };
});

app.put<{ Params: { id: string }; Body: { value?: string } }>(
  "/item/:id",
  async (req, reply) => {
    const value = req.body?.value;
    if (typeof value !== "string") {
      reply.code(400).send({ error: "value_required" });
      return;
    }
    await strategy.set(req.params.id, value);
    reply.code(204).send();
  },
);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  strategy.stopBackgroundTasks?.();
  if (config.cacheStrategy === "write-back") {
    try {
      await flushAllDirty();
    } catch (e) {
      app.log.error(e, "flushAllDirty failed");
    }
  }
  await app.close();
  await closeDb();
  await closeRedis();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main(): Promise<void> {
  await initDb();
  await getRedis().ping();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`Listening on ${config.port}, strategy=${config.cacheStrategy}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
