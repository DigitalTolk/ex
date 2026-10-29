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
	// LastActivityAt is the thread's latest reply (its root's time while it
	// has none): where a followed thread sorts in the user's /threads list.
	LastActivityAt *time.Time `json:"lastActivityAt,omitempty" dynamodbav:"lastActivityAt,omitempty"`
}

// ThreadRef names one thread: its parent and its root message.
type ThreadRef struct {
	ParentID     string `json:"parentID"`
	ThreadRootID string `json:"threadRootID"`
}
