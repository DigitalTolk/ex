package service

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/cenkalti/backoff/v5"
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
	// NotificationKindApproval fires when an agent the user invoked needs their
	// decision (request_approval / ask_user). It blocks the run until answered,
	// so it's always notifiable and the client renders it distinctly (it's an
	// action the user must take, not just something to read).
	NotificationKindApproval NotificationKind = "approval"
	// NotificationKindCatchUp fires when a watcher accumulated an OFFLINE
	// backlog on a local CLI harness and needs the creator's go-ahead to
	// process it (their machine, their tokens). Always notifiable — it waits
	// for a decision.
	NotificationKindCatchUp NotificationKind = "catchup"
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
	NotificationKindApproval:    {},
	NotificationKindCatchUp:     {},
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

// memberSnapshot is everything NotifyForMessage and its helpers need to
// reason about a parent's audience: the IDs of every recipient (author
// excluded), which of them muted the channel, and each one's effective
// notification settings (account defaults folded with per-channel overrides).
// Loading it once per message keeps the hot path to a single ListMembers + a
// single batched override read + a single batched account-settings read even
// when the body contains @all/@here.
type memberSnapshot struct {
	memberIDs []string                              // every parent member except the author
	muted     map[string]bool                       // userID → true if muted (channels only; empty for conversations)
	prefs     map[string]model.NotificationSettings // userID → effective settings
	deepLink  string
}

// loadMemberSnapshot resolves the audience for a single message. Empty
// memberIDs is a valid result (e.g., empty channel) and signals "nobody
// to notify by default" — a direct @-mention can still reach a muted
// member via the mentions path.
// logAudienceLoadFailed reports an audience-resolution failure at ERROR. Losing
// the audience loses the ENTIRE recipient set for a message — no desktop alert
// AND no mobile fallback — which for an incident channel is a missed alert, so
// it must be LOUD, never silent.
func logAudienceLoadFailed(msg *model.Message, parentType string, err error) {
	slog.Error("notification audience load failed — message will notify NOBODY",
		"parentID", msg.ParentID, "parentType", parentType, "messageID", msg.ID, "error", err)
}

// audienceRetryInterval / audienceRetryMaxRetries bound the audience-read
// retry. Vars so tests can shrink the interval. The notify path already runs
// detached with a 30s budget, so a couple of half-second retries are cheap
// insurance against a DynamoDB blip zeroing a message's entire recipient set.
var (
	audienceRetryInterval          = 500 * time.Millisecond
	audienceRetryMaxRetries uint64 = 2
)

// retryAudienceLoad retries a transient audience-read failure before giving
// up: losing this read loses the ENTIRE recipient set for the message —
// desktop alerts AND mobile fallbacks — which the notification contract
// treats as an incident, not a degradation.
func retryAudienceLoad[T any](ctx context.Context, load func() (T, error)) (T, error) {
	return backoff.Retry(ctx, load,
		backoff.WithBackOff(backoff.NewConstantBackOff(audienceRetryInterval)),
		backoff.WithMaxTries(uint(audienceRetryMaxRetries)+1))
}

func (s *NotificationService) loadMemberSnapshot(ctx context.Context, msg *model.Message, parentType, parentName string) memberSnapshot {
	// Webhook posts have no human author to exclude — the "author" is the
	// webhook sentinel, and the creator didn't write the message, so they
	// stay in the audience as a normal, level-gated recipient.
	excludeID := msg.AuthorID
	if msg.WebhookUsername != "" {
		excludeID = ""
	}
	switch parentType {
	case ParentChannel:
		members, err := retryAudienceLoad(ctx, func() ([]*model.ChannelMembership, error) {
			return s.members.ListMembers(ctx, msg.ParentID)
		})
		if err != nil {
			// (Unlike the per-member overrides/prefs below, which degrade
			// gracefully — a lost override is a minor over-notification — losing
			// the member list loses the whole audience.)
			logAudienceLoadFailed(msg, parentType, err)
			return memberSnapshot{}
		}
		ids := make([]string, 0, len(members))
		for _, m := range members {
			if m.UserID == excludeID {
				continue
			}
			ids = append(ids, m.UserID)
		}
		// One batched read of the members' per-channel overrides (incl. mute)
		// rather than a ListUserChannels query per member (O(members) queries
		// on every channel message). On failure, fall back to "no overrides" —
		// a missed mute/override is a minor over-notification, not a
		// correctness bug.
		overrides, err := s.members.UserChannelNotifPrefs(ctx, msg.ParentID, ids)
		if err != nil {
			overrides = map[string]*model.UserChannel{}
		}
		muted := make(map[string]bool, len(ids))
		for uid, uc := range overrides {
			if uc != nil && uc.Muted {
				muted[uid] = true
			}
		}
		prefs := s.resolvePrefs(ctx, ids, overrides)
		return memberSnapshot{memberIDs: ids, muted: muted, prefs: prefs, deepLink: "/channel/" + parentName}
	case ParentConversation:
		c, err := retryAudienceLoad(ctx, func() (*model.Conversation, error) {
			return s.conv.GetConversation(ctx, msg.ParentID)
		})
		if err != nil || c == nil {
			logAudienceLoadFailed(msg, parentType, err)
			return memberSnapshot{}
		}
		ids := make([]string, 0, len(c.ParticipantIDs))
		for _, p := range c.ParticipantIDs {
			if p == excludeID {
				continue
			}
			ids = append(ids, p)
		}
		prefs := s.resolvePrefs(ctx, ids, nil)
		return memberSnapshot{memberIDs: ids, muted: map[string]bool{}, prefs: prefs, deepLink: "/conversation/" + msg.ParentID}
	}
	return memberSnapshot{}
}

