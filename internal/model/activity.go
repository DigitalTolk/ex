package model

import "time"

// ActivityType discriminates the kinds of entries in a user's activity stream.
type ActivityType string

const (
	// ActivityReaction records that someone added an emoji reaction to one of
	// the user's own messages.
	ActivityReaction ActivityType = "reaction"
	// ActivityReminder records a "remind me about this message" reminder that
	// has fired at its scheduled time.
	ActivityReminder ActivityType = "reminder"
)

// ActivityItem is one entry in a user's personal activity stream (Slack-style
// Activity tab). It is a denormalized, self-contained hint: it carries enough
// context (preview + parent + message id) to render a row and deep-link to the
// source message without any further lookups, so the stream survives even if the
// underlying message is later edited or deleted.
type ActivityItem struct {
	ID         string       `json:"id"`
	Type       ActivityType `json:"type"`
	CreatedAt  time.Time    `json:"createdAt"`
	MessageID  string       `json:"messageID"`
	ParentID   string       `json:"parentID"`
	ParentType string       `json:"parentType"` // "channel" | "conversation"
	// ChannelSlug is set for channel parents so the client can build a slug URL
	// without resolving the channel; empty for conversations.
	ChannelSlug string `json:"channelSlug,omitempty"`
	// MessagePreview is a short plain-text excerpt of the source message.
	MessagePreview string `json:"messagePreview,omitempty"`
	// ActorID / Emoji are set for ActivityReaction: who reacted and with what.
	ActorID string `json:"actorID,omitempty"`
	Emoji   string `json:"emoji,omitempty"`
}

// Reminder is a scheduled "remind me about this message" entry. It lives until
// it fires (or is cancelled), at which point it produces an ActivityReminder
// item in the owner's activity stream plus a desktop/mobile alert.
type Reminder struct {
	ID             string    `json:"id"`
	UserID         string    `json:"userID"`
	MessageID      string    `json:"messageID"`
	ParentID       string    `json:"parentID"`
	ParentType     string    `json:"parentType"` // "channel" | "conversation"
	ChannelSlug    string    `json:"channelSlug,omitempty"`
	MessagePreview string    `json:"messagePreview,omitempty"`
	RemindAt       time.Time `json:"remindAt"`
	CreatedAt      time.Time `json:"createdAt"`
}
