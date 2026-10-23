package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/cenkalti/backoff/v5"
)

// SentDraftClearer removes a composer scope's draft once its content has been
// sent — DraftService.DeleteForScope. The clear presents no generation:
// sending is the authoritative user event for the scope (see the gen-token
// CAS in DraftService), so it always wins.
type SentDraftClearer interface {
	DeleteForScope(ctx context.Context, userID, parentID, parentType, parentMessageID string) error
}

// draftScope names one composer: a user's channel or conversation composer,
// or their thread composer when parentMessageID is set.
type draftScope struct {
	userID, parentID, parentType, parentMessageID string
}

// The clear's retry schedule. "Sent ⇒ draft cleared" is an invariant, not a
// nicety: a draft that survives its send resurrects in every composer that
// scope opens next. Package vars so tests can compress the schedule; a clear
// snapshots them when it starts.
var (
	// clearSentDraftMaxTries bounds the attempts: the first plus two retries.
	clearSentDraftMaxTries uint = 3
	// clearSentDraftTimeout bounds the whole clear, retries included: the AWS
	// SDK has no default per-call timeout, so a hung draft store must not pin
	// the worker indefinitely.
	clearSentDraftTimeout = 30 * time.Second
	// newClearSentDraftBackOff paces the retries: about 1s, then about 5s.
	newClearSentDraftBackOff = func() backoff.BackOff {
		b := backoff.NewExponentialBackOff()
		b.InitialInterval = time.Second
		b.Multiplier = 5
		b.MaxInterval = 5 * time.Second
		return b
	}
)

// clearSentDraft removes the scope's draft after a successful send, OFF the
// request path: like a send's notify/index side effects it runs detached, so
// the response doesn't wait on the draft store + pub/sub, and it survives the
// request's cancellation. Every composer send path (MessageService.Send, a
// scheduled message's Schedule, a slash command's Run) clears through here, so
// they all keep the same retry semantics. Exhausting them is logged at ERROR —
// the invariant was broken, not merely a hiccup.
func clearSentDraft(ctx context.Context, clearer SentDraftClearer, scope draftScope) {
	if clearer == nil {
		return
	}
	bg := context.WithoutCancel(ctx)
	safe.Go(func() {
		if err := clearSentDraftNow(bg, clearer, scope); err != nil {
			slog.Error("clear sent draft failed: the draft outlives its send",
				"userID", scope.userID, "parentID", scope.parentID, "parentType", scope.parentType,
				"parentMessageID", scope.parentMessageID, "error", err)
		}
	})
}

// clearSentDraftNow is the clear itself: retried on the schedule above within
// clearSentDraftTimeout, returning the last failure when it gives up.
func clearSentDraftNow(ctx context.Context, clearer SentDraftClearer, scope draftScope) error {
	ctx, cancel := context.WithTimeout(ctx, clearSentDraftTimeout)
	defer cancel()
	var lastErr error
	_, err := backoff.Retry(ctx, func() (struct{}, error) {
		lastErr = clearer.DeleteForScope(ctx, scope.userID, scope.parentID, scope.parentType, scope.parentMessageID)
		return struct{}{}, lastErr
	},
		backoff.WithBackOff(newClearSentDraftBackOff()),
		backoff.WithMaxTries(clearSentDraftMaxTries),
		backoff.WithMaxElapsedTime(0), // the context deadline bounds the clear
		backoff.WithNotify(func(err error, next time.Duration) {
			slog.Warn("clear sent draft failed, retrying",
				"userID", scope.userID, "parentID", scope.parentID, "parentType", scope.parentType,
				"retryIn", next, "error", err)
		}))
	if err != nil && ctx.Err() != nil {
		// Retry reports the deadline, not why the attempts failed.
		return fmt.Errorf("abandoned at the deadline (%w): %w", err, lastErr)
	}
	return err
}
