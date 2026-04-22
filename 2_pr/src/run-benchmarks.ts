import { execFile, spawn, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { APP_CONFIG, BrokerKind, makeRunId, parseDurationToSeconds } from "./config.js";
import { ScenarioResult } from "./types.js";
import { writeCsv, writeJsonResult } from "./metrics/collector.js";

const execFileAsync = promisify(execFile);

type Scenario = {
  broker: BrokerKind;
  payloadBytes: number;
  rate: number;
  duration: string;
};

const args = process.argv.slice(2);

const readArgValue = (flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return undefined;
  }
  return args[idx + 1];
};

const hasFlag = (flag: string): boolean => args.includes(flag);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const runCommand = async (
  command: string,
  commandArgs: string[],
  env: NodeJS.ProcessEnv = {},
  acceptableExitCodes: number[] = [0]
): Promise<void> => {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      shell: true,
      stdio: "inherit",
      env: { ...process.env, ...env }
    });

    child.on("exit", (code) => {
      if (code !== null && acceptableExitCodes.includes(code)) {
        resolve(null);
      } else {
        reject(new Error(`${command} ${commandArgs.join(" ")} failed with code ${code}`));
      }
    });
  });
};

const startProcess = (scriptName: "consumer" | "ingest", env: NodeJS.ProcessEnv): ChildProcess => {
  const tsxCliPath = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const scriptPath = scriptName === "consumer" ? "src/consumer.ts" : "src/ingest-api.ts";

  return spawn(process.execPath, [tsxCliPath, scriptPath], {
    shell: false,
    stdio: "inherit",
    env: { ...process.env, ...env }
  });
};

const waitForHealth = async (port: number, attempts = 120): Promise<void> => {
  const url = `http://127.0.0.1:${port}/health`;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await sleep(300);
  }
  throw new Error("Ingest API failed health checks.");
};

const stopProcess = async (child: ChildProcess): Promise<void> => {
  if (!child.pid || child.killed) {
    return;
  }

  const waitExit = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  child.kill("SIGTERM");

  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5000);
  });

  await Promise.race([waitExit, timeout]);
};

const loadJson = async <T>(filePath: string): Promise<T> => {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
};

const fetchContainerStats = async (broker: BrokerKind): Promise<{ cpu: number | null; memMiB: number | null }> => {
  const containerName = broker === "rabbit" ? "benchmark-rabbitmq" : "benchmark-redis";
  try {
    const { stdout } = await execFileAsync("docker", ["stats", containerName, "--no-stream", "--format", "{{json .}}"]);
    const parsed = JSON.parse(stdout.trim()) as { CPUPerc: string; MemUsage: string };
    const cpu = Number(parsed.CPUPerc.replace("%", ""));
    const memLeft = parsed.MemUsage.split("/")[0].trim(); // e.g. "50.21MiB"
    const memMatch = memLeft.match(/^([0-9.]+)([A-Za-z]+)$/);
    if (!memMatch) {
      return { cpu: Number.isFinite(cpu) ? cpu : null, memMiB: null };
    }
    const value = Number(memMatch[1]);
    const unit = memMatch[2].toLowerCase();
    const memMiB = unit.startsWith("gi") ? value * 1024 : value;
    return { cpu: Number.isFinite(cpu) ? cpu : null, memMiB: Number.isFinite(memMiB) ? memMiB : null };
  } catch {
    return { cpu: null, memMiB: null };
  }
};

