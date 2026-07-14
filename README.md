# ex

[![CI](https://github.com/DigitalTolk/ex/actions/workflows/ci.yml/badge.svg)](https://github.com/DigitalTolk/ex/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/DigitalTolk/ex/badge.svg?branch=main)](https://coveralls.io/github/DigitalTolk/ex?branch=main)

A team messaging application built with Go and React.

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

Workspaces on Entra ID can additionally enable the tighter [Microsoft 365 Integration](#microsoft-365-integration-optional) (directory profile sync + the `/mstmeetings` slash command).

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

## Microsoft 365 Integration (optional)

When the workspace signs in through Microsoft Entra ID, setting `MS_TENANT_ID` enables a tighter Microsoft 365 integration — with **no per-user account linking**, because the app authenticates against Microsoft Graph app-only (client credentials) using the same app registration the workspace already signs in through:

- **Profile enrichment** — each SSO login syncs the user's phone number and manager from the directory onto their Ex profile (hover card + directory page), broadcast live via `user.updated`. Values come from Entra ID's `mobilePhone`/`businessPhones` fields and the manager assignment, so they only appear for users whose directory profiles have them filled in. The OIDC email claim is the source of truth for identity; directory lookups resolve it against the `mail` attribute first with UPN as fallback, so tenants where logins differ from mailbox addresses (UPN `first.last@…` vs mail `first@…`) work throughout. A periodic re-sync (every `MS_PROFILE_SYNC_INTERVAL`, default 12h; Redis-lock elected so a cluster sweeps once) refreshes every user without waiting for their next login — the first sweep runs at boot and backfills existing users.
- **Offboarding sync** — the same sweep mirrors directory existence onto account status: an SSO user deleted in Entra is deactivated (refresh tokens wiped, live sessions force-logged-out — SSO removal alone doesn't end an existing session) and automatically reactivated if the directory account reappears. Safety rails: only an AAD-object-id keyed 404 counts as "deleted" (an email-keyed miss may just mean email ≠ UPN), and a circuit breaker refuses to deactivate more than max(3, 10% of users) in one sweep — a tenant/app-registration misconfiguration makes every lookup 404 and must not read as company-wide offboarding.
- **`/mstmeetings` slash command** — creates a Microsoft Teams online meeting organized by the invoking user and posts the join link into the chat. Everyone in the current chat (channel, group or DM) is placed on the meeting roster (by AAD object id, granting direct join/lobby-bypass), but Teams does **not** ring or send calendar invites for ad-hoc online meetings: the chat message *is* the invitation. In channels it leads with `@all`, so every member is alerted through the normal notification pipeline — desktop popup, and the deferred mobile push when they're away or offline — subject to their own mute/group-mention preferences. Teams-native ringing would require a registered calling bot (`Calls.InitiateGroupCall.All` + an Azure Bot resource with a public callback endpoint) and is deliberately not included. Join-link messages are excluded from search indexing (stale meeting URLs are noise, not content).

Without `MS_TENANT_ID`, everything below is disabled and the app behaves exactly as before.

There is no separate "enable Graph" switch in Azure — Microsoft Graph is always available. Setup is two things in Azure plus one Teams policy:

### 1. Add the application permissions (Azure Portal)

1. [Azure Portal](https://portal.azure.com) > **Microsoft Entra ID** > **App registrations** > your app (the one whose client ID is in `OIDC_CLIENT_ID`)
2. **API permissions** > **Add a permission** > **Microsoft Graph** > **Application permissions** (⚠️ not *Delegated* — the app calls Graph as itself, with no signed-in user)
3. Add:
   - `User.Read.All` — read phone + manager from the directory
   - `OnlineMeetings.ReadWrite.All` — create Teams meetings
4. Click **Grant admin consent for \<tenant\>** — the Status column must show a green check. Without this step the permissions sit there un-consented and every Graph call returns 403.

### 2. Grant the Teams application access policy (PowerShell)

Graph's rule for **app-only** meeting creation is that permissions alone are not sufficient: the tenant must explicitly authorize the app to act on behalf of the organizing users via an [application access policy](https://learn.microsoft.com/graph/cloud-communication-online-meeting-application-access-policy). Run once as a Teams administrator:

```powershell
Install-Module MicrosoftTeams
Connect-MicrosoftTeams

New-CsApplicationAccessPolicy -Identity "ex-meetings" `
  -AppIds "<your-client-id>" `
  -Description "Allow Ex to create Teams meetings on behalf of users"

# Tenant-wide (simplest):
Grant-CsApplicationAccessPolicy -PolicyName "ex-meetings" -Global
```

To scope it instead, grant per user: `Grant-CsApplicationAccessPolicy -PolicyName "ex-meetings" -Identity "user@yourdomain.com"`. Propagation can take up to ~30 minutes — a 403 from `/mstmeetings` right after granting usually just means "wait a bit."

Profile enrichment needs only step 1 — if you skip step 2, logins still sync phone/manager and only meeting creation fails.

### 3. Configure Ex

```bash
MS_TENANT_ID={tenant-id}          # from the app registration's Overview page — enables the integration
MS_CLIENT_ID=...                  # optional — defaults to OIDC_CLIENT_ID
MS_CLIENT_SECRET=...              # optional — defaults to OIDC_CLIENT_SECRET
```

Restart and check the boot log for `Microsoft 365 integration enabled`.

### 4. Verify

- **Profiles**: log out and back in (the sync runs at SSO login, so existing sessions pick up data on their next login), then open your profile hover card — phone and manager should appear.
- **Meetings**: type `/mstmeetings` in any channel or DM and send — the join link should post into the chat. If it errors, check the server log: a Graph 403 there means the access policy (step 2) hasn't propagated or wasn't granted to that user.

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

| Variable             | Default                           | Description                                             |
|----------------------|-----------------------------------|---------------------------------------------------------|
| `PORT`               | `8080`                            | HTTP server port                                        |
| `ENV`                | `development`                     | `development` or `production`                           |
| `BASE_URL`           | `http://localhost:8080`           | Application base URL (used to derive OIDC redirect URL) |
| `OIDC_ISSUER`        | -                                 | OIDC provider issuer URL                                |
| `OIDC_CLIENT_ID`     | -                                 | OIDC client ID                                          |
| `OIDC_CLIENT_SECRET` | -                                 | OIDC client secret                                      |
| `MS_TENANT_ID`       | -                                 | Entra ID tenant — enables the Microsoft 365 integration (profile sync + `/mstmeetings`) |
| `MS_CLIENT_ID`       | `OIDC_CLIENT_ID`                  | Graph app-registration client ID override               |
| `MS_CLIENT_SECRET`   | `OIDC_CLIENT_SECRET`              | Graph app-registration client secret override            |
| `MS_PROFILE_SYNC_INTERVAL` | `12h`                       | Directory re-sync cadence (phone + manager for all users; first sweep at boot = backfill) |
| `JWT_SECRET`         | `dev-secret-change-me` (dev only) | JWT signing secret (`openssl rand -base64 48`)          |
| `AWS_REGION`         | `us-east-1`                       | AWS region                                              |
| `DYNAMODB_TABLE`     | `ex`                              | DynamoDB table name (single-table design — see below)   |
| `DYNAMODB_ENDPOINT`  | -                                 | DynamoDB endpoint (set for local dev)                   |
| `REDIS_URL`          | `redis://localhost:6379`          | Redis connection URL                                    |
| `ACCESS_LOG_ENABLED` | `true`                            | Set `false` to silence per-request logs except 5xx responses |
| `SMTP_HOST`          | -                                 | SMTP server hostname                                    |
| `SMTP_PORT`          | `587`                             | SMTP server port                                        |
| `SMTP_USER`          | -                                 | SMTP username                                           |
| `SMTP_PASS`          | -                                 | SMTP password                                           |
| `SMTP_FROM`          | -                                 | Sender email address for invites                        |
| `SENTRY_FRONTEND_DSN`| -                                 | Enables Sentry in the SPA (served as a meta tag to browsers + both native shells) |
| `SENTRY_FRONTEND_TRACES_SAMPLE_RATE` | `0` (off)         | Sentry browser performance tracing sample rate (0..1)  |
| `SENTRY_FRONTEND_REPLAY_SESSION_SAMPLE_RATE` | `0` (off) | Sentry session replay: sample rate for all sessions (0..1) |
| `SENTRY_FRONTEND_REPLAY_ERROR_SAMPLE_RATE` | `0` (off)   | Sentry session replay: sample rate for sessions with an error (0..1) |

### Datadog APM (optional)

The Docker image is compiled through [Orchestrion](https://github.com/DataDog/orchestrion),
so APM instrumentation (HTTP server/client, Redis, AWS SDK v2 — the set lives in
`orchestrion.tool.go`) is baked in at compile time. Tracing is **off by default**
(`DD_TRACE_ENABLED=false` in the image); a deployment opts in purely via environment:

| Variable                | Example          | Description                                    |
|-------------------------|------------------|------------------------------------------------|
| `DD_TRACE_ENABLED`      | `true`           | Turn the compiled-in tracer on                 |
| `DD_AGENT_HOST`         | `datadog-agent`  | Datadog agent host (default `localhost`)       |
| `DD_ENV`                | `production`     | Environment tag on all traces                  |
| `DD_SERVICE`            | `ex` (default)   | Service name                                   |
| `DD_VERSION`            | `v0.0.57`        | Version tag on all traces                      |
| `DD_TRACE_SAMPLE_RATE`  | `1.0`            | Trace sampling rate                            |

Plain `go build` / `go test` remain uninstrumented — Orchestrion only runs in the
Docker build, and its version is pinned through `go.mod`.

## Build

```bash
# Build production binary (includes embedded frontend)
make build

# Build Docker image
make docker
```

## DynamoDB

Despite the name, `DYNAMODB_TABLE` configures **a single table**, not a prefix. The app follows the [DynamoDB single-table design](https://aws.amazon.com/blogs/compute/creating-a-single-table-design-with-amazon-dynamodb/): every entity (users, channels, conversations, messages, memberships, invites, refresh tokens, settings, …) lives in one table, distinguished by composite `PK`/`SK` prefixes (`USER#`, `CHAN#`, `MSG#`, …) plus two GSIs.

### Local development

The dev stack creates the table for you on first start — `EnsureTable` runs only when `ENV=development` and is a no-op when the table already exists.

### Production — pre-create the table

In production the binary will **not** create or modify the table; that responsibility lives with your infrastructure tooling so the running app needs only `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem`, `dynamodb:TransactWriteItems`, `dynamodb:BatchWriteItem` — never `CreateTable`.

Create the table once with the AWS CLI (replace `ex` with your `DYNAMODB_TABLE` value if different):

```bash
aws dynamodb create-table \
  --table-name ex \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
      AttributeName=PK,AttributeType=S \
      AttributeName=SK,AttributeType=S \
      AttributeName=GSI1PK,AttributeType=S \
      AttributeName=GSI1SK,AttributeType=S \
      AttributeName=GSI2PK,AttributeType=S \
      AttributeName=GSI2SK,AttributeType=S \
  --key-schema \
      AttributeName=PK,KeyType=HASH \
      AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes '[
    {
      "IndexName": "GSI1",
      "KeySchema": [
        {"AttributeName": "GSI1PK", "KeyType": "HASH"},
        {"AttributeName": "GSI1SK", "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"}
    },
    {
      "IndexName": "GSI2",
      "KeySchema": [
        {"AttributeName": "GSI2PK", "KeyType": "HASH"},
        {"AttributeName": "GSI2SK", "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"}
    }
  ]'

# Enable TTL so expired refresh tokens / invites are auto-evicted.
aws dynamodb update-time-to-live \
  --table-name ex \
  --time-to-live-specification "Enabled=true, AttributeName=ttl"
```

If you prefer Terraform / CloudFormation / CDK, replicate the same shape: `PK`+`SK` primary key, two GSIs (`GSI1`/`GSI2`) each with `*PK`+`*SK` and `ProjectionType=ALL`, and a TTL on the `ttl` attribute.

### Key prefixes (per parent partition)

A parent partition (`PK = CHAN#<id>` or `PK = CONV#<id>`) holds the parent's messages plus a few index rows that let the sidebar's "pinned" and "files" panes load in O(pinned) / O(files-shared) instead of scanning every message:

| `SK` prefix | Item               | Lifecycle                                                                                                |
| ----------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `MSG#`      | Message            | Created on send; soft-deleted on delete.                                                                 |
| `PIN#`      | Pinned-message ref | Written when a message is pinned; removed on unpin or message delete. Listed by `Query SK begins_with`.  |
| `FILE#`     | Shared-file ref    | Upserted per `(parent, attachmentID)` on every send/edit that references the file; removed on delete only when the row's `MessageID` still points at the deleted message (re-shares survive). |

`PIN#` and `FILE#` rows live alongside the `MSG#` rows in the same DDB partition, so listing them is a single `Query` against `PK` + `begins_with(SK, "PIN#")` (no GSI). The dedicated row also lets `ListPinned` / `ListFiles` skip the legacy 1000-message scan that previously bounded both queries' accuracy.

**Existing deployments must run this migration once after upgrading** — `ListPinned` and `ListFiles` read exclusively from `PIN#` / `FILE#` rows when the index is wired (always, in production), so pre-rollout messages whose pins and attachments never got indexed will show up as empty Files / Pinned panels until the backfill runs.

```bash
# Preview (default — no writes)
go run ./cmd/migrate-parent-index --dry-run

# Apply: writes one PIN# row per pinned message and one FILE# row
# per shared attachment (latest sharer wins). Idempotent; safe to
# re-run after a crash. Requires the same AWS_REGION /
# DYNAMODB_TABLE / DYNAMODB_ENDPOINT env vars as the server.
go run ./cmd/migrate-parent-index --apply
```

**Local dev (docker compose)** — DynamoDB Local lives inside the `dynamodb` container; point the migrator at it from the host:

```bash
# Preview against the running stack:
AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=dummy \
AWS_SECRET_ACCESS_KEY=dummy \
DYNAMODB_TABLE=ex \
DYNAMODB_ENDPOINT=http://localhost:8000 \
  go run ./cmd/migrate-parent-index --dry-run

# Same shape with --apply when you're ready to write.
AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=dummy \
AWS_SECRET_ACCESS_KEY=dummy \
DYNAMODB_TABLE=ex \
DYNAMODB_ENDPOINT=http://localhost:8000 \
  go run ./cmd/migrate-parent-index --apply
```

The AWS credentials are mandatory but their values don't matter — DynamoDB Local accepts anything; the SDK just refuses to start without a key pair set.

The script is read-mostly: it scans every parent's `MSG#` rows once and writes ~1 index row per pinned message + ~1 per shared attachment. Storage impact is bounded by `parents × (pinned_messages + unique_attachments)` — typically negligible vs. message volume.

### Thread-delete backfill (`cmd/migrate-thread-delete`)

Deleting a thread root now cascades: every reply is soft-deleted too, and the server rejects new replies to a deleted thread (`409`). Threads deleted **before** this shipped left their replies live — the root renders as a "(Message deleted)" tombstone while its replies are still visible. Run this one-off once after upgrading to tombstone those orphaned replies so historical data matches the new invariant.

```bash
# Preview (default — no writes)
go run ./cmd/migrate-thread-delete --dry-run

# Apply: tombstones every reply whose thread root is already deleted.
# Idempotent (already-deleted replies are skipped); safe to re-run.
# Same AWS_REGION / DYNAMODB_TABLE / DYNAMODB_ENDPOINT env vars as the server.
go run ./cmd/migrate-thread-delete --apply
```

The same DynamoDB Local env-var shape shown above for `migrate-parent-index` applies here. No events are published — these threads were closed long ago and no client is watching them.

## Architecture

- **Real-time**: WebSocket for server-to-client push, REST for everything else
- **Stateless servers**: Redis pub/sub enables horizontal scaling
- **DynamoDB single-table**: All entities in one table with composite keys
- **Embedded SPA**: Frontend built into the Go binary for single-artifact deployment
- **First user is admin**: The first person to log in via SSO gets the admin role
