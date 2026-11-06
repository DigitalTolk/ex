package model

import "time"

// BotAccount is a bot as the admin API lists it: the bot accounts admins
// create, and the ones migrated from Mattermost. The bots behind incoming
// webhooks belong to their webhooks and are not listed.
type BotAccount struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Description string `json:"description"`
	// OwnerID is the admin who created the bot; empty for a migrated one.
	OwnerID string `json:"ownerID"`
	// Status is "active" or "deactivated" (a disabled bot).
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// BotToken is an access token a bot authenticates the Mattermost-compatible
// API (/api/v4) with. Only the SHA-256 of the secret is stored: the secret is
// shown once, when the token is made, and cannot be read back.
type BotToken struct {
	ID          string    `json:"id" dynamodbav:"id"`
	BotUserID   string    `json:"botUserID" dynamodbav:"botUserID"`
	Description string    `json:"description" dynamodbav:"description"`
	CreatedBy   string    `json:"createdBy" dynamodbav:"createdBy"`
	CreatedAt   time.Time `json:"createdAt" dynamodbav:"createdAt"`
	TokenHash   string    `json:"-" dynamodbav:"tokenHash"`
}

// BotTokenIssued answers the request that made a token: the record, and the
// secret, which is never shown again.
type BotTokenIssued struct {
	Token  BotToken `json:"token"`
	Secret string   `json:"secret"`
}