// resolvePrefs batch-loads each member's account-level settings and folds the
// per-channel override (if any) on top. Missing account settings default to
// DefaultNotificationSettings; a nil overrides map (conversations) means every
// member resolves to their pure account baseline.
func (s *NotificationService) resolvePrefs(ctx context.Context, ids []string, overrides map[string]*model.UserChannel) map[string]model.NotificationSettings {
	prefs := make(map[string]model.NotificationSettings, len(ids))
	accounts := map[string]model.NotificationSettings{}
	if s.users != nil {
		if got, err := s.users.NotificationSettingsFor(ctx, ids); err == nil {
			accounts = got
		}
	}
	for _, uid := range ids {
		acct, ok := accounts[uid]
		if !ok {
			acct = model.DefaultNotificationSettings()
		}
		var uc *model.UserChannel
		if overrides != nil {
			uc = overrides[uid]
		}
		prefs[uid] = model.ResolveNotificationPrefs(acct, uc)
	}
	return prefs
}

// NotifyForMessage emits a notification to every channel/conversation member
// except the author and any user who muted the parent. Errors loading
// recipients are swallowed (logged via the publisher path) — failure to
// notify must never block the underlying message send.
//
// For a thread reply, threadRoot is the authoritative root returned by
// IncrementReplyMetadata (nil when that bump failed or for non-thread
// messages): it drives the thread.updated fan-out that live-patches each
// participant's /threads list. Computing that audience HERE — from the
// same member snapshot and thread reads the notification decision uses —
// keeps the two audiences from drifting; a previous parallel copy of the
// participation rules in MessageService silently missed follow-all-threads
// users and notification-pulled bystanders, and doubled the DynamoDB reads
// on every reply.
func (s *NotificationService) NotifyForMessage(ctx context.Context, msg *model.Message, parentType string, threadRoot *model.Message) {
	if msg == nil || msg.System {
		return
	}
	kind := NotificationKindMessage
	if msg.ParentMessageID != "" {
		kind = NotificationKindThreadReply
	}
	// kind is one of NotificationKindMessage / NotificationKindThreadReply,
	// both notifiable by construction — no runtime guard needed.

	parentName := s.parentDisplayName(ctx, msg.ParentID, parentType)
	authorName := s.userDisplayName(ctx, msg.AuthorID)
	// Incoming-webhook messages display the override username, not the
	// creator's name, and fall back to the attachment fallback text when
	// the body is empty (attachments-only post) — both mirror Mattermost.
	if msg.WebhookUsername != "" {
		authorName = msg.WebhookUsername
	}
	snap := s.loadMemberSnapshot(ctx, msg, parentType, parentName)

	deepLink := snap.deepLink
	if kind == NotificationKindThreadReply {
		deepLink = deepLink + "?thread=" + msg.ParentMessageID + "#msg-" + msg.ParentMessageID
	}

	baseNotif := Notification{
		Kind:            kind,
		Title:           titleFor(kind, parentType, parentName, authorName),
		Body:            previewBody(notificationBody(msg)),
		DeepLink:        deepLink,
		ParentID:        msg.ParentID,
		ParentType:      parentType,
		MessageID:       msg.ID,
		ParentMessageID: msg.ParentMessageID,
		AuthorID:        msg.AuthorID,
		Webhook:         msg.WebhookUsername != "",
		CreatedAt:       time.Now(),
	}
	mentionNotif := baseNotif
	mentionNotif.Kind = NotificationKindMention

	isThreadReply := kind == NotificationKindThreadReply

	// Mentions are resolved into two sets so per-channel preferences can treat
	// them differently: an explicit @-mention bypasses mute and notification
	// level entirely, while @all/@here ("group" mentions) are gated by the
	// recipient's "ignore @all/@here" preference and their mute flag.
	mentions := ParseMentions(msg.Body)
	mentionNotif.Title = mentionTitleFor(mentions, parentType, parentName, authorName)
	explicitSet := make(map[string]bool)
	for _, m := range mentions.Users {
		if m.UserID != "" && m.UserID != msg.AuthorID {
			explicitSet[m.UserID] = true
		}
	}
	groupSet := make(map[string]bool)
	if mentions.All || mentions.Here {
		// @here needs presence for the WHOLE member list — resolve it in one
		// batched read instead of a Redis GET per member.
		var hereOnline map[string]bool
		if mentions.Here {
			hereOnline = s.onlineSet(snap.memberIDs)
		}
		for _, uid := range snap.memberIDs {
			if mentions.Here && !hereOnline[uid] {
				continue
			}
			groupSet[uid] = true
		}
	}

	// Thread replies are scoped to participants (root author + prior repliers +
	// explicit followers), expanded with anyone whose preferences enable
	// "follow all threads". A bystander who never opened the thread and didn't
	// opt into follow-all is not pinged for unrelated thread chatter.
	//
	// threadAudience is the SUPERSET whose /threads list shows this thread:
	// the participants above plus the reply author (re-participating by
	// posting, even past an earlier unfollow) plus anyone THIS reply's
	// notifications pull in (a mention/keyword recipient gains a
	// notification row via markThreadNotification, which surfaces the
	// thread in their /threads list). They all receive the live
	// thread.updated patch. Residual gap, deliberate: a bystander pulled in
	// by an EARLIER reply's notification who stays quiet gets no live bump
	// for later un-notifying replies (their row is already "unread"; finding
	// them would need a per-thread reverse index over user notification
	// state) — their list heals on the next ListUserThreads read.
	threadParticipants := make(map[string]bool)
	var threadAudience map[string]bool
	if isThreadReply {
		recipients := s.resolveThreadRecipients(ctx, msg, snap)
		threadAudience = make(map[string]bool, len(recipients)+1)
		for _, uid := range recipients {
			threadAudience[uid] = true
		}
		if parentType == ParentChannel {
			for _, uid := range recipients {
				threadParticipants[uid] = true
			}
			for uid, eff := range snap.prefs {
				if eff.FollowAllThreads {
					threadParticipants[uid] = true
					threadAudience[uid] = true
				}
			}
		}
		// The reply author is excluded from snap.memberIDs (no self-
		// notifications) but their /threads list must patch live too; Send
		// already verified their membership before accepting the reply.
		if msg.AuthorID != "" {
			threadAudience[msg.AuthorID] = true
		}
		// Posting a reply reads the thread for you: advance the author's
		// seen watermark server-side (the thread analogue of bumpUnreadSeq
		// marking the author caught up on the parent) and clear any stale
		// thread-notification row. The client RELIES on this and does not
		// issue a follow-up seen PUT for its own replies — removing this
		// would resurrect one HTTP round-trip per reply and mark the
		// author's own reply unread on their other devices.
		if s.userState != nil && msg.AuthorID != "" && msg.WebhookUsername == "" {
			if err := s.userState.MarkThreadSeen(ctx, msg.AuthorID, msg.ParentID, parentType, msg.ParentMessageID); err != nil {
				slog.Warn("author thread-seen mark failed", "threadRootID", msg.ParentMessageID, "userID", msg.AuthorID, "error", err)
			}
		}
	}

	bodyLower := strings.ToLower(msg.Body)

	// Mobile pushes collected during the loop; their presence checks resolve
	// in one batched read afterwards.
	type pendingPush struct {
		uid   string
		notif Notification
	}
	var mobilePending []pendingPush

	// Pass 1 — pure gating: decide who is alerted and how. No I/O.
	type alertPlan struct {
		uid       string
		mentioned bool
		desktop   bool
		mobile    bool
	}
	var plans []alertPlan
	for _, uid := range snap.memberIDs {
		eff := snap.prefs[uid]
		r := recipientReasons{
			explicitMention:   explicitSet[uid],
			groupMention:      groupSet[uid] && !eff.IgnoreGroupMentions,
			muted:             snap.muted[uid],
			threadReply:       isThreadReply,
			threadParticipant: parentType == ParentConversation || threadParticipants[uid],
			threadReplies:     eff.ThreadReplies,
		}
		// The keyword scan is the one per-recipient cost that walks the whole
		// body, and eligibleAtLevel only consults it once the cheaper signals
		// (explicit mention, mute, group mention) haven't already
		// decided. Skip it entirely in those cases and when the user has no
		// keywords — the dominant case now that names are seeded but most
		// channel members still aren't @-mentioned.
		if len(eff.Keywords) > 0 && !r.explicitMention && !r.muted && !r.groupMention {
			r.keyword = keywordsMatchLower(bodyLower, eff.Keywords)
		}

		// DMs always notify their participants — "direct messages" is part of
		// even the quiet "mentions, DMs & keywords" level — so they short-
		// circuit the level machinery.
		desktop := parentType == ParentConversation || eligibleAtLevel(eff.DesktopLevel, r)
		mobile := parentType == ParentConversation
		if !mobile {
			switch eff.MobileLevel {
			case model.MobileNotificationDefault:
				mobile = desktop
			case model.MobileNotificationAll:
				mobile = eligibleAtLevel(model.NotificationLevelAll, r)
			case model.MobileNotificationMentions:
				mobile = eligibleAtLevel(model.NotificationLevelMentions, r)
			}
		}
		if !desktop && !mobile {
			continue
		}

		// This recipient is being alerted about the thread reply, so a
		// notification row will surface the thread in their /threads list —
		// include them in the live thread.updated patch below.
		if isThreadReply && threadAudience != nil {
			threadAudience[uid] = true
		}
		plans = append(plans, alertPlan{uid: uid, mentioned: r.explicitMention || r.groupMention, desktop: desktop, mobile: mobile})
	}

	// Pass 2 — the per-recipient DynamoDB writes, bounded-parallel: badge
	// bumps for top-level messages, thread markers for replies. These were
	// SEQUENTIAL — a 500-member "all messages" post paid 500 UpdateItems one
	// after another on the notify path. Each write stays best-effort: a
	// failure must never block the alert itself (the badge/marker self-heals
	// on the next list fetch).
	//
	// Thread replies persist a thread-notification marker so the Threads nav
	// lights up on a cold reload — thread replies do NOT bump the parent's
	// unread seq, so this marker is the only durable thread-unread signal.
	// Channel/DM unread needs NO per-user marker here: the sidebar badge is
	// driven by the durable server seq count (channel.MessageSeq −
	// LastReadSeq), which already shows on a cold reload even when the live
	// event was missed.
	counts := make([]int64, len(plans))
	haveCount := make([]bool, len(plans))
	if len(plans) > 0 {
		var wg sync.WaitGroup
		sem := make(chan struct{}, notifyWriteConcurrency)
		for i := range plans {
			wg.Add(1)
			sem <- struct{}{}
			go func(i int) {
				defer wg.Done()
				defer func() { <-sem }()
				defer safe.Recover()
				if isThreadReply {
					s.markThreadNotification(ctx, plans[i].uid, msg, parentType)
					return
				}
				if n, ok := s.bumpNotifyCount(ctx, parentType, msg.ParentID, plans[i].uid); ok {
					counts[i] = n
					haveCount[i] = true
				}
			}(i)
		}
		wg.Wait()
	}

	// Pass 3 — build each recipient's payload and fan out: desktop publishes
	// collected into ONE pipelined batch (they used to be one PUBLISH
	// round-trip per recipient), mobile pushes deferred to the batched
	// presence check below.
	desktopItems := make([]events.PublishItem, 0, len(plans))
	for i, plan := range plans {
		uid := plan.uid
		notif := baseNotif
		mentioned := plan.mentioned
		if mentioned {
			notif = mentionNotif
		}
		if haveCount[i] {
			notif.ParentUnreadNotifyCount = counts[i]
		}
		desktop := plan.desktop
		mobile := plan.mobile

		if desktop {
			if evt, err := events.NewEvent(events.EventNotificationNew, notif); err == nil {
				desktopItems = append(desktopItems, events.PublishItem{Channel: pubsub.UserChannel(uid), Event: evt})
			}
		}
		if mobile {
			// Defer the push decision: presence for every mobile recipient
			// resolves in ONE batched read after the loop instead of a
			// Redis GET per recipient here.
			mobilePending = append(mobilePending, pendingPush{uid: uid, notif: notif})
		}
	}

	// One pipelined round-trip for the whole desktop fan-out.
	events.PublishEach(ctx, s.publisher, desktopItems)

	if len(mobilePending) > 0 {
		ids := make([]string, len(mobilePending))
		for i, p := range mobilePending {
			ids[i] = p.uid
		}
		online := s.onlineSet(ids)
		for _, p := range mobilePending {
			s.sendMobilePush(ctx, p.uid, p.notif, online[p.uid])
		}
	}

	// Live-patch every audience member's /threads list from the
	// authoritative root. Gated on threadRoot: when the reply-metadata bump
	// failed there is no fresh root to patch from, and clients must fall
	// back to their next ListUserThreads read instead of caching a stale
	// replyCount.
	if isThreadReply && threadRoot != nil && len(threadAudience) > 0 {
		s.publishThreadUpdate(ctx, msg, parentType, threadRoot, threadAudience)
	}
}

