package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

func TestNormalizeTriggerWord(t *testing.T) {
	ok := map[string]string{
		"deploy":   "deploy",
		"  Deploy": "deploy",
		"deploy:":  "deploy",  // surrounding punctuation is stripped, as at match time
		"/deploy":  "/deploy", // a leading slash can legitimately be part of a trigger
	}
	for in, want := range ok {
		if got := normalizeTriggerWord(in); got != want {
			t.Errorf("normalizeTriggerWord(%q) = %q, want %q", in, got, want)
		}
	}
	// A word containing whitespace could never match a whitespace-split token, so
	// accepting it would look configured and never fire.
	for _, in := range []string{"", "   ", "two words", "tab\there", strings.Repeat("x", maxTriggerWordLen+1)} {
		if got := normalizeTriggerWord(in); got != "" {
			t.Errorf("normalizeTriggerWord(%q) = %q, want rejection", in, got)
		}
	}
}

func TestNormalizeTriggerWords(t *testing.T) {
	got, err := normalizeTriggerWords([]string{"Deploy", "status", "deploy"})
	if err != nil {
		t.Fatalf("normalizeTriggerWords: %v", err)
	}
	if len(got) != 2 || got[0] != "deploy" || got[1] != "status" {
		t.Errorf("got %+v, want deduped and lowercased", got)
	}

	// One unusable entry rejects the whole list rather than silently dropping it.
	if _, err := normalizeTriggerWords([]string{"deploy", "two words"}); !errors.Is(err, ErrInvalidTriggerWord) {
		t.Errorf("err = %v, want ErrInvalidTriggerWord", err)
	}

	many := make([]string, maxTriggerWords+1)
	for i := range many {
		many[i] = "w" + string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	if _, err := normalizeTriggerWords(many); !errors.Is(err, ErrTooManyTriggerWords) {
		t.Errorf("err = %v, want ErrTooManyTriggerWords", err)
	}
}

// fakeBotStore is a minimal store.BotStore over in-memory maps.
//
// Guarded by a mutex: refreshTriggersAsync and StartTriggerRefresh read the store
// from detached goroutines while a test is still writing to it, so an unguarded
// map here is a genuine race, not a test artifact.
type fakeBotStore struct {
	mu       sync.Mutex
	bots     map[string]*model.BotAccount
	order    []string
	tokens   map[string]*model.BotToken
	listErr  error
	users    map[string]*model.User
	updateAt int
}

// setListErr flips the injected list failure under the lock.
func (f *fakeBotStore) setListErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listErr = err
}

func newFakeBotStore() *fakeBotStore {
	return &fakeBotStore{
		bots:   map[string]*model.BotAccount{},
		tokens: map[string]*model.BotToken{},
		users:  map[string]*model.User{},
	}
}

func (f *fakeBotStore) CreateBot(_ context.Context, bot *model.BotAccount) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, dup := f.bots[bot.UserID]; dup {
		return store.ErrAlreadyExists
	}
	copied := *bot
	f.bots[bot.UserID] = &copied
	f.order = append(f.order, bot.UserID)
	return nil
}

func (f *fakeBotStore) UpdateBot(_ context.Context, bot *model.BotAccount) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updateAt++
	copied := *bot
	f.bots[bot.UserID] = &copied
	return nil
}

func (f *fakeBotStore) GetBot(_ context.Context, userID string) (*model.BotAccount, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	bot, ok := f.bots[userID]
	if !ok {
		return nil, store.ErrNotFound
	}
	copied := *bot
	return &copied, nil
}

func (f *fakeBotStore) ListBots(_ context.Context) ([]*model.BotAccount, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	// Directory order, so a trigger collision resolves deterministically.
	out := make([]*model.BotAccount, 0, len(f.order))
	for _, id := range f.order {
		if bot, ok := f.bots[id]; ok {
			copied := *bot
			out = append(out, &copied)
		}
	}
	return out, nil
}

func (f *fakeBotStore) RemoveBotFromDirectory(_ context.Context, userID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	kept := f.order[:0]
	for _, id := range f.order {
		if id != userID {
			kept = append(kept, id)
		}
	}
	f.order = kept
	return nil
}

func (f *fakeBotStore) CreateBotToken(_ context.Context, tok *model.BotToken) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	copied := *tok
	f.tokens[tok.TokenHash] = &copied
	return nil
}

func (f *fakeBotStore) GetBotTokenByHash(_ context.Context, hash string) (*model.BotToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	tok, ok := f.tokens[hash]
	if !ok {
		return nil, store.ErrNotFound
	}
	copied := *tok
	return &copied, nil
}

func (f *fakeBotStore) ListBotTokens(_ context.Context, botUserID string) ([]*model.BotToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []*model.BotToken{}
	for _, tok := range f.tokens {
		if tok.BotUserID == botUserID {
			copied := *tok
			out = append(out, &copied)
		}
	}
	return out, nil
}

