# Docker builds bake release metadata into the binary. Pass GIT_TAG for
# releases; otherwise pass GIT_SHA and the build falls back to its short SHA.

# Stage 1: Build frontend
FROM node:24-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Go binary
FROM golang:1.26-alpine AS backend
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
