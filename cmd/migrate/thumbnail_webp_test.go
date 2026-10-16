package main

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func thumbnailAttachments() []*model.Attachment {
	return []*model.Attachment{
		{ID: "a1", ThumbnailS3Key: "t1", SquareThumbnailS3Key: "s1"},
		{ID: "pdf"},
		{ID: "a2", ThumbnailS3Key: "t2", SquareThumbnailS3Key: "s2"},
	}
}

func applyRun(workers int) thumbnailRun {
	return thumbnailRun{mode: "apply", verbose: true, workers: workers, progressEvery: time.Hour}
}

type reencodeSpy struct {
	mu      sync.Mutex
	keys    []string
	dryRuns []bool
	fail    string
	lossy   string
	// wait, when set, runs inside each call before it answers.
	wait func()
}

func (s *reencodeSpy) reencode(_ context.Context, key string, dryRun bool) (bool, error) {
	s.mu.Lock()
	s.keys = append(s.keys, key)
	s.dryRuns = append(s.dryRuns, dryRun)
	s.mu.Unlock()
	if s.wait != nil {
		s.wait()
	}
	if key == s.fail {
		return false, errors.New("boom")
	}
	return key != s.lossy, nil
}

func (s *reencodeSpy) sortedKeys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Sorted(slices.Values(s.keys))
}

func TestThumbnailWebP_ReencodesBothThumbnailsOfEveryAttachment(t *testing.T) {
	spy := &reencodeSpy{lossy: "s2"}
	if code := thumbnailWebP(context.Background(), thumbnailAttachments(), spy.reencode, applyRun(4)); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if want := []string{"s1", "s2", "t1", "t2"}; !slices.Equal(spy.sortedKeys(), want) {
		t.Fatalf("keys = %v, want %v", spy.sortedKeys(), want)
	}
	if slices.Contains(spy.dryRuns, true) {
		t.Fatal("an apply run asked for a dry run")
	}
}

func TestThumbnailWebP_DryRunIsPassedThrough(t *testing.T) {
	spy := &reencodeSpy{}
	thumbnailWebP(context.Background(), thumbnailAttachments(), spy.reencode, thumbnailRun{dryRun: true, mode: "dry-run", workers: 4, progressEvery: time.Hour})
	if slices.Contains(spy.dryRuns, false) {
		t.Fatal("a dry run asked for a write")
	}
}

func TestThumbnailWebP_AFailedThumbnailFailsTheRunButNotTheWalk(t *testing.T) {
	spy := &reencodeSpy{fail: "t1"}
	if code := thumbnailWebP(context.Background(), thumbnailAttachments(), spy.reencode, applyRun(4)); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if len(spy.sortedKeys()) != 4 {
		t.Fatalf("keys = %v, want all four", spy.sortedKeys())
	}
}

// Each thumbnail is a round trip to S3; one at a time, a run over thousands
// took most of an hour from a laptop.
func TestThumbnailWebP_WorksOnThumbnailsInParallelUpToTheLimit(t *testing.T) {
	var mu sync.Mutex
	inFlight, most := 0, 0
	together := make(chan struct{})
	var once sync.Once
	spy := &reencodeSpy{wait: func() {
		mu.Lock()
		inFlight++
		most = max(most, inFlight)
		if inFlight == 2 {
			once.Do(func() { close(together) })
		}
		mu.Unlock()
		// Hold each call until two are running at once: one at a time,
		// that never happens and the run would stall here.
		select {
		case <-together:
		case <-time.After(5 * time.Second):
		}
		mu.Lock()
		inFlight--
		mu.Unlock()
	}}
	thumbnailWebP(context.Background(), thumbnailAttachments(), spy.reencode, applyRun(2))
	select {
	case <-together:
	default:
		t.Fatal("no two thumbnails were worked on at once")
	}
	if most > 2 {
		t.Fatalf("%d thumbnails at once, want at most 2", most)
	}
}

// progressSeen is a slog handler that closes seen at the first progress line
// reporting want done.
type progressSeen struct {
	slog.Handler
	want string
	once sync.Once
	seen chan struct{}
}

func (h *progressSeen) Handle(_ context.Context, r slog.Record) error {
	if r.Message != "thumbnail-webp progress" {
		return nil
	}
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == "done" && a.Value.String() == h.want {
			h.once.Do(func() { close(h.seen) })
		}
		return true
	})
	return nil
}

func (h *progressSeen) Enabled(context.Context, slog.Level) bool { return true }

func TestThumbnailWebP_SaysHowFarItHasGotWhileItRuns(t *testing.T) {
	h := &progressSeen{Handler: slog.Default().Handler(), want: "3/4", seen: make(chan struct{})}
	prev := slog.Default()
	slog.SetDefault(slog.New(h))
	t.Cleanup(func() { slog.SetDefault(prev) })

	// The last thumbnail is held until progress reports the other three
	// done, so that line has to come while the run is still going.
	spy := &reencodeSpy{}
	spy.wait = func() {
		spy.mu.Lock()
		last := len(spy.keys) == 4
		spy.mu.Unlock()
		if last {
			select {
			case <-h.seen:
			case <-time.After(5 * time.Second):
			}
		}
	}
	thumbnailWebP(context.Background(), thumbnailAttachments(), spy.reencode,
		thumbnailRun{mode: "apply", workers: 1, progressEvery: time.Millisecond})

	select {
	case <-h.seen:
	default:
		t.Fatal("no progress line reported 3 of 4 done while the last one ran")
	}
}

func TestProgress_Attrs(t *testing.T) {
	p := newProgress("x", 200)
	p.done.Store(50)
	p.changed.Store(40)
	p.failed.Store(2)
	got := p.attrs(10 * time.Second)
	want := []any{"done", "50/200", "percent", int64(25), "changed", int64(40), "errors", int64(2), "eta", "30s"}
	if !slices.Equal(got, want) {
		t.Fatalf("attrs = %v, want %v", got, want)
	}

	// Nothing done yet: no estimate. Nothing to do: 0%, not a division by zero.
	if got := newProgress("x", 0).attrs(time.Second); len(got) != 8 || got[3] != int64(0) {
		t.Fatalf("attrs = %v", got)
	}
}
