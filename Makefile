.PHONY: dev dev-up dev-down dev-logs build frontend run docker clean deps check

# VERSION is the build identifier baked into both the Go binary
# (-ldflags -X main.Version) and the Vite bundle (VITE_BUILD_VERSION).
# Derived from git so each new build differs — that's what makes the
# in-app upgrade banner fire on tabs left open across rebuilds.
VERSION ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
export VERSION

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
	go build -ldflags "-X main.Version=$(VERSION)" -o bin/ex ./cmd/server

# Build frontend assets
frontend:
	cd frontend && npm ci && VITE_BUILD_VERSION=$(VERSION) npm run build

# Run Go server directly (requires DynamoDB + Redis already running)
run:
	go run -ldflags "-X main.Version=$(VERSION)" ./cmd/server

# Build production Docker image
docker:
	docker build --build-arg VERSION=$(VERSION) -t ex:latest .

# Clean build artifacts
clean:
	rm -rf bin/ frontend/dist/ coverage.out

# Install Go dependencies
deps:
	go mod tidy

# Lint + test everything (backend and frontend)
check:
	@echo "=== Go lint ==="
	golangci-lint run ./...
	@echo "=== Go test (with integration) ==="
	go test -tags=integration -coverprofile=coverage.out -covermode=atomic ./internal/...
	@go tool cover -func=coverage.out | tail -1
	@echo "=== Frontend lint ==="
	cd frontend && npx eslint src/
	@echo "=== Frontend test ==="
	cd frontend && npx vitest run --coverage
