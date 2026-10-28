package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/oklog/ulid/v2"
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

// authUserStore is deliberately narrow (status + role): the lookup runs on
// every authenticated request, and a full user fetch (GetByID) drags avatar
// URL resolution — extra Redis round trips for fields this middleware
// discards.
type authUserStore interface {
	UserAccess(ctx context.Context, id string) (status string, role model.SystemRole, err error)
}

// AuthWithUserStatus validates a JWT and, when a user store is supplied,
// rejects tokens for accounts that have since been deactivated and replaces
// the token's role claim with the STORED role. An access token lives 15
// minutes; without this, an admin demoted (or a member promoted) in the
// meantime kept the old powers until it expired — every role gate
// (RequireSystemRole, the handlers' requireAdmin and guest checks) reads the
// claims this puts in context.
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
			// Scoped tokens (runner, run) authenticate machines, not people —
			// they are valid only on their dedicated routes via AuthScope. A
			// leaked runner token must not drive the interactive API.
			if claims.Scope != "" {
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}
			if users != nil {
				status, role, err := users.UserAccess(r.Context(), claims.UserID)
				if err != nil || status == "deactivated" {
					http.Error(w, "account deactivated", http.StatusUnauthorized)
					return
				}
				if role != claims.SystemRole {
					fresh := *claims
					fresh.SystemRole = role
					claims = &fresh
				}
			}

			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// AuthScope validates a JWT and requires it to carry exactly the given
// scope. Session tokens (empty scope) and other scopes are rejected: the
// runner API takes runner tokens only, the run-tool API run tokens only.
func AuthScope(jwtMgr *auth.JWTManager, scope string) func(http.Handler) http.Handler {
	return AuthScopeWithUserStatus(jwtMgr, scope, nil)
}

// AuthScopeWithUserStatus is AuthScope plus the deactivation check the
// session middleware already makes: a machine token acts with its user's
// access (a run token's UserID is the run's INVOKER), so it must stop working
// the moment that account is deactivated, not when the token expires. An
// unreadable status fails closed. A nil store skips the check.
func AuthScopeWithUserStatus(jwtMgr *auth.JWTManager, scope string, users authUserStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tokenStr := extractToken(r)
			if tokenStr == "" {
				http.Error(w, "missing or invalid token", http.StatusUnauthorized)
				return
			}
			claims, err := jwtMgr.ValidateToken(tokenStr)
			if err != nil || claims.Scope != scope {
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}
			if users != nil {
				status, _, err := users.UserAccess(r.Context(), claims.UserID)
				if err != nil || status == "deactivated" {
					http.Error(w, "account deactivated", http.StatusUnauthorized)
					return
				}
			}
			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RunnerProofHeader carries a device-bound runner's signature over the
// request: "v1.<unix-seconds>.<base64url DER signature>".
const RunnerProofHeader = "X-Ex-Runner-Proof"

// RunnerRequest is what the runner middleware hands its checker about one
// request: enough to verify the device proof and to record where the install
// was last used.
type RunnerRequest struct {
	Method string
	Path   string
	Proof  string
	IP     string
}

// RunnerRefusal is a checker's answer for a request it refuses: the status
// and the stable code the runner acts on (runner_disconnected,
// runner_clock_skew, runner_upgrade_required).
type RunnerRefusal struct {
	Status  int
	Code    string
	Message string
}

func (e *RunnerRefusal) Error() string { return e.Message }

// RunnerTokenChecker is the per-request check behind every runner route: the
// install must still exist (revocation on the Runners page, `ex-runner
// logout`, account deactivation, expiry) and, when it has a device key, the
// request must prove it holds it. It answers nil for an accepted request, a
// *RunnerRefusal, or any other error when the check itself failed.
type RunnerTokenChecker interface {
	CheckRunner(ctx context.Context, claims *model.TokenClaims, req RunnerRequest) error
}

// AuthRunner is AuthScope(runner) plus the per-install check. A refusal is a
// JSON error with its status (401 for a revoked install — the runner stops
// and asks for a fresh `ex-runner login`). A failed check is a 503 instead,
// so a store blip makes the runner back off and retry rather than give up on
// a credential that is probably fine. A nil checker fails closed: no runner
// token is accepted at all.
func AuthRunner(jwtMgr *auth.JWTManager, checker RunnerTokenChecker) func(http.Handler) http.Handler {
	scoped := AuthScope(jwtMgr, model.TokenScopeRunner)
	return func(next http.Handler) http.Handler {
		return scoped(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if checker == nil {
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}
			err := checker.CheckRunner(r.Context(), ClaimsFromContext(r.Context()), RunnerRequest{
				Method: r.Method,
				Path:   r.URL.Path,
				Proof:  r.Header.Get(RunnerProofHeader),
				IP:     clientIP(r),
			})
			var refusal *RunnerRefusal
			if errors.As(err, &refusal) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(refusal.Status)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]string{"code": refusal.Code, "message": refusal.Message},
				})
				return
			}
			if err != nil {
				http.Error(w, "runner token check unavailable", http.StatusServiceUnavailable)
				return
			}
			next.ServeHTTP(w, r)
		}))
	}
}

