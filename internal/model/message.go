package model

import "time"

type Message struct {
	ID              string              `json:"id" dynamodbav:"id"`
	ParentID        string              `json:"parentID" dynamodbav:"parentID"` // channel or conversation ID
	AuthorID        string              `json:"authorID" dynamodbav:"authorID"`
	Body            string              `json:"body" dynamodbav:"body"`
	System          bool                `json:"system,omitempty" dynamodbav:"system,omitempty"`
	ParentMessageID string              `json:"parentMessageID,omitempty" dynamodbav:"parentMessageID,omitempty"` // root message of the thread
	ReplyCount      int                 `json:"replyCount,omitempty" dynamodbav:"replyCount,omitempty"`           // count of replies (only set on root messages)
	Reactions       map[string][]string `json:"reactions,omitempty" dynamodbav:"reactions,omitempty"`             // emoji -> userIDs that reacted
	AttachmentIDs   []string            `json:"attachmentIDs,omitempty" dynamodbav:"attachmentIDs,omitempty"`     // ordered list of attachments referenced by this message
	CreatedAt       time.Time           `json:"createdAt" dynamodbav:"createdAt"`
	EditedAt        *time.Time          `json:"editedAt,omitempty" dynamodbav:"editedAt,omitempty"`
}
