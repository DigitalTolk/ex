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

func TestTrigger_SingleUse(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()
	rec := model.TriggerRecord{WebhookID: "wh", UserID: "u1", ClickID: "tab-1", IconEmoji: ":robot:"}
	if err := c.MintTrigger(ctx, "trig-1", rec, time.Minute); err != nil {
		t.Fatalf("mint: %v", err)
	}
	// Six apps race for one trigger: exactly one gets it.
	var wg sync.WaitGroup
	var mu sync.Mutex
	granted := 0
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := c.UseTrigger(ctx, "trig-1")
			if err != nil {
				t.Errorf("use: %v", err)
				return
			}
			if got != nil {
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
	if granted != 1 {
		t.Fatalf("trigger used %d times, want 1", granted)
	}
	if got, err := c.UseTrigger(ctx, "unknown"); err != nil || got != nil {
		t.Fatalf("unknown trigger: %v %v", got, err)
	}
}

func TestTrigger_ExpiresAndCorruptRecords(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()
	if err := c.MintTrigger(ctx, "trig-exp", model.TriggerRecord{WebhookID: "wh"}, time.Minute); err != nil {
		t.Fatalf("mint: %v", err)
	}
	if ttl := c.client.TTL(ctx, triggerKeyPrefix+"trig-exp").Val(); ttl <= 0 || ttl > time.Minute {
		t.Fatalf("trigger ttl = %v", ttl)
	}
	// Expiry is Redis's own; make it happen now rather than waiting for it.
	c.client.PExpire(ctx, triggerKeyPrefix+"trig-exp", time.Millisecond)
	waitGone(t, c, triggerKeyPrefix+"trig-exp")
	if got, err := c.UseTrigger(ctx, "trig-exp"); err != nil || got != nil {
		t.Fatalf("expired trigger: %v %v", got, err)
	}
	c.client.Set(ctx, triggerKeyPrefix+"trig-bad", "{not json", time.Minute)
	if _, err := c.UseTrigger(ctx, "trig-bad"); err == nil {
		t.Fatal("a corrupt trigger must be an error")
	}
}

// runScope makes scope this run's own: the container outlives a test, and
// -count reruns it against what the last run left.
func runScope(scope string) string {
	return scope + "-" + strconv.FormatInt(time.Now().UnixNano(), 36)
}

// waitGone waits until Redis has expired key.
func waitGone(t *testing.T, c *RedisCache, key string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for c.client.Exists(context.Background(), key).Val() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("%s never expired", key)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestViews_SaveGetFindDelete(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()
	opened := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	withExt := &model.StoredView{
		View:      model.View{ID: "V1", Type: model.ViewModal, Title: model.TextObject{Type: model.TextPlain, Text: "Review"}, ExternalID: "ext-1", Hash: "h1"},
		WebhookID: "wh-v", UserID: "u1", ClickID: "tab", OpenedAt: opened,
	}
	plain := &model.StoredView{View: model.View{ID: "V2", Type: model.ViewModal, Hash: "h2"}, WebhookID: "wh-v", UserID: "u2", OpenedAt: opened}
	for _, v := range []*model.StoredView{withExt, plain} {
		if err := c.SaveView(ctx, v, time.Minute); err != nil {
			t.Fatalf("save %s: %v", v.View.ID, err)
		}
	}
	got, err := c.GetView(ctx, "V1")
	if err != nil || got == nil || got.View.ID != "V1" || got.View.ExternalID != "ext-1" || got.UserID != "u1" || got.ClickID != "tab" || !got.OpenedAt.Equal(opened) {
		t.Fatalf("get V1: %+v %v", got, err)
	}
	if ttl := c.client.TTL(ctx, viewExternalKey("wh-v", "ext-1")).Val(); ttl <= 0 || ttl > time.Minute {
		t.Fatalf("external index ttl = %v", ttl)
	}
	if id, err := c.ViewIDByExternalID(ctx, "wh-v", "ext-1"); err != nil || id != "V1" {
		t.Fatalf("by external id: %q %v", id, err)
	}
	// External IDs are per app.
	if id, err := c.ViewIDByExternalID(ctx, "wh-other", "ext-1"); err != nil || id != "" {
		t.Fatalf("another app's external id: %q %v", id, err)
	}

	if err := c.DeleteView(ctx, withExt); err != nil {
		t.Fatalf("delete V1: %v", err)
	}
	if got, err := c.GetView(ctx, "V1"); err != nil || got != nil {
		t.Fatalf("deleted view: %+v %v", got, err)
	}
	if id, err := c.ViewIDByExternalID(ctx, "wh-v", "ext-1"); err != nil || id != "" {
		t.Fatalf("deleted view's external id: %q %v", id, err)
	}
	if err := c.DeleteView(ctx, plain); err != nil {
		t.Fatalf("delete V2: %v", err)
	}
	if got, _ := c.GetView(ctx, "V2"); got != nil {
		t.Fatalf("deleted V2: %+v", got)
	}

	c.client.Set(ctx, viewKeyPrefix+"V-bad", "{not json", time.Minute)
	if _, err := c.GetView(ctx, "V-bad"); err == nil {
		t.Fatal("a corrupt view must be an error")
	}
}

func TestIdempotencyKey_ClaimFinishRelease(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()
	open, update := runScope("wh:views.open"), runScope("wh:views.update")
	if prev, claimed, err := c.ClaimIdempotencyKey(ctx, open, "k1", time.Minute); err != nil || !claimed || prev != nil {
		t.Fatalf("first claim: %q %v %v", prev, claimed, err)
	}
	// While the first call runs, a retry gets an empty answer.
	if prev, claimed, err := c.ClaimIdempotencyKey(ctx, open, "k1", time.Minute); err != nil || claimed || len(prev) != 0 {
		t.Fatalf("claim in progress: %q %v %v", prev, claimed, err)
	}
	// The same key is a separate claim in another scope.
	if _, claimed, _ := c.ClaimIdempotencyKey(ctx, update, "k1", time.Minute); !claimed {
		t.Fatal("another method's key must be its own")
	}
	if err := c.FinishIdempotencyKey(ctx, open, "k1", []byte(`{"ok":true}`), time.Minute); err != nil {
		t.Fatalf("finish: %v", err)
	}
	if prev, claimed, err := c.ClaimIdempotencyKey(ctx, open, "k1", time.Minute); err != nil || claimed || string(prev) != `{"ok":true}` {
		t.Fatalf("retry after finish: %q %v %v", prev, claimed, err)
	}
	// A nil answer releases the claim: the call failed, a retry runs it again.
	if err := c.FinishIdempotencyKey(ctx, update, "k1", nil, time.Minute); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, claimed, err := c.ClaimIdempotencyKey(ctx, update, "k1", time.Minute); err != nil || !claimed {
		t.Fatalf("claim after release: %v %v", claimed, err)
	}
}

// A held key whose answer can't be read is an error, not a fresh claim.
func TestIdempotencyKey_ReadFails(t *testing.T) {
	seed := realRedisClient(t)
	ctx := context.Background()
	scope := runScope("wh:m")
	seed.Set(ctx, idempotencyKeyPrefix+scope+":held", "", time.Minute)
	c := cacheFailingOn(t, "get")
	if _, _, err := c.ClaimIdempotencyKey(ctx, scope, "held", time.Minute); err == nil {
		t.Fatal("want the read's error")
	}
}

func TestViews_AnExternalIDThatMovedOnSurvivesTheOldForm(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	wh, ext := "wh-move-"+suffix, "ext-move"
	old := &model.StoredView{View: model.View{ID: "Vold-" + suffix, ExternalID: ext}, WebhookID: wh}
	newer := &model.StoredView{View: model.View{ID: "Vnew-" + suffix, ExternalID: ext}, WebhookID: wh}
	for _, v := range []*model.StoredView{old, newer} {
		if err := c.SaveView(ctx, v, time.Minute); err != nil {
			t.Fatalf("save: %v", err)
		}
	}
	// The external_id now names the newer form: closing the old one, or
	// dropping the old one's claim, leaves it alone.
	if err := c.DeleteView(ctx, old); err != nil {
		t.Fatalf("delete old: %v", err)
	}
	if err := c.DropViewExternalID(ctx, wh, ext, old.View.ID); err != nil {
		t.Fatalf("drop old claim: %v", err)
	}
	if id, err := c.ViewIDByExternalID(ctx, wh, ext); err != nil || id != newer.View.ID {
		t.Fatalf("external id after the old form closed: %q %v", id, err)
	}
	// Its own form's drop does remove it; no external_id is a no-op.
	if err := c.DropViewExternalID(ctx, wh, ext, newer.View.ID); err != nil {
		t.Fatalf("drop: %v", err)
	}
	if id, _ := c.ViewIDByExternalID(ctx, wh, ext); id != "" {
		t.Fatalf("dropped external id still names %q", id)
	}
	if err := c.DropViewExternalID(ctx, wh, "", newer.View.ID); err != nil {
		t.Fatalf("no external id: %v", err)
	}
}

func TestViews_DeleteFailsWhenTheExternalIDCantBeDropped(t *testing.T) {
	c := cacheFailingOn(t, "evalsha", "eval")
	v := &model.StoredView{View: model.View{ID: "Vdrop", ExternalID: "e"}, WebhookID: "wh"}
	if err := c.DeleteView(context.Background(), v); err == nil {
		t.Fatal("a failed drop of the external id must surface")
	}
}

func TestViews_RedisDown(t *testing.T) {
	c := cacheFailingOn(t)
	ctx := context.Background()
	v := &model.StoredView{View: model.View{ID: "V", ExternalID: "e"}, WebhookID: "wh"}
	if err := c.MintTrigger(ctx, "h", model.TriggerRecord{}, time.Minute); err == nil {
		t.Error("mint trigger")
	}
	if _, err := c.UseTrigger(ctx, "h"); err == nil {
		t.Error("use trigger")
	}
	if err := c.SaveView(ctx, v, time.Minute); err == nil {
		t.Error("save view")
	}
	if _, err := c.GetView(ctx, "V"); err == nil {
		t.Error("get view")
	}
	if _, err := c.ViewIDByExternalID(ctx, "wh", "e"); err == nil {
		t.Error("view by external id")
	}
	if err := c.DeleteView(ctx, v); err == nil {
		t.Error("delete view")
	}
	if _, _, err := c.ClaimIdempotencyKey(ctx, "s", "k", time.Minute); err == nil {
		t.Error("claim")
	}
	if err := c.FinishIdempotencyKey(ctx, "s", "k", []byte("x"), time.Minute); err == nil {
		t.Error("finish")
	}
	if err := c.FinishIdempotencyKey(ctx, "s", "k", nil, time.Minute); err == nil {
		t.Error("release")
	}
}