const runScenario = async (scenario: Scenario): Promise<ScenarioResult> => {
  const runId = `${scenario.broker}-${scenario.payloadBytes}b-${scenario.rate}r-${makeRunId()}`;
  const durationSec = parseDurationToSeconds(scenario.duration);
  const startedAt = new Date();
  const env = {
    BROKER: scenario.broker,
    RUN_ID: runId,
    DURATION_SEC: String(durationSec),
    HTTP_PORT: String(APP_CONFIG.httpPort)
  };

  const consumer = startProcess("consumer", env);
  const ingest = startProcess("ingest", env);

  try {
    await waitForHealth(APP_CONFIG.httpPort);
    await sleep(3000);

    await runCommand(
      "docker",
      [
        "compose",
        "run",
        "--rm",
        "--no-deps",
        "-e",
        `INGEST_URL=http://host.docker.internal:${APP_CONFIG.httpPort}/publish`,
        "-e",
        `RUN_ID=${runId}`,
        "-e",
        `PAYLOAD_BYTES=${scenario.payloadBytes}`,
        "-e",
        `RATE=${scenario.rate}`,
        "-e",
        `DURATION=${scenario.duration}`,
        "k6",
        "run",
        "/scripts/publisher.js",
        "--summary-export",
        `/results/k6-${runId}.json`
      ],
      {},
      [0, 99]
    );
  } finally {
    await sleep(1200);
    await stopProcess(ingest);
    await stopProcess(consumer);
  }

  const finishedAt = new Date();
  const ingestStats = await loadJson<{ sent: number; errors: number }>(
    path.join(APP_CONFIG.resultsDir, `ingest-${runId}.json`)
  );
  const consumerStats = await loadJson<{
    processed: number;
    errors: number;
    latencyAvgMs: number;
    latencyP95Ms: number;
    latencyMaxMs: number;
    backlog: number | null;
  }>(path.join(APP_CONFIG.resultsDir, `consumer-${runId}.json`));
  const containerStats = await fetchContainerStats(scenario.broker);

  const sent = ingestStats.sent;
  const processed = consumerStats.processed;
  const errors = ingestStats.errors + consumerStats.errors;
  const lost = Math.max(0, sent - processed);
  const throughput = processed / durationSec;

  return {
    runId,
    broker: scenario.broker,
    payloadBytes: scenario.payloadBytes,
    rate: scenario.rate,
    durationSec,
    sent,
    processed,
    errors,
    lost,
    throughput,
    latencyAvgMs: consumerStats.latencyAvgMs,
    latencyP95Ms: consumerStats.latencyP95Ms,
    latencyMaxMs: consumerStats.latencyMaxMs,
    backlog: consumerStats.backlog,
    cpuPercent: containerStats.cpu,
    memoryMiB: containerStats.memMiB,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString()
  };
};

const buildScenarios = (): Scenario[] => {
  if (hasFlag("--full")) {
    const brokers: BrokerKind[] = ["rabbit", "redis"];
    const payloads = [128, 1024, 10_240, 102_400];
    const rates = [1000, 5000, 10_000, 15_000, 20_000];
    const duration = "30s";

    const scenarios: Scenario[] = [];
    for (const broker of brokers) {
      for (const payloadBytes of payloads) {
        for (const rate of rates) {
          scenarios.push({ broker, payloadBytes, rate, duration });
        }
      }
    }
    return scenarios;
  }

  const broker = (readArgValue("--broker") as BrokerKind | undefined) ?? "rabbit";
  const payloadBytes = Number(readArgValue("--payload") ?? 1024);
  const rate = Number(readArgValue("--rate") ?? 1000);
  const duration = readArgValue("--duration") ?? "30s";

  return [{ broker, payloadBytes, rate, duration }];
};

const run = async () => {
  const scenarios = buildScenarios();
  const results: ScenarioResult[] = [];

  await runCommand("docker", ["compose", "up", "-d"]);

  for (const scenario of scenarios) {
    console.log(
      `[runner] scenario broker=${scenario.broker} payload=${scenario.payloadBytes} rate=${scenario.rate} duration=${scenario.duration}`
    );
    const result = await runScenario(scenario);
    results.push(result);
    await writeJsonResult("results-latest.json", results);
  }

  await writeJsonResult("results-final.json", results);
  await writeCsv("results-final.csv", results);
};

run()
  .then(() => {
    console.log("[runner] all scenarios complete.");
  })
  .catch((error: Error) => {
    console.error("[runner] failed:", error.message);
    process.exit(1);
  });
