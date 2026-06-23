package model

import "time"

type MessageDraft struct {
	ID              string    `json:"id" dynamodbav:"id"`
	UserID          string    `json:"userID" dynamodbav:"userID"`
	ParentID        string    `json:"parentID" dynamodbav:"parentID"`
	ParentType      string    `json:"parentType" dynamodbav:"parentType"`
	ParentMessageID string    `json:"parentMessageID,omitempty" dynamodbav:"parentMessageID,omitempty"`
	Body            string    `json:"body" dynamodbav:"body"`
	AttachmentIDs   []string  `json:"attachmentIDs,omitempty" dynamodbav:"attachmentIDs,omitempty"`
	UpdatedAt       time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
	CreatedAt       time.Time `json:"createdAt" dynamodbav:"createdAt"`
	// Ts is the CLIENT edit-time (epoch ms) used for last-write-wins ordering
	// in the Redis store: a save applies only if its Ts is newer than the
	// stored value's (and any delete tombstone's). It is the time the content
	// was captured on the client — NOT when the request was sent — so a delayed
	// keystroke save can't supersede a later send. Omitted from JSON when zero.
	Ts int64 `json:"ts,omitempty" dynamodbav:"ts,omitempty"`
}
