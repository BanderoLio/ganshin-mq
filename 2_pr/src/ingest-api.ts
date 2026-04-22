import express from "express";
import { APP_CONFIG, BrokerKind } from "./config.js";
import { createRabbitPublisher } from "./brokers/rabbit.js";
import { createRedisPublisher } from "./brokers/redis-pubsub.js";
import { BrokerMessage } from "./types.js";
import { writeJsonResult } from "./metrics/collector.js";

const broker = (process.env.BROKER as BrokerKind | undefined) ?? "rabbit";
const runId = process.env.RUN_ID ?? "manual-run";
const app = express();

app.use(express.json({ limit: "2mb" }));

const publisher = broker === "rabbit" ? await createRabbitPublisher() : await createRedisPublisher();
let sent = 0;
let errors = 0;
const startedAt = new Date().toISOString();

const flushStats = async (isFinal: boolean): Promise<void> => {
  await writeJsonResult(`ingest-${runId}.json`, {
    runId,
    broker,
    sent,
    errors,
    startedAt,
    updatedAt: new Date().toISOString(),
    isFinal
  });
};

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, broker, runId });
});

app.post("/publish", async (req, res) => {
  const body = req.body as Partial<BrokerMessage>;
  if (!body.id || !body.sentAtMs || !body.payload || !body.payloadBytes || !body.runId) {
    res.status(400).json({ ok: false, error: "invalid_payload" });
    return;
  }

  try {
    await publisher.publish(body as BrokerMessage);
    sent += 1;
    res.status(202).json({ ok: true });
  } catch {
    errors += 1;
    res.status(500).json({ ok: false, error: "publish_failed" });
  }
});

const timer = setInterval(() => {
  flushStats(false).catch(() => {
    errors += 1;
  });
}, 1000);

const shutdown = async () => {
  clearInterval(timer);
  await flushStats(true);
  await publisher.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  shutdown().catch(() => process.exit(1));
});

process.on("SIGTERM", () => {
  shutdown().catch(() => process.exit(1));
});

app.listen(APP_CONFIG.httpPort, () => {
  console.log(`[ingest-api] started on :${APP_CONFIG.httpPort} broker=${broker} runId=${runId}`);
});
