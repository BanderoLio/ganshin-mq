export type BrokerMessage = {
  id: string;
  sentAtMs: number;
  payload: string;
  payloadBytes: number;
  runId: string;
};

export type ConsumeHandler = (message: BrokerMessage) => Promise<void>;

export type BrokerPublisher = {
  publish: (message: BrokerMessage) => Promise<void>;
  close: () => Promise<void>;
};

export type BrokerSubscriber = {
  start: (handler: ConsumeHandler) => Promise<void>;
  stop: () => Promise<void>;
  getBacklog: () => Promise<number | null>;
};

export type ScenarioResult = {
  runId: string;
  broker: "rabbit" | "redis";
  payloadBytes: number;
  rate: number;
  durationSec: number;
  sent: number;
  processed: number;
  errors: number;
  lost: number;
  throughput: number;
  latencyAvgMs: number;
  latencyP95Ms: number;
  latencyMaxMs: number;
  backlog: number | null;
  cpuPercent: number | null;
  memoryMiB: number | null;
  startedAt: string;
  finishedAt: string;
};
