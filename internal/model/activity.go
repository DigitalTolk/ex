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

// MentionKind says how an ActivityMention item addressed the user.
type MentionKind string

const (
	MentionKindUser    MentionKind = "user"    // @-mentioned by name
	MentionKindAll     MentionKind = "all"     // @all / @channel
	MentionKindHere    MentionKind = "here"    // @here
	MentionKindKeyword MentionKind = "keyword" // matched one of the user's notification keywords
)

// ActivityItem is one entry in a user's personal activity stream (Slack-style
// Activity tab). It is a denormalized hint: it carries enough context (preview
// + parent + message id) to render a row and deep-link to the source message
// without further lookups. It follows its message: deleting the message removes
// the item, editing it refreshes the preview, and losing access to the parent
// removes the parent's items.
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
	// ActorID is who acted: the reactor, the message author, or who added the
	// user to a channel. Emoji is set for ActivityReaction.
	ActorID string `json:"actorID,omitempty"`
	Emoji   string `json:"emoji,omitempty"`
	// ActorName is the display name to show instead of resolving ActorID — set
	// for incoming-webhook messages, whose author is a bot sentinel.
	ActorName string `json:"actorName,omitempty"`
	// Webhook marks an item whose actor is an incoming webhook: ActorName is the
	// name the webhook chose for itself, so it must render as a bot, never as
	// a person.
	Webhook bool `json:"webhook,omitempty"`
	// ParentName snapshots the channel name for ActivityChannelAdded items so
	// the row can render before the client's channel list catches up.
	ParentName string `json:"parentName,omitempty"`
	// MentionKind is set on ActivityMention items.
	MentionKind MentionKind `json:"mentionKind,omitempty"`
}

// ActivityFeedItem is an ActivityItem as listed to its owner: the stored item
// plus its read state, which is resolved from the owner's read state at list
// time rather than stored with the item.
type ActivityFeedItem struct {
	ActivityItem `tstype:",extends"`
	Read         bool `json:"read"`
}

// ActivityFeed is a user's activity stream as returned to their client,
// newest first. Unread counts every unread item; UnreadByType splits that count
// by item type.
type ActivityFeed struct {
	Items        []*ActivityFeedItem  `json:"items"`
	Unread       int                  `json:"unread"`
	UnreadByType map[ActivityType]int `json:"unreadByType"`
}

// ActivityNewEvent is the activity.new payload: the item that just arrived in
// the user's stream, with its read state (it can arrive already read when the
// user read past its message before the item was written).
type ActivityNewEvent struct {
	Item *ActivityFeedItem `json:"item"`
}

// ActivityChangedEvent is the activity.read payload: what changed in the
// user's stream. One group is set per event:
//
//   - All: every item was marked read.
//   - IDs + Read: these items were marked read or unread.
//   - Removed: these items are gone — removed by the user, deleted with their
//     message, or dropped when the user lost access to the parent.
//   - Updated: these items' previews changed (their message was edited).
//   - ParentID (+ ThreadRootID): the user read, or marked unread, part of that
//     channel, conversation or thread, so items there may have flipped.
//
// Reminders may accompany any of them (or stand alone): the user's pending
// reminders changed — one was scheduled or cancelled, or one lost its message
// or channel, or its preview changed with an edit.
type ActivityChangedEvent struct {
	All          bool     `json:"all,omitempty"`
	IDs          []string `json:"ids,omitempty"`
	Read         *bool    `json:"read,omitempty"`
	Removed      []string `json:"removed,omitempty"`
	Updated      []string `json:"updated,omitempty"`
	ParentID     string   `json:"parentID,omitempty"`
	ThreadRootID string   `json:"threadRootID,omitempty"`
	Reminders    bool     `json:"reminders,omitempty"`
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
