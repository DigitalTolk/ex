package model

import "time"

type UserStateKind string

const (
	UserStateChannelNotification UserStateKind = "channel_notification"
	UserStateThreadNotification  UserStateKind = "thread_notification"
	UserStateThreadSeen          UserStateKind = "thread_seen"
	UserStateHiddenConversation  UserStateKind = "hidden_conversation"
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
	ChannelNotifications []string          `json:"channelNotifications"`
	ThreadNotifications  []string          `json:"threadNotifications"`
	ThreadSeen           map[string]string `json:"threadSeen"`
	HiddenConversations  []string          `json:"hiddenConversations"`
}
