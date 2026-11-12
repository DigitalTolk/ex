//go:build integration

package cache

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestResponseURL_UsesAreSpentAtomically(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()
	rec := model.ResponseURLRecord{WebhookID: "wh", ParentID: "ch", ParentType: "channel", MessageID: "m1", UserID: "u1"}
	if err := c.MintResponseURL(ctx, "hash-1", rec, 5, time.Minute); err != nil {
		t.Fatalf("mint: %v", err)
	}
	// Eight requests race for five uses: exactly five get one.
	var wg sync.WaitGroup
	var mu sync.Mutex
	granted := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, left, err := c.UseResponseURL(ctx, "hash-1")
			if err != nil || got == nil {
				t.Errorf("use: %v %v", got, err)
				return
			}
			if left >= 0 {
				if *got != rec {
					t.Errorf("record = %+v", *got)
				}
				mu.Lock()
				granted++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if granted != 5 {
		t.Fatalf("granted %d uses, want 5", granted)
	}
	if got, _, err := c.UseResponseURL(ctx, "unknown"); err != nil || got != nil {
		t.Fatalf("unknown url: %v %v", got, err)
	}
}

func TestResponseURL_ExpiresAndCorruptRecords(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()
	if err := c.MintResponseURL(ctx, "hash-exp", model.ResponseURLRecord{MessageID: "m"}, 5, 50*time.Millisecond); err != nil {
		t.Fatalf("mint: %v", err)
	}
	time.Sleep(120 * time.Millisecond)
	if got, _, err := c.UseResponseURL(ctx, "hash-exp"); err != nil || got != nil {
		t.Fatalf("expired url: %v %v", got, err)
	}
	c.client.HSet(ctx, responseURLKeyPrefix+"hash-bad", "rec", "{not json", "uses", 3)
	if _, _, err := c.UseResponseURL(ctx, "hash-bad"); err == nil {
		t.Fatal("a corrupt record must be an error")
	}
}

func TestInteractionHistory_NewestFirstAndCapped(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()
	for i := 0; i < interactionHistoryLen+5; i++ {
		if err := c.RecordInteraction(ctx, "wh-hist", model.InteractionEntry{Kind: model.InteractionClick, ActionID: strconv.Itoa(i), Result: model.InteractionOK}); err != nil {
			t.Fatalf("record: %v", err)
		}
	}
	c.client.RPush(ctx, interactionsKeyPrefix+"wh-hist", "{bad")
	got, err := c.ListInteractions(ctx, "wh-hist")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != interactionHistoryLen || got[0].ActionID != strconv.Itoa(interactionHistoryLen+4) {
		t.Fatalf("history: %d entries, newest %q", len(got), got[0].ActionID)
	}
	if ttl := c.client.TTL(ctx, interactionsKeyPrefix+"wh-hist").Val(); ttl <= 0 || ttl > interactionHistoryTTL {
		t.Fatalf("history ttl = %v", ttl)
	}
}

func TestAppFailures_PauseAtTheThresholdAndResetOnSuccess(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()
	for i := 1; i < 3; i++ {
		if paused, err := c.NoteAppFailure(ctx, "wh-f", 3, time.Minute); err != nil || paused != 0 {
			t.Fatalf("failure %d: paused %v err %v", i, paused, err)
		}
	}
	if left, _ := c.AppPausedFor(ctx, "wh-f"); left != 0 {
		t.Fatalf("paused before the threshold: %v", left)
	}
	if paused, err := c.NoteAppFailure(ctx, "wh-f", 3, time.Minute); err != nil || paused != time.Minute {
		t.Fatalf("third failure: %v %v", paused, err)
	}
	if left, err := c.AppPausedFor(ctx, "wh-f"); err != nil || left <= 0 || left > time.Minute {
		t.Fatalf("paused for %v (%v)", left, err)
	}
	if err := c.NoteAppSuccess(ctx, "wh-f"); err != nil {
		t.Fatalf("success: %v", err)
	}
	if paused, _ := c.NoteAppFailure(ctx, "wh-f", 3, time.Minute); paused != 0 {
		t.Fatal("a success must end the streak")
	}
}

func TestInteractions_RedisDown(t *testing.T) {
	c := newDeadCache(t)
	ctx := context.Background()
	if err := c.MintResponseURL(ctx, "h", model.ResponseURLRecord{}, 5, time.Minute); err == nil {
		t.Error("mint")
	}
	if _, _, err := c.UseResponseURL(ctx, "h"); err == nil {
		t.Error("use")
	}
	if err := c.RecordInteraction(ctx, "wh", model.InteractionEntry{}); err == nil {
		t.Error("record")
	}
	if _, err := c.ListInteractions(ctx, "wh"); err == nil {
		t.Error("list")
	}
	if _, err := c.NoteAppFailure(ctx, "wh", 1, time.Minute); err == nil {
		t.Error("failure")
	}
	if err := c.NoteAppSuccess(ctx, "wh"); err == nil {
		t.Error("success")
	}
	if _, err := c.AppPausedFor(ctx, "wh"); err == nil {
		t.Error("paused")
	}
}

// Pausing can fail after the streak was counted: that failure is reported.
func TestAppFailures_PauseWriteFails(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()
	c.client.AddHook(cmdFailHook{fail: map[string]bool{"set": true}})
	if _, err := c.NoteAppFailure(ctx, "wh-pf", 1, time.Minute); err == nil {
		t.Fatal("want the pause write's error")
	}
}
