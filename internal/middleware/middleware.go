package middleware

import (
	"context"
	"log/slog"
	"net/http"
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
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Refresh-Token")
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

// RequestIDFromContext returns the request ID stored in context.
func RequestIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
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
