package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/golang-jwt/jwt/v5"
)

// fakeTicketStore is an in-memory WSTicketStore for handler tests.
type fakeTicketStore struct {
	mu         sync.Mutex
	tickets    map[string]struct {
		userID   string
		deadline time.Time
	}
	mintErr    error
	consumeErr error
}

func newFakeTicketStore() *fakeTicketStore {
	return &fakeTicketStore{tickets: map[string]struct {
		userID   string
		deadline time.Time
	}{}}
}

func (f *fakeTicketStore) MintWSTicket(_ context.Context, ticket, userID string, deadline time.Time) error {
	if f.mintErr != nil {
		return f.mintErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tickets[ticket] = struct {
		userID   string
		deadline time.Time
	}{userID, deadline}
	return nil
}

func (f *fakeTicketStore) ConsumeWSTicket(_ context.Context, ticket string) (string, time.Time, error) {
	if f.consumeErr != nil {
		return "", time.Time{}, f.consumeErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	entry, ok := f.tickets[ticket]
	if !ok {
		return "", time.Time{}, nil
	}
	delete(f.tickets, ticket) // single-use
	return entry.userID, entry.deadline, nil
}

func claimsCtx(userID string, exp time.Time) context.Context {
	claims := &model.TokenClaims{UserID: userID}
	if !exp.IsZero() {
		claims.RegisteredClaims = jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(exp)}
	}
	return middleware.ContextWithClaims(context.Background(), claims)
}

func TestMintTicket_IssuesSingleUseTicket(t *testing.T) {
	h := &WSHandler{}
	store := newFakeTicketStore()
	h.SetTicketStore(store)
	exp := time.Now().Add(10 * time.Minute)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/ws/ticket", nil).WithContext(claimsCtx("u-1", exp))
	rec := httptest.NewRecorder()
	h.MintTicket(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Ticket string `json:"ticket"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Ticket == "" {
		t.Fatalf("ticket body = %q (%v)", rec.Body.String(), err)
	}
	if len(body.Ticket) != 64 {
		t.Fatalf("ticket length = %d, want 64 hex chars (32 random bytes)", len(body.Ticket))
	}
	uid, deadline, err := store.ConsumeWSTicket(context.Background(), body.Ticket)
	if err != nil || uid != "u-1" {
		t.Fatalf("stored ticket = (%q, %v)", uid, err)
	}
	// The stored deadline is the raw token expiry — Connect adds the session
	// grace exactly once for both auth paths.
	if deadline.Sub(exp) > time.Second || exp.Sub(deadline) > time.Second {
		t.Fatalf("deadline = %v, want ≈ %v", deadline, exp)
	}
}

func TestMintTicket_NoExpiryFallsBackToMaxLifetime(t *testing.T) {
	h := &WSHandler{}
	store := newFakeTicketStore()
	h.SetTicketStore(store)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/ws/ticket", nil).WithContext(claimsCtx("u-1", time.Time{}))
	rec := httptest.NewRecorder()
	h.MintTicket(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body struct {
		Ticket string `json:"ticket"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	_, deadline, _ := store.ConsumeWSTicket(context.Background(), body.Ticket)
	want := time.Now().Add(wsMaxSessionLifetime - wsSessionGrace)
	if deadline.Sub(want) > time.Minute || want.Sub(deadline) > time.Minute {
		t.Fatalf("deadline = %v, want ≈ %v", deadline, want)
	}
}

func TestMintTicket_ErrorArms(t *testing.T) {
	t.Run("unauthenticated", func(t *testing.T) {
		h := &WSHandler{}
		h.SetTicketStore(newFakeTicketStore())
		rec := httptest.NewRecorder()
		h.MintTicket(rec, httptest.NewRequest(http.MethodPost, "/api/v1/ws/ticket", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})
	t.Run("no store", func(t *testing.T) {
		h := &WSHandler{}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/ws/ticket", nil).WithContext(claimsCtx("u-1", time.Time{}))
		h.MintTicket(rec, req)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", rec.Code)
		}
	})
	t.Run("mint failure", func(t *testing.T) {
		h := &WSHandler{}
		h.SetTicketStore(&fakeTicketStore{mintErr: errors.New("redis down")})
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/ws/ticket", nil).WithContext(claimsCtx("u-1", time.Time{}))
		h.MintTicket(rec, req)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
	})
}

// The upgrade auth: a valid ticket authenticates (and is consumed), a bad or
// errored ticket answers 401, and no ticket falls through to header auth.
func TestUpgradeAuth(t *testing.T) {
	sawUser := ""
	sawExp := time.Time{}
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		sawUser = middleware.UserIDFromContext(r.Context())
		if c := middleware.ClaimsFromContext(r.Context()); c != nil && c.ExpiresAt != nil {
			sawExp = c.ExpiresAt.Time
		}
	})
	headerAuth := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") == "Bearer good" {
				next.ServeHTTP(w, r.WithContext(claimsCtx("u-header", time.Time{})))
				return
			}
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		})
	}

	t.Run("valid ticket authenticates and is single-use", func(t *testing.T) {
		h := &WSHandler{}
		store := newFakeTicketStore()
		h.SetTicketStore(store)
		deadline := time.Now().Add(5 * time.Minute).Truncate(time.Second)
		_ = store.MintWSTicket(context.Background(), "tick", "u-9", deadline)

		handler := h.UpgradeAuth(headerAuth)(next)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/ws?ticket=tick", nil))
		if rec.Code != http.StatusOK || sawUser != "u-9" {
			t.Fatalf("code=%d user=%q, want 200/u-9", rec.Code, sawUser)
		}
		if !sawExp.Equal(deadline) {
			t.Fatalf("session deadline = %v, want %v", sawExp, deadline)
		}
		// Second use of the same ticket: consumed → 401.
		rec = httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/ws?ticket=tick", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("replayed ticket status = %d, want 401", rec.Code)
		}
	})

	t.Run("unknown ticket answers 401", func(t *testing.T) {
		h := &WSHandler{}
		h.SetTicketStore(newFakeTicketStore())
		handler := h.UpgradeAuth(headerAuth)(next)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/ws?ticket=nope", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("store error answers 401 (never authenticates on doubt)", func(t *testing.T) {
		h := &WSHandler{}
		h.SetTicketStore(&fakeTicketStore{consumeErr: errors.New("redis down")})
		handler := h.UpgradeAuth(headerAuth)(next)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/ws?ticket=any", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("no ticket falls through to header auth", func(t *testing.T) {
		h := &WSHandler{}
		h.SetTicketStore(newFakeTicketStore())
		handler := h.UpgradeAuth(headerAuth)(next)
		req := httptest.NewRequest(http.MethodGet, "/api/v1/ws", nil)
		req.Header.Set("Authorization", "Bearer good")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || sawUser != "u-header" {
			t.Fatalf("code=%d user=%q, want 200/u-header", rec.Code, sawUser)
		}
	})

	t.Run("no store falls through to header auth even with a ticket", func(t *testing.T) {
		h := &WSHandler{}
		handler := h.UpgradeAuth(headerAuth)(next)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/ws?ticket=any", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401 from header auth", rec.Code)
		}
	})
}