// publishThreadUpdate fans a thread.updated event out to everyone whose
// /threads list shows this thread, so the list patches live from the
// reply's authoritative root instead of a race-prone refetch. The
// audience is computed by NotifyForMessage from the same member snapshot
// and thread reads that gate notifications — keep it that way; a second
// implementation of the participation rules WILL drift (the last one
// missed follow-all-threads users and notification-pulled bystanders).
func (s *NotificationService) publishThreadUpdate(ctx context.Context, msg *model.Message, parentType string, root *model.Message, audience map[string]bool) {
	if s.publisher == nil {
		return
	}
	latest := root.CreatedAt
	if root.LastReplyAt != nil {
		latest = *root.LastReplyAt
	}
	summary := &ThreadSummary{
		ParentID:         msg.ParentID,
		ParentType:       parentType,
		ThreadRootID:     root.ID,
		RootAuthorID:     root.AuthorID,
		RootBody:         root.Body,
		RootCreatedAt:    root.CreatedAt,
		ReplyCount:       root.ReplyCount,
		LatestActivityAt: latest,
	}
	channels := make([]string, 0, len(audience))
	for uid := range audience {
		channels = append(channels, pubsub.UserChannel(uid))
	}
	events.PublishMany(ctx, s.publisher, channels, events.EventThreadUpdated, summary)
}

