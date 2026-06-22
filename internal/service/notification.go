package service

import (
	"context"
	"log/slog"
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
	// webhook (CI alerts, deploy bots, etc.). These are external/automated
	// posts the user explicitly wired up, so the client treats them as
	// always-notifiable: it bypasses both the own-author suppression (the
	// "author" is just the webhook's creator, not a real sender) and the
	// "channel messages are quiet" rule that mutes ordinary chatter.
	Webhook   bool      `json:"webhook,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// PresenceLookup is the slice of PresenceService NotificationService cares
// about. Defined as an interface so the dependency is explicit and tests
// can stub it without instantiating the real presence tracker.
type PresenceLookup interface {
	IsOnline(userID string) bool
}

type MobilePushSender interface {
	Send(ctx context.Context, recipientUserID string, n Notification) error
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
	userState *UserStateService
	push      MobilePushSender
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

func (s *NotificationService) SetUserStateService(userState *UserStateService) {
	s.userState = userState
}

func (s *NotificationService) SetMobilePushSender(push MobilePushSender) {
	s.push = push
}

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
func (s *NotificationService) loadMemberSnapshot(ctx context.Context, msg *model.Message, parentType, parentName string) memberSnapshot {
	// Webhook posts notify everyone, including the webhook's creator —
	// the creator wired up the integration to be alerted, they didn't
	// write the message. So there's no "author" to exclude.
	excludeID := msg.AuthorID
	if msg.WebhookUsername != "" {
		excludeID = ""
	}
	switch parentType {
	case ParentChannel:
		members, err := s.members.ListMembers(ctx, msg.ParentID)
		if err != nil {
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
		c, err := s.conv.GetConversation(ctx, msg.ParentID)
		if err != nil || c == nil {
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
func (s *NotificationService) NotifyForMessage(ctx context.Context, msg *model.Message, parentType string) {
	if msg == nil || msg.System {
		return
	}
	kind := NotificationKindMessage
	if msg.ParentMessageID != "" {
		kind = NotificationKindThreadReply
	}
	if !IsNotifiable(kind) { // coverage-ignore: kind is set above to either NotificationKindMessage or NotificationKindThreadReply, both of which are in notifiableKinds; this guard is defensive against a future kind that is not notifiable.
		return
	}

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
		for _, uid := range snap.memberIDs {
			if mentions.Here && (s.presence == nil || !s.presence.IsOnline(uid)) {
				continue
			}
			groupSet[uid] = true
		}
	}

	// Thread replies are scoped to participants (root author + prior repliers +
	// explicit followers), expanded with anyone whose preferences enable
	// "follow all threads". A bystander who never opened the thread and didn't
	// opt into follow-all is not pinged for unrelated thread chatter.
	threadParticipants := make(map[string]bool)
	if isThreadReply && parentType == ParentChannel {
		for _, uid := range s.resolveThreadRecipients(ctx, msg, parentType, snap) {
			threadParticipants[uid] = true
		}
		for uid, eff := range snap.prefs {
			if eff.FollowAllThreads {
				threadParticipants[uid] = true
			}
		}
	}

	// Incoming-webhook posts are integrations the user explicitly wired up to
	// be alerted on, so they notify every (non-muted) member regardless of the
	// quiet "mentions only" level — the same always-notifiable treatment the
	// client gives the Webhook flag.
	isWebhook := msg.WebhookUsername != ""

	for _, uid := range snap.memberIDs {
		eff := snap.prefs[uid]
		r := recipientReasons{
			explicitMention:   explicitSet[uid],
			groupMention:      groupSet[uid] && !eff.IgnoreGroupMentions,
			muted:             snap.muted[uid],
			forceAll:          isWebhook,
			threadReply:       isThreadReply,
			threadParticipant: parentType == ParentConversation || threadParticipants[uid],
			threadReplies:     eff.ThreadReplies,
			keyword:           matchesKeywords(msg.Body, eff.Keywords),
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

		notif := baseNotif
		mentioned := r.explicitMention || r.groupMention
		if mentioned {
			notif = mentionNotif
		}

		// Mirror the unread-indicator marking the previous notifier did:
		// thread replies mark the thread; channel mentions mark the channel.
		if isThreadReply {
			s.markThreadNotification(ctx, uid, msg, parentType)
		} else if mentioned && parentType == ParentChannel {
			s.markChannelNotification(ctx, uid, msg.ParentID)
		}

		if desktop {
			events.Publish(ctx, s.publisher, pubsub.UserChannel(uid), events.EventNotificationNew, notif)
		}
		if mobile {
			s.sendMobilePush(ctx, uid, notif)
		}
	}
}

// recipientReasons captures, for one recipient and one message, the precomputed
// signals eligibleAtLevel needs. Keeping it a plain struct makes the decision a
// pure function that is trivial to unit-test across the level matrix.
type recipientReasons struct {
	explicitMention   bool // @-mentioned by user id (bypasses mute + level)
	groupMention      bool // @all/@here applies after the ignore preference
	muted             bool // channel muted (suppresses everything but explicit @)
	forceAll          bool // webhook post — notify every non-muted member regardless of level
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
	if r.forceAll {
		return true
	}
	if r.groupMention {
		return true
	}
	if r.threadReply {
		if !r.threadParticipant {
			return false
		}
		if level == model.NotificationLevelAll {
			return true
		}
		return r.threadReplies || r.keyword
	}
	if level == model.NotificationLevelAll {
		return true
	}
	return r.keyword
}

func (s *NotificationService) sendMobilePush(ctx context.Context, recipientUserID string, notif Notification) {
	if s.push == nil {
		return
	}
	// Don't double-notify. A user with any live WebSocket connection already
	// receives the in-app banner published just above, so a parallel push
	// would land a second alert on the same device (native push + in-app on
	// the mobile app) or a redundant ping on another. Push therefore targets
	// only users who are offline — app backgrounded/closed, so the socket has
	// dropped — matching the Slack/Mattermost model. IsOnline is Redis-backed,
	// so the check holds across every backend instance and device.
	if s.presence != nil && s.presence.IsOnline(recipientUserID) {
		return
	}
	if err := s.push.Send(ctx, recipientUserID, notif); err != nil {
		slog.Warn(
			"mobile push send failed",
			"userID", recipientUserID,
			"parentID", notif.ParentID,
			"parentType", notif.ParentType,
			"messageID", notif.MessageID,
			"kind", notif.Kind,
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

func (s *NotificationService) markChannelNotification(ctx context.Context, userID, channelID string) {
	if s.userState == nil {
		return
	}
	if err := s.userState.MarkChannelNotificationUnread(ctx, userID, channelID); err != nil {
		slog.Warn("channel notification state failed", "channelID", channelID, "userID", userID, "error", err)
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
	lower := strings.ToLower(body)
	for _, kw := range keywords {
		kw = strings.ToLower(strings.TrimSpace(kw))
		if kw == "" {
			continue
		}
		if containsWord(lower, kw) {
			return true
		}
	}
	return false
}

// containsWord reports whether needle appears in haystack bounded by non-word
// characters on both sides (a lightweight \bneedle\b without compiling a regex
// per keyword per message). Both arguments are expected to be lowercased.
func containsWord(haystack, needle string) bool {
	from := 0
	for {
		idx := strings.Index(haystack[from:], needle)
		if idx < 0 {
			return false
		}
		start := from + idx
		end := start + len(needle)
		if wordBoundary(haystack, start-1) && wordBoundary(haystack, end) {
			return true
		}
		from = start + 1
	}
}

// wordBoundary reports whether position i in s is a word boundary — i.e. out of
// range or a non-[a-z0-9_] byte. Used by containsWord on already-lowercased
// strings, so only ASCII word bytes need checking.
func wordBoundary(s string, i int) bool {
	if i < 0 || i >= len(s) {
		return true
	}
	c := s[i]
	isWord := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'
	return !isWord
}

// resolveThreadRecipients returns the user IDs that should receive a
// thread-reply notification: the thread root's author plus everyone
// who has already replied in this thread. The current message's author
// is excluded; duplicates are removed.
func (s *NotificationService) resolveThreadRecipients(ctx context.Context, msg *model.Message, _ string, snap memberSnapshot) []string {
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
	currentMembers := make(map[string]bool, len(snap.memberIDs))
	for _, uid := range snap.memberIDs {
		currentMembers[uid] = true
	}
	// resolveThreadRecipients is only ever called for channel parents now —
	// conversations always notify every participant, so NotifyForMessage
	// short-circuits them without scoping to thread participation.
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
	for _, m := range all {
		switch {
		case m.ID == msg.ParentMessageID:
			if rootAuthor == "" && m.AuthorID != "" && m.AuthorID != msg.AuthorID && !unfollowed[m.AuthorID] && currentMembers[m.AuthorID] {
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
		if a.Fallback != "" {
			return a.Fallback
		}
	}
	return ""
}

func previewBody(body string) string {
	const max = 140
	body = userMentionPattern.ReplaceAllString(body, "@$2")
	body = strings.ReplaceAll(body, "\n", " ")
	if len(body) > max {
		return body[:max-1] + "…"
	}
	return body
}
