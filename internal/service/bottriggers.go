package service

import (
	"context"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/safe"
)

// Trigger-word index for external bots (Mattermost's outgoing-webhook trigger
// model, RFC §2).
//
// The dispatcher consults this on the SYNCHRONOUS message-send path, where a
// DynamoDB read per message would be unacceptable. So the index is an immutable
// snapshot swapped atomically: readers do one map lookup and never block, and
// writers rebuild the whole map. Freshness comes from two directions —
// RefreshTriggers() is called after every admin write that could change a
// trigger, and StartTriggerRefresh() re-reads periodically so a change made by
// another instance converges without cross-instance invalidation.
//
// Consequence to know: a trigger change made on instance A is visible on
// instance B within triggerRefreshInterval, not instantly. That is acceptable
// because triggers are configuration, not authorization — a stale trigger
// dispatches to a bot that still exists, and a *removed* bot's dispatch fails
// closed at WebhookBot() lookup, which is not cached.

// triggerRefreshInterval bounds cross-instance staleness of the trigger index.
// A var, not a const, so tests can shorten it and exercise the ticker without
// sleeping for a minute.
var triggerRefreshInterval = 60 * time.Second

// triggerSnapshot is one immutable version of the index.
type triggerSnapshot struct {
	// byWord maps a lowercased trigger word to the bot that registered it.
	byWord map[string]triggerEntry
	// hasContains is true when any entry uses BotTriggerWhenContains, letting the
	// dispatcher skip its multi-word scan entirely in the common case.
	hasContains bool
}

type triggerEntry struct {
	botUserID string
	when      model.BotTriggerWhen
}

// TriggerBot implements BotTriggerIndex.
func (s *BotService) TriggerBot(word string) (string, model.BotTriggerWhen, bool) {
	snap := s.triggers.Load()
	if snap == nil {
		return "", 0, false
	}
	e, ok := snap.byWord[word]
	if !ok {
		return "", 0, false
	}
	return e.botUserID, e.when, true
}

// HasContainsTriggers implements BotTriggerIndex.
func (s *BotService) HasContainsTriggers() bool {
	snap := s.triggers.Load()
	return snap != nil && snap.hasContains
}

// RefreshTriggers rebuilds the trigger index from the bot directory. Called after
// any admin write that can change triggers, and periodically by
// StartTriggerRefresh. Errors are returned but are safe to ignore at call sites
// that are already reporting a successful write — the periodic refresh retries.
func (s *BotService) RefreshTriggers(ctx context.Context) error {
	bots, err := s.bots.ListBots(ctx)
	if err != nil {
		return err
	}
	snap := &triggerSnapshot{byWord: make(map[string]triggerEntry)}
	for _, b := range bots {
		// A trigger without a callback URL has nothing to dispatch to. Skipping
		// those here means a bot that loses its webhook also loses its triggers,
		// with no separate cleanup.
		if b == nil || strings.TrimSpace(b.CallbackURL) == "" {
			continue
		}
		for _, w := range b.TriggerWords {
			word := normalizeTriggerWord(w)
			if word == "" {
				continue
			}
			// First registration of a word wins. Two bots claiming the same trigger
			// is a misconfiguration; resolving it by directory order is at least
			// deterministic, and the collision is logged so an admin can see it.
			if existing, clash := snap.byWord[word]; clash {
				if existing.botUserID != b.UserID {
					slog.Warn("bot triggers: word claimed by more than one bot",
						"word", word, "kept", existing.botUserID, "ignored", b.UserID)
				}
				continue
			}
			snap.byWord[word] = triggerEntry{botUserID: b.UserID, when: b.TriggerWhen}
			if b.TriggerWhen == model.BotTriggerWhenContains {
				snap.hasContains = true
			}
		}
	}
	s.triggers.Store(snap)
	return nil
}

// StartTriggerRefresh keeps the index converging on a ticker until ctx is done.
// Called once at wiring time; safe to omit in tests (the index then only reflects
// explicit RefreshTriggers calls).
func (s *BotService) StartTriggerRefresh(ctx context.Context) {
	if err := s.RefreshTriggers(ctx); err != nil {
		slog.Warn("bot triggers: initial load failed", "error", err)
	}
	// Read the interval on the caller's goroutine, not inside the spawned one, so
	// the value is captured at a well-defined point.
	interval := triggerRefreshInterval
	safe.Go(func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := s.RefreshTriggers(ctx); err != nil {
					slog.Warn("bot triggers: refresh failed", "error", err)
				}
			}
		}
	})
}

// refreshTriggersAsync rebuilds the index off the request path. Used by admin
// writes: the write's own response must not wait on (or fail because of) a
// directory re-read, since the periodic refresh is the backstop.
func (s *BotService) refreshTriggersAsync(ctx context.Context) {
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		if err := s.RefreshTriggers(bg); err != nil {
			slog.Warn("bot triggers: refresh after write failed", "error", err)
		}
	})
}

// maxTriggerWords caps how many triggers one bot may register, so a single
// misconfigured bot can't bloat the snapshot every instance holds in memory.
const maxTriggerWords = 32

// maxTriggerWordLen caps one trigger's length. A trigger is matched against
// whitespace-separated words, so a very long one could never fire anyway.
const maxTriggerWordLen = 64

// normalizeTriggerWord lowercases and trims a trigger to the form the dispatcher
// looks up (see matchTriggerWord). Returns "" for anything unusable: empty,
// over-long, or containing whitespace — a word with a space in it can never match
// a whitespace-split token, so accepting it would silently never fire.
func normalizeTriggerWord(raw string) string {
	w := strings.ToLower(strings.TrimSpace(raw))
	if w == "" || len(w) > maxTriggerWordLen || strings.ContainsAny(w, " \t\n\r") {
		return ""
	}
	return strings.Trim(w, botTriggerTrimCutset)
}

// normalizeTriggerWords cleans and dedupes an admin-supplied trigger list,
// rejecting the whole list if any entry is unusable — a silently-dropped trigger
// would look configured in the UI but never fire.
func normalizeTriggerWords(raw []string) ([]string, error) {
	if len(raw) > maxTriggerWords {
		return nil, ErrTooManyTriggerWords
	}
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		w := normalizeTriggerWord(r)
		if w == "" {
			return nil, ErrInvalidTriggerWord
		}
		if seen[w] {
			continue
		}
		seen[w] = true
		out = append(out, w)
	}
	return out, nil
}

// triggerIndexPtr is the atomically-swapped snapshot holder. Declared as a type
// alias here (rather than inline in BotService) purely for readability.
type triggerIndexPtr = atomic.Pointer[triggerSnapshot]