// recipientReasons captures, for one recipient and one message, the precomputed
// signals eligibleAtLevel needs. Keeping it a plain struct makes the decision a
// pure function that is trivial to unit-test across the level matrix.
type recipientReasons struct {
	explicitMention   bool // @-mentioned by user id (bypasses mute + level)
	groupMention      bool // @all/@here applies after the ignore preference
	muted             bool // channel muted (suppresses everything but explicit @)
	threadReply       bool // the message is a reply within a thread
	threadParticipant bool // recipient participates in / follows the thread
	threadReplies     bool // recipient wants thread-reply notifications
	keyword           bool // message body matched one of the recipient's keywords
}

// eligibleAtLevel decides whether a channel recipient should be notified at the
// given notification level. Conversations are handled by the caller (always
// notified) and never reach here.
func eligibleAtLevel(level model.NotificationLevel, r recipientReasons) bool {
	if r.explicitMention {
		return true
	}
	if r.muted {
		return false
	}
	if r.groupMention {
		return true
	}
	if r.threadReply {
		// An explicit keyword match reflects a standing "always alert me on this
		// word" interest, so it fires even for a thread bystander (e.g. an
		// incident keyword landing in a thread reply). Everything else stays
		// quiet for non-participants so "all messages" doesn't spam every member
		// with every thread reply.
		if r.keyword {
			return true
		}
		if !r.threadParticipant {
			return false
		}
		if level == model.NotificationLevelAll {
			return true
		}
		return r.threadReplies
	}
	if level == model.NotificationLevelAll {
		return true
	}
	return r.keyword
}

