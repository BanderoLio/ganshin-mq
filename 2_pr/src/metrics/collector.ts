import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { APP_CONFIG } from "../config.js";
import { ScenarioResult } from "../types.js";

export type RuntimeStats = {
  processed: number;
  errors: number;
  latenciesMs: number[];
  startedAt: Date;
};

export const createRuntimeStats = (): RuntimeStats => ({
  processed: 0,
  errors: 0,
  latenciesMs: [],
  startedAt: new Date()
});

const percentile = (values: number[], percent: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((percent / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
};

export const summarizeLatency = (values: number[]) => {
  if (values.length === 0) {
    return { avg: 0, p95: 0, max: 0 };
  }

  const sum = values.reduce((acc, current) => acc + current, 0);
  return {
    avg: sum / values.length,
    p95: percentile(values, 95),
    max: Math.max(...values)
  };
};

export const writeJsonResult = async (fileName: string, data: unknown): Promise<void> => {
  await mkdir(APP_CONFIG.resultsDir, { recursive: true });
  const filePath = path.join(APP_CONFIG.resultsDir, fileName);
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
};

export const writeCsv = async (fileName: string, rows: ScenarioResult[]): Promise<void> => {
  await mkdir(APP_CONFIG.resultsDir, { recursive: true });
  const header = [
    "runId",
    "broker",
    "payloadBytes",
    "rate",
    "durationSec",
    "sent",
    "processed",
    "errors",
    "lost",
    "throughput",
    "latencyAvgMs",
    "latencyP95Ms",
    "latencyMaxMs",
    "backlog",
    "cpuPercent",
    "memoryMiB",
    "startedAt",
    "finishedAt"
  ];

  const lines = rows.map((r) =>
    [
      r.runId,
      r.broker,
      r.payloadBytes,
      r.rate,
      r.durationSec,
      r.sent,
      r.processed,
      r.errors,
      r.lost,
      r.throughput.toFixed(2),
      r.latencyAvgMs.toFixed(2),
      r.latencyP95Ms.toFixed(2),
      r.latencyMaxMs.toFixed(2),
      r.backlog ?? "",
      r.cpuPercent?.toFixed(2) ?? "",
      r.memoryMiB?.toFixed(2) ?? "",
      r.startedAt,
      r.finishedAt
    ].join(",")
  );

  const body = [header.join(","), ...lines].join("\n");
  await writeFile(path.join(APP_CONFIG.resultsDir, fileName), body, "utf8");
};