// extractToken reads the bearer token from the Authorization header ONLY.
// The old `?token=` query fallback (added for the WebSocket upgrade, where
// browsers can't set headers) leaked the full access JWT into LB/proxy logs,
// browser history, and APM URL capture — the WS upgrade now authenticates
// with a single-use opaque ticket instead (handler.WSHandler.UpgradeAuth),
// so no URL ever carries a credential.
func extractToken(r *http.Request) string {
	if ah := r.Header.Get("Authorization"); ah != "" {
		if strings.HasPrefix(ah, "Bearer ") {
			return strings.TrimPrefix(ah, "Bearer ")
		}
	}
	return ""
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
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Client-Nonce")
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

// Logging returns access-log middleware that records method, path, status,
// and duration for each request.
//
// logAll=true logs every request, except /healthz when it returns 2xx —
// orchestrators (Docker, k8s) hit it every few seconds and the noise drowns
// out signal in the access log; a non-2xx healthcheck still logs so a
// flapping probe stays visible.
//
// logAll=false (ACCESS_LOG_ENABLED=false) silences the access log EXCEPT for
// 5xx responses: server faults must stay visible even with access logging
// switched off.
func Logging(logAll bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

			next.ServeHTTP(rw, r)

			if !logAll && rw.statusCode < 500 {
				return
			}
			if r.URL.Path == "/healthz" && rw.statusCode >= 200 && rw.statusCode < 300 {
				return
			}

			slog.Info("request",
				"method", r.Method,
				"path", RedactPath(r.URL.Path),
				"status", rw.statusCode,
				"duration", time.Since(start).String(),
				"requestID", RequestIDFromContext(r.Context()),
			)
		})
	}
}

// RedactPath masks credentials that ride in a URL path before the path reaches
// a log line: an incoming webhook's URL (/hooks/{id}) is that webhook's only
// credential, and a media URL's token is a bearer capability for the file.
func RedactPath(path string) string {
	switch {
	case strings.HasPrefix(path, "/hooks/"):
		return "/hooks/[redacted]"
	case strings.HasPrefix(path, mediaPathPrefix):
		return redactToken(mediaPathPrefix, strings.TrimPrefix(path, mediaPathPrefix))
	case strings.HasPrefix(path, htmlPreviewPathPrefix):
		return redactToken(htmlPreviewPathPrefix, strings.TrimPrefix(path, htmlPreviewPathPrefix))
	}
	return path
}

// redactToken masks the token segment of a "<prefix><token>/<file>" path.
func redactToken(prefix, rest string) string {
	if _, file, ok := strings.Cut(rest, "/"); ok {
		return prefix + "[redacted]/" + file
	}
	return prefix + "[redacted]"
}

const (
	mediaPathPrefix = "/api/v1/media/"
	// The HTML-attachment preview serves the same media tokens.
	htmlPreviewPathPrefix = "/api/v1/html-preview/"
)

// SecretFingerprint is a short, non-reversible stand-in for a secret
// identifier in logs (e.g. a webhook ID), stable enough to correlate lines.
func SecretFingerprint(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return "sha256:" + hex.EncodeToString(sum[:6])
}

// RequestID is middleware that generates a unique request ID, stores it in context,
// and sets the X-Request-ID response header.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" {
			id = ulid.Make().String()
		}

		ctx := context.WithValue(r.Context(), requestIDKey, id)
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// securityHeaderCSP is intentionally permissive on the resource directives
// (img/style/font/connect) so the SPA's Google Fonts, S3 images, Giphy media,
// and the wss WebSocket keep working, while the high-value directives are
// locked down: being framed is forbidden (clickjacking), and object/base are
// neutered.
//
// script-src has no 'unsafe-inline': the SPA's own inline scripts (index.html's
// boot blocks) are allowed by hash through CSPOptions.ScriptSrc. Nothing else
// on the page is inline — the HTML-attachment preview is its own
// network-loaded document with its own policy, not a srcdoc that would
// inherit this one.
//
// frame-src is 'none' unless CSPOptions.FramePath names the one route the
// page may frame (the preview); see frameSources.
const securityHeaderCSP = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
	"font-src 'self' https://fonts.gstatic.com; " +
	"img-src 'self' https: data: blob:; " +
	"media-src 'self' https: blob:; " +
	"connect-src 'self' https: wss:; " +
	"frame-src 'none'; " +
	"object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

