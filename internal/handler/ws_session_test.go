package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The ticket answer tells the client how long the socket it opens will live
// (the token's expiry plus the grace), so it can renew before that.
func TestMintTicket_ReportsTheSocketLifetime(t *testing.T) {
	h := &WSHandler{}
	h.SetTicketStore(newFakeTicketStore())
	exp := time.Now().Add(10 * time.Minute)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/ws/ticket", nil).WithContext(claimsCtx("u-1", exp))
	rec := httptest.NewRecorder()
	h.MintTicket(rec, req)

	var body struct {
		ExpiresIn int64 `json:"expiresIn"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body = %q (%v)", rec.Body.String(), err)
	}
	want := time.Until(exp.Add(wsSessionGrace)).Milliseconds()
	if diff := want - body.ExpiresIn; diff < 0 || diff > time.Second.Milliseconds() {
		t.Fatalf("expiresIn = %d ms, want ≈ %d", body.ExpiresIn, want)
	}
}

// renewRecorder captures the confirmations a session sends.
type renewRecorder struct{ sent []time.Duration }

func (r *renewRecorder) confirm(expiresIn time.Duration) { r.sent = append(r.sent, expiresIn) }

func newTestSession(t *testing.T, until time.Time) (*wsSession, *renewRecorder, context.Context) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rec := &renewRecorder{}
	s := newWSSession(until, cancel, rec.confirm)
	t.Cleanup(s.stop)
	return s, rec, ctx
}

// A renew frame carrying the user's own fresh ticket moves the socket's
// deadline out to the ticket's (plus the grace) and confirms the new lifetime.
func TestRenewSession_OwnTicketExtends(t *testing.T) {
	store := newFakeTicketStore()
	h := &WSHandler{}
	h.SetTicketStore(store)
	s, rec, ctx := newTestSession(t, time.Now().Add(time.Minute))
	next := time.Now().Add(15 * time.Minute)
	_ = store.MintWSTicket(context.Background(), "fresh", "u-1", next)

	h.renewSession(ctx, "u-1", "fresh", s)

	if got := s.deadline(); !got.Equal(next.Add(wsSessionGrace)) {
		t.Fatalf("deadline = %v, want %v", got, next.Add(wsSessionGrace))
	}
	if len(rec.sent) != 1 || rec.sent[0] < 15*time.Minute {
		t.Fatalf("confirmations = %v, want one of the new lifetime", rec.sent)
	}
	// Single-use: the same ticket can't extend twice.
	h.renewSession(ctx, "u-1", "fresh", s)
	if len(rec.sent) != 1 {
		t.Fatalf("confirmations = %v, want the used ticket refused", rec.sent)
	}
}

// Nothing else extends a socket: another user's ticket, an unknown one, a
// ticket store that fails, a ticket that would not move the deadline out, or
// a connection with no session (or no ticket store) at all.
func TestRenewSession_RefusesEverythingElse(t *testing.T) {
	store := newFakeTicketStore()
	h := &WSHandler{}
	h.SetTicketStore(store)
	start := time.Now().Add(time.Hour)
	s, rec, ctx := newTestSession(t, start)

	_ = store.MintWSTicket(context.Background(), "theirs", "u-2", time.Now().Add(2*time.Hour))
	h.renewSession(ctx, "u-1", "theirs", s)
	h.renewSession(ctx, "u-1", "unknown", s)
	h.renewSession(ctx, "u-1", "", s)
	_ = store.MintWSTicket(context.Background(), "older", "u-1", time.Now().Add(time.Minute))
	h.renewSession(ctx, "u-1", "older", s)
	store.consumeErr = errors.New("redis down")
	_ = store.MintWSTicket(context.Background(), "fresh", "u-1", time.Now().Add(2*time.Hour))
	h.renewSession(ctx, "u-1", "fresh", s)
	h.renewSession(ctx, "u-1", "fresh", nil)
	(&WSHandler{}).renewSession(ctx, "u-1", "fresh", s)

	if !s.deadline().Equal(start) || len(rec.sent) != 0 {
		t.Fatalf("deadline = %v (confirmations %v), want it untouched at %v", s.deadline(), rec.sent, start)
	}
}

// Once the deadline has passed the session is over: the connection was
// cancelled, and no ticket brings it back.
func TestWSSession_EndsAtItsDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rec := &renewRecorder{}
	s := newWSSession(time.Now().Add(10*time.Millisecond), cancel, rec.confirm)
	defer s.stop()

	<-ctx.Done()
	if s.extend(time.Now().Add(time.Hour)) {
		t.Fatal("an ended session was extended")
	}
}
