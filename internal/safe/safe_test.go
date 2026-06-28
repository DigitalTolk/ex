package safe

import (
	"sync"
	"testing"
)

func TestGo_RunsFunction(t *testing.T) {
	var wg sync.WaitGroup
	wg.Add(1)
	ran := false
	Go(func() {
		defer wg.Done()
		ran = true
	})
	wg.Wait()
	if !ran {
		t.Fatal("Go did not run the function")
	}
}

func TestGo_RecoversPanic(t *testing.T) {
	// A panicking goroutine must not crash the process — Go recovers it. We
	// can't assert "didn't crash" directly, but if the recover were missing
	// the test binary itself would abort. Sync on a second goroutine to prove
	// the runtime stayed alive afterwards.
	var wg sync.WaitGroup
	wg.Add(1)
	Go(func() {
		defer wg.Done()
		panic("boom")
	})
	wg.Wait()

	wg.Add(1)
	alive := false
	Go(func() {
		defer wg.Done()
		alive = true
	})
	wg.Wait()
	if !alive {
		t.Fatal("runtime did not survive a panicking goroutine")
	}
}

func TestRecover_NoPanicIsNoop(t *testing.T) {
	// Calling Recover outside a panic is a harmless no-op.
	func() {
		defer Recover()
	}()
}
