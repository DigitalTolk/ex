package model

import "time"

// ThreadFollow is a per-user override for thread participation.
// Following=true explicitly adds a thread to /threads and thread-reply
// notifications. Following=false suppresses implicit participation from
// authored roots/replies without suppressing direct mentions.
type ThreadFollow struct {
	UserID       string    `json:"userID" dynamodbav:"userID"`
	ParentID     string    `json:"parentID" dynamodbav:"parentID"`
	ParentType   string    `json:"parentType" dynamodbav:"parentType"`
	ThreadRootID string    `json:"threadRootID" dynamodbav:"threadRootID"`
	Following    bool      `json:"following" dynamodbav:"following"`
	UpdatedAt    time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
}