// SecurityHeaders sets defense-in-depth response headers on every response:
// a CSP (incl. frame-ancestors), X-Frame-Options (clickjacking belt-and-braces
// for older browsers), nosniff, a no-referrer policy (so an access token that
// rides in a URL can't leak via Referer), and HSTS (ignored by browsers over
// plain HTTP, so safe to always send).
func SecurityHeaders(next http.Handler) http.Handler {
	return SecurityHeadersWith()(next)
}

// SecurityHeadersWith is SecurityHeaders with extra connect-src origins
// appended to the CSP. Direct-to-storage browser uploads PUT presigned URLs
// straight at the S3 endpoint; the base policy's `https:` covers production
// object stores, but a plain-http endpoint (local MinIO) must be allow-listed
// explicitly or the browser refuses the upload with a CSP violation.
func SecurityHeadersWith(extraConnectSrc ...string) func(http.Handler) http.Handler {
	return SecurityHeadersWithOptions(CSPOptions{ConnectSrc: extraConnectSrc})
}

// CSPOptions are the per-deployment additions to the base policy. The zero
// value serves securityHeaderCSP unchanged.
type CSPOptions struct {
	// ConnectSrc is appended to connect-src (see SecurityHeadersWith).
	ConnectSrc []string
	// ScriptSrc is appended to script-src: the hashes of the served page's
	// inline scripts, and e.g. Sentry's CDN, which serves the lazily loaded
	// Session Replay bundle when a deployment samples it.
	ScriptSrc []string
	// WorkerSrc, when set, adds a worker-src of 'self' plus these sources
	// (Session Replay compresses in a blob: worker). 'self' stays because
	// pdf.js runs its worker from the app's own origin; without WorkerSrc
	// the directive is omitted and workers fall back to script-src.
	WorkerSrc []string
	// FramePath is the one same-origin path prefix the page may frame (the
	// HTML-attachment preview route). Empty keeps frame-src 'none'.
	FramePath string
	// FrameHosts are the deployment's public hosts (host[:port]) that
	// FramePath is allowed under, besides the host each request names.
	FrameHosts []string
}

// trustedTypesReportOnly asks the browser to report — not block — any string
// written into an HTML or script DOM sink (innerHTML, script.src, …). No
// first-party code does; a report means a library or a regression does.
const trustedTypesReportOnly = "require-trusted-types-for 'script'"

// SecurityHeadersWithOptions is SecurityHeaders with the given additions to
// the CSP.
func SecurityHeadersWithOptions(o CSPOptions) func(http.Handler) http.Handler {
	csp := securityHeaderCSP
	if len(o.ConnectSrc) > 0 {
		csp = strings.Replace(csp, "connect-src 'self'", "connect-src 'self' "+strings.Join(o.ConnectSrc, " "), 1)
	}
	if len(o.ScriptSrc) > 0 {
		csp = strings.Replace(csp, "script-src 'self'", "script-src 'self' "+strings.Join(o.ScriptSrc, " "), 1)
	}
	if len(o.WorkerSrc) > 0 {
		csp += "; worker-src 'self' " + strings.Join(o.WorkerSrc, " ")
	}
	// frame-src is the one directive that can depend on the request (its
	// Host); everything around it is fixed.
	const noFrames = "frame-src 'none'"
	beforeFrames, afterFrames, _ := strings.Cut(csp, noFrames)
	frames := newFrameSources(o.FramePath, o.FrameHosts)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("Content-Security-Policy", beforeFrames+"frame-src "+frames.forHost(r.Host)+afterFrames)
			h.Set("Content-Security-Policy-Report-Only", trustedTypesReportOnly)
			h.Set("X-Frame-Options", "DENY")
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			next.ServeHTTP(w, r)
		})
	}
}

// RequestIDFromContext returns the request ID stored in context.
func RequestIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
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
// X-Forwarded-For. Called from the app wiring (internal/app) with the deployment's topology.
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
// upgrade) are exempt, or the socket would be torn down after the deadline, and
// so is every path under one of streamingPrefixes: a download or a video read
// legitimately outlasts any fixed budget (a 30s cap truncated them mid-body).
// Those routes bound a stalled client with ProgressDeadline instead.
func RequestTimeout(d time.Duration, streamingPrefixes ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if d <= 0 || strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || hasAnyPrefix(r.URL.Path, streamingPrefixes) {
				next.ServeHTTP(w, r)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
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
