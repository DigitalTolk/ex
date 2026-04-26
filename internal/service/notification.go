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
	CreatedAt  time.Time        `json:"createdAt"`
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
}

// NewNotificationService builds a NotificationService.
func NewNotificationService(p Publisher, m MembershipStore, c ConversationStore, ch ChannelStore, u UserStore) *NotificationService {
	return &NotificationService{publisher: p, members: m, conv: c, channels: ch, users: u}
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

	recipients, deepLink := s.recipientsAndLink(ctx, msg, parentType, parentName)
	if len(recipients) == 0 {
		return
	}

	notif := Notification{
		Kind:       kind,
		Title:      titleFor(kind, parentType, parentName, authorName),
		Body:       previewBody(msg.Body),
		DeepLink:   deepLink,
		ParentID:   msg.ParentID,
		ParentType: parentType,
		MessageID:  msg.ID,
		CreatedAt:  time.Now(),
	}
	for _, uid := range recipients {
		events.Publish(ctx, s.publisher, pubsub.UserChannel(uid), events.EventNotificationNew, notif)
	}
}

// recipientsAndLink resolves who should receive an alert and where the
// notification click should land them. Author is always excluded; muted
// channel members are excluded for channel notifications.
func (s *NotificationService) recipientsAndLink(ctx context.Context, msg *model.Message, parentType, parentName string) ([]string, string) {
	switch parentType {
	case ParentChannel:
		members, err := s.members.ListMembers(ctx, msg.ParentID)
		if err != nil {
			return nil, ""
		}
		// Look up each member's UserChannel to honor mute. ListUserChannels
		// is per-user, so we walk it once for each member — fine for the
		// small workspaces this app targets. For larger scale this would
		// move to a single batched query.
		out := make([]string, 0, len(members))
		for _, m := range members {
			if m.UserID == msg.AuthorID {
				continue
			}
			if s.userMutedChannel(ctx, m.UserID, msg.ParentID) {
				continue
			}
			out = append(out, m.UserID)
		}
		// channelName is the slug-ish display; the frontend route uses slug
		// derived from name, but ParentID is also accepted as a fallback.
		link := "/channel/" + parentName
		return out, link
	case ParentConversation:
		c, err := s.conv.GetConversation(ctx, msg.ParentID)
		if err != nil || c == nil {
			return nil, ""
		}
		out := make([]string, 0, len(c.ParticipantIDs))
		for _, p := range c.ParticipantIDs {
			if p == msg.AuthorID {
				continue
			}
			out = append(out, p)
		}
		link := "/conversation/" + msg.ParentID
		return out, link
	}
	return nil, ""
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
			return authorName + " replied in #" + parentName
		}
		return authorName + " replied"
	case NotificationKindMessage:
		if parentType == ParentChannel {
			return authorName + " in #" + parentName
		}
		return authorName
	default:
		return authorName
	}
}

// previewBody clamps a message body to a sane length for a notification
// preview and strips newlines so the OS-level popup renders on one line.
func previewBody(body string) string {
	const max = 140
	body = strings.ReplaceAll(body, "\n", " ")
	if len(body) > max {
		return body[:max-1] + "…"
	}
	return body
}
