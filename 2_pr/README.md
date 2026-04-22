# RabbitMQ vs Redis Pub/Sub Benchmark (2_pr)

Практика по сравнению `RabbitMQ` и `Redis Pub/Sub` в одинаковом стенде:

- единый ingest API;
- единый формат сообщения;
- одинаковые параметры прогонов (payload/rate/duration);
- единый consumer c замером latency;
- нагрузка через `k6` в Docker (локально `k6` ставить не нужно).

## 1) Что внутри

- `docker-compose.yml` - RabbitMQ + Redis + k6 image.
- `src/ingest-api.ts` - HTTP endpoint `/publish`, публикует в выбранный брокер.
- `src/consumer.ts` - читает сообщения, считает latency/processed/errors.
- `src/run-benchmarks.ts` - оркестратор прогонов.
- `k6/publisher.js` - нагрузочный сценарий.
- `results/` - сырые и агрегированные результаты.
- `report.md` - автоматически генерируемый отчет.

## 2) Требования

- Docker Desktop (или совместимый Docker Engine + Compose).
- Node.js 20+.
- npm 10+.

## 3) Быстрый запуск

Из директории `2_pr`:

```bash
npm install
npm run build
```

### Инфраструктура

```bash
npm run infra:up
```

### Один smoke-прогон

```bash
npx tsx src/run-benchmarks.ts --broker rabbit --payload 1024 --rate 1000 --duration 30s
```

или

```bash
npx tsx src/run-benchmarks.ts --broker redis --payload 1024 --rate 1000 --duration 30s
```

### Полная матрица экспериментов

```bash
npx tsx src/run-benchmarks.ts --full
npm run report:generate
```

### Остановка инфраструктуры

```bash
npm run infra:down
```

## 4) Параметры полной матрицы

`--full` запускает:

- brokers: `rabbit`, `redis`
- payload: `128B`, `1KB`, `10KB`, `100KB`
- rate: `1000`, `5000`, `10000`, `15000`, `20000` msg/s
- duration: `30s`

Итого: `2 * 4 * 5 = 40` сценариев.

## 5) Ключевые итоговые результаты (по `results/results-final.json`)

### 5.1 Сводка по брокерам (все 20 сценариев на брокер)

| Broker | Avg throughput (msg/s) | Max throughput (msg/s) | Avg p95 latency (ms) | Total sent | Total processed | Total lost | Avg CPU (%) | Avg RAM (MiB) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| RabbitMQ | 63.27 | 115.87 | 13696.85 | 228458 | 37963 | 190495 | 0.88 | 167.96 |
| Redis Pub/Sub | 494.08 | 1095.80 | 10498.90 | 296447 | 296447 | 0 | 0.37 | 3.79 |

### 5.2 Сравнение по размеру сообщения (усреднение по всем rate)

| Payload | Rabbit avg throughput | Redis avg throughput | Rabbit avg p95 | Redis avg p95 |
|---|---:|---:|---:|---:|
| 128B | 56.50 | 381.65 | 11547.60 | 15734.40 |
| 1KB | 84.62 | 935.99 | 2166.20 | 1366.00 |
| 10KB | 88.67 | 538.90 | 23504.20 | 3426.40 |
| 100KB | 23.30 | 119.77 | 17569.40 | 21468.80 |

### 5.3 Сравнение по интенсивности (усреднение по payload)

| Rate (msg/s) | Rabbit avg throughput | Redis avg throughput | Rabbit avg p95 | Redis avg p95 |
|---:|---:|---:|---:|---:|
| 1000 | 63.93 | 548.53 | 12641.75 | 7670.25 |
| 5000 | 77.72 | 443.62 | 11223.75 | 10271.75 |
| 10000 | 60.37 | 458.78 | 13890.25 | 11770.75 |
| 15000 | 49.93 | 623.48 | 18496.50 | 7502.75 |
| 20000 | 64.40 | 395.98 | 12232.00 | 15279.00 |

## 6) Анализ результатов

### 6.1 Пропускная способность

- В этом стенде Redis Pub/Sub показывает существенно более высокий throughput почти во всех группах.
- Пиковое значение Redis (`1095.8 msg/s`) значительно выше пика Rabbit (`115.87 msg/s`).
- На Rabbit во всех сценариях зафиксирован заметный `lost`, что резко снижает эффективную обработку.

### 6.2 Влияние размера сообщения

- Для обоих брокеров рост payload до `100KB` приводит к сильному росту latency и падению throughput.
- При `1KB` Redis демонстрирует лучший баланс throughput/latency.
- Для Rabbit рост payload особенно болезненный: p95 уходит в десятки секунд уже на `10KB` и выше.

### 6.3 Влияние интенсивности потока

- При увеличении rate оба брокера начинают деградировать по latency, но профиль разный:
  - Rabbit деградирует в основном через низкий processed и большой lost.
  - Redis чаще держит доставку (lost=0), но p95/avg latency резко растет на тяжелых комбинациях payload/rate.
- Для Redis на части сценариев виден скачкообразный характер производительности (ограничения по VUs/очередям на ingest пути).

### 6.4 Точка деградации single instance (по критерию: `lost>0` или `p95>2000ms`)

- RabbitMQ: `1000 msg/s`, payload `128B` (p95=9390ms, lost>0).
- Redis Pub/Sub: `1000 msg/s`, payload `10KB` (p95=3530ms).

## 7) Вывод по результатам

1. **Кто показал большую пропускную способность:** в текущей реализации стенда - **Redis Pub/Sub**.
2. **Кто лучше переносит рост размера сообщения:** по совокупности throughput в этом прогоне - **Redis Pub/Sub**, но на `100KB` у обоих сильная latency-деградация.
3. **Когда single instance начинает деградировать:**
   - Rabbit - уже на низких нагрузках (потери + высокий p95).
   - Redis - позже по delivery, но заметно по latency при росте payload/rate.
4. **Какой инструмент подходит лучше:** **k6**, так как дает воспроизводимый control по arrival-rate, удобный экспорт метрик и хорошо интегрируется в Docker-пайплайн.

## 8) Важные ограничения интерпретации

- Redis используется в режиме `Pub/Sub` (не durable queue), поэтому семантика доставки отличается от RabbitMQ очередей.
- В этом стенде итог сравнения отражает именно текущую реализацию ingest/consumer и выбранные ограничения (`single instance`, `maxVUs`, host ресурсы).
- Для академически более строгого сравнения "очередь vs очередь" имеет смысл повторить тест с `Redis Streams` и эквивалентной моделью ACK/retry.