// The ticket URL never carries a JWT: what appears in the query is a 64-char
// random hex string with no claims inside — this is the structural fix for
// access tokens leaking into LB/proxy logs and browser history.
func TestUpgradeAuth_TicketIsOpaque(t *testing.T) {
	h := &WSHandler{}
	store := newFakeTicketStore()
	h.SetTicketStore(store)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ws/ticket", nil).WithContext(claimsCtx("u-1", time.Now().Add(time.Minute)))
	rec := httptest.NewRecorder()
	h.MintTicket(rec, req)
	var body struct {
		Ticket string `json:"ticket"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if strings.Contains(body.Ticket, ".") || strings.Contains(body.Ticket, "eyJ") {
		t.Fatalf("ticket %q looks like a JWT — it must be opaque", body.Ticket)
	}
}

// A typing burst inside typingMinInterval relays exactly one frame — the
// per-connection throttle that stops one client turning keystrokes into a
// fan-out PUBLISH each. After the interval passes, the next frame relays.
func TestPublishTyping_ThrottlesBursts(t *testing.T) {
	pub := &stubPublisher{}
	h := &WSHandler{}
	h.SetPublisher(pub)
	gate := newTypingGate()

	msg := inboundMessage{Type: "typing", ParentID: "c-1", ParentType: "conversation"}
	// Conversation typing needs the participant check — wire the conv service.
	convs := newDataConversationStore()
	users := newDataUserStoreForConv()
	if err := convs.CreateConversation(context.Background(), &model.Conversation{
		ID: "c-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "u-2"},
	}, nil); err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	h.convSvc = service.NewConversationService(convs, users, nil, nil, nil)

	for range 5 {
		h.publishTyping(context.Background(), "u-1", msg, gate)
	}
	if len(pub.hits) != 1 {
		t.Fatalf("burst published %d typing events, want 1 (throttled)", len(pub.hits))
	}

	// Simulate the interval passing: rewind the gate's stamp.
	gate.lastTyping = time.Now().Add(-2 * typingMinInterval)
	h.publishTyping(context.Background(), "u-1", msg, gate)
	if len(pub.hits) != 2 {
		t.Fatalf("post-interval frame published %d total, want 2", len(pub.hits))
	}
}

func TestMintTicket_RandFailure(t *testing.T) {
	orig := wsTicketRand
	wsTicketRand = func([]byte) (int, error) { return 0, errors.New("entropy exhausted") }
	t.Cleanup(func() { wsTicketRand = orig })

	h := &WSHandler{}
	h.SetTicketStore(newFakeTicketStore())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ws/ticket", nil).WithContext(claimsCtx("u-1", time.Time{}))
	h.MintTicket(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}
