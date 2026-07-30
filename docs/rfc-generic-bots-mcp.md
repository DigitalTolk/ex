# Generic bots + MCP for ex (Mattermost-shaped)

**Status:** Implemented (platform + MCP + Cliffy-on-platform landed; gaps noted in §8)
**Author:** Habib Altaf · **Reviewer:** Günter Grodotzki (CTO) · **Date:** 2026-07-29

This is the single design record for turning ex's hardcoded `@cliffy` assistant
into a **generic, Mattermost-shaped bot platform** with an **MCP** tool layer, on
which Cliffy runs as just one bot. It folds in the bot-identity decision, the MCP
transport/SDK decision (now built), and the Cliffy↔CliffHub bridge operator guide.

---

## 1. Background & direction

We shipped an in-chat assistant ("Cliffy"): you `@cliffy` in a channel/DM, it
replies in-thread, proposes task creation, and creates it in CliffHub on
confirmation. It worked, but the feedback was that it was **too hardcoded for one
use case**. The direction:

1. **Make bot functionality generic and Mattermost-compatible** — not a hardwired
   `@cliffy`, but a real bot/integration platform where Cliffy is *one* bot.
2. **Add MCP** so bots (and Cliffy) access tools/data through a standard protocol,
   instead of bespoke bridge + `writeApi` wiring.

**TL;DR:** ex *already had* a generic, MM-shaped bot-account platform (bot accounts
`bot_…`, `exbot_` tokens, token auth on every route, MM/Slack-compatible incoming
webhooks). Cliffy was a **separate legacy path** bypassing all of it. The work was:
**(A)** fill the generic gaps (event dispatch / outgoing webhooks), **(B)** add an
**MCP** tool layer, **(C)** re-express Cliffy as a normal bot on those rails.

## 2. Current state (what exists in-tree)

| Capability | Status | Where |
|---|---|---|
| Bot **accounts** (`bot_` id, `AuthProvider=bot`) | ✅ | `service/bot.go`, `model/bot.go`, `model/user.go` (`IsBotUserID`) |
| Bot **access tokens** (`exbot_…`, hashed, rotatable) | ✅ | `bot.go` (`IssueToken`/`ValidateBotToken`), `store/bot.go` |
| Bot **auth on all routes** (`exbot_` → same claims as a human) | ✅ | `middleware.AuthWithBots`, `handler/router.go` |
| Bot **admin CRUD API** (create bot, issue/revoke tokens, set webhook) | ✅ | `handler/bot.go`, `/api/v1/admin/bots…` |
| **Incoming webhooks** (post as bot; MM/Slack payload) | ✅ compatible | `service/webhook.go`, public `POST /hooks/{id}` |
| **Event dispatch** (notify a bot on `@mention` / thread reply) | ✅ | `service/botdispatch.go` (`RegisterBot`, `maybeDispatchToBots`) |
| **Outgoing webhooks** (HMAC-signed event → bot callback URL → reply) | ✅ ex's own contract | `service/webhookbot.go` (`webhookBotHandler`) |

**Honesty on "Mattermost-compatible":** incoming webhooks and the bot-account/token
model are genuinely MM/Slack-*compatible* (same payloads/auth). Outgoing webhooks
are **not**: ex POSTs its own JSON event signed with `X-Ex-Timestamp` + HMAC
`X-Ex-Signature`, where MM POSTs form-encoded fields with a body `token`. Only the
*reply* shape (`text` + `response_type`) is MM/Slack-style. So an existing MM
outgoing-webhook bot would **not** work against ex unchanged. Slash commands and
interactive message actions don't exist yet (§8). Net: ex is Mattermost-*shaped*
(D1), a deliberate design choice — not a drop-in Mattermost.
| **MCP server** (tool protocol over Streamable HTTP) | ✅ | `handler/mcp.go`, `/api/v1/mcp` behind `AuthWithBots` |
| **Slash commands** (register + MM request/response) | ❌ gap | designed, not wired (§8) |
| **Interactive message actions** (attachment buttons + callback) | ❌ gap | §8 |
| **Bot-admin frontend UI** | ❌ gap | backend exists; no `src` page |

## 3. The problem it replaced: Cliffy as a parallel hardcoded path

Cliffy originally did **not** use the `bot_`/`exbot_` platform — a sentinel author
`"cliffy"`, a literal `@cliffy` regex hooked into `MessageService.Send`, a
CliffHub-only bridge, and an agent proxy + `writeApi` passthrough with `/tasks/<id>`
and `type_id` semantics baked in. All single-tenant and CliffHub-specific — the
"hardcoded" the review called out.

**What stopped being hardcoded (now generalized):**

| Before (hardcoded to CliffHub) | Now |
|---|---|
| `"cliffy"` sentinel author | real `bot_cliffy` account (any bot uses the same path) |
| literal `@cliffy` regex in `Send` | generic mention / thread-reply dispatch (`botdispatch.go`) |
| CliffHub bridge baked into the message path | Cliffy is a registered `BotHandler`; ex core knows nothing of tasks |
| — | ex is an **MCP server**; any MCP agent can read/post in ex |

