# Docker builds bake release metadata into the binary. Pass GIT_TAG for
# releases; otherwise pass GIT_SHA and the build falls back to its short SHA.
#
# Build stages use Debian (trixie) variants to keep parity with the
# Debian 13 distroless runtime below; the final image is distroless so it
# ships only the static binary — no shell, package manager, or wget.

# Stage 1: Build frontend
FROM node:24-trixie AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Go binary
FROM golang:1.26-trixie AS backend
ARG GIT_TAG=""
ARG GIT_SHA=""
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /app/frontend/dist ./frontend/dist
RUN VERSION="${GIT_TAG:-${GIT_SHA}}" && \
    VERSION="${VERSION:-dev}" && \
    VERSION="$(printf '%s' "$VERSION" | cut -c1-12)" && \
    CGO_ENABLED=0 GOOS=linux go build \
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

# The runtime has no shell or wget, so Docker can't probe /healthz with a
# CLI. The binary probes itself instead: `ex healthcheck` GETs the local
# /healthz and exits 0 (healthy) or 1. Exec form — no shell required.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD ["ex", "healthcheck"]

ENTRYPOINT ["ex"]
