# CLAUDE.md

> **What may go in this file.** CLAUDE.md is committed to the repository and read by every coding agent working on it. It contains **technical guidance only**: architecture, conventions, UI and backend design decisions, testing and reliability rules — how to build this codebase well.
>
> It must **never** contain business information about the company or anyone connected to it: no company, customer, partner or vendor-account names; no contracts, pricing, revenue, costs, plans or roadmap; no internal processes or org details; no names, emails, phone numbers or other personal data of real people; no credentials, tokens, keys or connection strings; no internal hostnames, URLs, IP addresses, account ids, dashboards, tickets or documents; no production data or incident specifics beyond the generic technical lesson. If a rule needs an example, make it up (`example.com`, `user-1`).
>
> `make check-claude-md` (part of `make check` and CI) enforces this with gitleaks: default secret rules plus `.gitleaks-claude-md.toml`. The scanner is a backstop, not the boundary — when in doubt, leave it out.

## Project

Ex — a Slack-like team messaging app. Go backend with embedded React frontend, DynamoDB, Redis, SSE.

## Acceptance Tests — non-negotiable

**Every change must pass all checks before being reported as done.**
**Every new feature or bug fix must include tests.**
**Every user-visible action must emit a WebSocket event** so all connected clients update in real-time. Examples: user joins/leaves channel → `member.joined`/`member.left` event with updated member count; new DM created → `conversation.new` event to the receiver; channel archived → `channel.archived` event. The frontend must handle every event type it can receive.

Run from the project root:

```bash
make check
```

### Required Before Every Completion

Before sending any final response for a user prompt, run `make check` from the project root and confirm it exits successfully. Do this even if targeted tests, type-checks, or linters were already run during the task. If `make check` fails, do not report the prompt as complete; fix the failures and rerun `make check` until it passes. If an external blocker makes `make check` impossible to run, state that blocker explicitly and treat the prompt as unfinished.

This single command runs everything in order:
1. `golangci-lint run ./...` (backend lint)
2. `go test -tags=integration -coverprofile=coverage.out ./internal/...` (backend tests with testcontainers)
3. `npx eslint src/` (frontend lint)
4. `npx vitest run --coverage` (ALL frontend projects — jsdom + the three browser instances — with one merged coverage gate)

All must pass. Do not skip any. Fix lint errors in code you changed.

### Zero warnings (HARD GATE)

**`make check` must end with zero warnings of any kind.** Lint warnings, test runtime warnings, deprecation notices, React `act(...)` warnings, "Query data cannot be undefined", missing-key warnings, "No routes matched" — all of them count. A passing exit code is necessary but not sufficient: the prompt is not done while the suite still emits warnings.

This applies whether you introduced the warning or it was already there. If your changes touch the file or you have a chance to drive the warning count down by fixing it, do so. Treat warnings as eventual errors and do not let them accumulate.

Common patterns:
- React Query `queryFn` should never return `undefined` — coerce with `Array.isArray(res) ? res : []` (or a typed default object) so test mocks don't trip the warning.
- For tests, prefer `await screen.findBy*` / RTL's `waitFor` over `vi.waitFor` — only the former wraps polling in `act()`.
- Wrap any non-React event dispatch (`element.dispatchEvent`, callback invocation, `vi.advanceTimersByTime`) in `act()` so the resulting state updates are act-scoped.
- For ref-only deps that ESLint flags, list the refs in the dep array — refs are stable so it's a no-op behaviorally and silences the warning.
- For `vi.fn().mockImplementation(...)` of a constructor, use a `function` (not arrow) so `[[Construct]]` works and vitest doesn't warn.

### Coverage — 100% everywhere (HARD GATE)

**The backend AND the merged frontend gate must stay at 100%.** This is non-negotiable. The metric differs per gate (Go has no branch-coverage metric):

| Suite | Gate | Metric |
| --- | --- | --- |
| Backend | = 100% | statement (go-test-coverage over `./internal/...`; zero `// coverage-ignore` annotations allowed — see COVERAGE.md for the seam / must-helper / dead-guard-deletion playbook) |
| Frontend (merged) | = 100% | statements + branches + functions + lines (`vitest.config.ts` root `thresholds` over the MERGED istanbul report of all `test.projects`: jsdom + chromium-desktop + chromium-mobile + webkit-iphone) |