**By design**, each app still brings *its own* tools and *its own* "act-as-user"
mapping (see §5). That belongs in the app / its MCP server — which is exactly why
it stops being hardcoded *in ex*.

## 4. Architecture — three tracks

- **Track A — generic bot platform (MM-shaped).** `botdispatch.go` generalizes the
  old Cliffy trigger into a **registry keyed by bot user id**. On send, if a message
  `@mentions` a `bot_` user (or is a thread reply a bot owns), the event is
  dispatched to that bot's handler — either an **in-process** responder (bots we
  host, like Cliffy) or an **outgoing webhook** (`webhookbot.go`: HMAC-signed event
  POSTed to the bot's callback URL, reply posted back). The webhook is the portable
  contract that lets *external* bots integrate; in-process is an optimization on the
  *same* contract.
- **Track B — MCP tool access.** `handler/mcp.go` stands up an MCP server in ex over
  Streamable HTTP, mounted at `/api/v1/mcp` behind `AuthWithBots`. v1 tools are thin
  wrappers over existing service methods — `postMessage`, `readChannel` (plus
  `whoami`/`ping`) — each acting with the caller's identity and access-checked like
  the equivalent REST call. See §6.
- **Track C — Cliffy as a bot.** Cliffy is a real `bot_cliffy` account
  (`EnsureBot`), triggered via Track A dispatch, replying through the platform. Its
  in-chat handler (`handler/cliffy_inchat.go`) implements `BotHandler`; confirm-first
  writes, threaded continuity, and "typing…" are ordinary bot behaviors. It reaches
  CliffHub via the identity bridge (§7). (Note: because ex's *outgoing*-webhook
  contract is bespoke, not MM's, a bot is portable across ex's own bot models — not
  a drop-in against a real Mattermost server; see the honesty note in §2.)

## 5. Bot identity & "act-as-user" (decided, implemented)

Two identity models collided: Cliffy acted **as the asking human** (bridge mints a
CliffHub token per ex user), while the bot platform returns the **bot's own**
identity. Resolution — **ex never impersonates a user to a bot, and a bot never
posts as a user.** Three explicit roles:

1. **Platform identity (posts in ex): the bot.** A reply is authored by the `bot_`
   account; actions via its `exbot_` token are the bot's own, under its membership.
2. **Requester identity (who asked): data, enforced as a ceiling.** Every dispatched
   event carries the asking user's id (`BotEvent.AskerID`). `postBotReply`
   access-checks the asker before posting — a bot can't be driven to speak where the
   asker can't. `AskerID` is an attested fact ex vouches for (HMAC-signed for
   external bots), **not** a credential.
3. **Target-app identity (act-as-user in CliffHub/Jira/…): the bot's problem, via
   that app's own auth.** ex never mints or forwards user credentials for other apps.
   Cliffy acts as the user in CliffHub through its own bridge; a future MCP server
   would do its own per-user auth from the attested `AskerID`.

