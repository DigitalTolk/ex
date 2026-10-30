package model

import "time"

type IncomingWebhook struct {
	ID              string    `json:"id" dynamodbav:"id"`
	Title           string    `json:"title" dynamodbav:"title"`
	Description     string    `json:"description,omitempty" dynamodbav:"description,omitempty"`
	ChannelID       string    `json:"channelID" dynamodbav:"channelID"`
	ChannelName     string    `json:"channelName,omitempty" dynamodbav:"channelName,omitempty"`
	ChannelSlug     string    `json:"channelSlug,omitempty" dynamodbav:"channelSlug,omitempty"`
	LockToChannel   bool      `json:"lockToChannel" dynamodbav:"lockToChannel"`
	Username        string    `json:"username,omitempty" dynamodbav:"username,omitempty"`
	ProfileImageURL string    `json:"profileImageURL,omitempty" dynamodbav:"profileImageURL,omitempty"`
	CreatedBy       string    `json:"createdBy" dynamodbav:"createdBy"`
	CreatedAt       time.Time `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt" dynamodbav:"updatedAt"`

	// Interactivity: an app that gets the clicks on its messages' buttons.
	// InteractivityURL is where ex sends them; empty means the webhook only
	// posts.
	InteractivityURL string `json:"interactivityURL,omitempty" dynamodbav:"interactivityURL,omitempty"`
	// EmailSharing adds the clicker's email to what the app receives. Only a
	// workspace admin turns it on.
	EmailSharing bool `json:"emailSharing,omitempty" dynamodbav:"emailSharing,omitempty"`
	// AdminPaused stops the app's buttons everywhere until an admin resumes
	// them.
	AdminPaused bool `json:"adminPaused,omitempty" dynamodbav:"adminPaused,omitempty"`
	// BotTokenHash is the SHA-256 of the app's bot token (the token itself is
	// shown once and never stored). PrevBotTokenHash stays valid until
	// PrevBotTokenUntil, so a rotation needs no downtime.
	BotTokenHash      string     `json:"-" dynamodbav:"botTokenHash,omitempty"`
	PrevBotTokenHash  string     `json:"-" dynamodbav:"prevBotTokenHash,omitempty"`
	PrevBotTokenUntil *time.Time `json:"-" dynamodbav:"prevBotTokenUntil,omitempty"`
	// SecretVersion names the current signing secret, which is derived from
	// the server's key and never stored (0: none issued yet). The version
	// before it keeps signing alongside until PrevSecretUntil.
	SecretVersion   int        `json:"-" dynamodbav:"secretVersion,omitempty"`
	PrevSecretUntil *time.Time `json:"-" dynamodbav:"prevSecretUntil,omitempty"`
	// HasBotToken and HasSigningSecret tell the webhooks panel what has been
	// issued, without the values.
	HasBotToken      bool `json:"hasBotToken,omitempty" dynamodbav:"-"`
	HasSigningSecret bool `json:"hasSigningSecret,omitempty" dynamodbav:"-"`
}

// Present fills the fields the webhooks panel shows instead of the secrets.
func (w *IncomingWebhook) Present() *IncomingWebhook {
	w.HasBotToken = w.BotTokenHash != ""
	w.HasSigningSecret = w.SecretVersion > 0
	return w
}
