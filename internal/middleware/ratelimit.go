package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/go-redis/redis_rate/v10"
	"github.com/redis/go-redis/v9"
)

// Limit is one limiter's budget: Rate requests per Period, with up to Burst
// requests admitted back to back (GCRA — a client that has been quiet can
// spend a burst at once, then refills at Rate/Period).
//
// Name namespaces the limiter's counters: two limiters with different names
// never share a budget, even when they key on the same user. (They used to:
// every per-user limiter spent one `rlu:write:<id>` counter, so a burst of
// message sends locked a user out of minting a WebSocket ticket — and a
// user without a socket gets no desktop alerts.)
type Limit struct {
	Name   string
	Rate   int
	Burst  int
	Period time.Duration
}

// PerMinute is a Limit of rate requests a minute with the given burst.
func PerMinute(name string, rate, burst int) Limit {
	return Limit{Name: name, Rate: rate, Burst: burst, Period: time.Minute}
}

// RateLimitCounter decides whether one more request under key fits the
// limit. retryAfter is how long until the next request would be admitted
// (only meaningful when allowed is false).
type RateLimitCounter interface {
	Allow(ctx context.Context, key string, limit Limit) (allowed bool, retryAfter time.Duration, err error)
}

// RedisRateLimiter is the production RateLimitCounter: go-redis/redis_rate's
// GCRA limiter, one atomic Lua call per request, shared by every instance.
type RedisRateLimiter struct {
	limiter *redis_rate.Limiter
}

// NewRedisRateLimiter builds the limiter over an existing Redis client.
func NewRedisRateLimiter(client *redis.Client) *RedisRateLimiter {
	return &RedisRateLimiter{limiter: redis_rate.NewLimiter(noScriptTolerant{client})}
}

// Allow implements RateLimitCounter.
func (l *RedisRateLimiter) Allow(ctx context.Context, key string, limit Limit) (bool, time.Duration, error) {
	res, err := l.limiter.Allow(ctx, key, redis_rate.Limit{Rate: limit.Rate, Burst: limit.Burst, Period: limit.Period})
	if err != nil {
		return false, 0, fmt.Errorf("rate limit %q: %w", key, err)
	}
	return res.Allowed > 0, res.RetryAfter, nil
}

// noScriptTolerant hands redis_rate a client whose EVALSHA reports a missing
// script in the form go-redis's Script.Run recognises. Script.Run falls back
// to EVAL only when the NOSCRIPT error still satisfies redis.Error; an
// instrumentation layer that re-creates errors (production builds are
// Datadog-instrumented) strips that interface, and the limiter would then
// fail every request after a Redis restart (see redisx.RunScript for the
// same incident on the app's own scripts). A NOSCRIPT reply is produced
// without executing anything, so the EVAL retry is always safe.
type noScriptTolerant struct {
	*redis.Client
}

func (c noScriptTolerant) EvalSha(ctx context.Context, sha1 string, keys []string, args ...any) *redis.Cmd {
	cmd := c.Client.EvalSha(ctx, sha1, keys, args...)
	if err := cmd.Err(); err != nil && strings.Contains(err.Error(), "NOSCRIPT") {
		cmd.SetErr(redis.ErrNoScript)
	}
	return cmd
}

// rateLimitByKey is the shared core for the rate-limit middlewares: it derives
// a counter key per request via keyFn and rejects (HTTP 429) once that key
// exceeds the limit. Fails OPEN — a counter error allows the request, so an
// infra blip can never lock everyone out. A nil counter disables limiting.
func rateLimitByKey(counter RateLimitCounter, keyFn func(*http.Request) string, limit Limit) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if counter == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			allowed, retryAfter, err := counter.Allow(r.Context(), keyFn(r), limit)
			if err != nil {
				slog.WarnContext(r.Context(), "rate limit check failed; allowing request", "limiter", limit.Name, "error", err)
				next.ServeHTTP(w, r)
				return
			}
			if !allowed {
				w.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds(retryAfter)))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"error":"rate_limited","message":"too many requests, please slow down"}`))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// retryAfterSeconds rounds a wait up to whole seconds (the Retry-After
// header's unit), never below one — "retry in 0s" invites a hot loop.
func retryAfterSeconds(d time.Duration) int {
	return max(int(math.Ceil(d.Seconds())), 1)
}

// RateLimit throttles per client IP and route. The route enters the key as
// a digest, not verbatim: some paths carry a secret (an incoming webhook's
// URL is its credential), and Redis keys are not where secrets belong.
func RateLimit(counter RateLimitCounter, limit Limit) func(http.Handler) http.Handler {
	return rateLimitByKey(counter, func(r *http.Request) string {
		return "ip:" + limit.Name + ":" + pathDigest(r.URL.Path) + ":" + clientIP(r)
	}, limit)
}

func pathDigest(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:8])
}

// RateLimitPerUser keys on the authenticated caller instead of the IP, so a
// single account can't flood write endpoints — message sends fan out
// notifications to every member, so an unbounded write rate is an
// amplification vector. One counter per (limiter, caller) across every route
// it wraps. A run-scoped token is keyed by its RUN: run tokens carry the
// invoking human's user ID, and an agent's tool calls must not spend the
// human's own budget. Unauthenticated requests fall back to the client IP.
// Must run AFTER the auth middleware so the caller is in context.
func RateLimitPerUser(counter RateLimitCounter, limit Limit) func(http.Handler) http.Handler {
	return rateLimitByKey(counter, func(r *http.Request) string {
		if c := ClaimsFromContext(r.Context()); c != nil {
			if c.Scope == model.TokenScopeRun && c.RunID != "" {
				return "run:" + limit.Name + ":" + c.RunID
			}
			if c.UserID != "" {
				return "user:" + limit.Name + ":" + c.UserID
			}
		}
		return "ip:" + limit.Name + ":" + clientIP(r)
	}, limit)
}
