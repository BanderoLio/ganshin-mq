/**
 * Матрица 3 стратегии × 3 профиля: сброс Redis, запуск сервера, единый бенч, сбор /metrics.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadEnvFileSync } from "./env-load.js";
import { runBenchmark, type LoadProfile } from "./benchmark.js";
import { getRedis, closeRedis } from "./redis.js";
import { closeDb } from "./db.js";
import { config as appConfig } from "./config.js";
import { runSeed } from "./seed.js";

loadEnvFileSync();

const STRATEGIES = ["cache-aside", "write-through", "write-back"] as const;
const PROFILES: LoadProfile[] = ["read-heavy", "balanced", "write-heavy"];

const quick = process.env.BENCH_QUICK === "1";
const durationMs = Number(process.env.BENCH_DURATION_MS ?? (quick ? 2500 : 10000));
const targetRps = Number(process.env.BENCH_TARGET_RPS ?? (quick ? 40 : 80));
const keys = Number(process.env.BENCH_KEYS ?? 500);
const seed = Number(process.env.BENCH_SEED ?? 42);
const baseUrl = process.env.BENCH_BASE_URL ?? `http://127.0.0.1:${appConfig.port}`;
const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

interface CellResult {
  strategy: string;
  profile: LoadProfile;
  client: Awaited<ReturnType<typeof runBenchmark>>;
  server: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealth(url: string, maxMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error(`health check failed: ${url}`);
}

async function postReset(url: string): Promise<void> {
  const r = await fetch(`${url}/metrics/reset`, { method: "POST" });
  if (!r.ok && r.status !== 204) throw new Error(`metrics reset failed ${r.status}`);
}

async function getMetrics(url: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${url}/metrics`);
  if (!r.ok) throw new Error(`metrics ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

function resolveTsxCli(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("tsx/package.json");
  const cli = resolve(pkg, "..", "dist", "cli.mjs");
  if (!existsSync(cli)) throw new Error(`tsx cli not found: ${cli}`);
  return cli;
}

function spawnServer(strategy: string): ChildProcess {
  const tsxCli = resolveTsxCli();
  const entry = resolve(projectRoot, "src", "server.ts");
  const env = {
    ...process.env,
    CACHE_STRATEGY: strategy,
    PORT: String(appConfig.port),
  };
  return spawn(process.execPath, [tsxCli, entry], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function killProc(proc: ChildProcess | null): Promise<void> {
  if (!proc?.pid) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  await new Promise<void>((resolvePromise) => {
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolvePromise();
    }, 8000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolvePromise();
    });
  });
}

async function runCell(strategy: string, profile: LoadProfile): Promise<CellResult> {
  await runSeed(keys);
  const proc = spawnServer(strategy);
  let stderr = "";
  proc.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  try {
    await waitHealth(baseUrl);
    await postReset(baseUrl);
    const client = await runBenchmark({
      baseUrl,
      profile,
      durationMs,
      targetRps,
      keys,
      seed,
    });
    if (strategy === "write-back") {
      await sleep(quick ? 400 : 1500);
    }
    const server = await getMetrics(baseUrl);
    return { strategy, profile, client, server };
  } finally {
    await killProc(proc);
    if (stderr.trim()) console.error(`[server ${strategy} stderr]\n`, stderr.slice(-2000));
  }
}

function markdownTable(rows: CellResult[]): string {
  const header =
    "| Стратегия | Профиль | RPS (клиент) | Lat avg ms | Lat p95 ms | DB reads | DB writes | Hit rate | Dirty peak | Flush runs |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  const lines = rows.map((r) => {
    const s = r.server;
    const hr = s.cache_hit_rate == null ? "n/a" : `${((s.cache_hit_rate as number) * 100).toFixed(1)}%`;
    return (
      `| ${r.strategy} | ${r.profile} | ${r.client.throughput_rps.toFixed(1)} | ` +
      `${r.client.latency_avg_ms.toFixed(2)} | ${r.client.latency_p95_ms.toFixed(2)} | ` +
      `${s.db_reads} | ${s.db_writes} | ${hr} | ${s.dirty_keys_peak ?? 0} | ${s.flush_runs ?? 0} |`
    );
  });
  return [header, ...lines].join("\n");
}

async function main(): Promise<void> {
  try {
    try {
      await getRedis().ping();
    } catch (e) {
      console.error(
        "Не удалось подключиться к Redis. Запустите инфраструктуру: docker compose up -d",
      );
      throw e;
    }
    const results: CellResult[] = [];
    for (const strategy of STRATEGIES) {
      for (const profile of PROFILES) {
        console.error(`\n=== ${strategy} / ${profile} ===\n`);
        const cell = await runCell(strategy, profile);
        results.push(cell);
        console.log(JSON.stringify(cell));
      }
    }
    const summary = { durationMs, targetRps, keys, seed, baseUrl, results };
    console.error("\n--- Markdown table ---\n");
    console.error(markdownTable(results));
    const outPath = resolve(projectRoot, "bench-results.json");
    await import("fs/promises").then((fs) =>
      fs.writeFile(outPath, JSON.stringify(summary, null, 2), "utf8"),
    );
    console.error(`\nWrote ${outPath}`);
  } finally {
    await closeRedis().catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
