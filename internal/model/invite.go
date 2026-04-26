package model

import "time"

type Invite struct {
	Token      string   `json:"token" dynamodbav:"token"`
	Email      string   `json:"email" dynamodbav:"email"`
	InviterID  string   `json:"inviterID" dynamodbav:"inviterID"`
	ChannelIDs []string `json:"channelIDs,omitempty" dynamodbav:"channelIDs,omitempty"`
	ExpiresAt  time.Time `json:"expiresAt" dynamodbav:"expiresAt"`
	CreatedAt  time.Time `json:"createdAt" dynamodbav:"createdAt"`
}
