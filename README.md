# Ex

A Slack-like team messaging application built with Go and React.

## Tech Stack

- **Backend**: Go (single binary with embedded frontend)
- **Frontend**: React + TypeScript + Vite + shadcn/ui
- **Database**: DynamoDB (single-table design)
- **Cache/PubSub**: Redis
- **Real-time**: WebSocket + Redis pub/sub
- **Auth**: OIDC SSO + email invites (guests), JWT sessions

## Prerequisites

- Docker & Docker Compose

## Quick Start

```bash
docker compose up --build
```

This builds the app using the production Dockerfile (frontend + Go binary) and starts it alongside DynamoDB Local and Redis.

- **App**: http://localhost:8080 (serves both API and frontend)

The DynamoDB table is created automatically on first start. The first user to log in via SSO is automatically promoted to admin.

```bash
# Or use the Makefile shortcuts:
make dev          # foreground (same as docker compose up --build)
make dev-up       # background
make dev-down     # stop all
make dev-logs     # tail logs
```

## SSO Configuration

The app uses OpenID Connect (OIDC) for authentication. The OIDC redirect URL is always `{BASE_URL}/auth/oidc/callback` (e.g. `http://localhost:8080/auth/oidc/callback`). Register this as the redirect URI in your identity provider.

### Microsoft Entra ID (Azure AD / MS365)

1. Go to [Azure Portal](https://portal.azure.com) > **Microsoft Entra ID** > **App registrations** > **New registration**
2. Set the **Redirect URI** to `http://localhost:8080/auth/oidc/callback` (or your production URL)
3. Under **Certificates & secrets**, create a new **Client secret** and copy the value
4. Note the **Application (client) ID** and **Directory (tenant) ID** from the Overview page
5. Set these environment variables:

```bash
OIDC_ISSUER=https://login.microsoftonline.com/{tenant-id}/v2.0
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
BASE_URL=http://localhost:8080
```

### Google Workspace

1. Go to [Google Cloud Console](https://console.cloud.google.com) > **APIs & Services** > **Credentials** > **Create OAuth client ID**
2. Set **Authorized redirect URIs** to `http://localhost:8080/auth/oidc/callback`
3. Set these environment variables:

```bash
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=your-client-id.apps.googleusercontent.com
OIDC_CLIENT_SECRET=your-client-secret
BASE_URL=http://localhost:8080
```

### Any OIDC Provider

Any provider that supports OpenID Connect Discovery (`.well-known/openid-configuration`) will work. Set `OIDC_ISSUER` to the issuer URL, and register `{BASE_URL}/auth/oidc/callback` as the redirect URI.

## Email Invites (SMTP)

To send invite links via email, configure the following environment variables:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
SMTP_FROM=noreply@yourcompany.com
```

When SMTP is not configured, invite links are logged to the server console.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `ENV` | `development` | `development` or `production` |
| `BASE_URL` | `http://localhost:8080` | Application base URL (used to derive OIDC redirect URL) |
| `OIDC_ISSUER` | - | OIDC provider issuer URL |
| `OIDC_CLIENT_ID` | - | OIDC client ID |
| `OIDC_CLIENT_SECRET` | - | OIDC client secret |
| `JWT_SECRET` | `dev-secret-change-me` (dev only) | JWT signing secret |
| `AWS_REGION` | `us-east-1` | AWS region |
| `DYNAMODB_TABLE` | `ex` | DynamoDB table name |
| `DYNAMODB_ENDPOINT` | - | DynamoDB endpoint (set for local dev) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `SMTP_HOST` | - | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP server port |
| `SMTP_USER` | - | SMTP username |
| `SMTP_PASS` | - | SMTP password |
| `SMTP_FROM` | - | Sender email address for invites |

## Build

```bash
# Build production binary (includes embedded frontend)
make build

# Build Docker image
make docker
```

## Architecture

- **Real-time**: WebSocket for server-to-client push, REST for everything else
- **Stateless servers**: Redis pub/sub enables horizontal scaling
- **DynamoDB single-table**: All entities in one table with composite keys
- **Embedded SPA**: Frontend built into the Go binary for single-artifact deployment
- **First user is admin**: The first person to log in via SSO gets the admin role
