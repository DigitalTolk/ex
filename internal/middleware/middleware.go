package middleware

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/google/uuid"
)

type contextKey string

const (
	claimsKey    contextKey = "claims"
	requestIDKey contextKey = "requestID"
)

// Auth returns middleware that validates a JWT from the Authorization header
// (Bearer scheme) or the "token" query parameter, and stores the claims in context.
func Auth(jwtMgr *auth.JWTManager) func(http.Handler) http.Handler {
	return AuthWithUserStatus(jwtMgr, nil)
}

type authUserStore interface {
	GetByID(ctx context.Context, id string) (*model.User, error)
}

// AuthWithUserStatus validates a JWT and, when a user store is supplied,
// rejects tokens for accounts that have since been deactivated.
func AuthWithUserStatus(jwtMgr *auth.JWTManager, users authUserStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tokenStr := extractToken(r)
			if tokenStr == "" {
				http.Error(w, "missing or invalid token", http.StatusUnauthorized)
				return
			}

			claims, err := jwtMgr.ValidateToken(tokenStr)
			if err != nil {
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}
			if users != nil {
				user, err := users.GetByID(r.Context(), claims.UserID)
				if err != nil || user == nil || user.Status == "deactivated" {
					http.Error(w, "account deactivated", http.StatusUnauthorized)
					return
				}
			}

			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func extractToken(r *http.Request) string {
	if ah := r.Header.Get("Authorization"); ah != "" {
		if strings.HasPrefix(ah, "Bearer ") {
			return strings.TrimPrefix(ah, "Bearer ")
		}
	}
	return r.URL.Query().Get("token")
}

// RequireSystemRole returns middleware that checks whether the authenticated
// user has one of the specified system roles.
func RequireSystemRole(roles ...model.SystemRole) func(http.Handler) http.Handler {
	allowed := make(map[model.SystemRole]bool, len(roles))
	for _, r := range roles {
		allowed[r] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims := ClaimsFromContext(r.Context())
			if claims == nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			if !allowed[claims.SystemRole] {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ClaimsFromContext extracts the TokenClaims stored in context by the Auth middleware.
func ClaimsFromContext(ctx context.Context) *model.TokenClaims {
	claims, _ := ctx.Value(claimsKey).(*model.TokenClaims)
	return claims
}

// ContextWithClaims returns a new context with the given claims attached so
// downstream code (e.g. service-layer permission checks) can read them via
// ClaimsFromContext. This is primarily useful in tests that exercise code
// paths gated on the authenticated user's role.
func ContextWithClaims(ctx context.Context, claims *model.TokenClaims) context.Context {
	return context.WithValue(ctx, claimsKey, claims)
}

// UserIDFromContext returns the authenticated user's ID from context.
func UserIDFromContext(ctx context.Context) string {
	if c := ClaimsFromContext(ctx); c != nil {
		return c.UserID
	}
	return ""
}

// CORS returns middleware that sets Cross-Origin Resource Sharing headers.
// Multiple origins may be passed; the request Origin is echoed back when it
// matches one of them (required when Allow-Credentials is true).
func CORS(allowOrigins ...string) func(http.Handler) http.Handler {
	allowed := make(map[string]bool, len(allowOrigins))
	for _, o := range allowOrigins {
		allowed[o] = true
	}
	primary := ""
	if len(allowOrigins) > 0 {
		primary = allowOrigins[0]
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if allowed[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
			} else {
				w.Header().Set("Access-Control-Allow-Origin", primary)
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Max-Age", "86400")

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// responseWriter wraps http.ResponseWriter to capture the status code.
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// Logging is middleware that logs every request with method, path,
// status, and duration. /healthz is suppressed when it returns 2xx —
// orchestrators (Docker, k8s) hit it every few seconds and the noise
// drowns out signal in the access log. Non-2xx still logs so a flapping
// healthcheck stays visible.
func Logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		next.ServeHTTP(rw, r)

		if r.URL.Path == "/healthz" && rw.statusCode >= 200 && rw.statusCode < 300 {
			return
		}

		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rw.statusCode,
			"duration", time.Since(start).String(),
			"requestID", RequestIDFromContext(r.Context()),
		)
	})
}

// RequestID is middleware that generates a unique request ID, stores it in context,
// and sets the X-Request-ID response header.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" {
			id = uuid.NewString()
		}

		ctx := context.WithValue(r.Context(), requestIDKey, id)
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// securityHeaderCSP is intentionally permissive on the resource directives
// (img/style/font/connect/frame) so the SPA's Google Fonts, S3 images, Giphy
// embeds, and the wss WebSocket keep working, while the high-value directives
// are locked down: framing is forbidden (clickjacking), and object/base are
// neutered. script-src keeps 'unsafe-inline' only because index.html ships an
// inline theme bootstrap script; everything else is constrained to self/https.
const securityHeaderCSP = "default-src 'self'; " +
	"script-src 'self' 'unsafe-inline'; " +
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
	"font-src 'self' https://fonts.gstatic.com; " +
	"img-src 'self' https: data: blob:; " +
	"media-src 'self' https: blob:; " +
	"connect-src 'self' https: wss:; " +
	"frame-src 'self' https:; " +
	"object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

// SecurityHeaders sets defense-in-depth response headers on every response:
// a CSP (incl. frame-ancestors), X-Frame-Options (clickjacking belt-and-braces
// for older browsers), nosniff, a no-referrer policy (so an access token that
// rides in a URL can't leak via Referer), and HSTS (ignored by browsers over
// plain HTTP, so safe to always send).
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", securityHeaderCSP)
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		next.ServeHTTP(w, r)
	})
}

