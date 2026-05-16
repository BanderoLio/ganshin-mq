# Broko AMQP Broker - convenience runner.
# Use `make help` to list targets.

.PHONY: help build clean test sdk-smoke demo demo-up demo-down demo-logs broker docker-build

BUILD_DIR  := build
COMPOSE    := docker compose -f docker/docker-compose.yml

help:
	@echo "Broko — make targets:"
	@echo "  make build         собрать брокер (Release)"
	@echo "  make broker        запустить брокер локально на порту 5672"
	@echo "  make test          прогнать интеграционные тесты (брокер должен быть запущен)"
	@echo "  make sdk-smoke     прогнать smoke-тест самописного SDK"
	@echo "  make demo          поднять docker-compose демо (broker + 7 сервисов + Web UI)"
	@echo "  make demo-logs     показать логи демо в реальном времени"
	@echo "  make demo-down     остановить демо и удалить volumes"
	@echo "  make clean         удалить build/ и data/"
	@echo ""
	@echo "Web UI: http://localhost:15672  (admin / admin)"
	@echo "AMQP:   localhost:5672          (guest / guest)"

build:
	cmake -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=Release
	cmake --build $(BUILD_DIR) -j$$(nproc)

broker: build
	mkdir -p data
	./$(BUILD_DIR)/Broko 5672 ./data

test:
	cd test && npm install --no-audit --no-fund --silent && \
	    node test_connect.js && \
	    node test_full.js && \
	    node test_advanced.js && \
	    node test_persistence.js

sdk-smoke:
	cd sdk/broko-client-js && node examples/smoke.js

demo demo-up:
	bash scripts/run-demo.sh

demo-logs:
	$(COMPOSE) logs -f --tail=50

demo-down:
	$(COMPOSE) down -v

docker-build:
	$(COMPOSE) build

clean:
	rm -rf $(BUILD_DIR) data
