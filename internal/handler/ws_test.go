package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/eventlog"
)

// Redis-free WSHandler tests live here; everything that needs a live broker
// (and therefore the shared Redis container) is in ws_integration_test.go.


func TestWSHandler_Connect_Unauthenticated(t *testing.T) {
	h := &WSHandler{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/ws", nil)
	rec := httptest.NewRecorder()

	// No auth context set, should return 401.
	h.Connect(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

// stubReplayer is a captured-call double for InboxReplayer so each
// WS-replay scenario can dictate what the durable inbox returns
// without standing up Redis Streams in a unit test.
type stubReplayer struct {
	res      eventlog.ReplayResult
	err      error
	gotUser  string
	gotSince string
}

func (s *stubReplayer) Replay(_ context.Context, userID, since string) (eventlog.ReplayResult, error) {
	s.gotUser = userID
	s.gotSince = since
	return s.res, s.err
}

// SetReplayer assignment must stick — guards against the field-tag
// accident where setters get re-named but the field isn't updated.
func TestWSHandler_SetReplayer(t *testing.T) {
	h := &WSHandler{}
	rep := &stubReplayer{}
	h.SetReplayer(rep)
	if h.replayer != rep {
		t.Error("SetReplayer did not assign field")
	}
}

// Drain returns immediately when no connections are in flight, waits for an
// in-flight handler's teardown when one is, and reports false on timeout —
// the graceful-shutdown contract that lets deploys publish offline
// transitions instead of leaving presence to lapse by TTL.
func TestWSHandler_Drain(t *testing.T) {
	h := &WSHandler{}

	if !h.Drain(time.Second) {
		t.Fatal("Drain with no connections must return true immediately")
	}

	// Simulate an in-flight connection handler.
	h.drain.Add(1)
	if h.Drain(50 * time.Millisecond) {
		t.Fatal("Drain must time out while a handler is still in flight")
	}
	release := make(chan struct{})
	go func() {
		<-release
		h.drain.Done()
	}()
	close(release)
	if !h.Drain(5 * time.Second) {
		t.Fatal("Drain must return true once the handler finishes")
	}
}
