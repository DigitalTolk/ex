package eventlog

import (
	"context"
	"strings"
	"sync"
	"time"
)

// MemberLister is the subset of MembershipStore needed to resolve
// channel-topic recipients without importing the store interface.
type MemberLister interface {
	MemberIDs(ctx context.Context, channelID string) ([]string, error)
}

// ParticipantLister is the subset of ConversationStore needed to
// resolve conversation-topic recipients.
type ParticipantLister interface {
	ParticipantIDs(ctx context.Context, conversationID string) ([]string, error)
}

// Resolver maps a pub/sub topic to the set of userIDs that should
// receive the event in their durable inbox. Topics whose recipient
// set is "everyone connected" (global:*) are intentionally not
// resolved — those events are sent live-only because fanning them out
// to every user's inbox is expensive and the recovery cost on the
// client (a single list refetch) is cheap.
type Resolver struct {
	members      MemberLister
	participants ParticipantLister

	// Optional short-TTL cache of topic → recipient IDs. The inbox fan-out
	// otherwise re-queries DynamoDB membership on EVERY persistent event
	// (message.new, every reaction/edit, member changes). Off by default
	// (ttl 0); enabled in production via SetCacheTTL. Bounded staleness means a
	// just-joined member's inbox recipiency is fresh within ttl — and live
	// delivery (the broker subscription) is already correct on join, so this
	// only affects reconnect replay during the brief window.
	mu    sync.Mutex
	cache map[string]cachedRecipients
	ttl   time.Duration
	now   func() time.Time
}

type cachedRecipients struct {
	ids       []string
	expiresAt time.Time
}

// recipientCacheMaxEntries bounds the cache: a channel that publishes once and
// goes dormant would otherwise retain its recipient slice forever (it's never
// re-resolved to refresh/expire it). At the cap we sweep expired entries — the
// short TTL means most are stale — keeping retention ~the active topic set.
const recipientCacheMaxEntries = 4096

// SetCacheTTL enables (ttl>0) or disables (ttl<=0) the recipient cache.
func (r *Resolver) SetCacheTTL(ttl time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ttl = ttl
	r.cache = nil
}

func (r *Resolver) clock() time.Time {
	if r.now != nil {
		return r.now()
	}
	return time.Now()
}

// cachedResolve returns a cached recipient list for topic when caching is on
// and the entry is fresh; otherwise it calls fetch, caches the result, and
// returns it.
func (r *Resolver) cachedResolve(topic string, fetch func() ([]string, error)) ([]string, error) {
	r.mu.Lock()
	if r.ttl > 0 {
		if e, ok := r.cache[topic]; ok && r.clock().Before(e.expiresAt) {
			r.mu.Unlock()
			return e.ids, nil
		}
	}
	r.mu.Unlock()

	ids, err := fetch()
	if err != nil {
		return nil, err
	}
	if r.ttl > 0 {
		now := r.clock()
		r.mu.Lock()
		if r.cache == nil {
			r.cache = make(map[string]cachedRecipients)
		}
		if len(r.cache) >= recipientCacheMaxEntries {
			for k, e := range r.cache {
				if !now.Before(e.expiresAt) {
					delete(r.cache, k)
				}
			}
		}
		r.cache[topic] = cachedRecipients{ids: ids, expiresAt: now.Add(r.ttl)}
		r.mu.Unlock()
	}
	return ids, nil
}

// NewResolver builds a Resolver. Either dependency may be nil — the
// corresponding topic prefix then simply yields an empty recipient
// list (the event still publishes live, just nothing goes into any
// inbox).
func NewResolver(m MemberLister, p ParticipantLister) *Resolver {
	return &Resolver{members: m, participants: p}
}

// Resolve returns the recipient userIDs for the given pubsub topic.
// Topics not understood by the resolver (e.g. `global:*`) return an
// empty slice and a nil error so the caller can safely skip durable
// fan-out without special-casing topic strings.
func (r *Resolver) Resolve(ctx context.Context, topic string) ([]string, error) {
	if r == nil {
		return nil, nil
	}
	switch {
	case strings.HasPrefix(topic, "chan:"):
		if r.members == nil {
			return nil, nil
		}
		return r.cachedResolve(topic, func() ([]string, error) {
			return r.members.MemberIDs(ctx, strings.TrimPrefix(topic, "chan:"))
		})
	case strings.HasPrefix(topic, "conv:"):
		if r.participants == nil {
			return nil, nil
		}
		return r.cachedResolve(topic, func() ([]string, error) {
			return r.participants.ParticipantIDs(ctx, strings.TrimPrefix(topic, "conv:"))
		})
	case strings.HasPrefix(topic, "user:"):
		// Direct delivery — the topic encodes the recipient.
		return []string{strings.TrimPrefix(topic, "user:")}, nil
	default:
		// global:* and anything else — live-only.
		return nil, nil
	}
}
