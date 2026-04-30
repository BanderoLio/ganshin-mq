# Отчёт: сравнение типов кеширования

## Параметры прогона

| Параметр | Значение |
|----------|----------|
| Длительность (настройка матрицы), мс | 10000 |
| Целевой RPS | 120 |
| Ключей | 50 |
| Seed RNG | 42 |
| Базовый URL | http://127.0.0.1:3000 |

## Описание тестов

Один генератор нагрузки ([benchmark.ts](src/benchmark.ts)): предрасчёт списка операций (read/write + id) по seed и профилю; объём запросов = floor(duration_s * target_rps); выполнение с ограниченной параллельностью. Перед каждой ячейкой матрицы — TRUNCATE + сид + сброс Redis ([bench-matrix.ts](src/bench-matrix.ts)).

Метрики: **throughput** = успешные запросы / фактическое время прогона; **latency** — RTT на клиенте; **db_reads/db_writes** — счётчики на сервере; **hit rate** — hits/(hits+misses) на чтениях; для write-back — **dirty_keys_peak**, **flush_runs**.

## Проверка валидности

Проверки пройдены: для каждой ячейки hits+misses=reads, db_reads=misses, ok+err=planned, hit rate согласован с hits/misses; для cache-aside и write-through — db_writes равно числу HTTP-записей; для write-back объём записей в БД задаётся flush и может отличаться от числа PUT.

## Таблица результатов

| Стратегия | Профиль | Запланировано | RPS | Lat avg ms | Lat p95 ms | DB reads | DB writes | Hit rate | Dirty peak | Flush |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cache-aside | read-heavy | 1200 | 827.0 | 70.73 | 209.96 | 306 | 249 | 67.8% | 0 | 0 |
| cache-aside | balanced | 1200 | 900.2 | 66.09 | 131.38 | 356 | 623 | 38.3% | 0 | 0 |
| cache-aside | write-heavy | 1200 | 826.4 | 71.83 | 183.89 | 196 | 961 | 18.0% | 0 | 0 |
| write-through | read-heavy | 1200 | 1083.0 | 54.69 | 149.30 | 75 | 249 | 92.1% | 0 | 0 |
| write-through | balanced | 1200 | 922.4 | 63.73 | 137.86 | 46 | 623 | 92.0% | 0 | 0 |
| write-through | write-heavy | 1200 | 915.3 | 64.63 | 163.90 | 20 | 961 | 91.6% | 0 | 0 |
| write-back | read-heavy | 1200 | 1185.8 | 48.89 | 103.77 | 71 | 98 | 92.5% | 48 | 2 |
| write-back | balanced | 1200 | 1136.4 | 51.71 | 130.05 | 37 | 101 | 93.6% | 50 | 3 |
| write-back | write-heavy | 1200 | 1053.6 | 56.53 | 98.50 | 14 | 150 | 94.1% | 50 | 3 |

## Скриншоты

### Вывод npm run bench:matrix (таблица и JSON по ячейкам)

![Результат матрицы прогонов в консоли](public/output.png)

### Логи сервера (Fastify, write-back, запросы PUT)

![Логи приложения при нагрузке](public/logs.png)

## Выводы

### Чтение (read-heavy)

- Hit rate (read-heavy): лучше у **write-back** (92.5%). При случайном доступе к **50** ключам доля попаданий ограничена; cache-aside при записи снимает ключ с кеша — на balanced профиле hit rate обычно ниже, чем у write-through.
- По средней задержке (ниже лучше): **write-back** (~48.89 ms).

### Запись (write-heavy)

- **Write-back** даёт меньше синхронных обращений к БД на путь записи (запись в Redis), нагрузка на PG снимается flush'ами; пик dirty и число flush видны в таблице.
- Максимальный клиентский RPS в прогоне: **write-back** (~1053.6 req/s).

### Смешанная нагрузка (balanced)

- Компромисс latency / throughput: смотрите колонки RPS и Lat avg; ориентир по «сводной» метрике в автотексте: **write-back**.

_Выводы сгенерированы по числам из `bench-results.json`; при необходимости отредактируйте вручную._

---

_Файл сгенерирован командой npm run report. Исходные данные: bench-results.json._
