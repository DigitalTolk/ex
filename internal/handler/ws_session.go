package handler

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// wsSession is a socket's session deadline: the connection is cancelled when
// it passes, and a renew frame carrying a fresh ticket moves it out. Without
// renewals a socket lives exactly as long as before (its token's expiry plus
// wsSessionGrace); with them a healthy client keeps one socket open instead of
// reconnecting, and refetching its lists, every token lifetime.
type wsSession struct {
	mu      sync.Mutex
	until   time.Time
	timer   *time.Timer
	confirm func(expiresIn time.Duration)
}

// newWSSession cancels the connection at until. confirm tells the client a
// renewal took, with the socket's new remaining lifetime.
func newWSSession(until time.Time, cancel context.CancelFunc, confirm func(expiresIn time.Duration)) *wsSession {
	return &wsSession{until: until, timer: time.AfterFunc(time.Until(until), cancel), confirm: confirm}
}

// stop releases the deadline timer when the connection ends.
func (s *wsSession) stop() { s.timer.Stop() }

func (s *wsSession) deadline() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.until
}

// extend moves the deadline out to until. It refuses a deadline that is not
// later, and a session that already ended (its timer fired and cancelled the
// connection).
func (s *wsSession) extend(until time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !until.After(s.until) || !s.timer.Stop() {
		return false
	}
	s.until = until
	s.timer.Reset(time.Until(until))
	return true
}

// renewSession handles a session.renew frame. The client mints the ticket
// through POST /ws/ticket, whose auth middleware re-validates the session —
// the same check a reconnect passes, so a deactivated or logged-out user can
// never mint one — and the ticket's deadline is its fresh token's expiry. A
// ticket that is unknown, used, another user's, or would not move the deadline
// out extends nothing: the socket then closes at its current deadline and the
// client reconnects, as it did before renewals existed.
func (h *WSHandler) renewSession(ctx context.Context, userID, ticket string, sess *wsSession) {
	if sess == nil || ticket == "" || h.tickets == nil {
		return
	}
	owner, deadline, err := h.tickets.ConsumeWSTicket(ctx, ticket)
	if err != nil {
		slog.WarnContext(ctx, "ws: session renew ticket read failed", "userID", userID, "error", err)
		return
	}
	if owner != userID {
		return
	}
	until := deadline.Add(wsSessionGrace)
	if sess.extend(until) {
		sess.confirm(time.Until(until))
	}
}
