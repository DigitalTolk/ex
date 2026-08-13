package service

import (
	"context"
	"time"
)

// NotificationKind tags a notification with its semantic class so the client
// can apply different sounds, copy, and grouping rules without a large
// payload-shape switch on the receiver. Adding a new kind here is the
// single place a new notification flavor is registered.
type NotificationKind string

const (
	NotificationKindMessage     NotificationKind = "message"
	NotificationKindMention     NotificationKind = "mention"
	NotificationKindThreadReply NotificationKind = "thread_reply"
	// NotificationKindReminder is a self-set "remind me about this message"
	// alert firing at its scheduled time. Always notifiable — the user
	// explicitly asked to be alerted, so no gating applies.
	NotificationKindReminder NotificationKind = "reminder"
)

// notifiableKinds is the registry of kinds that should actually fire a
// user-facing notification. This is the small "notifiable" property the
// design ask referenced — keep it data-driven so a new event type either
// joins this set explicitly or stays silent. No magic, no hidden defaults.
var notifiableKinds = map[NotificationKind]struct{}{
	NotificationKindMessage:     {},
	NotificationKindMention:     {},
	NotificationKindThreadReply: {},
	NotificationKindReminder:    {},
}

// IsNotifiable reports whether a kind should produce an actual user-facing
// notification (sound + browser popup). Exposed so callers can short-circuit
// payload assembly when nothing would be delivered.
func IsNotifiable(k NotificationKind) bool {
	_, ok := notifiableKinds[k]
	return ok
}