**MCP** follows the same rule: tools authorize by the calling `exbot_` token (the
bot's membership), never a user credential. **Out of scope:** ex issuing
OAuth/token-exchange for third-party apps on a user's behalf.

## 6. MCP — decision & status

**Decisions:** Streamable HTTP (ex is a long-lived service — one mounted route, no
subprocess; stdio doesn't apply). Official `modelcontextprotocol/go-sdk` (v1.7.0).
Auth reuses `AuthWithBots` — `exbot_` bearer → bot identity; tool reach = the bot's
membership. v1 tools are thin wrappers over service methods, no new business logic.

**MCP is a tool-access protocol, not the model runtime.** The LLM turn lives in
CliffHub's Next agent (`handler/cliffy.go` proxies its SSE). MCP carries discrete
`tools/call` request/response, not the token stream — "the agent turn runs over MCP"
is a category error and a non-goal.

**Status — built:** `handler/mcp.go` exposes `postMessage` + `readChannel` (act as
caller, access-checked) plus `whoami`/`ping`. Proven by `mcp_test.go`: an in-process
round-trip and a full HTTP test (`TestMCPServer_HTTPToolsRunAsCaller`) that drives
the real SDK client over HTTP through an auth-injecting middleware and asserts the
tools act as the authenticated caller. Live `initialize` handshake verified (401
without a token; 200 with). **Later:** per-tool consent, an ex MCP *client* consuming
a CliffHub MCP server (retiring the `writeApi` bridge).

## 7. Cliffy ↔ CliffHub bridge (operator guide)

Cliffy's brain and CliffHub's task API stay in CliffHub; ex is a *client*. The one
hard prerequisite is **identity**: an ex user acts as their own CliffHub identity so
tasks get the right reporter and RBAC.

```
ex user (OIDC/JWT)                         CliffHub (Sanctum + Spatie RBAC)
  │  1. sign short-lived HS256 assertion (iss=ex, aud=cliffy-bridge, email=<user>)
  │─────── POST /api/ai/bridge/mint { assertion } ───────▶  verify sig+iss+aud+freshness
  │◀────── { token, expires_at, employee } ──────────────  mint Sanctum token (short TTL)
  │  2. hold token server-side; proxy Cliffy's calls on the user's behalf
```

- The assertion's HMAC signature **is** the credential — the mint route has no
  `auth:sanctum`; only ex's backend can produce a valid assertion.
- The minted token is **never** sent to the browser. ex holds it server-side, so the
  browser only ever talks to ex's origin — **CORS to CliffHub is a non-issue**.
- Guests (no CliffHub `Employee`) → 403 → Cliffy shows "unavailable".
- Sanctum tokens carry `['*']` abilities; containment is **short TTL + no sliding +
  revoke-on-logout**, not ability-scoping. Trust anchor is the shared OIDC tenant;
  email is the v1 match key.

**Config — ex** (`internal/config/config.go`), all `CLIFFY_*` set together or not at all:

| Env | Meaning |
|---|---|
| `CLIFFY_BRIDGE_SECRET` | Shared HMAC secret (≥32 chars outside dev). Signs the assertion. |
| `CLIFFY_BRIDGE_MINT_URL` | CliffHub mint URL (`…/api/ai/bridge/mint`). |
| `CLIFFY_AGENT_URL` | CliffHub Next agent (`…/api/ai/chat`). Empty → session probe works, chat 503. |
| `CLIFFY_WEB_BASE` | CliffHub web app base for task links (e.g. `https://cliffhub.example`). |

**Config — CliffHub** (`config/services.php → cliffy_bridge`): `CLIFFY_BRIDGE_SECRET`
(must match ex), `CLIFFY_BRIDGE_TOKEN_TTL` (900s), `CLIFFY_BRIDGE_ASSERTION_MAX_AGE`
(60s), `CLIFFY_BRIDGE_TOKEN_NAME` (`cliffy-bridge`; `SlideTokenExpiration` skips it).

**Code map — ex:** `service/cliffybridge.go` (sign/mint/cache/refresh) ·
`handler/cliffy.go` (`/api/v1/cliffy/{session,chat,api}` — bridged token injected
server-side, writes SSRF-guarded + cost-capped) · `handler/cliffy_inchat.go` (the
`BotHandler`: dispatch, confirm-first writes, thread history, typing) ·
`store/redis_cliffy_inchat.go` (pending-action store). **Frontend:**
`src/features/cliffy/*` (launcher/panel widget + `/cliffy` command detection in the
chat views). **CliffHub:** `CliffyBridgeController` + `CliffyBridgeService` +
`SlideTokenExpiration` (skips bridge tokens) + `CliffyBridgeMintTest` (Pest).

**Hardening in place:** revoke-on-logout (`POST /api/v1/cliffy/revoke` → clears ex
cache + CliffHub token delete); per-user cost caps (chat 30/min + 300/day, writes
60/min); structured audit `slog`; every write requires client-side human approval
(the `writeApi` card) — ex only forwards approved, SSRF-guarded writes and never
feeds raw channel messages to the agent as instructions (only the conversation
*name* as context).

## 8. Gaps / not yet done

- **Slash commands & interactive actions** — designed, not wired (confirm-first is
  currently phrase-classified, not an attachment-button callback).
- **Bot-admin UI** — backend API exists; no `src` page yet.
- **Cliffy widget vs in-chat** — the standalone `CliffyLauncher`/`CliffyPanel` widget
  still ships alongside the in-chat `@cliffy` bot; consolidating onto the bot path is
  a follow-up product decision.
- **Live external-bot run** — outgoing-webhook transport is unit-tested; no external
  bot exercised end-to-end yet.
- **Live MCP `tools/call` with a real `exbot_` token** — covered hermetically by the
  HTTP test; a live smoke against the running server is pending.
- **Cliffy live agent run** — point `CLIFFY_AGENT_URL` at a running CliffHub agent and
  drive a real turn.

## 9. Decisions, risks, non-goals

- **D1 — MM-*shaped*, not literal `/api/v4`.** Adopt MM's bot/webhook/slash *patterns
  and payloads* on ex's own `/api/v1`. Literal `/api/v4` is a large permanent surface
  whose only payoff is running MM's ecosystem verbatim — not our goal.
- **D2 — ex as an MCP server first; Cliffy as an MCP client of CliffHub second.**
- **D3 — both hosting models; the outgoing webhook is the generic contract**,
  in-process responders an optimization on the same event contract.
- **Risks:** literal MM compat balloons scope (mitigated by D1); MCP was greenfield
  (de-risked — now built and tested).
- **Non-goals:** MM plugin system, full MM websocket API, migrating MM data,
  running the agent/LLM turn over MCP, ex issuing delegated third-party user auth.
