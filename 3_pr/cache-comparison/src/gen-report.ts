/**
 * Читает bench-results.json, проверяет согласованность метрик, перезаписывает REPORT.md.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpPlan, type LoadProfile } from "./benchmark.js";

const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

interface Cell {
  strategy: string;
  profile: LoadProfile;
  client: {
    planned_requests: number;
    reads: number;
    writes: number;
    requests_ok: number;
    requests_err: number;
    duration_ms: number;
    throughput_rps: number;
    latency_avg_ms: number;
    latency_p95_ms: number;
  };
  server: {
    cache_hits?: number;
    cache_misses?: number;
    cache_hit_rate?: number | null;
    db_reads?: number;
    db_writes?: number;
    dirty_keys_peak?: number;
    flush_runs?: number;
    keys_flushed_total?: number;
  };
}

interface BenchResultsFile {
  durationMs: number;
  targetRps: number;
  keys: number;
  seed: number;
  baseUrl: string;
  results: Cell[];
}

function fmtPct(x: number | null | undefined): string {
  if (x == null || Number.isNaN(x)) return "n/a";
  return `${(x * 100).toFixed(1)}%`;
}

function validateCell(
  cell: Cell,
  matrixDurationMs: number,
  matrixTargetRps: number,
  matrixKeys: number,
  matrixSeed: number,
): string[] {
  const issues: string[] = [];
  const c = cell.client;
  const s = cell.server;
  const planned = Math.max(1, Math.floor((matrixDurationMs / 1000) * matrixTargetRps));
  if (c.planned_requests !== planned) {
    issues.push(`${cell.strategy}/${cell.profile}: planned_requests ${c.planned_requests} != ожидаемое ${planned}`);
  }
  if (c.reads + c.writes !== c.planned_requests) {
    issues.push(`${cell.strategy}/${cell.profile}: reads+writes != planned`);
  }
  const { reads: expectedReads, writes: expectedWrites } = buildOpPlan(
    cell.profile,
    matrixKeys,
    matrixSeed,
    c.planned_requests,
  );
  if (c.reads !== expectedReads || c.writes !== expectedWrites) {
    issues.push(
      `${cell.strategy}/${cell.profile}: несовпадение доли read/write с планом (client reads=${c.reads} vs ${expectedReads})`,
    );
  }
  if (c.requests_ok + c.requests_err !== c.planned_requests) {
    issues.push(`${cell.strategy}/${cell.profile}: ok+err != planned (${c.requests_ok + c.requests_err} vs ${c.planned_requests})`);
  }

  const hits = s.cache_hits ?? 0;
  const misses = s.cache_misses ?? 0;
  if (hits + misses !== c.reads) {
    issues.push(
      `${cell.strategy}/${cell.profile}: cache_hits+cache_misses (${hits + misses}) != число чтений клиента (${c.reads})`,
    );
  }

  const dbw = s.db_writes ?? 0;
  if (cell.strategy !== "write-back" && dbw !== c.writes) {
    issues.push(`${cell.strategy}/${cell.profile}: db_writes (${dbw}) != число записей клиента (${c.writes})`);
  }

  const dbr = s.db_reads ?? 0;
  if (dbr !== misses) {
    issues.push(
      `${cell.strategy}/${cell.profile}: db_reads (${dbr}) != cache_misses (${misses}) — ожидается 1 чтение БД на промах кеша`,
    );
  }

  const denom = hits + misses;
  if (denom > 0) {
    const hr = hits / denom;
    const reported = s.cache_hit_rate;
    if (reported != null && Math.abs(reported - hr) > 1e-6) {
      issues.push(`${cell.strategy}/${cell.profile}: cache_hit_rate не согласован с hits/misses`);
    }
  }

  const impliedRps = c.requests_ok / (c.duration_ms / 1000);
  if (Math.abs(impliedRps - c.throughput_rps) > 0.05) {
    issues.push(`${cell.strategy}/${cell.profile}: throughput_rps не сходится с ok/duration`);
  }

  if (cell.strategy === "write-back") {
    const peak = s.dirty_keys_peak ?? 0;
    const flushed = s.keys_flushed_total ?? 0;
    if (c.writes > 0 && peak === 0 && flushed === 0) {
      issues.push(`${cell.profile}: write-back — нет ни пика dirty, ни flush (подозрительно при наличии записей)`);
    }
  }

  return issues;
}

function markdownTable(rows: Cell[]): string {
  const header =
    "| Стратегия | Профиль | Запланировано | RPS | Lat avg ms | Lat p95 ms | DB reads | DB writes | Hit rate | Dirty peak | Flush |\n" +
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  const lines = rows.map((r) => {
    const s = r.server;
    return (
      `| ${r.strategy} | ${r.profile} | ${r.client.planned_requests} | ${r.client.throughput_rps.toFixed(1)} | ` +
      `${r.client.latency_avg_ms.toFixed(2)} | ${r.client.latency_p95_ms.toFixed(2)} | ` +
      `${s.db_reads ?? ""} | ${s.db_writes ?? ""} | ${fmtPct(s.cache_hit_rate ?? null)} | ${s.dirty_keys_peak ?? 0} | ${s.flush_runs ?? 0} |`
    );
  });
  return [header, ...lines].join("\n");
}

function conclusions(rows: Cell[], keys: number): string {
  const byProfile = (p: LoadProfile) => rows.filter((r) => r.profile === p);

  const pickMax = (subset: Cell[], key: (c: Cell) => number) =>
    subset.reduce((a, b) => (key(b) > key(a) ? b : a));

  const pickMin = (subset: Cell[], key: (c: Cell) => number) =>
    subset.reduce((a, b) => (key(b) < key(a) ? b : a));

  const readHeavy = byProfile("read-heavy");
  const writeHeavy = byProfile("write-heavy");
  const balanced = byProfile("balanced");

  const maxHr = Math.max(...readHeavy.map((c) => (c.server.cache_hit_rate ?? 0) as number));
  const tiedHr = readHeavy.filter((c) => (c.server.cache_hit_rate ?? 0) === maxHr);
  const bestLatRead = pickMin(readHeavy, (c) => c.client.latency_avg_ms);
  const bestTputWrite = pickMax(writeHeavy, (c) => c.client.throughput_rps);
  const bestBal = pickMax(balanced, (c) => c.client.throughput_rps - c.client.latency_avg_ms * 2);

  return [
    "### Чтение (read-heavy)",
    "",
    `- Hit rate (read-heavy): ${
      tiedHr.length >= readHeavy.length
        ? "у всех трёх стратегий совпадает (одинаковая логика чтения из кеша/БД на GET)."
        : `лучше у **${tiedHr.map((c) => c.strategy).join(", ")}** (${fmtPct(maxHr)}).`
    } При случайном доступе к **${keys}** ключам доля попаданий ограничена; cache-aside при записи снимает ключ с кеша — на balanced профиле hit rate обычно ниже, чем у write-through.`,
    `- По средней задержке (ниже лучше): **${bestLatRead.strategy}** (~${bestLatRead.client.latency_avg_ms.toFixed(2)} ms).`,
    "",
    "### Запись (write-heavy)",
    "",
    `- **Write-back** даёт меньше синхронных обращений к БД на путь записи (запись в Redis), нагрузка на PG снимается flush'ами; пик dirty и число flush видны в таблице.`,
    `- Максимальный клиентский RPS в прогоне: **${bestTputWrite.strategy}** (~${bestTputWrite.client.throughput_rps.toFixed(1)} req/s).`,
    "",
    "### Смешанная нагрузка (balanced)",
    "",
    `- Компромисс latency / throughput: смотрите колонки RPS и Lat avg; ориентир по «сводной» метрике в автотексте: **${bestBal.strategy}**.`,
    "",
    "_Выводы сгенерированы по числам из `bench-results.json`; при необходимости отредактируйте вручную._",
  ].join("\n");
}

async function main(): Promise<void> {
  const pathJson = resolve(projectRoot, "bench-results.json");
  const raw = await readFile(pathJson, "utf8");
  const data = JSON.parse(raw) as BenchResultsFile;
  const allIssues: string[] = [];
  for (const cell of data.results) {
    allIssues.push(...validateCell(cell, data.durationMs, data.targetRps, data.keys, data.seed));
  }

  const validationBlock =
    allIssues.length === 0
      ? "Проверки пройдены: для каждой ячейки hits+misses=reads, db_reads=misses, ok+err=planned, hit rate согласован с hits/misses; для cache-aside и write-through — db_writes равно числу HTTP-записей; для write-back объём записей в БД задаётся flush и может отличаться от числа PUT."
      : ["**Обнаружены несоответствия:**", ...allIssues.map((x) => `- ${x}`)].join("\n");

  const report = `# Отчёт: сравнение типов кеширования

## Параметры прогона

| Параметр | Значение |
|----------|----------|
| Длительность (настройка матрицы), мс | ${data.durationMs} |
| Целевой RPS | ${data.targetRps} |
| Ключей | ${data.keys} |
| Seed RNG | ${data.seed} |
| Базовый URL | ${data.baseUrl} |

## Описание тестов

Один генератор нагрузки ([benchmark.ts](src/benchmark.ts)): предрасчёт списка операций (read/write + id) по seed и профилю; объём запросов = floor(duration_s * target_rps); выполнение с ограниченной параллельностью. Перед каждой ячейкой матрицы — TRUNCATE + сид + сброс Redis ([bench-matrix.ts](src/bench-matrix.ts)).

Метрики: **throughput** = успешные запросы / фактическое время прогона; **latency** — RTT на клиенте; **db_reads/db_writes** — счётчики на сервере; **hit rate** — hits/(hits+misses) на чтениях; для write-back — **dirty_keys_peak**, **flush_runs**.

## Проверка валидности

${validationBlock}

## Таблица результатов

${markdownTable(data.results)}

## Скриншоты

### Вывод npm run bench:matrix (таблица и JSON по ячейкам)

![Результат матрицы прогонов в консоли](public/output.png)

### Логи сервера (Fastify, write-back, запросы PUT)

![Логи приложения при нагрузке](public/logs.png)

## Выводы

${conclusions(data.results, data.keys)}

---

_Файл сгенерирован командой npm run report. Исходные данные: bench-results.json._
`;

  const outMd = resolve(projectRoot, "REPORT.md");
  await writeFile(outMd, report, "utf8");
  console.log(`Wrote ${outMd}`);
  if (allIssues.length) {
    console.error("Validation had issues; fix code or data and re-run.");
    process.exit(2);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
