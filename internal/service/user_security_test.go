package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// panickyListStore panics on the first ListUsers and signals every call.
type panickyListStore struct {
	*mockUserStore
	calls chan int
	n     int
}

func (p *panickyListStore) ListUsers(ctx context.Context, limit int, cursor string) ([]*model.User, string, error) {
	p.n++
	select {
	case p.calls <- p.n:
	default:
	}
	if p.n == 1 {
		panic("store exploded")
	}
	return p.mockUserStore.ListUsers(ctx, limit, cursor)
}

// Regression: the expired-status sweeper ran as a bare goroutine — one panic
// in a sweep took the whole process (and every WebSocket on it) down. A
// panicking sweep is now logged and the sweeper keeps its schedule.
func TestRunExpiredStatusSweeperSurvivesAPanickingSweep(t *testing.T) {
	st := &panickyListStore{mockUserStore: newMockUserStore(), calls: make(chan int, 8)}
	svc := NewUserService(st, nil, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		svc.RunExpiredStatusSweeper(ctx, time.Millisecond)
	}()
	if n := <-st.calls; n != 1 {
		t.Fatalf("first sweep = call %d", n)
	}
	if n := <-st.calls; n != 2 {
		t.Fatalf("the sweeper must run again after a panicking sweep, got call %d", n)
	}
	cancel()
	<-done
}

// fakeAutomations records StopUserAutomations calls.
type fakeAutomations struct {
	stopped []string
	err     error
}

func (f *fakeAutomations) StopUserAutomations(_ context.Context, userID string) error {
	f.stopped = append(f.stopped, userID)
	return f.err
}

// Deactivation stops the account's agent automations; a failure to stop
// them fails the call (the admin retries) — reactivation doesn't touch them.
func TestDeactivationStopsAgentAutomations(t *testing.T) {
	users := newMockUserStore()
	users.users["u-1"] = &model.User{ID: "u-1", Status: "active", AuthProvider: model.AuthProviderOIDC}
	svc := NewUserService(users, nil, nil, &mockPublisher{})
	autos := &fakeAutomations{}
	svc.SetAutomationStopper(autos)
	if _, err := svc.SetStatus(context.Background(), "u-1", true); err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	if len(autos.stopped) != 1 || autos.stopped[0] != "u-1" {
		t.Fatalf("automations stopped for %v, want [u-1]", autos.stopped)
	}
	if _, err := svc.SetStatus(context.Background(), "u-1", false); err != nil || len(autos.stopped) != 1 {
		t.Fatalf("reactivate: err=%v stops=%v", err, autos.stopped)
	}
	autos.err = errors.New("orchestrator down")
	if _, err := svc.SetStatus(context.Background(), "u-1", true); err == nil {
		t.Fatal("a failed automation stop must fail the deactivation")
	}
	if users.users["u-1"].Status != "deactivated" {
		t.Fatal("the status flip itself still lands")
	}
}

// The directory sweep reactivates only what the directory deactivated: an
// admin's deactivation of an SSO account must survive the 12-hourly sweep
// that still finds the person upstream.
func TestDirectorySweepNeverUndoesAnAdminDeactivation(t *testing.T) {
	users := newMockUserStore()
	users.users["u-sso"] = &model.User{ID: "u-sso", Status: "active", AuthProvider: model.AuthProviderOIDC}
	svc := NewUserService(users, nil, nil, &mockPublisher{})
	ctx := context.Background()

	if _, err := svc.SetStatus(ctx, "u-sso", true); err != nil {
		t.Fatalf("admin deactivate: %v", err)
	}
	if err := svc.SetStatusFromDirectory(ctx, "u-sso", false); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if users.users["u-sso"].Status != "deactivated" {
		t.Fatal("the directory sweep reactivated an account an admin deactivated")
	}

	// The admin reactivates; the directory then deactivates (deleted
	// upstream) and may reactivate its own call.
	if _, err := svc.SetStatus(ctx, "u-sso", false); err != nil || users.users["u-sso"].DeactivatedBy != "" {
		t.Fatalf("admin reactivate: err=%v by=%q", err, users.users["u-sso"].DeactivatedBy)
	}
	if err := svc.SetStatusFromDirectory(ctx, "u-sso", true); err != nil || users.users["u-sso"].DeactivatedBy != model.DeactivatedByDirectory {
		t.Fatalf("directory deactivate: err=%v by=%q", err, users.users["u-sso"].DeactivatedBy)
	}
	if err := svc.SetStatusFromDirectory(ctx, "u-sso", false); err != nil || users.users["u-sso"].Status != "active" {
		t.Fatalf("directory reactivate: err=%v status=%q", err, users.users["u-sso"].Status)
	}
}