// Notification is the user-facing alert payload delivered over the same
// WebSocket pipe as state events. It is intentionally minimal — title, body,
// where to go on click, and a stable client-side de-dup key.
type Notification struct {
	Kind            NotificationKind `json:"kind"`
	Title           string           `json:"title"`
	Body            string           `json:"body"`
	DeepLink        string           `json:"deepLink"`
	ParentID        string           `json:"parentID"`   // channel/conversation ID
	ParentType      string           `json:"parentType"` // "channel" | "conversation"
	MessageID       string           `json:"messageID,omitempty"`
	ParentMessageID string           `json:"parentMessageID,omitempty"`
	AuthorID        string           `json:"authorID,omitempty"` // for client-side own-author suppression
	// Webhook marks a notification that originated from an incoming
	// webhook (CI alerts, deploy bots, etc.). The "author" is the webhook,
	// not a real sender, so the client exempts these from its own-author
	// echo suppression. Whether to notify at all is decided server-side by
	// the recipient's notification level, exactly like a regular message.
	Webhook   bool      `json:"webhook,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	// ParentUnreadNotifyCount is the recipient's authoritative alerted-unread
	// badge for the parent AFTER this notification (top-level messages only;
	// thread replies never touch parent counters). Clients SET their sidebar
	// badge to this value — never increment locally — so replayed or
	// duplicated events can't drift the count.
	ParentUnreadNotifyCount int64 `json:"parentUnreadNotifyCount,omitempty"`
}

// PresenceLookup is the slice of PresenceService NotificationService cares
// about. Defined as an interface so the dependency is explicit and tests
// can stub it without instantiating the real presence tracker.
type PresenceLookup interface {
	IsOnline(userID string) bool
}

// PresenceBatchLookup is the optional batched sibling of PresenceLookup
// (PresenceService implements it): one Redis round trip for a whole recipient
// set instead of a GET per recipient. Asserted where fan-outs need presence
// for many users; plain single-user lookups keep working via the fallback.
type PresenceBatchLookup interface {
	OnlineMany(userIDs []string) map[string]bool
}

// notifyCountBumper is the optional per-recipient alerted-unread counter
// capability of the membership/conversation stores (the DynamoDB adapters
// have it). The badge is maintained HERE — at the moment the notification
// decision fires — because that decision (level + mute + keywords + mentions)
// is made exactly once, server-side; recomputing it at read time would mean
// re-running the notifier over history.
type notifyCountBumper interface {
	IncrementNotifyCount(ctx context.Context, parentID, userID string) (int64, error)
}

type MobilePushSender interface {
	Send(ctx context.Context, recipientUserID string, n Notification) error
}

// NotificationAckStore records and reports desktop-delivery acknowledgements.
// When a client receives a `notification.new` it acks over its WebSocket; the
// deferred mobile-push fallback consults WasNotificationAcked to decide whether
// the desktop actually delivered the alert (ack present) or merely looked online
// (no ack → the socket was dead/reconnecting → push must fire). Redis-backed in
// production so an ack on one backend instance is visible to the deferred push
// running on another.
type NotificationAckStore interface {
	WasNotificationAcked(ctx context.Context, userID, messageID string) bool
}

// ackFallbackDelay is how long the deferred mobile push waits for the desktop
// client to ack before giving up and pushing. A var so tests can shrink it.
//
// INVARIANT (asserted by TestAckFallbackDelayInvariants): the delay must be at
// least one full WS keep-alive cycle —
//
//	ackFallbackDelay >= wsKeepAliveInterval (15s) + wsPongTimeout (10s)
//
// so a HEALTHY socket has time to prove liveness (and surface + ack the alert)
// before the push fires, and a DEAD socket is detected by the keep-alive within
// the same window — otherwise the deferred push races the very presence signal
// it depends on and double-notifies an online desktop user. It must also stay
// below the ack-marker TTL so a recorded ack is still visible when the timer
// fires —
//
//	ackFallbackDelay < cache.notifAckTTL (60s)
//
// At 8s (the previous value) the push fired before a live desktop — under
// fan-out latency — could round-trip its ack, so every online user got a
// redundant mobile push. 30s covers the keep-alive cycle plus surfacing slack.
var ackFallbackDelay = 30 * time.Second

// notifyWriteConcurrency bounds the parallel per-recipient DynamoDB writes
// (badge bumps / thread markers) on the notify path — high enough to collapse
// a big channel's fan-out latency, low enough to stay inside table capacity.
const notifyWriteConcurrency = 16

// NotificationService dispatches notifications to interested users while
// honoring per-user mute preferences. It is intentionally tiny and parallel
// to the events package: events update *every* connected client; this fans
// out a separate "notification.new" event only to recipients who actually
// want an alert.
type NotificationService struct {
	publisher Publisher
	members   MembershipStore
	conv      ConversationStore
	channels  ChannelStore
	users     UserStore
	messages  MessageStore
	presence  PresenceLookup
	follows   ThreadFollowStore
	userState *UserStateService
	pushSched MobilePushScheduler
	ackStore  NotificationAckStore
	nameCache NameCache
}

// NotificationServiceDeps declares the notifier's full dependency surface —
// the production constructor input. This pipeline is incident-critical
// (see CLAUDE.md): declaring presence/acks/push here makes it obvious at the
// wiring site when a delivery-path dependency is missing, instead of a
// forgotten Set* silently degrading the fallback.
type NotificationServiceDeps struct {
	// Required core.
	Publisher     Publisher
	Memberships   MembershipStore
	Conversations ConversationStore
	Channels      ChannelStore
	Users         UserStore
	// Messages is used only for thread-reply scoping (root author + prior
	// participants). Nil degrades the thread path to "no recipients beyond
	// explicit @-mentions".
	Messages MessageStore

	// Delivery-path capabilities (each nil-tolerant, but production wires
	// all of them; see the Set* docs for per-field semantics).
	Presence      PresenceLookup
	ThreadFollows ThreadFollowStore
	UserState     *UserStateService
	AckStore      NotificationAckStore
	NameCache     NameCache
}

// NewNotificationServiceFromDeps constructs a fully-wired NotificationService.
// The push scheduler still attaches via SetMobilePushScheduler — it is built
// after the service because the asynq worker needs the service's ack store.
func NewNotificationServiceFromDeps(d NotificationServiceDeps) *NotificationService {
	return &NotificationService{
		publisher: d.Publisher,
		members:   d.Memberships,
		conv:      d.Conversations,
		channels:  d.Channels,
		users:     d.Users,
		messages:  d.Messages,
		presence:  d.Presence,
		follows:   d.ThreadFollows,
		userState: d.UserState,
		ackStore:  d.AckStore,
		nameCache: d.NameCache,
	}
}

// NewNotificationService builds a NotificationService from the required core —
// the test-oriented constructor; delivery capabilities attach via Set*.
// messages is used only for thread-reply scoping (looking up the root author
// + prior participants). Pass nil and the thread path will degrade gracefully
// to "no recipients beyond explicit @-mentions".
func NewNotificationService(p Publisher, m MembershipStore, c ConversationStore, ch ChannelStore, u UserStore, msgs MessageStore) *NotificationService {
	return NewNotificationServiceFromDeps(NotificationServiceDeps{
		Publisher:     p,
		Memberships:   m,
		Conversations: c,
		Channels:      ch,
		Users:         u,
		Messages:      msgs,
	})
}

// SetPresence wires a presence lookup so the @here mention can target only
// currently-online members. Optional — when nil, @here falls through to
// "no recipients" (better than spamming the whole channel).
func (s *NotificationService) SetPresence(p PresenceLookup) { s.presence = p }

func (s *NotificationService) SetThreadFollowStore(f ThreadFollowStore) { s.follows = f }

func (s *NotificationService) SetUserStateService(userState *UserStateService) {
	s.userState = userState
}

// SetMobilePushScheduler wires the durable (Redis-backed) push scheduler.
// The service only ever *schedules* pushes — immediate for offline
// recipients, deferred by ackFallbackDelay for online ones; the ack check
// and the provider call happen in the worker at delivery time, so a pending
// push survives restarts and any instance can deliver it.
func (s *NotificationService) SetMobilePushScheduler(sched MobilePushScheduler) {
	s.pushSched = sched
}

// SetAckStore wires the desktop-delivery acknowledgement store that gates the
// deferred mobile-push fallback. Without it, an online recipient's push falls
// back to the old presence-only behaviour (skipped) — so wiring this is what
// closes the dead-socket delivery hole.
func (s *NotificationService) SetAckStore(store NotificationAckStore) {
	s.ackStore = store
}

// NameCache caches the rarely-changing channel/author display names used in
// notification titles, so the per-message notify path doesn't do two uncached
// DynamoDB point reads (author profile + channel metadata) on every notifiable
// message. A short TTL keeps a renamed channel/user fresh within minutes.
type NameCache interface {
	GetName(ctx context.Context, key string) (string, bool)
	SetName(ctx context.Context, key, val string)
}

// SetNameCache wires the display-name cache. Optional — without it the notifier
// reads names from the stores directly (the previous behaviour).
func (s *NotificationService) SetNameCache(c NameCache) { s.nameCache = c }
