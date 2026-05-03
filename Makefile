.PHONY: dev dev-up dev-down dev-logs build frontend run docker clean deps check check-dist-placeholder

# The app version is derived from a SHA-256 of the embedded index.html at
# server startup — no VERSION env-var to keep in sync between Go and Vite.

# Start the full local environment
dev:
	docker compose up --build

# Start in background
dev-up:
	docker compose up --build -d

# Stop all services
dev-down:
	docker compose down

# Tail logs
dev-logs:
	docker compose logs -f

# Build production binary (includes embedded frontend)
build: frontend
	go build -o bin/ex ./cmd/server

# Build frontend assets
frontend:
	cd frontend && npm ci && npm run build

# Run Go server directly (requires DynamoDB + Redis already running)
run:
	go run ./cmd/server

# Build production Docker image
docker:
	docker build -t ex:latest .

# Clean build artifacts
clean:
	rm -rf bin/ coverage.out
	find frontend/dist -mindepth 1 ! -name .gitignore -exec rm -rf {} +

# Install Go dependencies
deps:
	go mod tidy

# Lint + test everything (backend and frontend)
check-dist-placeholder:
	@test -f frontend/dist/.gitignore || (echo "frontend/dist/.gitignore is required so frontend.go's //go:embed matches on fresh checkouts" >&2; exit 1)

check:
	@echo "=== Dist placeholder ==="
	$(MAKE) check-dist-placeholder
	@echo "=== Go lint ==="
	golangci-lint run ./...
	@echo "=== Go test (with integration) ==="
	go test -tags=integration -coverprofile=coverage.out -covermode=atomic ./internal/...
	@coverage=$$(go tool cover -func=coverage.out | awk '/^total:/ { gsub(/%/, "", $$3); print $$3 }'); \
		echo "backend total coverage: $$coverage%"; \
		awk -v coverage="$$coverage" 'BEGIN { if (coverage + 0 < 92) { printf "backend coverage %.1f%% is below 92%%\n", coverage; exit 1 } }'
	@echo "=== Frontend type-check ==="
	# `tsc --noEmit` on a project-references root tsconfig is a no-op
	# — it ignores `references` unless --build is set. The production
	# build (`npm run build`) uses `tsc -b`, so use the same here so
	# `make check` actually catches the same errors prod does.
	cd frontend && npx tsc -b --noEmit
	@echo "=== Frontend lint ==="
	cd frontend && npx eslint src/
	@echo "=== Frontend test ==="
	cd frontend && npx vitest run --coverage
