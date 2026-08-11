# Generic bots + MCP for ex (Mattermost-shaped)

**Status:** Implemented (platform + MCP + Cliffy-on-platform landed; Mattermost
payload compatibility — outgoing webhooks, trigger words, slash commands,
interactive actions — landed; gaps noted in §8)
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
| **Event dispatch** (`@mention` / trigger word / thread reply) | ✅ | `service/botdispatch.go` (`RegisterBot`, `maybeDispatchToBots`) |
| **Outgoing webhooks** — MM form-encoded **or** ex signed JSON | ✅ compatible (MM transport) | `service/webhookbot.go` |
| **Trigger words** (MM's `trigger_word` / `trigger_when`) | ✅ compatible | `service/bottriggers.go` |
| **MCP server** (tool protocol over Streamable HTTP) | ✅ | `handler/mcp.go`, `/api/v1/mcp` behind `AuthWithBots` |
| **Slash commands** (register + MM request/response + `response_url`) | ✅ compatible | `service/extcommand.go`, `handler/extcommand.go` |
| **Interactive message actions** (attachment buttons/selects + callback) | ✅ compatible | `service/messageactions.go`, `handler/messageaction.go` |
| **Bot-admin frontend UI** | ✅ | `src/pages/BotsPage.tsx`, `src/components/admin/BotsPanel.tsx` |

**Where "Mattermost-compatible" now holds — and where it doesn't.** The three
integration *payloads* third-party bots actually depend on are emitted in MM's exact
wire shape, so an existing MM receiver works unchanged:

- **Incoming webhooks** — same payload (`text`, `channel`, `username`, `icon_url`,
  `icon_emoji`, `attachments`) and same semantics (`~channel`/`@user` targeting,
  `<!channel>`/`<url|label>` translation, creator-must-be-member).
- **Outgoing webhooks** — per-bot `transport`. `"mattermost"` POSTs MM's
  form-encoded fields (`token`, `team_id`, `channel_id`, `channel_name`, `user_id`,
  `user_name`, `post_id`, `text`, `trigger_word`, `timestamp`) with the shared
  secret as the body `token`. `"ex"` (the default for new bots) keeps ex's
  HMAC-signed JSON, which is strictly better authentication — a signature bound to
  a timestamp rather than a bearer token in the body.
- **Slash commands** — MM's form-encoded invocation, MM's response
  (`response_type`, `text`, `attachments`, `username`, `icon_url`,
  `goto_location`), and a working `response_url` for delayed replies
  (30-minute TTL, matching MM's documented window).
- **Interactive actions** — MM's attachment `actions` with `integration.{url,
  context}`, MM's action request (`user_id`, `channel_id`, `post_id`, `trigger_id`,
  `context`) and response (`ephemeral_text`, `update.{message,props.attachments}`).

**Still not a drop-in Mattermost server (D1).** ex serves `/api/v1`, not
`/api/v4`, so MM's *client libraries* (`mattermost-driver`, `mmpy_bot`) and its
plugin system do not work against ex. Doing that would need, beyond route
translation: a real unique `username` on `model.User` (plus a backfill — ex users
have only email + display name), a synthetic team threaded through every
team-scoped route, an id format MM clients accept (`bot_<ulid>` is 30 chars where
MM validates 26 lowercase alphanumerics), and a `/api/v4/websocket` speaking MM's
frame protocol. That remains a non-goal.

**Two documented approximations** in the MM payloads, both centralized in
`service/mmcompat.go`:

- `team_id` / `team_domain` are a **single synthetic team** — ex has no teams.
- `user_name` is **derived from the email local part** — ex has no usernames. It is
  a display label, not an identifier: it is not unique and nothing resolves a user
  from it. Receivers must key on `user_id`.

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
  CliffHub via the identity bridge (§7). (Note: an MM outgoing-webhook *receiver*
  now works against ex unchanged via the `"mattermost"` transport, but ex is still
  not a server MM's own client libraries can drive — see §2.)

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

**Config — ex** (`internal/config/config.go`). The secret is the on/off switch; the
three URLs default to **CliffHub production**, so any other environment must
override all three or it writes to the real CliffHub (boot logs a warning when it
detects that). Unset ⇒ the production default; explicitly empty ⇒ "none", which
means something different per row:

| Env | Meaning |
|---|---|
| `CLIFFY_BRIDGE_SECRET` | Shared HMAC secret (≥32 chars outside dev). Signs the assertion. **Unset ⇒ Cliffy is off.** |
| `CLIFFY_BRIDGE_MINT_URL` | CliffHub mint URL (`…/api/ai/bridge/mint`) — the LARAVEL API host. Empty alongside a secret ⇒ boot failure. |
| `CLIFFY_AGENT_URL` | CliffHub NEXT agent (`…/api/ai/chat`) — the web host. Empty ⇒ session probe and write passthrough work, chat 503s, in-chat `@cliffy` bot never registers. |
| `CLIFFY_WEB_BASE` | CliffHub web base for record links. Empty ⇒ derived from the agent URL's origin. |

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

- **Cliffy's confirm-first is still phrase-classified**, not an attachment-button
  callback — now that interactive actions exist, moving it onto a real
  Approve/Cancel button is a straightforward follow-up.
- **Interactive dialogs** — MM's `trigger_id`-authorized modal dialogs. ex mints and
  sends a `trigger_id` for payload compatibility but has nowhere to open a dialog,
  so an integration that opens one on the callback gets no modal.
- **Ephemeral posts** — ex has no ephemeral message in a channel. A slash command's
  ephemeral response works (it answers its live HTTP caller), but an ephemeral
  *bot-dispatch* reply is dropped and an ephemeral *delayed* command response is
  dropped: with no caller to answer, the safe direction is not posting.
- **Command rename** — the trigger is a claimed unique key, so renaming is
  delete + re-create rather than an in-place edit.
- **Cliffy widget vs in-chat** — the standalone `CliffyLauncher`/`CliffyPanel` widget
  still ships alongside the in-chat `@cliffy` bot; consolidating onto the bot path is
  a follow-up product decision.
- **Live external-bot run** — both transports are unit-tested against an httptest
  receiver; no real third-party MM bot exercised end-to-end yet. That is the one
  remaining proof that the compatibility claim above holds in practice.

## 8a. Test coverage of the bot platform

The whole surface in §2 is now at the repo's 100% statement gate (see COVERAGE.md),
including the parts that predated this work and had none: `store/bot.go` and
`store/redis_cliffy_inchat.go` were at 0%, `handler/bot.go` at 4%,
`handler/cliffy_inchat.go` at 4%, and `service/botdispatch.go`'s async half at 42%.

Three seams were added to make otherwise-untestable behaviour reachable, each
narrowing a concrete class of bug:

- **`handler.cliffyPendingStore`** — the in-chat pending store is an interface, so
  the confirm-first race (two "yes" replies, only one may execute the write) is
  tested deterministically instead of by timing. Note the trap this introduced and
  now guards against: assigning a nil `*store.CliffyInChatStore` to an interface
  field yields a *non-nil* interface, so `NewCliffyHandler` assigns it only when
  non-nil — otherwise every `h.inchat != nil` guard passes and then dereferences.
- **`handler.MessageActionInvoker`** — the action endpoint takes an interface, so
  its HTTP contract is tested without standing up the message service.
- **`service.CommandResponseStore`** — the delayed-response (`response_url`) store
  is an interface, so that path is tested without Redis.

Per the coverage policy, provably-dead error guards were deleted rather than
annotated: `json.Marshal` over all-string payloads (three sites), HMAC signing
with a `[]byte` key (now `service.mustSigned`), re-marshalling a value that just
came from `json.Unmarshal` (now `handler.mustJSON`), and a duplicated
not-configured branch in `ProxyAPI` that its own fail-fast guard already covered.
`CreateCommand` uses the package's existing `randRead` seam so its
randomness-failure arm stays reachable.
- **Live MCP `tools/call` with a real `exbot_` token** — covered hermetically by the
  HTTP test; a live smoke against the running server is pending.
- **Cliffy live agent run** — point `CLIFFY_AGENT_URL` at a running CliffHub agent and
  drive a real turn.

## 9. Decisions, risks, non-goals

- **D1 — MM-*shaped*, not literal `/api/v4`.** Adopt MM's bot/webhook/slash *patterns
  and payloads* on ex's own `/api/v1`. Literal `/api/v4` is a large permanent surface
  whose only payoff is running MM's ecosystem verbatim — not our goal. Refined by D4.
- **D4 — payload-level compatibility, deliberately.** Outgoing webhooks, slash
  commands, and interactive actions now speak MM's exact wire format, because that
  is what real MM integrations are built against — most "Mattermost bots" are
  webhook/slash-command integrations, not driver-based clients. This buys genuine
  compatibility without the permanent second public API surface (and the username
  migration) that literal `/api/v4` would require. The admin APIs are snake_case for
  the same reason.
- **D5 — the outgoing-webhook transport is per bot, and defaults to ex's.** A new
  bot gets HMAC-signed JSON; `"mattermost"` is opt-in for a bot that already exists
  elsewhere. Defaulting the other way would hand every new integration the weaker
  body-token authentication for no benefit.
- **D2 — ex as an MCP server first; Cliffy as an MCP client of CliffHub second.**
- **D3 — both hosting models; the outgoing webhook is the generic contract**,
  in-process responders an optimization on the same event contract.
- **Risks:** literal MM compat balloons scope (mitigated by D1); MCP was greenfield
  (de-risked — now built and tested).
- **Non-goals:** MM plugin system, full MM websocket API, migrating MM data,
  running the agent/LLM turn over MCP, ex issuing delegated third-party user auth.
