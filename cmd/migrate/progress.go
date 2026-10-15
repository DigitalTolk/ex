package main

import (
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"
)

// progressEvery is how often a long backfill says how far it has got.
const progressEvery = 5 * time.Second

// progress counts a backfill's items as they finish and, while it runs, logs
// how far it has got, so a run that takes minutes is not silent until its
// summary.
type progress struct {
	name                  string
	total                 int64
	start                 time.Time
	done, changed, failed atomic.Int64
}

func newProgress(name string, total int) *progress {
	return &progress{name: name, total: int64(total), start: time.Now()}
}

// report logs a progress line every interval until the returned stop is
// called.
func (p *progress) report(every time.Duration) (stop func()) {
	ticker := time.NewTicker(every)
	quit := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for {
			select {
			case <-ticker.C:
				p.log()
			case <-quit:
				return
			}
		}
	}()
	return func() {
		ticker.Stop()
		close(quit)
		<-finished
	}
}

func (p *progress) log() {
	slog.Info(p.name+" progress", p.attrs(time.Since(p.start))...)
}

// attrs describes the run after elapsed: items done of the total, how many
// changed and failed, and, once anything is done, when the rest should be.
func (p *progress) attrs(elapsed time.Duration) []any {
	done := p.done.Load()
	attrs := []any{
		"done", fmt.Sprintf("%d/%d", done, p.total),
		"percent", done * 100 / max(p.total, 1),
		"changed", p.changed.Load(),
		"errors", p.failed.Load(),
	}
	if done > 0 {
		left := time.Duration(int64(elapsed) / done * (p.total - done))
		attrs = append(attrs, "eta", left.Round(time.Second).String())
	}
	return attrs
}