Each gate fails `make check` **and** the GitHub Actions CI run: the backend gate is an awk check in `Makefile` + a dedicated CI step; the frontend gate is enforced by vitest's own `thresholds` (non-zero exit) on the single `npx vitest run --coverage` invocation. The Makefile additionally re-checks all four metrics from `coverage/coverage-summary.json`.

**No file may go silently ungraded.** Coverage is one merged universe: a file only needs 100% from the UNION of jsdom + browser hits, and `scripts/check-coverage-universe.mjs` (a `make check` + CI step) fails when any non-excluded `src/` runtime file is absent from the merged lcov (i.e. no test in any project loads it). The only sanctioned exclusions live in the config's coverage `exclude` list (entry shim, type-only modules, the tygo-generated mirror), each with a reason — do not grow that list casually. Ignore annotations must carry BOTH `/* v8 ignore */` and `/* istanbul ignore */` twins (the provider is istanbul today; the dual form keeps them provider-portable) with a WHY.

If ANY gate is below 100%, the prompt is **NOT done**. Iterate: write more tests, re-run `make check`, repeat — until all three are at 100%. Do not respond "done" before this is true. Do not ask the user whether to skip this; do not propose lowering the threshold; do not claim a number is "close enough." There are no excuses. When a branch arm is genuinely unreachable (SSR guard, provider-specific quirk), use the established escape hatches deliberately and sparingly: delete dead guards, add a testable seam, per-file coverage excludes with a justification comment, or a dual `/* v8 ignore */` + `/* istanbul ignore */` annotation explaining WHY — never an unexplained ignore.

**Every user flow must have a test.** Coverage percentage alone is not sufficient — for every user-visible flow you add or change, there must be at least one test that exercises the actual flow end-to-end (not just the helper functions it touches). User flows include: clicking a button → API call → state update → UI update; opening a page → loading data → rendering; the full lifecycle of a feature (create → edit → delete). If a flow has no test, the prompt is not done even when coverage reads 100%.

**Bug fixes require regression tests.** A bug-fix without a test that fails before the fix and passes after is not a bug fix — it is a guess. Write the failing test first, then the fix.

**When fixing existing tests after a code change**, fix the test to assert the new correct behavior. Do not weaken assertions or delete tests to make them pass.

After every prompt, report coverage to the user, and if any suite is below 100% **state explicitly that the prompt is not done and that you are continuing**:

```
Backend coverage (statement):                    XX.X%
Frontend coverage, merged (stmt/branch/fn/line): XX.X% / XX.X% / XX.X% / XX.X%
```

The user has repeatedly had to remind me to add tests. That stops here. The default posture going forward is: **assume tests are required for every change. If unsure whether a test is needed, write one.**

## Notifications — delivery must be 100% reliable

Notification channels **may** carry incident traffic (alert feeds, on-call pings), so the **delivery pipeline** is load-bearing: once the backend decides a user should be alerted, that alert must reach them — desktop popup or mobile fallback — with no silent loss. A dropped opted-in alert is a production incident, not a UI nit. Treat the whole path as load-bearing and never regress it. Any change touching notifications MUST keep these invariants and ship tests proving them.

### The user-perspective truth table (what "notified" means; every change must preserve this)

The recipient's situation decides everything. "At the device" = real input within 10 min, no lock/suspend/sleep (`isUserAtDevice`); "looking at it" = that + window focused + page visible + input within 2 min (`isUserAttentive`) + the parent on screen.

