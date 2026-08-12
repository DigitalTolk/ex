// Audience resolution and the per-message alert fan-out: who gets told
// about a message, at which level, and the NotifyForMessage entry point
// that plans and publishes every desktop alert + schedules every mobile
// push. Split out of notification.go (2026-08-12) — one file per concern;
// the service type and its wiring stay in notification.go.

package service

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/cenkalti/backoff/v5"
)

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
