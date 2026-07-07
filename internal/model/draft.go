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
	// Gen is the SERVER-assigned generation token for optimistic concurrency:
	// every accepted write mints a new one, and a save or clear is accepted
	// only when the client presents the generation it acted on (empty = "no
	// draft exists"). Ordering is decided entirely server-side — client
	// clocks play no part — so a delayed, stale, or hostile client write can
	// never supersede a later clear or send. Pre-gen rows report "legacy".
	Gen string `json:"gen"`
}
