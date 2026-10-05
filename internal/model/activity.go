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
	// ActivityMention records that a message addressed the user: an explicit
	// @-mention, an @all/@here group mention, or one of their notification
	// keywords. MentionKind says which.
	ActivityMention ActivityType = "mention"
	// ActivityThreadReply records a reply in a thread the user takes part in
	// or follows.
	ActivityThreadReply ActivityType = "thread_reply"
	// ActivityDM records a message in one of the user's direct or group
	// conversations.
	ActivityDM ActivityType = "dm"
	// ActivityChannelAdded records that someone else added the user to a
	// channel.
	ActivityChannelAdded ActivityType = "channel_added"
)

// MentionKind values for ActivityItem.MentionKind on ActivityMention items.
const (
	MentionKindUser    = "user"    // @-mentioned by name
	MentionKindAll     = "all"     // @all / @channel
	MentionKindHere    = "here"    // @here
	MentionKindKeyword = "keyword" // matched one of the user's notification keywords
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
	// ParentMessageID is the thread root when the source message is a thread
	// reply (empty for top-level messages). Replies never render in the main
	// list, so the deep link must open the thread to show them.
	ParentMessageID string `json:"parentMessageID,omitempty"`
	// ChannelSlug is set for channel parents so the client can build a slug URL
	// without resolving the channel; empty for conversations.
	ChannelSlug string `json:"channelSlug,omitempty"`
	// MessagePreview is a short plain-text excerpt of the source message.
	MessagePreview string `json:"messagePreview,omitempty"`
	// ActorID / Emoji are set for ActivityReaction: who reacted and with what.
	ActorID string `json:"actorID,omitempty"`
	Emoji   string `json:"emoji,omitempty"`
	// ActorName is the display name to show instead of resolving ActorID — set
	// for incoming-webhook messages, whose author is a bot sentinel.
	ActorName string `json:"actorName,omitempty"`
	// ParentName snapshots the channel name for ActivityChannelAdded items so
	// the row can render before the client's channel list catches up.
	ParentName string `json:"parentName,omitempty"`
	// ThreadRootID is the root message of the thread for ActivityThreadReply
	// items (and mentions made inside a thread), so the client can open the
	// thread and group several replies into one row.
	ThreadRootID string `json:"threadRootID,omitempty"`
	// MentionKind is one of the MentionKind* values on ActivityMention items.
	MentionKind string `json:"mentionKind,omitempty"`
	// Read reports whether the user has read this item. It is resolved from the
	// user's read state each time the stream is listed, not stored.
	Read bool `json:"read"`
}

// Reminder is a scheduled "remind me about this message" entry. It lives until
// it fires (or is cancelled), at which point it produces an ActivityReminder
// item in the owner's activity stream plus a desktop/mobile alert.
type Reminder struct {
	ID         string `json:"id"`
	UserID     string `json:"userID"`
	MessageID  string `json:"messageID"`
	ParentID   string `json:"parentID"`
	ParentType string `json:"parentType"` // "channel" | "conversation"
	// ParentMessageID is the thread root when the reminded message is a thread
	// reply, taken from the stored message (never the client) at schedule time.
	ParentMessageID string    `json:"parentMessageID,omitempty"`
	ChannelSlug     string    `json:"channelSlug,omitempty"`
	MessagePreview  string    `json:"messagePreview,omitempty"`
	RemindAt        time.Time `json:"remindAt"`
	CreatedAt       time.Time `json:"createdAt"`
}
