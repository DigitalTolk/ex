package service

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// panickyLocker panics on its first election and counts every attempt.
type panickyLocker struct{ n *atomic.Int64 }

func (l *panickyLocker) AcquireLock(context.Context, string, string, time.Duration) (bool, error) {
	if l.n.Add(1) == 1 {
		panic("directory backend exploded")
	}
	return false, nil
}

// The sweep loop runs on a detached goroutine; a panic in one sweep used to
// kill the process. It must be confined to that sweep — the loop keeps going.
func TestDirectorySyncRunSurvivesPanickingSweep(t *testing.T) {
	env := setupDirectorySync(&stubDirectoryLookup{}, []*model.User{oidcUser("u1", "a@x.se", "")})
	var attempts atomic.Int64
	env.svc.locker = &panickyLocker{n: &attempts}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		env.svc.Run(ctx, 5*time.Millisecond)
		close(done)
	}()
	waitFor(t, func() bool { return attempts.Load() >= 2 }) // panicked boot sweep, then a tick
	cancel()
	<-done
}