// NotifyDirect delivers a pre-built notification to a single user, bypassing all
// message-audience gating (mute/level/mention). It is for self-targeted alerts
// like fired reminders: publish the desktop `notification.new` and arm the same
// ack-gated mobile-push fallback messages use, so the alert reaches the user on
// desktop OR mobile exactly as a message notification would. No-op for an empty
// user id.
func (s *NotificationService) NotifyDirect(ctx context.Context, userID string, notif Notification) {
	if userID == "" {
		return
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventNotificationNew, notif)
	online := s.presence != nil && s.presence.IsOnline(userID)
	s.sendMobilePush(ctx, userID, notif, online)
}

// onlineSet resolves presence for many recipients at once: one batched Redis
// read when the lookup supports it (PresenceService does), a per-user check
// otherwise. A nil presence lookup reads as everyone-offline — the fail-safe
// direction (offline → immediate push; duplicates beat silence).
func (s *NotificationService) onlineSet(userIDs []string) map[string]bool {
	if s.presence == nil {
		return map[string]bool{}
	}
	if batch, ok := s.presence.(PresenceBatchLookup); ok {
		return batch.OnlineMany(userIDs)
	}
	out := make(map[string]bool, len(userIDs))
	for _, uid := range userIDs {
		out[uid] = s.presence.IsOnline(uid)
	}
	return out
}

// bumpNotifyCount advances the recipient's alerted-unread badge for the
// parent, returning the authoritative new value. False when the store lacks
// the capability (plain test stores) or the write fails.
func (s *NotificationService) bumpNotifyCount(ctx context.Context, parentType, parentID, userID string) (int64, bool) {
	var backing any
	if parentType == ParentChannel {
		backing = s.members
	} else {
		backing = s.conv
	}
	bumper, ok := backing.(notifyCountBumper)
	if !ok {
		return 0, false
	}
	n, err := bumper.IncrementNotifyCount(ctx, parentID, userID)
	if err != nil {
		slog.Warn("notify count bump failed", "parentID", parentID, "userID", userID, "error", err)
		return 0, false
	}
	return n, true
}