func (f *fakeBotStore) RevokeBotToken(_ context.Context, hash string, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	tok, ok := f.tokens[hash]
	if !ok {
		return store.ErrNotFound
	}
	tok.RevokedAt = &at
	return nil
}

func (f *fakeBotStore) TouchBotTokenLastUsed(_ context.Context, hash string, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	tok, ok := f.tokens[hash]
	if !ok {
		return store.ErrNotFound
	}
	tok.LastUsedAt = &at
	return nil
}

func TestRefreshTriggers(t *testing.T) {
	ctx := context.Background()

	t.Run("indexes only bots with a callback URL", func(t *testing.T) {
		bots := newFakeBotStore()
		// A trigger with nothing to dispatch to is not indexed, so a bot that loses
		// its webhook also loses its triggers with no separate cleanup.
		_ = bots.CreateBot(ctx, &model.BotAccount{UserID: "bot_a", CallbackURL: "https://a.example/h", TriggerWords: []string{"deploy"}})
		_ = bots.CreateBot(ctx, &model.BotAccount{UserID: "bot_b", TriggerWords: []string{"status"}})
		svc := NewBotService(bots, nil)
		if err := svc.RefreshTriggers(ctx); err != nil {
			t.Fatalf("RefreshTriggers: %v", err)
		}
		if id, _, ok := svc.TriggerBot("deploy"); !ok || id != "bot_a" {
			t.Errorf("deploy → (%q, %v), want bot_a", id, ok)
		}
		if _, _, ok := svc.TriggerBot("status"); ok {
			t.Error("a callback-less bot's trigger must not be indexed")
		}
		if svc.HasContainsTriggers() {
			t.Error("HasContainsTriggers = true with only starts-with triggers")
		}
	})

	t.Run("reports whether any contains-mode trigger exists", func(t *testing.T) {
		bots := newFakeBotStore()
		_ = bots.CreateBot(ctx, &model.BotAccount{
			UserID: "bot_a", CallbackURL: "https://a.example/h",
			TriggerWords: []string{"deploy"}, TriggerWhen: model.BotTriggerWhenContains,
		})
		svc := NewBotService(bots, nil)
		if err := svc.RefreshTriggers(ctx); err != nil {
			t.Fatalf("RefreshTriggers: %v", err)
		}
		if !svc.HasContainsTriggers() {
			t.Error("HasContainsTriggers = false, want true")
		}
	})

	t.Run("first bot wins a contested trigger, deterministically", func(t *testing.T) {
		bots := newFakeBotStore()
		_ = bots.CreateBot(ctx, &model.BotAccount{UserID: "bot_first", CallbackURL: "https://a.example/h", TriggerWords: []string{"deploy"}})
		_ = bots.CreateBot(ctx, &model.BotAccount{UserID: "bot_second", CallbackURL: "https://b.example/h", TriggerWords: []string{"deploy"}})
		svc := NewBotService(bots, nil)
		if err := svc.RefreshTriggers(ctx); err != nil {
			t.Fatalf("RefreshTriggers: %v", err)
		}
		if id, _, _ := svc.TriggerBot("deploy"); id != "bot_first" {
			t.Errorf("deploy → %q, want the first registration to win", id)
		}
	})

	t.Run("skips unusable trigger words", func(t *testing.T) {
		bots := newFakeBotStore()
		_ = bots.CreateBot(ctx, &model.BotAccount{
			UserID: "bot_a", CallbackURL: "https://a.example/h",
			TriggerWords: []string{"", "two words", "ok"},
		})
		svc := NewBotService(bots, nil)
		if err := svc.RefreshTriggers(ctx); err != nil {
			t.Fatalf("RefreshTriggers: %v", err)
		}
		if _, _, ok := svc.TriggerBot("ok"); !ok {
			t.Error("the usable word should be indexed")
		}
		if _, _, ok := svc.TriggerBot("two words"); ok {
			t.Error("an unusable word must not be indexed")
		}
	})

	t.Run("a nil bot row is skipped", func(t *testing.T) {
		bots := newFakeBotStore()
		bots.order = append(bots.order, "ghost") // in the directory, no META row
		svc := NewBotService(bots, nil)
		if err := svc.RefreshTriggers(ctx); err != nil {
			t.Fatalf("RefreshTriggers: %v", err)
		}
	})

	t.Run("a list failure is reported", func(t *testing.T) {
		bots := newFakeBotStore()
		bots.setListErr(errors.New("boom"))
		svc := NewBotService(bots, nil)
		if err := svc.RefreshTriggers(ctx); err == nil {
			t.Fatal("want the list error reported so the caller can retry")
		}
	})
}

// Before any refresh the snapshot is nil; readers must treat that as "no
// triggers" rather than panicking on the send path.
func TestTriggerBot_BeforeFirstRefresh(t *testing.T) {
	svc := NewBotService(newFakeBotStore(), nil)
	if _, _, ok := svc.TriggerBot("deploy"); ok {
		t.Error("TriggerBot returned a match before any refresh")
	}
	if svc.HasContainsTriggers() {
		t.Error("HasContainsTriggers = true before any refresh")
	}
	if _, _, ok := svc.TriggerBot("nope"); ok {
		t.Error("unknown word matched")
	}
}

