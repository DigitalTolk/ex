package model

import "time"

// ScheduledMessageState is where a scheduled message stands: waiting for its
// time, or a delivery that could not be made (kept so its text isn't lost).
type ScheduledMessageState string

const (
	ScheduledMessagePending ScheduledMessageState = "pending"
	ScheduledMessageFailed  ScheduledMessageState = "failed"
)

// ScheduledMessage is a message its author composed now to be sent at SendAt —
// into a channel, a conversation, or a thread (ParentMessageID). At SendAt it
// is posted exactly like a normal send (notifications included) and removed.
type ScheduledMessage struct {
	ID              string                `json:"id"`
	UserID          string                `json:"userID"`
	ParentID        string                `json:"parentID"`
	ParentType      string                `json:"parentType"` // "channel" | "conversation"
	ParentMessageID string                `json:"parentMessageID,omitempty"`
	Body            string                `json:"body"`
	AttachmentIDs   []string              `json:"attachmentIDs,omitempty"`
	SendAt          time.Time             `json:"sendAt"`
	State           ScheduledMessageState `json:"state"`
	// FailReason says why a failed delivery couldn't be made.
	FailReason string    `json:"failReason,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}
