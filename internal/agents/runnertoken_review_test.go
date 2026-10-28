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
func TestRunnerToken_AuthorizeRefusesDeactivatedOwner(t *testing.T) {
	ctx := context.Background()
	env := newRTEnv()
	env.seedToken("rt-gone", "u-gone", env.now.Add(time.Hour))
	env.seedToken("rt-live", "u-alice", env.now.Add(time.Hour))

	if err := env.svc.AuthorizeRunner(ctx, rtClaims("rt-gone", "u-gone"), RunnerRequest{}); !errors.Is(err, ErrRunnerTokenRevoked) {
		t.Fatalf("deactivated owner's install: got %v; want ErrRunnerTokenRevoked", err)
	}
	if err := env.svc.AuthorizeRunner(ctx, rtClaims("rt-live", "u-alice"), RunnerRequest{}); err != nil {
		t.Fatalf("active owner's install: got %v; want it accepted", err)
	}
	env.users.err = errRTFake
	if err := env.svc.AuthorizeRunner(ctx, rtClaims("rt-live", "u-alice"), RunnerRequest{}); !errors.Is(err, errRTFake) {
		t.Fatalf("status read failure must surface, got %v", err)
	}
}
