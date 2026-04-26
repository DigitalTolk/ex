package model

import "time"

// ChannelMembership represents a user's membership in a channel (stored on channel side).
type ChannelMembership struct {
	ChannelID   string      `json:"channelID" dynamodbav:"channelID"`
	UserID      string      `json:"userID" dynamodbav:"userID"`
	Role        ChannelRole `json:"role" dynamodbav:"role"`
	DisplayName string      `json:"displayName" dynamodbav:"displayName"` // denormalized
	JoinedAt    time.Time   `json:"joinedAt" dynamodbav:"joinedAt"`
}

// UserChannel represents a channel from the user's perspective (stored on user side).
type UserChannel struct {
	UserID        string      `json:"userID" dynamodbav:"userID"`
	ChannelID     string      `json:"channelID" dynamodbav:"channelID"`
	ChannelName   string      `json:"channelName" dynamodbav:"channelName"`
	ChannelType   ChannelType `json:"channelType" dynamodbav:"channelType"`
	Role          ChannelRole `json:"role" dynamodbav:"role"`
	JoinedAt      time.Time   `json:"joinedAt" dynamodbav:"joinedAt"`
	LastReadMsgID string      `json:"lastReadMsgID,omitempty" dynamodbav:"lastReadMsgID,omitempty"`
	// Muted suppresses notifications (sound + browser popup) for this
	// channel without unsubscribing the user. Real-time event delivery is
	// unaffected; only the notifier respects this flag.
	Muted bool `json:"muted,omitempty" dynamodbav:"muted,omitempty"`
}

// UserConversation represents a conversation from the user's perspective.
type UserConversation struct {
	UserID         string           `json:"userID" dynamodbav:"userID"`
	ConversationID string           `json:"conversationID" dynamodbav:"conversationID"`
	Type           ConversationType `json:"type" dynamodbav:"type"`
	DisplayName    string           `json:"displayName" dynamodbav:"displayName"` // other user's name for DM, group name for group
	ParticipantIDs []string         `json:"participantIDs" dynamodbav:"participantIDs"`
	CreatedBy      string           `json:"createdBy,omitempty" dynamodbav:"createdBy,omitempty"`
	Activated      bool             `json:"activated" dynamodbav:"activated"`
	JoinedAt       time.Time        `json:"joinedAt" dynamodbav:"joinedAt"`
	LastReadMsgID  string           `json:"lastReadMsgID,omitempty" dynamodbav:"lastReadMsgID,omitempty"`
}
