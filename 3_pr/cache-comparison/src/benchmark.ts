/**
 * Единый генератор нагрузки: одинаковые ключи, seed RNG, профили read/balanced/write-heavy.
 * Операции предрасчитываются (детерминированно), затем выполняются с ограниченной параллельностью,
 * чтобы целевой объём запросов за прогон соответствовал duration×RPS и не упирался только в RTT одного потока.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvFileSync } from "./env-load.js";

loadEnvFileSync();

export type LoadProfile = "read-heavy" | "balanced" | "write-heavy";

const PROFILES: Record<LoadProfile, number> = {
  "read-heavy": 0.8,
  balanced: 0.5,
  "write-heavy": 0.2,
};

export interface BenchOp {
  isRead: boolean;
  id: string;
}

export interface BenchArgs {
  baseUrl: string;
  profile: LoadProfile;
  durationMs: number;
  targetRps: number;
  keys: number;
  seed: number;
  /** Параллельных in-flight запросов (по умолчанию из BENCH_CONCURRENCY или от targetRps). */
  concurrency?: number;
}

export interface BenchClientResult {
  planned_requests: number;
  reads: number;
  writes: number;
  requests_ok: number;
  requests_err: number;
  /** Фактическое время выполнения всех запланированных запросов, мс. */
  duration_ms: number;
  throughput_rps: number;
  latency_avg_ms: number;
  latency_p95_ms: number;
}

function mulberry32(a: number): () => number {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function plannedCount(durationMs: number, targetRps: number): number {
  return Math.max(1, Math.floor((durationMs / 1000) * targetRps));
}

export function buildOpPlan(
  profile: LoadProfile,
  keys: number,
  seed: number,
  total: number,
): { ops: BenchOp[]; reads: number; writes: number } {
  const readRatio = PROFILES[profile];
  const rnd = mulberry32(seed);
  const ops: BenchOp[] = [];
  let reads = 0;
  let writes = 0;
  for (let n = 0; n < total; n++) {
    const keyIndex = Math.floor(rnd() * keys);
    const isRead = rnd() < readRatio;
    if (isRead) reads += 1;
    else writes += 1;
    ops.push({ isRead, id: `k${keyIndex}` });
  }
  return { ops, reads, writes };
}

export async function runBenchmark(args: BenchArgs): Promise<BenchClientResult> {
  const total = plannedCount(args.durationMs, args.targetRps);
  const envConc = process.env.BENCH_CONCURRENCY;
  const defaultConc = Math.min(80, Math.max(8, Math.ceil(args.targetRps / 2)));
  const concurrency =
    args.concurrency ??
    (envConc ? Number(envConc) : defaultConc);
  const conc = Math.min(128, Math.max(1, concurrency));

  const { ops, reads, writes } = buildOpPlan(args.profile, args.keys, args.seed, total);
  const latencies: number[] = [];
  let ok = 0;
  let err = 0;

  let opIdx = 0;
  const startWall = Date.now();

  const runOne = async (op: BenchOp): Promise<void> => {
    const t0 = performance.now();
    try {
      if (op.isRead) {
        const res = await fetch(`${args.baseUrl}/item/${op.id}`);
        if (res.ok) ok += 1;
        else err += 1;
      } else {
        const res = await fetch(`${args.baseUrl}/item/${op.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: `w-${Date.now()}-${op.id}` }),
        });
        if (res.ok || res.status === 204) ok += 1;
        else err += 1;
      }
    } catch {
      err += 1;
    }
    latencies.push(performance.now() - t0);
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = opIdx++;
      if (idx >= ops.length) return;
      await runOne(ops[idx]!);
    }
  };

  await Promise.all(Array.from({ length: conc }, () => worker()));

  const wallMs = Math.max(1, Date.now() - startWall);
  latencies.sort((a, b) => a - b);
  const throughput_rps = ok / (wallMs / 1000);

  return {
    planned_requests: total,
    reads,
    writes,
    requests_ok: ok,
    requests_err: err,
    duration_ms: wallMs,
    throughput_rps,
    latency_avg_ms: latencies.length ? latencies.reduce((s, x) => s + x, 0) / latencies.length : 0,
    latency_p95_ms: percentile(latencies, 95),
  };
}

function parseArg(argv: string[], name: string, def?: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  return argv[i + 1] ?? def;
}

async function cliMain(): Promise<void> {
  const argv = process.argv.slice(2);
  const quick = process.env.BENCH_QUICK === "1";
  const baseUrl = parseArg(argv, "--base-url", "http://127.0.0.1:3000")!;
  const profile = (parseArg(argv, "--profile", "balanced") ?? "balanced") as LoadProfile;
  if (!(profile in PROFILES)) {
    console.error("Invalid --profile", profile);
    process.exit(1);
  }
  const durationMs = Number(parseArg(argv, "--duration-ms", quick ? "2000" : "10000"));
  const targetRps = Number(parseArg(argv, "--target-rps", quick ? "30" : "80"));
  const keys = Number(parseArg(argv, "--keys", "500"));
  const seed = Number(parseArg(argv, "--seed", "42"));

  const client = await runBenchmark({
    baseUrl,
    profile,
    durationMs,
    targetRps,
    keys,
    seed,
  });
  console.log(JSON.stringify({ profile, keys, seed, durationMs, targetRps, client }, null, 2));
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

const isMain = isExecutedDirectly();

if (isMain) {
  void cliMain().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
