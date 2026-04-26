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
ENTRYPOINT ["ex"]
