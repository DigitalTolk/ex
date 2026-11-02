package eventlog

import (
	"context"
	"strings"
	"sync/atomic"
	"time"

	"github.com/hashicorp/golang-lru/v2/expirable"
	"golang.org/x/sync/singleflight"
)

// MemberLister is the subset of MembershipStore needed to resolve
// channel-topic recipients without importing the store interface.
type MemberLister interface {
	MemberIDs(ctx context.Context, channelID string) ([]string, error)
}

// ChannelGenerations reads a channel's audience generation: the shared value
// every membership write moves (internal/cache's ChannelAudienceKey), from the
// services and the history importer alike.
type ChannelGenerations interface {
	ChannelGeneration(ctx context.Context, channelID string) (string, error)
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

	// Optional cache of topic → recipient IDs. The inbox fan-out otherwise
	// re-queries DynamoDB membership on EVERY persistent event (message.new,
	// every reaction/edit, member changes). Off by default (nil); enabled in
	// production via SetCacheTTL. With channel generations wired, a channel
	// entry is reused only while its generation is unchanged, and the TTL is
	// just the backstop; otherwise the TTL alone bounds staleness. Live
	// delivery (the broker subscription) is already correct on join, so this
	// only affects reconnect replay.
	cache atomic.Pointer[expirable.LRU[string, recipients]]
	gens  ChannelGenerations
	// lookups collapses concurrent misses for one topic into one store query,
	// so a burst of events on a busy channel can't stampede DynamoDB.
	lookups singleflight.Group
}

// recipients is one cached topic: its recipient IDs and the generation they
// were read under ("" for topics without one).
type recipients struct {
	ids []string
	gen string
}

// recipientCacheMaxEntries bounds the cache: the least recently resolved
// topic is evicted at the cap, and expired entries are swept in the
// background, so a channel that publishes once and goes dormant doesn't keep
// its recipient slice forever.
const recipientCacheMaxEntries = 4096

// SetCacheTTL enables (ttl>0) or disables (ttl<=0) the recipient cache.
func (r *Resolver) SetCacheTTL(ttl time.Duration) {
	if ttl <= 0 {
		r.cache.Store(nil)
		return
	}
	r.cache.Store(expirable.NewLRU[string, recipients](recipientCacheMaxEntries, nil, ttl))
}

// SetChannelGenerations makes cached channel recipients follow the channel's
// audience generation.
func (r *Resolver) SetChannelGenerations(g ChannelGenerations) { r.gens = g }

// generation reads topic's current generation: "" for a topic without one.
// ok is false when it could not be read; the topic is then fetched and not
// cached.
func (r *Resolver) generation(ctx context.Context, topic string) (string, bool) {
	channelID, isChannel := strings.CutPrefix(topic, "chan:")
	if r.gens == nil || !isChannel {
		return "", true
	}
	gen, err := r.gens.ChannelGeneration(ctx, channelID)
	return gen, err == nil
}

// cachedResolve returns a cached recipient list for topic when caching is on
// and the entry is fresh and of the current generation; otherwise it calls
// fetch, caches the result, and returns it. The generation is read before the
// fetch, so a change racing it moves the generation past the stored entry.
// With the cache on, concurrent misses for a topic share one fetch (run with
// the first caller's context — the publisher's fan-out context, which is
// already detached from any request and bounded).
func (r *Resolver) cachedResolve(ctx context.Context, topic string, fetch func() ([]string, error)) ([]string, error) {
	cache := r.cache.Load()
	if cache == nil {
		return fetch()
	}
	gen, ok := r.generation(ctx, topic)
	if e, hit := cache.Get(topic); hit && ok && e.gen == gen {
		return e.ids, nil
	}
	ids, err, _ := r.lookups.Do(topic+"\x00"+gen, func() (any, error) {
		ids, err := fetch()
		if err != nil {
			return nil, err
		}
		if ok {
			cache.Add(topic, recipients{ids: ids, gen: gen})
		}
		return ids, nil
	})
	if err != nil {
		return nil, err
	}
	return ids.([]string), nil
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
		return r.cachedResolve(ctx, topic, func() ([]string, error) {
			return r.members.MemberIDs(ctx, strings.TrimPrefix(topic, "chan:"))
		})
	case strings.HasPrefix(topic, "conv:"):
		if r.participants == nil {
			return nil, nil
		}
		return r.cachedResolve(ctx, topic, func() ([]string, error) {
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
