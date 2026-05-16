#!/usr/bin/env bash
# Запуск Broko демо: брокер + 7 микросервисов + Web UI sidecar.
# Поднимает docker-compose, ждёт healthcheck брокера, печатает URL и тейлит логи.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker/docker-compose.yml"

echo "==============================================="
echo "  Broko AMQP Broker — Demo"
echo "==============================================="
echo "  AMQP:   amqp://guest:guest@localhost:5672/"
echo "  Web UI: http://localhost:15672  (admin / admin)"
echo "==============================================="
echo ""

echo "[1/3] Сборка и запуск контейнеров..."
$COMPOSE up --build -d

echo ""
echo "[2/3] Ожидание готовности брокера..."
for i in $(seq 1 30); do
    if $COMPOSE ps broko 2>/dev/null | grep -q "healthy"; then
        echo "  → broker healthy"
        break
    fi
    sleep 1
    if [ "$i" -eq 30 ]; then
        echo "ERROR: broker did not become healthy in 30s"
        $COMPOSE logs broko | tail -30
        exit 1
    fi
done

echo ""
echo "[3/3] Статус сервисов:"
$COMPOSE ps
echo ""
echo "==============================================="
echo "  Готово! Откройте Web UI: http://localhost:15672"
echo "  Логин: admin / admin"
echo ""
echo "  Логи в реальном времени:  make demo-logs"
echo "  Остановка:                make demo-down"
echo "==============================================="
