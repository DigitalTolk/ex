package service

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// The LoadOrStore "raced" arm in startTypingTicker only fires when two
// goroutines pass the initial Load before either stores — hammer it with
// barrier-released waves until the window is hit (thousands of attempts;
// lands reliably, including under -race and full-suite load).
func TestOrchTickCov_TypingTickerRace(t *testing.T) {
	fx := newOrchFixture(t)
	const rounds, workers = 600, 16

	for i := 0; i < rounds; i++ {
		run := &model.Run{ID: fmt.Sprintf("run-tick-%d", i), ParentID: "ch-1", ParentType: "channel", AgentID: testGGID}
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(workers)
		for w := 0; w < workers; w++ {
			go func() {
				defer wg.Done()
				<-start
				fx.orch.startTypingTicker(run)
			}()
		}
		close(start)
		wg.Wait()
		// Exactly one stored cancel survives each wave; stop its ticker
		// goroutine and clear the key so waves stay independent.
		if c, ok := fx.orch.typing.Load(run.ID); ok {
			c.(context.CancelFunc)()
			fx.orch.typing.Delete(run.ID)
		}
	}
}
