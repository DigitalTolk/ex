.PHONY: dev dev-up dev-down dev-logs build frontend run docker clean deps check check-dist-placeholder types check-types-drift

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
	npm ci && npm run build

# Run Go server directly (requires DynamoDB + Redis already running)
run:
	go run ./cmd/server

# Build production Docker image
docker:
	docker build -t ex:latest .

# Clean build artifacts
clean:
	rm -rf bin/ coverage.out
	find dist -mindepth 1 ! -name .gitignore -exec rm -rf {} +

# Install Go dependencies
deps:
	go mod tidy

# Lint + test everything (backend and frontend)
check-dist-placeholder:
	@test -f dist/.gitignore || (echo "dist/.gitignore is required so frontend.go's //go:embed matches on fresh checkouts" >&2; exit 1)

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
	@echo "=== Wire-type drift (tygo) ==="
	$(MAKE) check-types-drift
	@echo "=== Frontend type-check ==="
	# `tsc --noEmit` on a project-references root tsconfig is a no-op
	# — it ignores `references` unless --build is set. The production
	# build (`npm run build`) uses `tsc -b`, so use the same here so
	# `make check` actually catches the same errors prod does.
	npx tsc -b --noEmit
	@echo "=== Frontend lint ==="
	npx eslint src/
	@echo "=== Frontend test (jsdom + browser projects, merged coverage) ==="
	@tmp=$$(mktemp); \
		npx vitest run --coverage > "$$tmp" 2>&1; \
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
	@node scripts/check-coverage-universe.mjs
	@summary=coverage/coverage-summary.json; \
		if [ ! -f "$$summary" ]; then \
			echo "$$summary not produced by vitest — coverage gate cannot run" >&2; \
			exit 1; \
		fi; \
		node -e "const s=require('./$$summary').total; const bad=['statements','branches','functions','lines'].filter(m=>s[m].pct<100); for (const m of ['statements','branches','functions','lines']) console.log('frontend '+m+' coverage (merged): '+s[m].pct+'%'); if (bad.length) { console.error('frontend merged coverage below 100% for: '+bad.join(', ')); process.exit(1); }" 

# Regenerate the TypeScript mirror of the Go wire types (internal/model).
types:
	go tool tygo generate

# Fail when src/types/generated.ts drifts from internal/model — regenerate
# side-effect-free (restore the committed file on mismatch so a failed check
# leaves the tree untouched).
check-types-drift:
	@cp src/types/generated.ts /tmp/ex-generated-types-check.ts; \
	go tool tygo generate; \
	if ! cmp -s src/types/generated.ts /tmp/ex-generated-types-check.ts; then \
		mv /tmp/ex-generated-types-check.ts src/types/generated.ts; \
		echo "src/types/generated.ts is stale — run 'make types' and commit the result" >&2; \
		exit 1; \
	fi; \
	rm -f /tmp/ex-generated-types-check.ts
