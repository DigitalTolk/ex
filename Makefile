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
	@echo "=== Go test (cmd — outside the coverage gate, but the migration CLIs stay tested) ==="
	go test ./cmd/...
	@echo "=== Go coverage gate (100%, see .testcoverage.yml + COVERAGE.md) ==="
	go run github.com/vladopajic/go-test-coverage/v2@v2.18.8 --config=.testcoverage.yml
	@echo "=== Frontend type-check ==="
	# `tsc --noEmit` on a project-references root tsconfig is a no-op
	# — it ignores `references` unless --build is set. The production
	# build (`npm run build`) uses `tsc -b`, so use the same here so
	# `make check` actually catches the same errors prod does.
	cd frontend && npx tsc -b --noEmit
	@echo "=== Frontend lint ==="
	cd frontend && npx eslint src/
	@echo "=== Frontend test ==="
	@tmp=$$(mktemp); \
		cd frontend && npx vitest run --coverage > "$$tmp" 2>&1; \
		status=$$?; \
		cat "$$tmp"; \
		if [ $$status -ne 0 ]; then \
			rm -f "$$tmp"; \
			exit $$status; \
		fi; \
		if grep -E '^(stderr|stdout) \|' "$$tmp" >/dev/null; then \
			echo "vitest emitted console output; keep tests quiet before passing make check" >&2; \
			grep -n -E '^(stderr|stdout) \|' "$$tmp" >&2; \
			rm -f "$$tmp"; \
			exit 1; \
		fi; \
		rm -f "$$tmp"
	@echo "=== Frontend browser test ==="
	cd frontend && npm run test:browser:coverage
	@summary=frontend/coverage-browser/coverage-summary.json; \
		if [ ! -f "$$summary" ]; then \
			echo "$$summary not produced by vitest — coverage gate cannot run" >&2; \
			exit 1; \
		fi; \
		coverage=$$(node -e "const s=require('./$$summary'); process.stdout.write(String(s.total.branches.pct))"); \
		if [ -z "$$coverage" ]; then \
			echo "$$summary did not contain total.branches.pct" >&2; \
			exit 1; \
		fi; \
		echo "browser branch coverage: $$coverage%"; \
		awk -v coverage="$$coverage" 'BEGIN { if (coverage + 0 < 100) { printf "browser branch coverage %.2f%% is below 100%%\n", coverage; exit 1 } }'