func (s *NotificationService) sendMobilePush(ctx context.Context, recipientUserID string, notif Notification, online bool) {
	if s.pushSched == nil {
		return
	}
	// Offline (no live WebSocket): nothing can ack, so the desktop can't be
	// delivering this — schedule the push for immediate delivery.
	delay := time.Duration(0)
	if online {
		// Online: the desktop SHOULD deliver this, so we don't want to
		// double-notify a healthy desktop with a redundant push. But "online"
		// only means presence SAYS so — a half-open / asleep socket reads
		// online for up to the dead-socket detection window. Trusting presence
		// here is exactly the hole that drops incident alerts. So instead of
		// skipping the push outright, we DEFER it; the worker checks for the
		// client's ACK at delivery time and pushes only if none arrived.
		// Presence can be wrong in EITHER direction without losing an alert.
		if s.ackStore == nil || notif.MessageID == "" {
			// No ack tracking (or nothing to key on) — fall back to the old
			// presence-only behaviour: skip the push for an online user.
			return
		}
		delay = ackFallbackDelay
	}
	// The scheduled task is Redis-backed, so it survives restarts and any
	// instance's worker can deliver it. WithoutCancel: scheduling is a quick
	// Redis write that must not be aborted by the caller's teardown — a
	// reminder fired during shutdown still gets its push scheduled.
	if err := s.pushSched.SchedulePush(context.WithoutCancel(ctx), recipientUserID, notif, delay); err != nil {
		// A failed schedule IS a potentially lost alert — loud, never silent.
		slog.Error(
			"mobile push schedule failed — alert may not reach the recipient",
			"userID", recipientUserID,
			"parentID", notif.ParentID,
			"parentType", notif.ParentType,
			"messageID", notif.MessageID,
			"kind", notif.Kind,
			"delay", delay,
			"error", err,
		)
	}
}

func mentionTitleFor(mentions ParsedMentions, parentType, parentName, authorName string) string {
	if label := groupMentionLabel(mentions); label != "" {
		if parentType == ParentChannel {
			return authorName + " used " + label + " in ~" + parentName
		}
		return authorName + " used " + label
	}
	return titleFor(NotificationKindMention, parentType, parentName, authorName)
}

func groupMentionLabel(mentions ParsedMentions) string {
	switch {
	case mentions.All && mentions.Here:
		return "@all/@here"
	case mentions.All:
		return "@all"
	case mentions.Here:
		return "@here"
	default:
		return ""
	}
}

func (s *NotificationService) markThreadNotification(ctx context.Context, userID string, msg *model.Message, parentType string) {
	if s.userState == nil || msg == nil || msg.ParentMessageID == "" {
		return
	}
	if err := s.userState.MarkThreadNotificationUnread(ctx, userID, msg.ParentID, parentType, msg.ParentMessageID); err != nil {
		slog.Warn("thread notification state failed", "threadRootID", msg.ParentMessageID, "userID", userID, "error", err)
	}
}

// matchesKeywords reports whether body contains any of the recipient's
// notification keywords as a whole word, case-insensitively. Keywords let the
// quiet "mentions, DMs & keywords only" level still surface messages a user
// cares about even when they're not @-mentioned.
func matchesKeywords(body string, keywords []string) bool {
	if body == "" || len(keywords) == 0 {
		return false
	}
	return keywordsMatchLower(strings.ToLower(body), keywords)
}

// keywordsMatchLower is matchesKeywords with the body already lowercased. The
// per-message hot path lowercases msg.Body once and reuses it across every
// recipient's keyword list rather than re-lowercasing the whole body per member.
func keywordsMatchLower(lowerBody string, keywords []string) bool {
	for _, kw := range keywords {
		kw = strings.ToLower(strings.TrimSpace(kw))
		if kw == "" {
			continue
		}
		if containsWord(lowerBody, kw) {
			return true
		}
	}
	return false
}

// containsWord reports whether needle appears in haystack bounded by non-word
// characters on both sides (a lightweight \bneedle\b without compiling a regex
// per keyword per message). Both arguments are expected to be lowercased.
// Boundaries are Unicode-aware so accented and non-Latin keywords (common at a
// translation company, and seeded from display names) match on whole words
// rather than mid-word — e.g. "ann" must not fire inside "annü".
func containsWord(haystack, needle string) bool {
	from := 0
	for {
		idx := strings.Index(haystack[from:], needle)
		if idx < 0 {
			return false
		}
		start := from + idx
		end := start + len(needle)
		if boundaryBefore(haystack, start) && boundaryAfter(haystack, end) {
			return true
		}
		from = start + 1
	}
}

