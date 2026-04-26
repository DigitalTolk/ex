package model

import "time"

type ConversationType string

const (
	ConversationTypeDM    ConversationType = "dm"
	ConversationTypeGroup ConversationType = "group"
)

type Conversation struct {
	ID             string           `json:"id" dynamodbav:"id"`
	Type           ConversationType `json:"type" dynamodbav:"type"`
	Name           string           `json:"name,omitempty" dynamodbav:"name,omitempty"` // for groups
	ParticipantIDs []string         `json:"participantIDs" dynamodbav:"participantIDs"`
	CreatedBy      string           `json:"createdBy" dynamodbav:"createdBy"`
	// Activated becomes true once the first message is sent. Until then, the
	// conversation is hidden from non-creator participants.
	Activated bool      `json:"activated" dynamodbav:"activated"`
	CreatedAt time.Time `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
}
