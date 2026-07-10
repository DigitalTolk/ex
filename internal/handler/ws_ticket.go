package handler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/golang-jwt/jwt/v5"
)

// WSTicketStore mints and redeems one-time WebSocket upgrade tickets
// (Redis-backed in production). A browser cannot set an Authorization header
// on a WebSocket, so historically the upgrade URL carried the full access
// JWT (?token=...) — leaking a 15-minute credential into LB/proxy logs,
// browser history, and APM URL capture. Tickets replace that: single-use,
// 30-second, high-entropy, and carrying only an opaque random value in the
// URL.
type WSTicketStore interface {
	MintWSTicket(ctx context.Context, ticket, userID string, sessionDeadline time.Time) error
	ConsumeWSTicket(ctx context.Context, ticket string) (userID string, sessionDeadline time.Time, err error)
}

// wsTicketRand is the entropy source for tickets — a var so tests can force
// the (otherwise unreachable on supported platforms) failure arm.
var wsTicketRand = rand.Read

// wsSessionGrace extends the socket's lifetime slightly past the access
// token's expiry so a healthy client (which refreshes tokens ahead of use)
// reconnects on its own schedule instead of exactly at the expiry stampede.
var wsSessionGrace = time.Minute

// wsMaxSessionLifetime bounds a socket whose auth context carries no expiry
// (header-auth paths with synthetic claims in tests). Matches the access
// token TTL + grace so both paths re-authenticate on the same cadence.
var wsMaxSessionLifetime = 16 * time.Minute

// SetTicketStore wires the one-time upgrade ticket store. Optional — without
// it, MintTicket answers 503 and upgrades fall through to header auth.
func (h *WSHandler) SetTicketStore(s WSTicketStore) { h.tickets = s }

// MintTicket issues a one-time WebSocket upgrade ticket for the
// authenticated user (POST /api/v1/ws/ticket, authed + per-user rate
// limited). The ticket inherits the caller's token expiry as the socket's
// session deadline: the connection is force-closed shortly after the access
// token would have expired, so a revoked/deactivated session cannot keep a
// live socket beyond the token lifetime even if the ephemeral force-logout
// event is lost.
func (h *WSHandler) MintTicket(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if claims == nil || claims.UserID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	if h.tickets == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "websocket tickets not configured")
		return
	}
	// Stored WITHOUT grace: Connect adds wsSessionGrace exactly once for
	// both auth paths (ticket and header), so the two can never drift.
	deadline := time.Now().Add(wsMaxSessionLifetime - wsSessionGrace)
	if claims.ExpiresAt != nil {
		deadline = claims.ExpiresAt.Time
	}
	buf := make([]byte, 32)
	if _, err := wsTicketRand(buf); err != nil {
		slog.Error("ws ticket: rand", "error", err)
		writeError(w, http.StatusInternalServerError, "internal", "could not mint ticket")
		return
	}
	ticket := hex.EncodeToString(buf)
	if err := h.tickets.MintWSTicket(r.Context(), ticket, claims.UserID, deadline); err != nil {
		slog.Error("ws ticket: mint", "userID", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "internal", "could not mint ticket")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"ticket": ticket})
}

// UpgradeAuth authenticates the WebSocket upgrade: a ?ticket= query is
// redeemed (single-use) and its userID + session deadline become the
// request's auth context; without a ticket the request falls through to the
// standard header-based auth middleware (non-browser clients, tests). The
// access JWT itself never appears in the URL on either path.
func (h *WSHandler) UpgradeAuth(headerAuth func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		fallback := headerAuth(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ticket := r.URL.Query().Get("ticket")
			if ticket == "" || h.tickets == nil {
				fallback.ServeHTTP(w, r)
				return
			}
			userID, deadline, err := h.tickets.ConsumeWSTicket(r.Context(), ticket)
			if err != nil {
				slog.Error("ws ticket: consume", "error", err)
				writeError(w, http.StatusUnauthorized, "unauthorized", "invalid ticket")
				return
			}
			if userID == "" {
				// Unknown, expired, or already-used ticket.
				writeError(w, http.StatusUnauthorized, "unauthorized", "invalid ticket")
				return
			}
			claims := &model.TokenClaims{
				UserID:           userID,
				RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(deadline)},
			}
			next.ServeHTTP(w, r.WithContext(middleware.ContextWithClaims(r.Context(), claims)))
		})
	}
}
