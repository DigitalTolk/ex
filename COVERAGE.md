# Coverage policy

All three suites gate at **≥99%** (`make check` + CI). This document explains how
we reach a *real* 99% — including what to do with the small slice of code that
genuinely cannot be reached by a test — without faking it.

The order of preference is always: **(1) write a real test → (2) make the code
testable → (3) delete dead code → (4) annotate as ignored with a justification.**
Lowering a threshold is never an option.

## 1. Write a real test

Most "uncovered" code is reachable; it just needs a test that drives the
specific condition. Two patterns cover the bulk of the backend gap:

- **SDK / I/O error branches** (`if err != nil { return ... }` after a DynamoDB,
  Redis, S3, or HTTP call). Inject a fake that returns an error. For the store,
  `DB.Client` is the `store.DynamoAPI` interface; `withFault(db, ...)` (see
  `internal/store/fault_test.go`) routes a single operation through a wrapper
  that returns `errInjected`, so the real error branch executes. Service- and
  handler-layer fakes do the same for their dependencies.
- **Not-found / conflict branches** (conditional-check-failed, empty `GetItem`).
  Drive them with real data: create then re-create for a conflict, read a
  missing key for not-found.

These are real failures that happen in production (throttling, network, IAM,
races) — they belong under test.

## 2. Make the code testable (seams)

If a branch is only unreachable because a collaborator is hard-coded, introduce
a seam (a package-level `var fn = realFn`) and override it in a test. Prefer this
over an ignore whenever the override test asserts something meaningful.

## 3. Delete dead code

If code cannot be reached because nothing calls it, remove it. Use `staticcheck`
/ `go vet` (Go) and `knip` / `ts-prune` (frontend) to find it.

## 4. Annotate as ignored — last resort, always justified

A genuinely irreducible slice remains: defensive guards against states that the
type system or a prior round-trip already guarantee cannot occur. Faking a test
for these is tautological (it asserts "the guard returns an error" by forcing the
guard to error). For these we annotate, and the gate **requires a written
justification** for every annotation (`force-annotation-comment: true`).

### Backend (Go) — `// coverage-ignore:<reason>`

Gate: [`github.com/vladopajic/go-test-coverage`](https://github.com/vladopajic/go-test-coverage),
configured in `.testcoverage.yml`, run from the `Makefile` and CI. It supports
block-level `// coverage-ignore` annotations and fails if one lacks an
explanation.

Allowed only for these classes:

- **Marshal of a fixed struct** — `attributevalue.MarshalMap(item)` where `item`
  has only string/number/bool/time fields can't fail. The `if err != nil` is
  defensive.
- **`expression.Build()` of a static expression** — a key-condition built from
  constants in the same function never returns a build error.
- **Round-trip unmarshal** — `UnmarshalMap` of an item this code just wrote via
  the matching `MarshalMap`. (Unmarshal of *foreign*/legacy data is NOT in this
  class — test it with a fault that returns a malformed item.)

Example:

```go
av, err := attributevalue.MarshalMap(item)
if err != nil { // coverage-ignore: item has only scalar fields; MarshalMap cannot fail
    return fmt.Errorf("store: marshal: %w", err)
}
```

### Frontend (TS) — `/* v8 ignore next -- <reason> */` / `/* istanbul ignore */`

Allowed only for:

- **SSR / environment guards** in a browser-only app (`typeof window ===
  'undefined'`, `typeof document === 'undefined'`). Reachable only under a Node
  render we don't do. Prefer deleting if the guard is truly never needed.
- **Exhaustiveness defaults** — `default: assertNever(x)` / unreachable `switch`
  arms the type system proves can't happen.
- **Framework error callbacks** that cannot be triggered from a test (e.g. a
  decode error on a resource the test environment always resolves).

Every frontend ignore must carry a `-- reason` after the pragma.

## Review rule

An ignore annotation is a claim that code is unreachable. Treat it like any other
claim in review: if a reviewer can describe an input that reaches it, it is not
irreducible — remove the annotation and write the test.
