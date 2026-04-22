import { APP_CONFIG, BrokerKind } from "./config.js";
import { createRabbitSubscriber } from "./brokers/rabbit.js";
import { createRedisSubscriber } from "./brokers/redis-pubsub.js";
import { createRuntimeStats, summarizeLatency, writeJsonResult } from "./metrics/collector.js";

const broker = (process.env.BROKER as BrokerKind | undefined) ?? "rabbit";
const runId = process.env.RUN_ID ?? "manual-run";
const expectedDurationSec = Number(process.env.DURATION_SEC ?? 30);

const subscriber = broker === "rabbit" ? await createRabbitSubscriber() : await createRedisSubscriber();
const stats = createRuntimeStats();

const flushStats = async (isFinal: boolean): Promise<void> => {
  const latency = summarizeLatency(stats.latenciesMs);
  const backlog = await subscriber.getBacklog();
  const payload = {
    runId,
    broker,
    processed: stats.processed,
    errors: stats.errors,
    latencyAvgMs: latency.avg,
    latencyP95Ms: latency.p95,
    latencyMaxMs: latency.max,
    backlog,
    startedAt: stats.startedAt.toISOString(),
    updatedAt: new Date().toISOString(),
    expectedDurationSec,
    isFinal
  };
  await writeJsonResult(`consumer-${runId}.json`, payload);
};

await subscriber.start(async (message) => {
  try {
    stats.processed += 1;
    stats.latenciesMs.push(Date.now() - message.sentAtMs);
  } catch {
    stats.errors += 1;
  }
});

const timer = setInterval(() => {
  flushStats(false).catch(() => {
    stats.errors += 1;
  });
}, 1000);

const stop = async () => {
  clearInterval(timer);
  await flushStats(true);
  await subscriber.stop();
  process.exit(0);
};

process.on("SIGINT", () => {
  stop().catch(() => process.exit(1));
});

process.on("SIGTERM", () => {
  stop().catch(() => process.exit(1));
});

console.log(`[consumer] started broker=${broker} runId=${runId} queue/channel=${APP_CONFIG.rabbitQueue}/${APP_CONFIG.redisChannel}`);