// StartTriggerRefresh loads once immediately and then keeps refreshing until the
// context is cancelled.
func TestStartTriggerRefresh(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	bots := newFakeBotStore()
	_ = bots.CreateBot(ctx, &model.BotAccount{UserID: "bot_a", CallbackURL: "https://a.example/h", TriggerWords: []string{"deploy"}})
	svc := NewBotService(bots, nil)

	svc.StartTriggerRefresh(ctx)
	if _, _, ok := svc.TriggerBot("deploy"); !ok {
		t.Error("StartTriggerRefresh must load the index synchronously before returning")
	}
	cancel()
}

// An initial-load failure is logged, not fatal: the ticker retries, and the
// dispatcher simply sees no triggers until it succeeds.
func TestStartTriggerRefresh_InitialLoadFailureIsNonFatal(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	bots := newFakeBotStore()
	bots.setListErr(errors.New("boom"))
	svc := NewBotService(bots, nil)
	svc.StartTriggerRefresh(ctx)
	if _, _, ok := svc.TriggerBot("deploy"); ok {
		t.Error("no triggers should be indexed after a failed load")
	}
}

// The ticker arm: a change made by another instance converges without any
// cross-instance invalidation, so the index must reload on its own.
func TestStartTriggerRefresh_TickerReloads(t *testing.T) {
	orig := triggerRefreshInterval
	triggerRefreshInterval = 10 * time.Millisecond
	t.Cleanup(func() { triggerRefreshInterval = orig })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	bots := newFakeBotStore()
	svc := NewBotService(bots, nil)
	svc.StartTriggerRefresh(ctx)

	// Registered AFTER the initial load — only the ticker can pick it up.
	if err := bots.CreateBot(ctx, &model.BotAccount{
		UserID: "bot_late", CallbackURL: "https://late.example/h", TriggerWords: []string{"late"},
	}); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	waitForTrigger(t, svc, "late")
}

// refreshTriggersAsync runs off the request path; the write has already
// succeeded, so the test waits for convergence rather than a return value.
func TestRefreshTriggersAsync(t *testing.T) {
	ctx := context.Background()
	bots := newFakeBotStore()
	svc := NewBotService(bots, nil)
	if err := bots.CreateBot(ctx, &model.BotAccount{
		UserID: "bot_a", CallbackURL: "https://a.example/h", TriggerWords: []string{"deploy"},
	}); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	svc.refreshTriggersAsync(ctx)
	waitForTrigger(t, svc, "deploy")
}

func waitForTrigger(t *testing.T, svc *BotService, word string) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if _, _, ok := svc.TriggerBot(word); ok {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("trigger %q never appeared in the index", word)
}

// signallingBotStore reports each ListBots call on a channel and can be switched
// to failing, so the refresh goroutines' error arms are observable rather than
// racing the end of the test.
type signallingBotStore struct {
	*fakeBotStore
	calls chan struct{}
}

func (s *signallingBotStore) ListBots(ctx context.Context) ([]*model.BotAccount, error) {
	select {
	case s.calls <- struct{}{}:
	default:
	}
	return s.fakeBotStore.ListBots(ctx)
}

func waitForListCall(t *testing.T, calls chan struct{}) {
	t.Helper()
	select {
	case <-calls:
	case <-time.After(3 * time.Second):
		t.Fatal("the refresh never ran")
	}
}

// A refresh failure on the ticker is logged, not fatal: the loop keeps going so a
// transient store outage self-heals on the next tick.
func TestStartTriggerRefresh_TickerFailureIsNonFatal(t *testing.T) {
	orig := triggerRefreshInterval
	triggerRefreshInterval = 10 * time.Millisecond
	t.Cleanup(func() { triggerRefreshInterval = orig })

	bots := &signallingBotStore{fakeBotStore: newFakeBotStore(), calls: make(chan struct{}, 8)}
	svc := NewBotService(bots, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	svc.StartTriggerRefresh(ctx)
	waitForListCall(t, bots.calls) // the synchronous initial load
	bots.setListErr(errors.New("store down"))
	waitForListCall(t, bots.calls) // a tick that now fails
	waitForListCall(t, bots.calls) // …and the loop survives to tick again
}

// The same for the post-write refresh: the write already succeeded, so a failed
// index rebuild must not surface anywhere.
func TestRefreshTriggersAsync_FailureIsNonFatal(t *testing.T) {
	bots := &signallingBotStore{fakeBotStore: newFakeBotStore(), calls: make(chan struct{}, 4)}
	bots.setListErr(errors.New("store down"))
	svc := NewBotService(bots, nil)

	svc.refreshTriggersAsync(context.Background())
	waitForListCall(t, bots.calls)
	if _, _, ok := svc.TriggerBot("anything"); ok {
		t.Error("a failed refresh must leave the index empty, not partially populated")
	}
}
