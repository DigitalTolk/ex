package agents

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The runner middleware's check only asked "does the install still exist?" —
// a deactivated user's runner kept claiming and executing runs. The check now
// also refuses an install whose owner is deactivated, and a status read that
// fails surfaces as an error (→ 503, the runner backs off and retries).
func TestRunnerToken_ActiveRefusesDeactivatedOwner(t *testing.T) {
	ctx := context.Background()
	env := newRTEnv()
	env.seedToken("rt-gone", "u-gone", env.now.Add(time.Hour))
	env.seedToken("rt-live", "u-alice", env.now.Add(time.Hour))

	if ok, err := env.svc.RunnerTokenActive(ctx, rtClaims("rt-gone", "u-gone")); err != nil || ok {
		t.Fatalf("deactivated owner's install: got %v, %v; want false", ok, err)
	}
	if ok, err := env.svc.RunnerTokenActive(ctx, rtClaims("rt-live", "u-alice")); err != nil || !ok {
		t.Fatalf("active owner's install: got %v, %v; want true", ok, err)
	}
	env.users.err = errRTFake
	if _, err := env.svc.RunnerTokenActive(ctx, rtClaims("rt-live", "u-alice")); !errors.Is(err, errRTFake) {
		t.Fatalf("status read failure must surface, got %v", err)
	}
}
