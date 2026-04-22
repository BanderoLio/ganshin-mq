import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { APP_CONFIG } from "./config.js";
import { ScenarioResult } from "./types.js";

const resultPath = path.join(APP_CONFIG.resultsDir, "results-final.json");
const reportPath = "report.md";

const avg = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, current) => acc + current, 0) / values.length;
};

const formatNum = (value: number): string => value.toFixed(2);

const findDegradationPoint = (rows: ScenarioResult[], broker: "rabbit" | "redis"): string => {
  const candidate = rows
    .filter((row) => row.broker === broker)
    .sort((a, b) => a.rate - b.rate)
    .find((row) => row.lost > 0 || row.errors > 0 || row.latencyP95Ms > 1000 || (row.backlog ?? 0) > 0);

  if (!candidate) {
    return "Не зафиксировано в доступных сценариях";
  }

  return `${candidate.rate} msg/s (payload ${candidate.payloadBytes} B)`;
};

const run = async () => {
  const raw = await readFile(resultPath, "utf8");
  const rows = JSON.parse(raw) as ScenarioResult[];

  if (rows.length === 0) {
    throw new Error("results-final.json is empty.");
  }

  const rabbitRows = rows.filter((row) => row.broker === "rabbit");
  const redisRows = rows.filter((row) => row.broker === "redis");

  const rabbitAvgThroughput = avg(rabbitRows.map((row) => row.throughput));
  const redisAvgThroughput = avg(redisRows.map((row) => row.throughput));

  const smallRows = rows.filter((row) => row.payloadBytes <= 1024);
  const bigRows = rows.filter((row) => row.payloadBytes >= 102_400);
  const rabbitSmall = avg(smallRows.filter((row) => row.broker === "rabbit").map((row) => row.throughput));
  const redisSmall = avg(smallRows.filter((row) => row.broker === "redis").map((row) => row.throughput));
  const rabbitBig = avg(bigRows.filter((row) => row.broker === "rabbit").map((row) => row.throughput));
  const redisBig = avg(bigRows.filter((row) => row.broker === "redis").map((row) => row.throughput));

  const throughputWinner = rabbitAvgThroughput >= redisAvgThroughput ? "RabbitMQ" : "Redis Pub/Sub";
  const smallWinner = rabbitSmall >= redisSmall ? "RabbitMQ" : "Redis Pub/Sub";
  const bigWinner = rabbitBig >= redisBig ? "RabbitMQ" : "Redis Pub/Sub";

  const tableRows = rows
    .map(
      (row) =>
        `| ${row.runId} | ${row.broker} | ${row.payloadBytes} | ${row.rate} | ${row.durationSec} | ${row.sent} | ${row.processed} | ${row.errors} | ${row.lost} | ${formatNum(row.throughput)} | ${formatNum(row.latencyAvgMs)} | ${formatNum(row.latencyP95Ms)} | ${formatNum(row.latencyMaxMs)} | ${row.backlog ?? "n/a"} | ${row.cpuPercent?.toFixed(2) ?? "n/a"} | ${row.memoryMiB?.toFixed(2) ?? "n/a"} |`
    )
    .join("\n");

  const report = `# Отчёт по сравнению RabbitMQ и Redis Pub/Sub

## Контур эксперимента
- Инструмент нагрузки: k6 (\`k6/publisher.js\`)
- Единый вход публикации: HTTP ingest API
- Consumer с измерением latency и подсчётом обработанных сообщений
- Сравнение в одинаковых условиях (single-instance, одинаковая длительность, payload, rate)

## Результаты прогонов
| runId | broker | payloadBytes | rate(msg/s) | durationSec | sent | processed | errors | lost | throughput(msg/s) | latencyAvgMs | latencyP95Ms | latencyMaxMs | backlog | cpuPercent | memoryMiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${tableRows}

## Ответы по ТЗ
- Какой брокер показал большую пропускную способность: **${throughputWinner}**.
- Кто лучше переносит маленькие сообщения: **${smallWinner}**.
- Кто лучше переносит большие сообщения (100KB): **${bigWinner}**.
- Точка деградации RabbitMQ: **${findDegradationPoint(rows, "rabbit")}**.
- Точка деградации Redis Pub/Sub: **${findDegradationPoint(rows, "redis")}**.
- Выбранный инструмент для сценария: **k6**, так как он воспроизводимо задаёт целевой rate, duration и экспортирует машинно-читаемую статистику.

## Скриншоты
- Добавьте скриншоты запуска \`docker compose ps\`, \`k6 run\`, графиков/таблиц из \`results/\` при сдаче работы.
`;

  await writeFile(reportPath, report, "utf8");
  console.log(`[report] generated: ${reportPath}`);
};

run().catch((error: Error) => {
  console.error("[report] failed:", error.message);
  process.exit(1);
});