// boundaryBefore reports whether byte offset i begins a word — true at the start
// of the string or when the preceding rune is not a word rune.
func boundaryBefore(s string, i int) bool {
	if i <= 0 {
		return true
	}
	r, _ := utf8.DecodeLastRuneInString(s[:i])
	return !isWordRune(r)
}

// boundaryAfter reports whether byte offset i ends a word — true at the end of
// the string or when the following rune is not a word rune.
func boundaryAfter(s string, i int) bool {
	if i >= len(s) {
		return true
	}
	r, _ := utf8.DecodeRuneInString(s[i:])
	return !isWordRune(r)
}

// isWordRune treats Unicode letters and digits (plus underscore) as word
// characters so whole-word boundaries hold for accented and non-Latin alphabets
// (e.g. "ann" must not fire inside "annü"). Ideographic / syllabic scripts
// (Han, Kana, Hangul) are excluded because they're written without spaces — each
// such rune is its own word, so a CJK keyword still matches as a substring of
// CJK text rather than being blocked by a non-existent word boundary.
func isWordRune(r rune) bool {
	if r == '_' {
		return true
	}
	if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
		return false
	}
	return !unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
}

// resolveThreadRecipients returns the user IDs that should receive a
// thread-reply notification: the thread root's author plus everyone
// who has already replied in this thread. The current message's author
// is excluded; duplicates are removed.
func (s *NotificationService) resolveThreadRecipients(ctx context.Context, msg *model.Message, snap memberSnapshot) []string {
	if s.messages == nil || msg.ParentMessageID == "" {
		return nil
	}
	unfollowed := make(map[string]bool)
	explicitFollowers := make([]string, 0)
	if s.follows != nil {
		follows, err := s.follows.ListThreadFollows(ctx, msg.ParentID, msg.ParentMessageID)
		if err == nil {
			for _, f := range follows {
				if f.Following {
					explicitFollowers = append(explicitFollowers, f.UserID)
				} else {
					unfollowed[f.UserID] = true
				}
			}
		}
	}
	// Fetch the thread's replies via the GSI1 thread index (one Query, exactly
	// this thread) rather than scanning up to 1000 of the parent's recent
	// messages, and resolve the root author with a direct GetMessage.
	replies, err := s.messages.ListThreadReplies(ctx, msg.ParentMessageID)
	if err != nil {
		return nil
	}
	repliers := make([]string, 0)
	seen := make(map[string]bool)
	currentMembers := make(map[string]bool, len(snap.memberIDs))
	for _, uid := range snap.memberIDs {
		currentMembers[uid] = true
	}
	var rootAuthor string
	if root, err := s.messages.GetMessage(ctx, msg.ParentID, msg.ParentMessageID); err == nil && root != nil &&
		root.AuthorID != "" && root.AuthorID != msg.AuthorID && !unfollowed[root.AuthorID] && currentMembers[root.AuthorID] {
		rootAuthor = root.AuthorID
		seen[root.AuthorID] = true
	}
	// For channel parents this set gates who is NOTIFIED about the reply.
	// Conversations always notify every participant, so there it only feeds
	// the thread.updated audience (whose /threads list shows the thread).
	add := func(dst *[]string, uid string) {
		if uid == "" || uid == msg.AuthorID || seen[uid] || unfollowed[uid] {
			return
		}
		if !currentMembers[uid] {
			return
		}
		seen[uid] = true
		*dst = append(*dst, uid)
	}
	for _, m := range replies {
		if m.ID == msg.ID {
			continue
		}
		add(&repliers, m.AuthorID)
	}
	for _, uid := range explicitFollowers {
		add(&repliers, uid)
	}
	if rootAuthor == "" {
		return repliers
	}
	return append([]string{rootAuthor}, repliers...)
}

// parentDisplayName resolves a human-readable name for the parent (channel
// or conversation) used in notification titles. Returns an empty string on
// error — title formatting handles that.
func (s *NotificationService) parentDisplayName(ctx context.Context, parentID, parentType string) string {
	switch parentType {
	case ParentChannel:
		if s.channels == nil {
			return parentID
		}
		if s.nameCache != nil {
			if v, ok := s.nameCache.GetName(ctx, "chan:"+parentID); ok {
				return v
			}
		}
		ch, err := s.channels.GetChannel(ctx, parentID)
		if err != nil || ch == nil {
			return parentID
		}
		// Slug is what URLs use, but Name reads more naturally in titles.
		name := ch.Name
		if ch.Slug != "" {
			name = ch.Slug
		}
		if s.nameCache != nil {
			s.nameCache.SetName(ctx, "chan:"+parentID, name)
		}
		return name
	}
	return ""
}

