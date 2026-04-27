package model

import "time"

// CustomEmoji represents a workspace-uploaded custom emoji that can be
// referenced in messages or reactions as :name:.
//
// ImageKey is the persistent S3 key. The service re-signs ImageURL on
// every List call from the key so the frontend never has to deal with
// expired presigned URLs (the bug where custom emojis broke after 7
// days). ImageURL is sent to clients but not relied on for storage.
type CustomEmoji struct {
	Name      string    `json:"name" dynamodbav:"name"`
	ImageURL  string    `json:"imageURL" dynamodbav:"imageURL"`
	ImageKey  string    `json:"-" dynamodbav:"imageKey,omitempty"`
	CreatedBy string    `json:"createdBy" dynamodbav:"createdBy"`
	CreatedAt time.Time `json:"createdAt" dynamodbav:"createdAt"`
}
