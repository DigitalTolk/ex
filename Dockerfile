# Single VERSION arg propagates to both the Vite bundle (via
# VITE_BUILD_VERSION → __BUILD_VERSION__) and the Go binary (via
# -ldflags -X main.Version). The frontend compares the running build's
# baked-in version against the version emitted on each WS handshake; a
# mismatch surfaces the "reload to pick up the latest" banner.
#
# CI should override VERSION to a real identifier (git sha or release
# tag). Local docker-compose builds default to the build timestamp,
# which still changes per rebuild so the banner correctly fires when
# you docker compose up --build a newer image while a stale tab is
# open.
ARG VERSION

# Stage 1: Build frontend
FROM node:24-alpine AS frontend
ARG VERSION
ENV VITE_BUILD_VERSION=${VERSION}
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Go binary
FROM golang:1.26-alpine AS backend
ARG VERSION
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /app/frontend/dist ./frontend/dist
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags "-X main.Version=${VERSION}" \
    -o /ex ./cmd/server

# Stage 3: Runtime
FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata
COPY --from=backend /ex /usr/local/bin/ex
EXPOSE 8080

# Docker probes /healthz to decide whether the container is ready —
# failures past `--retries` mark the container unhealthy so an
# orchestrator can restart it. BusyBox wget (already in alpine) is
# enough; --quiet suppresses the success line and -O - discards the
# response body so the log stays clean.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:8080/healthz || exit 1

ENTRYPOINT ["ex"]
