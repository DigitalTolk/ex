# Coverage policy

The backend gates at **100%** statement coverage; the two frontend suites gate
at **≥99%** branch coverage (`make check` + CI). This document explains how we
reach a *real* 100% on the backend — including what to do with code that at
first sight "cannot" be reached by a test — without faking it.

The order of preference is always: **(1) write a real test → (2) make the code
testable → (3) delete dead code.** There is **no annotation escape hatch on the
backend anymore** — the last `// coverage-ignore` was removed when the gate
moved to 100%. Lowering a threshold is never an option.

## 1. Write a real test

Most "uncovered" code is reachable; it just needs a test that drives the
specific condition. The patterns that cover the bulk of the backend:

- **SDK / I/O error branches** (`if err != nil { return ... }` after a DynamoDB,
  Redis, S3, or HTTP call). Inject the failure through the real client:
  - DynamoDB: `DB.Client` is the `store.DynamoAPI` interface; `withFault(db, ...)`
    (see `internal/store/fault_test.go`) wraps the real testcontainer-backed
    client and fails or *transforms* a single operation (corrupt rows for
    unmarshal arms, truncated pages for pagination arms, unprocessed-key
    continuations for batch arms).
  - Redis: a `cmdFailHook` (go-redis `Hook`) attached to a real container client
    fails exactly the named commands (`"expire"`, `"mget"`, `"ttl"`, …), so the
    surrounding code path is genuinely executed. Races (e.g. a key deleted
    between SCAN and MGET) are *reproduced*, not simulated — a hook deletes the
    key through a second client at the moment the follow-up command is issued.
  - HTTP: httptest servers that return errors/5xx, or clients pointed at closed
    ports.
- **Not-found / conflict branches** (conditional-check-failed, empty `GetItem`).
  Drive them with real data: create then re-create for a conflict, read a
  missing key for not-found.

These are real failures that happen in production (throttling, network, IAM,
races) — they belong under test.

## 2. Make the code testable (seams)

If a branch is only unreachable because a collaborator is hard-coded, introduce
a seam and override it in a test:

- **Seam variable** — `var randRead = rand.Read` (internal/auth, internal/service),
  `var webpEncode = nativewebp.Encode` (internal/service). The test swaps the
  var, asserts the error/panic behavior, and restores it with `defer`.
- **Narrow interface** — retype a struct field from a concrete SDK type to a
  package-private interface with exactly the method the code calls (e.g. the
  SigV4 `SignHTTP` seam in internal/search), so a failing fake can be injected
  while production construction stays unchanged.
- **Extract a pure helper** — when a guard protects against inputs the client
  library can't produce but the *type* allows (e.g. a non-string value in a
  Redis stream reply), extract the parsing into a package-level function and
  unit-test both arms directly (`parseStreamEntry` in internal/eventlog).

## 3. Delete dead code — including dead guards

If code cannot be reached because nothing calls it, remove it. Use `staticcheck`
/ `go vet` (Go) and `knip` / `ts-prune` (frontend) to find it.

This explicitly includes **tautological defensive guards**: a nil-coercion for
a slice the callee provably `make()`s, an error check on a call that returns
only nil by construction, a type assertion the library contract guarantees.
Delete the guard, restructure to a direct assertion where appropriate, and
leave a one-line comment stating the invariant. A guard nobody can reach is not
safety — it is untestable noise that hides real gaps.

For error arms that are impossible *and must stay fatal if the impossible ever
happens* (marshal of a fixed scalar struct, `expression.Build()` of a static
expression, encode of a freshly allocated image), wrap the call in a `must*`
helper that panics (`internal/store/must.go`, `internal/service/must.go`,
`internal/handler/must.go`, `internal/search/must.go`) and unit-test the panic
arm of the helper directly. `template.Must` is the precedent.

## Backend gate

Gate: [`github.com/vladopajic/go-test-coverage`](https://github.com/vladopajic/go-test-coverage),
configured in `.testcoverage.yml` (threshold **100**), run from the `Makefile`
and CI over `go test -tags=integration -coverprofile=coverage.out ./internal/...`.
Only `cmd/server/main.go` (process entrypoint / DI wiring) is excluded.

There are **zero `// coverage-ignore` annotations** in the tree, and new ones
are not accepted: if you believe a statement is unreachable, that belief is
exactly the review claim that sections 2 and 3 resolve — seam it, extract it,
or delete it.

### Frontend (TS) — `/* v8 ignore next -- <reason> */` / `/* istanbul ignore */`

The frontend suites (jsdom + browser, both ≥99% branch) still allow annotated
ignores, only for:

- **SSR / environment guards** in a browser-only app (`typeof window ===
  'undefined'`, `typeof document === 'undefined'`). Reachable only under a Node
  render we don't do. Prefer deleting if the guard is truly never needed.
- **Exhaustiveness defaults** — `default: assertNever(x)` / unreachable `switch`
  arms the type system proves can't happen.
- **Framework error callbacks** that cannot be triggered from a test (e.g. a
  decode error on a resource the test environment always resolves).

Every frontend ignore must carry a `-- reason` after the pragma.

## Review rule

An ignore annotation (frontend) or an "unreachable" claim (backend) is a claim
about inputs. Treat it like any other claim in review: if a reviewer can
describe an input that reaches the code, it is not irreducible — write the
test. If nobody can, it is dead or impossible — delete it or `must*` it.
