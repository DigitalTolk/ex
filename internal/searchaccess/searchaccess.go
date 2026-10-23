// Package searchaccess resolves which parents (channels + conversations) a
// user may see search results from. Membership lives in DynamoDB, not in
// OpenSearch, so every search first fetches the caller's memberships and
// hands them to the RBAC filter.
package searchaccess

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/hashicorp/golang-lru/v2/expirable"
	"golang.org/x/sync/singleflight"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/safe"
)

const (
	// cacheTTL bounds how stale a user's allowed set can be. The short TTL
	// smooths search-as-you-type bursts without a DynamoDB round-trip pair per
	// keystroke.
	cacheTTL = 30 * time.Second
	// cacheSize bounds the cache: one entry per recently-searching user.
	cacheSize = 10_000
	// lookupTimeout bounds a shared lookup. It runs detached from any single
	// caller (see AllowedParentIDs), so it needs its own deadline — otherwise
	// a hung query would wedge every later caller for that user.
	lookupTimeout = 10 * time.Second
)

// ChannelLister lists a user's channel memberships.
type ChannelLister interface {
	ListUserChannels(ctx context.Context, userID string) ([]*model.UserChannel, error)
}

// ConversationLister lists a user's conversation memberships.
type ConversationLister interface {
	ListUserConversations(ctx context.Context, userID string) ([]*model.UserConversation, error)
}

// Access implements handler.SearchAccess.
type Access struct {
	memberships   ChannelLister
	conversations ConversationLister
	cache         *expirable.LRU[string, []string]
	lookups       singleflight.Group
}

// New returns an Access backed by the given membership stores. Either may be
// nil, in which case that half contributes nothing.
func New(memberships ChannelLister, conversations ConversationLister) *Access {
	return newAccess(memberships, conversations, cacheSize, cacheTTL)
}

func newAccess(memberships ChannelLister, conversations ConversationLister, size int, ttl time.Duration) *Access {
	return &Access{
		memberships:   memberships,
		conversations: conversations,
		cache:         expirable.NewLRU[string, []string](size, nil, ttl),
	}
}

// AllowedParentIDs returns the user's channel + conversation IDs. The result
// is always non-nil for a signed-in user — an empty set means "no
// memberships", and channel search must never read it as "unscoped".
//
// Results are cached per user for cacheTTL, and concurrent misses for one user
// share a single lookup. That shared lookup runs detached from any single
// caller, so one caller giving up neither fails the others nor wedges the
// lookup; each caller still returns as soon as its own context ends. A failed
// lookup is an error and is never cached: a partial or empty set would hide
// results for the whole TTL.
func (a *Access) AllowedParentIDs(ctx context.Context, userID string) ([]string, error) {
	if userID == "" {
		return nil, nil
	}
	if ids, ok := a.cache.Get(userID); ok {
		return slices.Clone(ids), nil
	}
	shared := a.lookups.DoChan(userID, func() (any, error) {
		lookupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), lookupTimeout)
		defer cancel()
		ids, err := a.lookup(lookupCtx, userID)
		if err != nil {
			return nil, err
		}
		a.cache.Add(userID, ids)
		return ids, nil
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case res := <-shared:
		if res.Err != nil {
			return nil, res.Err
		}
		return slices.Clone(res.Val.([]string)), nil
	}
}

// lookup runs the two membership queries concurrently. The result is
// non-nil even when the user has no memberships.
func (a *Access) lookup(ctx context.Context, userID string) ([]string, error) {
	var (
		wg         sync.WaitGroup
		channelIDs []string
		convIDs    []string
		channelErr error
		convErr    error
	)
	if a.memberships != nil {
		wg.Add(1)
		safe.Go(func() {
			defer wg.Done()
			chans, err := a.memberships.ListUserChannels(ctx, userID)
			if err != nil {
				channelErr = fmt.Errorf("search access: list channels: %w", err)
				return
			}
			for _, c := range chans {
				channelIDs = append(channelIDs, c.ChannelID)
			}
		})
	}
	if a.conversations != nil {
		wg.Add(1)
		safe.Go(func() {
			defer wg.Done()
			convs, err := a.conversations.ListUserConversations(ctx, userID)
			if err != nil {
				convErr = fmt.Errorf("search access: list conversations: %w", err)
				return
			}
			for _, c := range convs {
				convIDs = append(convIDs, c.ConversationID)
			}
		})
	}
	wg.Wait()
	if err := errors.Join(channelErr, convErr); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(channelIDs)+len(convIDs))
	return append(append(out, channelIDs...), convIDs...), nil
}
