export type BrokerKind = "rabbit" | "redis";

export type BenchmarkScenario = {
  broker: BrokerKind;
  payloadBytes: number;
  rate: number;
  durationSec: number;
  consumers: number;
  runId: string;
};

export const APP_CONFIG = {
  httpPort: Number(process.env.HTTP_PORT ?? 3100),
  resultsDir: process.env.RESULTS_DIR ?? "results",
  rabbitUrl: process.env.RABBIT_URL ?? "amqp://guest:guest@localhost:5672",
  rabbitQueue: process.env.RABBIT_QUEUE ?? "benchmark.queue",
  rabbitManagementUrl:
    process.env.RABBIT_MANAGEMENT_URL ?? "http://localhost:15672/api/queues/%2F/benchmark.queue",
  rabbitManagementUser: process.env.RABBIT_MANAGEMENT_USER ?? "guest",
  rabbitManagementPass: process.env.RABBIT_MANAGEMENT_PASS ?? "guest",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6380",
  redisChannel: process.env.REDIS_CHANNEL ?? "benchmark.channel"
};

export const parseDurationToSeconds = (input: string): number => {
  const match = input.match(/^(\d+)(s|m)$/);
  if (!match) {
    throw new Error(`Unsupported duration format: ${input}. Use formats like 30s, 2m`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  return unit === "m" ? amount * 60 : amount;
};

export const makeRunId = (): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `run-${stamp}`;
};
