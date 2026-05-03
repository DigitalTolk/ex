package service

import (
	"context"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
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
)

// notifiableKinds is the registry of kinds that should actually fire a
// user-facing notification. This is the small "notifiable" property the
// design ask referenced — keep it data-driven so a new event type either
// joins this set explicitly or stays silent. No magic, no hidden defaults.
var notifiableKinds = map[NotificationKind]struct{}{
	NotificationKindMessage:     {},
	NotificationKindMention:     {},
	NotificationKindThreadReply: {},
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
	Kind       NotificationKind `json:"kind"`
	Title      string           `json:"title"`
	Body       string           `json:"body"`
	DeepLink   string           `json:"deepLink"`
	ParentID   string           `json:"parentID"`   // channel/conversation ID
	ParentType string           `json:"parentType"` // "channel" | "conversation"
	MessageID  string           `json:"messageID,omitempty"`
	AuthorID   string           `json:"authorID,omitempty"` // for client-side own-author suppression
	CreatedAt  time.Time        `json:"createdAt"`
}

// PresenceLookup is the slice of PresenceService NotificationService cares
// about. Defined as an interface so the dependency is explicit and tests
// can stub it without instantiating the real presence tracker.
type PresenceLookup interface {
	IsOnline(userID string) bool
}

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
}

// NewNotificationService builds a NotificationService. messages is used
// only for thread-reply scoping (looking up the root author + prior
// participants). Pass nil and the thread path will degrade gracefully
// to "no recipients beyond explicit @-mentions".
func NewNotificationService(p Publisher, m MembershipStore, c ConversationStore, ch ChannelStore, u UserStore, msgs MessageStore) *NotificationService {
	return &NotificationService{publisher: p, members: m, conv: c, channels: ch, users: u, messages: msgs}
}

// SetPresence wires a presence lookup so the @here mention can target only
// currently-online members. Optional — when nil, @here falls through to
// "no recipients" (better than spamming the whole channel).
func (s *NotificationService) SetPresence(p PresenceLookup) { s.presence = p }

func (s *NotificationService) SetThreadFollowStore(f ThreadFollowStore) { s.follows = f }

// memberSnapshot is everything NotifyForMessage and its helpers need to
// reason about a parent's audience: the IDs of every recipient (author
// excluded) and which of them muted the channel. Loading it once per
// message keeps the hot path to a single ListMembers + a single mute
// scan even when the body contains @all/@here.
type memberSnapshot struct {
	memberIDs []string        // every parent member except the author
	muted     map[string]bool // userID → true if muted (channels only; empty for conversations)
	deepLink  string
}

// loadMemberSnapshot resolves the audience for a single message. Empty
// memberIDs is a valid result (e.g., empty channel) and signals "nobody
// to notify by default" — a direct @-mention can still reach a muted
// member via the mentions path.
func (s *NotificationService) loadMemberSnapshot(ctx context.Context, msg *model.Message, parentType, parentName string) memberSnapshot {
	switch parentType {
	case ParentChannel:
		members, err := s.members.ListMembers(ctx, msg.ParentID)
		if err != nil {
			return memberSnapshot{}
		}
		ids := make([]string, 0, len(members))
		for _, m := range members {
			if m.UserID == msg.AuthorID {
				continue
			}
			ids = append(ids, m.UserID)
		}
		muted := make(map[string]bool, len(ids))
		for _, uid := range ids {
			if s.userMutedChannel(ctx, uid, msg.ParentID) {
				muted[uid] = true
			}
		}
		return memberSnapshot{memberIDs: ids, muted: muted, deepLink: "/channel/" + parentName}
	case ParentConversation:
		c, err := s.conv.GetConversation(ctx, msg.ParentID)
		if err != nil || c == nil {
			return memberSnapshot{}
		}
		ids := make([]string, 0, len(c.ParticipantIDs))
		for _, p := range c.ParticipantIDs {
			if p == msg.AuthorID {
				continue
			}
			ids = append(ids, p)
		}
		return memberSnapshot{memberIDs: ids, muted: map[string]bool{}, deepLink: "/conversation/" + msg.ParentID}
	}
	return memberSnapshot{}
}

