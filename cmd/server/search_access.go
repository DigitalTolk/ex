package main

import (
	"context"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/handler"
)

// allowedParentIDsTTL caches a single user's allowed-parent set
// in-process. Membership lives in DynamoDB (not in OpenSearch — we
// don't denormalize membership into every message doc), so the
// /search/messages RBAC filter has to fetch the user's channels and
// conversations. Search-as-you-type fires one such request per
// debounced keystroke; a 30s TTL turns a 20-keystroke burst into a
// single pair of point queries. Membership churn is rare on this
// scale, and a hit a user just lost access to gets re-validated when
// they click through to the parent.
const allowedParentIDsTTL = 30 * time.Second

type allowedEntry struct {
	ids       []string
	expiresAt time.Time
}

// searchAccess implements handler.SearchAccess.
type searchAccess struct {
	memberships   *handler.MembershipStoreAdapter
	conversations *handler.ConversationStoreAdapter
	now           func() time.Time

	mu    sync.Mutex
	cache map[string]allowedEntry
}

func newSearchAccess(memberships *handler.MembershipStoreAdapter, conversations *handler.ConversationStoreAdapter) *searchAccess {
	return &searchAccess{
		memberships:   memberships,
		conversations: conversations,
		now:           time.Now,
		cache:         make(map[string]allowedEntry),
	}
}

// AllowedParentIDs returns the user's channel + conversation IDs from
// DynamoDB. Two point queries run concurrently; results are cached
// per-user (see allowedParentIDsTTL) so a burst of search-as-you-type
// queries doesn't fan out into one DDB round-trip pair per keystroke.
func (a *searchAccess) AllowedParentIDs(ctx context.Context, userID string) ([]string, error) {
	if userID == "" {
		return nil, nil
	}
	if cached, ok := a.cachedFor(userID); ok {
		return cached, nil
	}
	var (
		wg         sync.WaitGroup
		channelIDs []string
		convIDs    []string
	)
	if a.memberships != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if chans, err := a.memberships.ListUserChannels(ctx, userID); err == nil {
				channelIDs = make([]string, 0, len(chans))
				for _, c := range chans {
					channelIDs = append(channelIDs, c.ChannelID)
				}
			}
		}()
	}
	if a.conversations != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if convs, err := a.conversations.ListUserConversations(ctx, userID); err == nil {
				convIDs = make([]string, 0, len(convs))
				for _, c := range convs {
					convIDs = append(convIDs, c.ConversationID)
				}
			}
		}()
	}
	wg.Wait()
	out := append(channelIDs, convIDs...)
	a.put(userID, out)
	return out, nil
}

func (a *searchAccess) cachedFor(userID string) ([]string, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	entry, ok := a.cache[userID]
	if !ok || a.now().After(entry.expiresAt) {
		return nil, false
	}
	return entry.ids, true
}

func (a *searchAccess) put(userID string, ids []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cache[userID] = allowedEntry{ids: ids, expiresAt: a.now().Add(allowedParentIDsTTL)}
}
