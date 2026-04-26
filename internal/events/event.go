package events

import (
	"encoding/json"
	"fmt"
)

// Event type constants used across the application.
const (
	EventMessageNew      = "message.new"
	EventMessageEdited   = "message.edited"
	EventMessageDeleted  = "message.deleted"
	EventMemberJoined    = "member.joined"
	EventMemberLeft      = "member.left"
	EventChannelUpdated  = "channel.updated"
	EventConversationNew = "conversation.new"
	EventChannelNew      = "channel.new"
	EventChannelArchived = "channel.archived"
	EventChannelRemoved  = "channel.removed" // user was removed from a channel — sent to that user's personal channel
	EventMembersChanged  = "members.changed"
	EventEmojiAdded      = "emoji.added"
	EventEmojiRemoved    = "emoji.removed"
	EventPresenceChanged = "presence.changed"
	EventUserUpdated     = "user.updated"
	EventAttachmentDeleted = "attachment.deleted"
	EventChannelMuted      = "channel.muted"
	EventNotificationNew   = "notification.new"
	EventPing            = "ping"
)

// Event represents a real-time event with a type and JSON payload, delivered
// to clients over WebSocket.
type Event struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// NewEvent creates an Event by marshaling data to JSON.
func NewEvent(eventType string, data any) (*Event, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshal event data: %w", err)
	}
	return &Event{
		Type: eventType,
		Data: raw,
	}, nil
}