func (s *NotificationService) userDisplayName(ctx context.Context, userID string) string {
	if s.users == nil {
		return userID
	}
	if s.nameCache != nil {
		if v, ok := s.nameCache.GetName(ctx, "user:"+userID); ok {
			return v
		}
	}
	u, err := s.users.GetUser(ctx, userID)
	if err != nil || u == nil {
		return userID
	}
	name := u.DisplayName
	if name == "" {
		name = u.Email
	}
	if s.nameCache != nil {
		s.nameCache.SetName(ctx, "user:"+userID, name)
	}
	return name
}

func titleFor(kind NotificationKind, parentType, parentName, authorName string) string {
	switch kind {
	case NotificationKindThreadReply:
		if parentType == ParentChannel {
			return authorName + " replied in ~" + parentName
		}
		return authorName + " replied"
	case NotificationKindMessage:
		if parentType == ParentChannel {
			return authorName + " in ~" + parentName
		}
		return authorName
	case NotificationKindMention:
		if parentType == ParentChannel {
			return authorName + " mentioned you in ~" + parentName
		}
		return authorName + " mentioned you"
	default:
		return authorName
	}
}

// previewBody clamps a message body to a sane length for a notification
// preview and strips newlines so the OS-level popup renders on one line.
// Mentions in their wire form `@[userID|DisplayName]` are flattened to
// `@DisplayName` so the popup reads "Alice mentioned: hi @Bob" rather
// than "hi @[U-2|Bob]".
// notificationBody is the text used for a push/notification preview. It
// prefers the message body, but for an attachments-only message (e.g. an
// incoming webhook posting a rich attachment with no text) it falls back
// to the first attachment's fallback summary — the field Mattermost
// defines for exactly this purpose.
func notificationBody(msg *model.Message) string {
	if msg.Body != "" {
		return msg.Body
	}
	for _, a := range msg.MessageAttachments {
		if s := attachmentSummary(a); s != "" {
			return s
		}
	}
	return ""
}

// attachmentSummary produces the notification-preview text for a rich
// (webhook) attachment. `fallback` is the field Slack/Mattermost define for
// exactly this — a plain-text summary — so it wins when present. But many
// webhook senders omit it (CI/deploy bots that only set title/text/fields),
// which left the popup empty. So when there's no fallback we synthesize a
// readable summary from the visible fields, mirroring what the attachment
// renders, rather than show a near-empty notification.
func attachmentSummary(a model.MessageAttachment) string {
	if s := strings.TrimSpace(a.Fallback); s != "" {
		return s
	}
	var parts []string
	addPart := func(s string) {
		if s = strings.TrimSpace(s); s != "" {
			parts = append(parts, s)
		}
	}
	addPart(a.Pretext)
	addPart(a.Title)
	addPart(a.Text)
	for _, f := range a.Fields {
		title, value := strings.TrimSpace(f.Title), strings.TrimSpace(f.Value)
		switch {
		case title != "" && value != "":
			addPart(title + ": " + value)
		case value != "":
			addPart(value)
		default:
			addPart(title)
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, " — ")
	}
	// Last resort: chrome-only fields, so the popup still says *something*
	// rather than arriving blank.
	if s := strings.TrimSpace(a.Footer); s != "" {
		return s
	}
	return strings.TrimSpace(a.AuthorName)
}

func previewBody(body string) string {
	const max = 140
	body = userMentionPattern.ReplaceAllString(body, "@$2")
	body = channelMentionRE.ReplaceAllString(body, "~$2")
	body = renderEmojiShortcodes(body)
	body = strings.ReplaceAll(body, "\n", " ")
	// Rune-aware clamp: byte-slicing would split a multi-byte emoji glyph into
	// invalid UTF-8.
	if runes := []rune(body); len(runes) > max {
		return string(runes[:max-1]) + "…"
	}
	return body
}

// renderEmojiShortcodes replaces known emoji shortcodes with their unicode
// glyph so a popup shows 😄 rather than ":smile:". The toned form is handled
// first so the bare matcher can't eat part of it; a toned shortcode renders as
// the base glyph (the skin-tone modifier is dropped in the flat preview).
// Unknown/custom shortcodes pass through unchanged — there is no glyph to show.
func renderEmojiShortcodes(body string) string {
	body = emojiTonedRE.ReplaceAllStringFunc(body, func(s string) string {
		m := emojiTonedRE.FindStringSubmatch(s)
		if g, ok := emojiShortcodeToUnicode[strings.ToLower(m[1])]; ok {
			return g
		}
		return s
	})
	return emojiBareRE.ReplaceAllStringFunc(body, func(s string) string {
		m := emojiBareRE.FindStringSubmatch(s)
		if g, ok := emojiShortcodeToUnicode[strings.ToLower(m[1])]; ok {
			return g
		}
		return s
	})
}