// RequestIDFromContext returns the request ID stored in context.
func RequestIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// RateLimitCounter is the minimal Redis-backed counter the RateLimit middleware
// needs: AllowRequest atomically increments the per-key counter for the current
// window and reports whether the request is within the limit.
type RateLimitCounter interface {
	AllowRequest(ctx context.Context, key string, limit int, window time.Duration) (bool, error)
}

// rateLimitByKey is the shared core for the rate-limit middlewares: it derives a
// bucket key per request via keyFn and rejects (HTTP 429) once that key exceeds
// `limit` per `window`. Fails OPEN — a counter error allows the request, so an
// infra blip can never lock everyone out. A nil counter disables limiting.
func rateLimitByKey(counter RateLimitCounter, keyFn func(*http.Request) string, limit int, window time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if counter == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			allowed, err := counter.AllowRequest(r.Context(), keyFn(r), limit, window)
			if err != nil {
				slog.Warn("rate limit check failed; allowing request", "error", err)
				next.ServeHTTP(w, r)
				return
			}
			if !allowed {
				w.Header().Set("Retry-After", strconv.Itoa(int(window.Seconds())))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"error":"rate_limited","message":"too many requests, please slow down"}`))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RateLimit rejects more than `limit` requests per `window` from a single client
// IP per route.
func RateLimit(counter RateLimitCounter, limit int, window time.Duration) func(http.Handler) http.Handler {
	return rateLimitByKey(counter, func(r *http.Request) string {
		return "rl:" + r.URL.Path + ":" + clientIP(r)
	}, limit, window)
}

// trustedProxyCount is how many reverse proxies sit in front of the app and
// append to X-Forwarded-For. Each proxy appends the address it received the
// connection FROM to the RIGHT, so the client-controllable (spoofable) portion
// is to the LEFT — taking the LEFT-most hop (the old behaviour) let any client
// forge their rate-limit identity with a fresh X-Forwarded-For per request. We
// instead take the entry just inside the trusted hops. Default 1 (a single LB).
// Set to 0 to ignore X-Forwarded-For entirely (no proxy / direct exposure).
var trustedProxyCount = 1

// SetTrustedProxyCount configures how many trusted proxies prepend to
// X-Forwarded-For. Called from main wiring with the deployment's topology.
func SetTrustedProxyCount(n int) {
	if n < 0 {
		n = 0
	}
	trustedProxyCount = n
}

// RequestTimeout attaches a context deadline to each request so a slow or
// black-holed dependency (DynamoDB/OpenSearch have no default per-call deadline)
// can't pin a handler goroutine indefinitely — the deadline propagates through
// r.Context() to every downstream call. Long-lived connections (the WebSocket
// upgrade) are exempt, or the socket would be torn down after the deadline.
func RequestTimeout(d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if d <= 0 || strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
				next.ServeHTTP(w, r)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RateLimitPerUser is like RateLimit but keys on the authenticated user ID
// (falling back to client IP when unauthenticated), so a single account can't
// flood write endpoints — message sends fan out notifications to every member,
// so an unbounded write rate is an amplification vector. Shares one bucket
// across every route it wraps (keyed by user, not path). Fails OPEN like
// RateLimit. Must run AFTER the auth middleware so the user ID is in context.
func RateLimitPerUser(counter RateLimitCounter, limit int, window time.Duration) func(http.Handler) http.Handler {
	return rateLimitByKey(counter, func(r *http.Request) string {
		id := UserIDFromContext(r.Context())
		if id == "" {
			id = clientIP(r)
		}
		return "rlu:write:" + id
	}, limit, window)
}

// clientIP extracts the real client IP for rate-limit keying. With trusted
// proxies it returns the X-Forwarded-For entry just left of the trusted hops
// (resistant to a forged leading X-Forwarded-For); otherwise the connection's
// remote host.
func clientIP(r *http.Request) string {
	if trustedProxyCount > 0 {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			idx := max(len(parts)-trustedProxyCount, 0)
			if ip := strings.TrimSpace(parts[idx]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// Wrap applies a chain of middleware to a handler in the order provided,
// so the first middleware in the list is the outermost.
func Wrap(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// WrapFunc is a convenience wrapper for http.HandlerFunc.
func WrapFunc(h http.HandlerFunc, mws ...func(http.Handler) http.Handler) http.Handler {
	return Wrap(h, mws...)
}

// Flush implements http.Flusher for the responseWriter wrapper.
func (rw *responseWriter) Flush() {
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap returns the underlying ResponseWriter, supporting http.ResponseController.
func (rw *responseWriter) Unwrap() http.ResponseWriter {
	return rw.ResponseWriter
}

// Compile-time interface checks.
var (
	_ http.ResponseWriter = (*responseWriter)(nil)
	_ http.Flusher        = (*responseWriter)(nil)
)