// NotifyForMessage emits a notification to every channel/conversation member
// except the author and any user who muted the parent. Errors loading
// recipients are swallowed (logged via the publisher path) — failure to
// notify must never block the underlying message send.
func (s *NotificationService) NotifyForMessage(ctx context.Context, msg *model.Message, parentType string) {
	if msg == nil || msg.System {
		return
	}
	kind := NotificationKindMessage
	if msg.ParentMessageID != "" {
		kind = NotificationKindThreadReply
	}
	if !IsNotifiable(kind) {
		return
	}

	parentName := s.parentDisplayName(ctx, msg.ParentID, parentType)
	authorName := s.userDisplayName(ctx, msg.AuthorID)
	snap := s.loadMemberSnapshot(ctx, msg, parentType, parentName)

	deepLink := snap.deepLink
	if kind == NotificationKindThreadReply {
		deepLink = deepLink + "?thread=" + msg.ParentMessageID + "#msg-" + msg.ParentMessageID
	}

	notif := Notification{
		Kind:       kind,
		Title:      titleFor(kind, parentType, parentName, authorName),
		Body:       previewBody(msg.Body),
		DeepLink:   deepLink,
		ParentID:   msg.ParentID,
		ParentType: parentType,
		MessageID:  msg.ID,
		AuthorID:   msg.AuthorID,
		CreatedAt:  time.Now(),
	}

	// A direct @-mention bypasses mute; @all/@here respect it. The
	// mentions path therefore needs the audience snapshot too — passing
	// it in keeps both paths to a single ListMembers + mute scan.
	mentions := ParseMentions(msg.Body)
	mentionRecipients := s.resolveMentionRecipients(msg, parentType, mentions, snap)

	mentionedSet := make(map[string]bool, len(mentionRecipients))
	for _, uid := range mentionRecipients {
		mentionedSet[uid] = true
	}

	// Audience differs by kind:
	//   - Regular message: every member who didn't mute and isn't
	//     already getting a higher-priority mention.
	//   - Thread reply: scoped to the root author + everyone who has
	//     replied earlier in the thread. A bystander who never opened
	//     the thread does NOT get pinged when an unrelated thread
	//     bubbles new replies — that was a regression where channel
	//     members were being woken up for conversations they're not in.
	var audience []string
	if kind == NotificationKindThreadReply {
		audience = s.resolveThreadRecipients(ctx, msg, parentType, snap)
	} else {
		audience = snap.memberIDs
	}
	for _, uid := range audience {
		if mentionedSet[uid] || snap.muted[uid] {
			continue
		}
		events.Publish(ctx, s.publisher, pubsub.UserChannel(uid), events.EventNotificationNew, notif)
	}

	if len(mentionRecipients) > 0 {
		mentionNotif := notif
		mentionNotif.Kind = NotificationKindMention
		mentionNotif.Title = titleFor(NotificationKindMention, parentType, parentName, authorName)
		for _, uid := range mentionRecipients {
			events.Publish(ctx, s.publisher, pubsub.UserChannel(uid), events.EventNotificationNew, mentionNotif)
		}
	}
}

// resolveMentionRecipients fans the parsed mentions out to user IDs:
//   - explicit user mentions → that user (regardless of mute, but never
//     the author themselves)
//   - @all → every channel/conversation member except the author (respects mute)
//   - @here → online subset of @all (respects mute)
//
// Returned IDs are de-duplicated; ordering is stable: explicit mentions
// first, then @all/@here members in member-list order.
func (s *NotificationService) resolveMentionRecipients(msg *model.Message, parentType string, mentions ParsedMentions, snap memberSnapshot) []string {
	if mentions.Empty() {
		return nil
	}

	out := make([]string, 0)
	seen := make(map[string]bool)
	add := func(uid string) {
		if uid == "" || uid == msg.AuthorID || seen[uid] {
			return
		}
		seen[uid] = true
		out = append(out, uid)
	}

	for _, m := range mentions.Users {
		add(m.UserID)
	}

	if !mentions.All && !mentions.Here {
		return out
	}

	for _, uid := range snap.memberIDs {
		if parentType == ParentChannel && snap.muted[uid] {
			continue
		}
		if mentions.Here && (s.presence == nil || !s.presence.IsOnline(uid)) {
			continue
		}
		add(uid)
	}
	return out
}

// resolveThreadRecipients returns the user IDs that should receive a
// thread-reply notification: the thread root's author plus everyone
// who has already replied in this thread. The current message's author
// is excluded; duplicates are removed.
func (s *NotificationService) resolveThreadRecipients(ctx context.Context, msg *model.Message, parentType string, snap memberSnapshot) []string {
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
	// Pull every message under the parent and filter for the thread.
	// 1000 matches the cap ListThreadMessages uses; threads larger
	// than that are vanishingly rare and the worst case is just that
	// the longest tail of replies doesn't get notified — acceptable
	// while we don't have a parent-message-indexed store query.
	all, _, err := s.messages.ListMessages(ctx, msg.ParentID, "", 1000)
	if err != nil {
		return nil
	}
	var rootAuthor string
	repliers := make([]string, 0)
	seen := make(map[string]bool)
	add := func(dst *[]string, uid string) {
		if uid == "" || uid == msg.AuthorID || seen[uid] || unfollowed[uid] {
			return
		}
		seen[uid] = true
		*dst = append(*dst, uid)
	}
	if parentType == ParentConversation {
		out := make([]string, 0, len(snap.memberIDs))
		for _, uid := range snap.memberIDs {
			add(&out, uid)
		}
		return out
	}
	for _, m := range all {
		switch {
		case m.ID == msg.ParentMessageID:
			if rootAuthor == "" && m.AuthorID != "" && m.AuthorID != msg.AuthorID && !unfollowed[m.AuthorID] {
				rootAuthor = m.AuthorID
				seen[m.AuthorID] = true
			}
		case m.ParentMessageID == msg.ParentMessageID && m.ID != msg.ID:
			add(&repliers, m.AuthorID)
		}
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
		ch, err := s.channels.GetChannel(ctx, parentID)
		if err != nil || ch == nil {
			return parentID
		}
		// Slug is what URLs use, but Name reads more naturally in titles.
		if ch.Slug != "" {
			return ch.Slug
		}
		return ch.Name
	}
	return ""
}

func (s *NotificationService) userDisplayName(ctx context.Context, userID string) string {
	if s.users == nil {
		return userID
	}
	u, err := s.users.GetUser(ctx, userID)
	if err != nil || u == nil {
		return userID
	}
	if u.DisplayName == "" {
		return u.Email
	}
	return u.DisplayName
}

func (s *NotificationService) userMutedChannel(ctx context.Context, userID, channelID string) bool {
	chans, err := s.members.ListUserChannels(ctx, userID)
	if err != nil {
		return false
	}
	for _, c := range chans {
		if c.ChannelID == channelID {
			return c.Muted
		}
	}
	return false
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
func previewBody(body string) string {
	const max = 140
	body = userMentionPattern.ReplaceAllString(body, "@$2")
	body = strings.ReplaceAll(body, "\n", " ")
	if len(body) > max {
		return body[:max-1] + "…"
	}
	return body
}
