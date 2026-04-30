# Сравнение стратегий кеширования

Практика по ТЗ: три варианта одной системы (**Cache-Aside**, **Write-Through**, **Write-Back**) с **Redis**, **PostgreSQL**, единым **нагрузочным сценарием** и сбором метрик (throughput, задержка, обращения к БД, hit rate). Стек: **Node.js 20+**, **TypeScript**, **Fastify**.

## Требования

- Node.js 20+
- Docker Desktop (или иной Docker) с запущенным движком

## Быстрый старт

1. Скопируйте переменные окружения (при необходимости поправьте порты):

   ```powershell
   copy .env.example .env
   ```

2. Поднимите Redis и PostgreSQL:

   ```powershell
   docker compose up -d
   ```

3. Установите зависимости и заполните БД:

   ```powershell
   npm install
   npm run seed
   ```

4. Запуск приложения (выберите стратегию):

   ```powershell
   $env:CACHE_STRATEGY="cache-aside"; npx tsx src/server.ts
   ```

   Другие значения: `write-through`, `write-back`.

5. В другом терминале — один прогон нагрузки:

   ```powershell
   npx tsx src/benchmark.ts --profile read-heavy --base-url http://127.0.0.1:3000
   ```

6. Полная матрица **3×3** (все стратегии и профили `read-heavy` / `balanced` / `write-heavy`):

   ```powershell
   npm run bench:matrix
   ```

   Перед **каждой** ячейкой матрицы выполняется сброс таблицы `items` и повторный сид — одинаковое начальное состояние БД и пустой Redis для сопоставимости.

   Быстрый режим (короче интервал, меньше RPS):

   ```powershell
   $env:BENCH_QUICK="1"; npm run bench:matrix
   ```

   Результаты JSON: файл `bench-results.json` в корне проекта. В stderr выводится **Markdown-таблица** для вставки в отчёт.

7. Сгенерировать отчёт с проверкой метрик:

   ```powershell
   npm run report
   ```

   Перезапишет `REPORT.md` по данным `bench-results.json` (таблица, блок валидации, черновые выводы).

Параллельность нагрузки задаётся переменной **`BENCH_CONCURRENCY`** (по умолчанию выбирается от `target_rps`). Число запросов за прогон: `floor(duration_sec * target_rps)`.

## Сборка production-сервера

```powershell
npm run build
$env:CACHE_STRATEGY="write-through"; npm start
```

## HTTP API

| Метод | Путь | Описание |
|--------|------|----------|
| GET | `/health` | Готовность, текущая стратегия |
| GET | `/item/:id` | Чтение по стратегии |
| PUT | `/item/:id` | Тело JSON: `{ "value": "..." }` |
| GET | `/metrics` | Счётчики (hits/misses, DB, write-back flush) |
| POST | `/metrics/reset` | Сброс серверных метрик |

## Переменные окружения

См. [.env.example](.env.example). Важные:

- `DATABASE_URL`, `REDIS_URL` — подключения к контейнерам (по умолчанию Postgres на **5433**, чтобы не конфликтовать с локальным 5432).
- `CACHE_STRATEGY` — `cache-aside` | `write-through` | `write-back`.
- `WRITEBACK_FLUSH_INTERVAL_MS`, `WRITEBACK_FLUSH_BATCH` — фоновый сброс грязных ключей для write-back.

Параметры единого теста (матрица / бенч):

- `BENCH_QUICK=1` — укороченный прогон.
- `BENCH_DURATION_MS`, `BENCH_TARGET_RPS`, `BENCH_KEYS`, `BENCH_SEED`, `BENCH_BASE_URL`.

## Архитектура (сводка)

- **load-generator**: [`src/benchmark.ts`](src/benchmark.ts) — фиксированный RNG (`--seed`), одинаковое число ключей (`--keys`), длительность и целевой RPS; профили 80/50/20 % чтений.
- **application**: [`src/server.ts`](src/server.ts) + [`src/strategies/`](src/strategies/) — меняется только логика кеша.
- **cache**: Redis (`item:*`, множество `dirty:items` для write-back).
- **БД**: PostgreSQL, таблица `items`.

## Скриншоты для отчёта

Запустите `npm run bench:matrix` (или быстрый режим) и сделайте скриншоты:

1. Терминал с выводом матрицы (таблица в stderr).
2. При желании — лог сервера за один прогон.

Вставьте изображения в [`REPORT.md`](REPORT.md) в отмеченные места.

## Соответствие критериям на 10 баллов

| Критерий | Где в проекте |
|----------|----------------|
| 3 типа кеширования | `src/strategies/cacheAside.ts`, `writeThrough.ts`, `writeBack.ts` |
| Единый тест на все варианты | `src/benchmark.ts` + `npm run bench:matrix` |
| Метрики: RPS, latency, DB ops, hit rate | клиент в `benchmark.ts`, сервер `GET /metrics` |

Подробный отчёт с таблицей и выводами — в [REPORT.md](REPORT.md).