| Recipient's situation when the message lands | Desktop | Unread trace (badge / bold row / title count) | Read state | Phone |
| --- | --- | --- | --- | --- |
| Looking at that channel/DM/thread | Nothing surfaces (they're watching it happen) | None | Read immediately | Silent |
| App open on that parent, but NOT looking (window blurred/hidden, or idle) | Popup + sound | **Appears and STAYS** until they actually return (read on window re-focus) | NOT read — an open route is not a reading user | Silent if at the device, buzzes otherwise |
| Elsewhere in the app, at the device | Popup + sound | Appears | Unread until they open it | Silent |
| At the machine but in another program | Popup over that program + sound | Appears | Unread until they return | Silent (input recency / shell OS-input keeps the desktop's claim alive) |
| Away from the machine (10+ min no input, or locked/suspended/slept) | Banner may sit there (harmless) | Appears | Unread | **Buzzes ~30 s after the message** |
| Offline (no socket) | — | On next connect | Unread | **Buzzes immediately** |

Non-negotiable consequences, each of which has been a real shipped bug:
- **An alert must never vanish without a trace.** A transient OS banner plus an auto-cleared badge = "I was never notified" (the ghost-DM bug: the open-but-unwatched DM auto-marked itself read).
- **Read-marking requires attention, never mere route-openness.** The gate lives in ChatPage's `message.new` handler (`isUserAttentive(suppressionWindowMs)`); the return-half lives in `useMarkReadOnReturn` (views re-read on window focus). Do not "simplify" either away.
- **Which window has focus is irrelevant to the phone decision.** Focus separates "looking at ex" from "looking at something else" — never "at the desk" from "gone" (GAP-14).
- **Duplicates beat silence, in every trade-off.**

This is a reliability contract about the *pipeline*, *not* a claim that any message class is special. **Whether** to notify is decided purely by the recipient's preferences — and that includes webhooks: **webhook posts are level-gated exactly like regular messages** (they alert via an "all messages" level, a keyword match, or an @-mention in the body; mute suppresses; the webhook creator is a normal recipient since the `webhook` sentinel authors the post). Not every webhook is an incident. A channel that carries real alerts opts in via a per-channel **"All messages"** override or keywords — do not reintroduce a server- or client-side "webhooks always notify" special case (the old `forceAll` flag was exactly that and was removed 2026-07-02).

**The backend is the single source of truth for *whether* to notify.** `NotifyForMessage` (`internal/service/notification.go`) folds account level + per-channel override + mute + keywords + @-mentions + thread participation, then publishes `notification.new` only to recipients who should be alerted. The client must **never** re-gate by `kind`/`parentType` — if a `notification.new` arrives, surface it (subject only to: own-author echo, per-message dedup, and "I'm actively viewing this parent **or thread**" — the thread match keys on `parentMessageID` via `@/lib/thread-scope`, viewing-based, never kind-based). A past blanket "drop every channel `message`" rule silently swallowed per-channel "all messages" alerts; do not reintroduce that class of client-side suppression.

**Desktop ⇄ mobile is an ACK-gated fallback (do not regress to presence-only).** Online → desktop popup (`notification.new` over WS); the client replies with a `notification.ack` (`messageID`) the moment it surfaces the alert (or suppresses it because the user is reading that channel/DM/thread) — **but only while the user is demonstrably at the device in ANY tab**. "At the device" is the two-tier ATTENTION model (SPEC.md §2, revised 2026-08-12; `@/lib/user-activity` locally, `@/lib/tab-leader` for sibling tabs). The ACK tier (`isUserAtDevice`) = REAL input within `attentionWindowMs` (10 min; focus/visibility events do NOT stamp the clock — OS unlock restores focus with no human proof) + no hard-away signal — **window focus and page visibility are deliberately NOT required**: the OS banner surfaces over whatever app the user is in, an abandoned machine keeps its focus state, and requiring focus was the GAP-14 regression that buzzed the phone for every alert while the user worked in another window. The SUPPRESSION tier (`isUserAttentive`, surfacing nothing at all) stays strict: at-device within `suppressionWindowMs` (2 min) + page visible + window focused — when in doubt, surface. Hard-away is **definitive not-at-device evidence only** — screen lock / suspend from the desktop-shell presence bridge (`@/lib/desktop-presence`, `data-ex-presence` stamped by ex-electron), the opt-in Chromium IdleDetector's `screenState: 'locked'` (`@/lib/idle-detector`), and the wake latch (a clock-jump means the machine slept — AWAY until the next real input; never retro-ack). **60-second OS-idle signals (shell `idle`, IdleDetector `userState: 'idle'`) are NOT hard-away** — that threshold is tuned for presence dots and trips while merely reading; the idle → phone handoff belongs to the 10-min input window aging out (the shell re-asserts `active` every 60 s while OS input flows, keeping the clock fresh even with ex unfocused). Buffered acks expire (`ackFreshnessMs`, 15 s) so a reconnect after sleep can't flush a stale ack and cancel a push the user needs. An open-but-abandoned (or locked, or just-woken) laptop must NOT ack: no ack → the deferred mobile push fires, Slack-style. With several tabs open, the ELECTED LEADER tab owns surfacing/acking (broadcast-channel election in `@/lib/tab-leader`; a sibling vouches at-device only when its snapshot AFFIRMS `hardAway: false` with fresh input — but justifies suppression only when additionally visible + focused) — a duplicate copy in another tab must never ack while the user is away, and a non-leader that waits out two holds with nobody delivering surfaces anyway (duplicate beats silent miss). Duplicates (desktop popup + phone buzz) are the deliberate failure direction; a silently-lost alert is not. The mobile fallback (`sendMobilePush` → `MobilePushScheduler`, asynq over Redis):
- **Offline** (no live socket): schedule for immediate delivery — nothing can ack.
- **Online**: schedule the push deferred by `ackFallbackDelay`; the asynq worker checks the ack AT DELIVERY TIME (`NotificationAckStore.WasNotificationAcked`, Redis-backed) and stands down if the desktop delivered. The task is DURABLE: it survives deploys/restarts and any instance's worker delivers it (the old in-memory timer silently dropped every pending fallback on shutdown — never reintroduce an in-process deferred push). A dead/half-open socket can't ack → the push fires; a healthy desktop acks → no redundant push. Presence can be wrong in EITHER direction without losing an alert — do not "optimize" it back to skipping the push for an online user.

Supporting rules:
- **Presence must still track a dead socket within seconds** (it picks the offline-immediate vs online-deferred path, and drives online indicators). The WS keep-alive (`internal/handler/ws.go`) sends a real protocol ping each `wsKeepAliveInterval` and cancels the connection if no pong arrives within `wsPongTimeout`. Keep `wsKeepAliveInterval` < `presenceTTL` (`internal/cache/redis.go`) with margin so a live user never flaps offline. Keep `ackFallbackDelay` < the ack-marker TTL (`cache.notifAckTTL`).
- **Undeliverable push is loud.** A provider 4xx (no registered device) — and a 2xx whose body reports no notification was created (empty `id` + `errors`) — is wrapped as `ErrPushUndeliverable` and logged at ERROR by the asynq worker (task archived, not retried) — the offline fallback produced no alert. Never downgrade that to WARN/silent.

**Client dedup is cross-tab and must never swallow a real alert.** The seen-set lives in `@/lib/notification-dedup` (localStorage, shared across all of a user's tabs — a per-tab in-memory set can't dedup the broker's per-session fan-out). `NotificationContext.dispatch` records a `messageID` as "alerted" **only after** it actually surfaces sound and/or a popup — never up-front and never for a suppressed/undelivered copy. Recording before delivery (the old bug) let a suppressed-or-failed first copy permanently dedup a later legitimate alert.

If you can't prove a change keeps every opted-in alert at 100% delivery (desktop AND mobile fallback), it is not done.

## Stack

- **Backend**: Go 1.22+ with stdlib `net/http` (Go 1.22+ pattern matching)
- **Frontend**: React + TypeScript + Vite + shadcn/ui + Tailwind CSS v4
- **Database**: DynamoDB (single-table design, key patterns in `internal/store/dynamo.go`)
- **Cache/PubSub**: Redis
- **Auth**: OIDC SSO + JWT (access token in memory, refresh token in httpOnly cookie)

## Key Conventions

- ULIDs for all entity IDs (via `store.NewID()`)
- Channels have both `ID` (ULID) and `Slug` (derived from name) — URLs use slugs
- **Channel prefix is `~` everywhere** — display ("~general"), browser tab title, notification titles ("Alice in ~general"), `~channel` autocomplete pill, and any other surface that prefixes a channel name. Don't use `#` (that's reserved for hashtags / IDs in markdown). The lock icon distinguishes private channels from public; the prefix stays the same.
- Mention syntax: `@[userID|displayName]` for users, `~[channelID|slug]` for channels, `@all` / `@here` for groups (see `src/lib/mention-syntax.ts` and `internal/service/mention.go`)
- DynamoDB dual-write for memberships (channel side + user side) via `TransactWriteItems`
- Service layer owns business logic and RBAC; handlers are thin HTTP adapters
- **Password reset is GUEST-ONLY, and the check keys on `AuthProvider`, never `SystemRole`.** Only accounts with `AuthProvider == guest` hold a local bcrypt password; an OIDC user's credential lives in the identity provider, so minting *or* redeeming a reset for one is refused (an SSO user demoted to the guest *role* is still SSO-only). The guard runs at BOTH ends — at mint and again at redemption — because an account can be converted while a ticket is outstanding. Tickets are single-use (Redis `GETDEL`), stored under the token's SHA-256 rather than the token, TTL-bounded, and redeeming one revokes every refresh token for that account. The self-service `/auth/password/forgot` endpoint answers 204 for *every* input (unknown address, SSO address, malformed, store or mail outage) — it must never become an account-enumeration oracle, which is why its handler has a single error arm and a fixed message.
- **Transactional email (`internal/email`) is optional and never load-bearing.** With no transport configured the app boots and every flow still works: invites and admin-initiated resets return their link so it can be relayed by hand, and the UI states whether the mail was actually sent. Never make a flow depend on delivery — mail is not part of the notification-reliability contract below. Two transports (`EMAIL_PROVIDER=smtp|ses`) share ONE message-construction path (`build`), so they can never drift; SES sends that rendered MIME as a raw message. **Message assembly and the SMTP conversation belong to `github.com/wneessen/go-mail`, and SES to the AWS SDK — do not hand-roll MIME, header encoding, or protocol handling here.** Delivery is proven end-to-end against a real Mailpit server (`mailpit_integration_test.go`), not just a scripted fake.
- Adapters in `internal/handler/store_adapters.go` bridge store and service interfaces
- WebSocket (`nhooyr.io/websocket`) for real-time via Redis pub/sub fan-out across server instances
- WebSocket endpoint: `POST /api/v1/ws/ticket` mints a one-time ticket, then `GET /api/v1/ws?ticket=<ticket>` connects (no JWT in the URL) — sends JSON `{"type":"...","data":"..."}`
- Dark mode via `.dark` class on `<html>`, toggled by `prefers-color-scheme`
- 14px practical base font size (`text-sm` = 14px at 16px root)
- WCAG AA compliance — all shadcn components, proper ARIA, keyboard navigation
- **Anything rendered in the chat message list must have explicit dimensions** so react-virtuoso can measure rows correctly on first paint and scroll-to-bottom lands at the actual bottom. Images render `<img width height>` from intrinsic pixel dimensions (collected at upload time, lazy-backfilled server-side for legacy attachments). Unfurl cards use fixed Tailwind sizing (e.g. `h-16 w-16`). Iframes/videos/embeds need `width`/`height` attributes or a fixed-aspect wrapper. Never ship a chat-list element whose box only resolves after async decode/load — that causes layout shift and breaks scroll anchoring.

## Project Layout

```
cmd/server/main.go       Entry point, DI wiring, graceful shutdown
internal/
  config/                Env-based configuration
  model/                 Domain types
  store/                 DynamoDB repositories
  auth/                  JWT + OIDC
  middleware/            Auth, RBAC, CORS, logging
  service/               Business logic
  handler/               HTTP handlers, router, adapters
  cache/                 Redis cache
  pubsub/                Redis pub/sub + WebSocket broker
  events/                Event types + connected-client buffer (delivered over WebSocket)
src/                     Frontend (React/TS; package.json + vite/vitest configs live at the repo root)
  context/               Auth provider + Unread state
  hooks/                 React Query hooks + WebSocket
  components/            UI (layout, chat, channels, conversations)
  pages/                 Login, Chat, Directories, OIDC callback
  lib/                   API client, utils
  types/                 TypeScript interfaces
```

## Running Locally

```bash
docker compose up --build
```

Starts DynamoDB Local, Redis, and the app at http://localhost:8080. First SSO user becomes admin.

## Route Conflicts

Go 1.22+ stdlib mux panics at runtime (not compile time) on ambiguous patterns. Literal path segments (e.g. `/channels/slug/{slug}`) must not conflict with wildcard patterns (e.g. `/channels/{id}/members`). Always run the app or `make check` to catch these.

## Design system — source of truth

The values below are the canonical design tokens for the app. They are wired into Tailwind v4 via CSS variables in `src/index.css` (`@theme` block for light, `html.dark` override for dark). When adding or revisiting any UI surface, do **not** introduce ad-hoc hex codes, font stacks, or one-off radius values — pull them from these tokens (or the Tailwind utility they generate) so light/dark and future palette changes stay coherent.

If a new value is genuinely required, add it to `index.css` first and reference it from there — never paste a literal hex into a component.

### Color tokens

#### Light theme (default)

| Role | Token / utility | Hex | Notes |
| --- | --- | --- | --- |
| Background base | `--color-background` / `bg-background` | `#FFFFFF` | Main chat surface |
| Sidebar / chat hover | `--color-sidebar` / `bg-sidebar`, `--color-muted` / `bg-muted` | `#F5F5F5` | bg/level1 |
| Chat top bar | `--color-card` / `bg-card` | `#FFFFFF` | bg/level2 |
| Typing field | `--color-typing-field` | `#FBFBFB` | bg/level3 |
| Text primary | `--color-foreground` / `text-foreground` | `#231F20` |  |
| Text secondary | `--color-secondary-foreground` | `#4F4C4D` | Body lower-emphasis |
| Text muted | `--color-muted-foreground` / `text-muted-foreground` | `#7B7979` |  |
| Text disabled | n/a (use `opacity-50`) | `#A7A5A6` |  |
| Border default | `--color-border-strong` | `#BDBCBC` |  |
| Border subtle | `--color-border` / `border-border` | `#E9E9E9` |  |
| CTA | `--color-primary` / `bg-primary` | `#231F20` | Neutral near-black action colour (default buttons etc.). **Not pink.** |
| CTA hover | `--color-primary-hover` | `#4F4C4D` |  |
| CTA disabled | n/a (use `disabled:opacity-50`) | `#A7A5A6` |  |
| Brand / badges | `--color-brand` / `bg-brand`, `Badge variant="brand"` | `#DE5D83` | Unread pill, mention dot — pink in both themes |
| Online / presence | `--color-online` / `bg-online` | `#10B981` | Presence dots/labels. The one green accent — use the token, never raw `emerald-*`. |
| Pinned affordance | `--color-pinned` / `border-pinned`, `text-pinned` | `#D97706` | Pinned-message accent bar + "Pinned" label. Use the token, never raw `amber-*`. |

#### Dark theme (`html.dark`)

| Role | Hex | Notes |
| --- | --- | --- |
| Background base | `#231F20` |  |
| Sidebar | `#2C2829` | bg/level1 |
| Chat top bar (`--color-chat-top`) | `#353132` | bg/level2 |
| bg/level3 | `#3F3A3B` |  |
| **Cards / panels** (`--color-card` / `bg-card`) | `#231F20` (base) | Thread cards (and their messages), admin/drafts/directory/search panels. Anchored to **base** so card-backed surfaces never read lighter than the chat — a message inside a thread card must match the same message in its channel. Borders delineate them. **Do not** raise this to level2; that was the "everything looks washed-out light" regression. |
| **Floating surfaces** (`--color-popover`) | `#2C2829` (level1) | Menus, dialogs, hover cards, tooltips — one subtle step above base, never level2. |
| Text primary | `#FFFFFF` |  |
| Text secondary | `#D3D2D2` |  |
| Text muted | `#A7A5A6` |  |
| Text disabled | `#7B7979` |  |
| Border default | `#A7A5A6` |  |
| Border subtle | `#4A4A4A` |  |
| CTA token (`--color-primary`) | `#FFFFFF` | Neutral accent token — drives focus rings, `bg-primary/10` avatar fallback, `@mention` pill, switch. Stays neutral. |
| CTA **button** (`Button variant="default"`) | `#DE5D83` (brand) | Per spec the dark CTA *button* is pink (hover `#C94E71`); applied via `dark:bg-brand` on the button only, never the token. |
| CTA hover | `#D3D2D2` |  |
| CTA disabled | n/a (use `disabled:opacity-50`) |  |
| Brand / badges | `#DE5D83` | Same pink as light theme |
| Online / presence | `#34D399` | Presence green, brighter than light for the dark surface (`--color-online`). |
| Pinned affordance | `#FBBF24` | Pinned amber, brighter gold for dark (`--color-pinned`). |

The `--color-primary` **token** is the **neutral** accent colour and stays neutral in both themes — near-black in light, white in dark. The token itself is **never** pink. Per the design spec, the primary CTA **button** (`Button variant="default"`) is near-black in light and **pink in dark** — that pink comes from `dark:bg-brand` on the button variant, not from the token. The `Badge variant="brand"` stays pink in both modes.

> **Do not point `--color-primary` at pink.** The token drives focus accent, `bg-primary/10` avatar fallback, `@mention` pill, reaction-by-me highlight, switch, and progress bar — making the *token* pink floods the entire dark UI (this was a real regression — see rule 2). The spec's dark-mode pink CTA is achieved on the **button only**: `Button variant="default"` (and the send button) opt in via `dark:bg-brand` / `dark:hover:bg-brand-hover`. Every non-button primary accent stays neutral.

### Typography

- **Family — body / UI:** `Figtree` (loaded via Google Fonts), falling back to the system UI stack. Exposed as `var(--font-sans)`. Use `font-sans` (the default) — no need to specify it.
- **Family — display headlines:** `Futura` (ships with macOS/iOS), falling back to `Figtree` and the system stack. Exposed as `var(--font-display)`. Use sparingly, only on display headlines (>=24px). Apply via `style={{ fontFamily: 'var(--font-display)' }}`.
- **Family — monospace:** browser default (`ui-monospace, SFMono-Regular, Menlo, monospace`). Use `font-mono` Tailwind utility.
- **Base size:** 16px root, 14px body (`text-sm`). Most chrome and chat content reads at 14px.
- **Minimum font size is 14px — the only exception is small text at exactly 12px (`text-xs`).** Nothing renders at 9, 10, 11 or 13px: no `text-[9px]` / `text-[10px]` / `text-[11px]` / `text-[13px]`, and no inline `fontSize` / CSS `font-size` that works out below 14px other than 12px. Things that genuinely need to be small (badge counts, captions, timestamps, kbd hints, tab-bar labels, avatar initials) use `text-xs`; everything else is `text-sm` or larger. If 12px doesn't fit, make the container bigger — don't shrink the text. Older code still has some 10/11/13px sizes: bring any you touch into line, never add new ones.

Ramp (use one of these — do not invent intermediate sizes):

| Step | Tailwind | px / line-height |
| --- | --- | --- |
| Display L | `text-[57px] leading-[130%] font-bold` | 57 / 1.30 — Futura |
| Display M | `text-[45px] leading-[130%] font-bold` | 45 / 1.30 — Futura |
| Display S | `text-4xl leading-[130%] font-bold` (≈36) | 36 / 1.30 — Futura |
| Headline L | `text-[32px] leading-[130%] font-bold` | 32 / 1.30 |
| Headline M | `text-[28px] leading-[130%] font-bold` | 28 / 1.30 |
| Headline S | `text-2xl leading-[130%] font-bold` (24) | 24 / 1.30 |
| Title L | `text-[26px] leading-[150%] font-semibold` | 26 / 1.50 |
| Title M | `text-[22px] leading-[150%] font-semibold` | 22 / 1.50 |
| Title S | `text-xl leading-[150%] font-semibold` (20) | 20 / 1.50 |
| Title XS | `text-lg leading-[150%] font-semibold` (18) | 18 / 1.50 |
| Body Larger | `text-xl leading-7` (20/28) |  |
| Body L | `text-base leading-6` (16/24) | tracking +0.5 |
| Body M | `text-sm leading-5` (14/20) | tracking +0.25 — **default body** |
| Body S | `text-xs leading-4` (12/16) | tracking +0.4 |
| Label Prominent (16) | `text-base font-semibold leading-5` |  |
| Label L (16) | `text-base font-medium leading-5` |  |
| Label Prominent (14) | `text-sm font-semibold leading-5` |  |
| Label M (14) | `text-sm font-medium leading-5` |  |
| Label Prominent (12) | `text-xs font-semibold leading-4` |  |
| Label S (12) | `text-xs font-medium leading-4` |  |

### Spacing scale

Pixel values mapped to Tailwind utilities (`p-*`, `gap-*`, `m-*`, `space-*`). Use only these — do not introduce arbitrary `p-[7px]`-style values without a spec reason.

| Token | px | Tailwind |
| --- | --- | --- |
| zero | 0 | `*-0` |
| 4xs-2 | 2 | `*-0.5` |
| 3xs-4 | 4 | `*-1` |
| 2xs-6 | 6 | `*-1.5` |
| 1xs-8 | 8 | `*-2` |
| xs-10 | 10 | `*-2.5` |
| 1sm-12 | 12 | `*-3` |
| sm-14 | 14 | `*-3.5` |
| md-16 | 16 | `*-4` |
| lg-20 | 20 | `*-5` |
| xl-24 | 24 | `*-6` |
| 2xl-28 | 28 | `*-7` |
| 3xl-32 | 32 | `*-8` |
| 4xl-36 | 36 | `*-9` |
| 5xl-40 | 40 | `*-10` |

#### List-row rhythm (sidebar channels/DMs/nav)

The reference screenshots show **airy** list rows — roughly a 40px row pitch, not a dense 1px-gap stack. Don't let list rows glue together:

- **Row vertical padding:** `py-1.5` (6px) on desktop sidebar rows (channels, DMs, nav items). Mobile keeps its fixed `max-md:h-12` tap target.
- **Gap between rows:** the list container separates rows with `space-y-1` (4px) — **never** `space-y-px`. A 1px gap reads as "no spacing between channels" and fails the spec.

Apply the same rhythm to any new vertical list of rows in the chrome.

### Radius scale

| Token | px | Tailwind |
| --- | --- | --- |
| radius-none | 0 | `rounded-none` |
| radius-xs-2 | 2 | `rounded-sm` (`--radius-sm: 0.25rem`) |
| radius-sm-4 | 4 | `rounded` |
| radius-md-6 | 6 | `rounded-md` |
| radius-lg-8 | 8 | `rounded-lg` |
| radius-2xl-16 | 16 | `rounded-2xl` |
| radius-capsule | 999 | `rounded-full` |

### Application rules

1. **Never paste a literal hex.** If a colour isn't in the table above, it doesn't belong in a component file. Add it to `index.css` first.
2. **Brand pink (`#DE5D83`) is for highlights only, and the palette is deliberately restrained — keep it that way.** Pink is allowed on exactly four kinds of surface: (a) unread count badges (`Badge variant="brand"`), (b) mention/unread/status dots (`bg-brand`, e.g. the channel-row dot), (c) the primary **CTA buttons** (`Button variant="default"` + the send button) — which opt in with `dark:bg-brand` and are **near-black in light, pink only in dark** per the spec, and (d) the brand logo accent dot. Nothing else. Do **not** use pink as a generic background, button, text, border, focus ring, active-tab, mention-pill, reaction, or avatar-fallback colour. The reference mocks in the design source show a near-monochrome UI with sparse pink accents — if a screen looks pink-washed (especially in dark mode), something is wrong. Most "accent" surfaces should use the **neutral** `primary` token (`bg-primary/10`, `text-primary`, `border-primary`), never `brand`. Note the one deliberate exception per the spec: primary **CTA buttons** (`Button variant="default"`, incl. send) are pink in **dark mode only** (`dark:bg-brand`); in light mode they're neutral near-black, and the underlying `primary` token stays neutral in both themes for all non-button accents.
3. **`Badge variant="brand"`** is the canonical wrapper for unread pills. Don't reach past it to compose pink badges by hand.
4. **Dark mode is `.dark` on `<html>`.** Toggle via `ThemeContext`'s `setTheme`. Never inline `prefers-color-scheme` checks at the component level; rely on the `dark:` variant.
5. **Sidebar uses the dark-palette utility remap.** Sidebar markup uses `text-white`, `bg-white/10`, `hover:bg-white/15`, etc. The `@layer utilities` block in `index.css` retargets those to the sidebar tokens when the document is in light mode. Keep new sidebar UI in this same vocabulary so the remap continues to work — don't introduce a parallel `light:`/`dark:` pair just for the sidebar.
6. **Font: Figtree everywhere, Futura only on the largest display headlines.** No literal `font-family:` values; rely on `var(--font-sans)` / `var(--font-display)`.
