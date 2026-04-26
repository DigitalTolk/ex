package model

import "time"

// CustomEmoji represents a workspace-uploaded custom emoji that can be
// referenced in messages or reactions as :name:.
type CustomEmoji struct {
	Name      string    `json:"name" dynamodbav:"name"`
	ImageURL  string    `json:"imageURL" dynamodbav:"imageURL"`
	ImageKey  string    `json:"-" dynamodbav:"imageKey,omitempty"`
	CreatedBy string    `json:"createdBy" dynamodbav:"createdBy"`
	CreatedAt time.Time `json:"createdAt" dynamodbav:"createdAt"`
}
