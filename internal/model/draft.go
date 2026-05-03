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
}
