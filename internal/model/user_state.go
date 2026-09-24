package model

import "time"

type UserStateKind string

const (
	UserStateThreadNotification UserStateKind = "thread_notification"
	UserStateThreadSeen         UserStateKind = "thread_seen"
	UserStateHiddenConversation UserStateKind = "hidden_conversation"
	// UserStateHiddenSkill removes one skill from the "# Workspace skills"
	// discovery index of THIS user's agent runs — a per-user curation knob so
	// a workspace full of skills stays legible. An explicit /skill pick still
	// attaches a hidden skill: hiding is about discovery, not permission.
	UserStateHiddenSkill UserStateKind = "hidden_skill"
)

type UserStateItem struct {
	UserID       string        `json:"userID" dynamodbav:"userID"`
	Kind         UserStateKind `json:"kind" dynamodbav:"kind"`
	TargetID     string        `json:"targetID" dynamodbav:"targetID"`
	ParentID     string        `json:"parentID,omitempty" dynamodbav:"parentID,omitempty"`
	ParentType   string        `json:"parentType,omitempty" dynamodbav:"parentType,omitempty"`
	ThreadRootID string        `json:"threadRootID,omitempty" dynamodbav:"threadRootID,omitempty"`
	SeenAt       *time.Time    `json:"seenAt,omitempty" dynamodbav:"seenAt,omitempty"`
	UpdatedAt    time.Time     `json:"updatedAt" dynamodbav:"updatedAt"`
}

type UserState struct {
	ThreadNotifications []string          `json:"threadNotifications"`
	ThreadSeen          map[string]string `json:"threadSeen"`
	HiddenConversations []string          `json:"hiddenConversations"`
	HiddenSkills        []string          `json:"hiddenSkills"`
}
