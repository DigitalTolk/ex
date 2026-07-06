# syntax=docker/dockerfile:1
#
# Docker builds bake release metadata into the binary. Pass GIT_TAG for
# releases; otherwise pass GIT_SHA and the build falls back to its short SHA.
#
# Build stages use Debian (trixie) variants to keep parity with the
# Debian 13 distroless runtime below; the final image is distroless so it
# ships only the static binary — no shell, package manager, or wget.
#
# The compose `app` service builds with `no_cache: true`, so every
# `docker compose up --build` re-runs `npm run build` and the Go compile from
# scratch — you can never ship a stale embedded SPA. The `--mount=type=cache`
# mounts below are NOT layer cache and survive `--no-cache`, so the npm package
# downloads, the Go module cache, and the Go build cache persist between builds:
# the guaranteed-fresh rebuild stays fast.

# Stage 1: Build frontend
FROM node:24-trixie AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Go binary
FROM golang:1.26-trixie AS backend
ARG GIT_TAG=""
ARG GIT_SHA=""
WORKDIR /app
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
COPY --from=frontend /app/frontend/dist ./frontend/dist
# The binary is compiled through Datadog Orchestrion, which weaves APM
# instrumentation (HTTP server/client, go-redis, AWS SDK v2 — see
# orchestrion.tool.go) into the build at compile time. This costs build time
# only: whether traces are actually produced is a RUNTIME decision via
# DD_TRACE_ENABLED (defaults to false in the runtime stage below), so the
# shipped image runs untraced unless a deployment opts in. Orchestrion's
# version is pinned through go.mod (`go run` resolves the module's version).
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    VERSION="${GIT_TAG:-${GIT_SHA}}" && \
    VERSION="${VERSION:-dev}" && \
    VERSION="$(printf '%s' "$VERSION" | cut -c1-12)" && \
    CGO_ENABLED=0 GOOS=linux go run github.com/DataDog/orchestrion go build \
      -ldflags="-X github.com/DigitalTolk/ex/internal/handler.BuildVersion=${VERSION}" \
      -o /ex ./cmd/server

# Stage 3: Runtime
# distroless/static-debian13 already ships ca-certificates and tzdata and
# runs as the unprivileged `nonroot` user (uid 65532). The static binary
# (CGO_ENABLED=0) is the only thing we add.
FROM gcr.io/distroless/static-debian13:nonroot
# Install to /usr/local/bin (the conventional FHS home for a locally-built
# binary) rather than dropping it at the filesystem root. distroless sets a
# standard PATH that includes /usr/local/bin, and Docker's exec form resolves
# bare command names against PATH (execvp), so `ex` below needs no path.
COPY --from=backend /ex /usr/local/bin/ex
EXPOSE 8080

# Datadog APM is compiled in (Orchestrion, see the build stage) but OFF by
# default — without this the injected tracer would start on boot and try to
# reach a local agent that usually isn't there. A deployment opts in by
# overriding: DD_TRACE_ENABLED=true, DD_AGENT_HOST=<agent>, DD_ENV=<env>
# (plus optionals like DD_VERSION / DD_TRACE_SAMPLE_RATE).
ENV DD_TRACE_ENABLED=false \
    DD_SERVICE=ex

# The runtime has no shell or wget, so Docker can't probe /healthz with a
# CLI. The binary probes itself instead: `ex healthcheck` GETs the local
# /healthz and exits 0 (healthy) or 1. Exec form — no shell required.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD ["ex", "healthcheck"]

ENTRYPOINT ["ex"]
