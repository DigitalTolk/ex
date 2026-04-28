# The build version is derived at runtime from a SHA-256 of the embedded
# index.html, so no VERSION arg or ldflag plumbing is needed: any change
# to the bundle changes the hash and the running clients see the banner.

# Stage 1: Build frontend
FROM node:24-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Go binary
FROM golang:1.26-alpine AS backend
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /app/frontend/dist ./frontend/dist
RUN CGO_ENABLED=0 GOOS=linux go build -o /ex ./cmd/server

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
