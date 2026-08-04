package model

import (
	"strings"
	"time"
)

// ExternalCommand is an admin-registered slash command backed by an HTTP
// integration, in Mattermost's slash-command shape: ex POSTs the invocation to
// RequestURL and posts (or shows) whatever comes back.
//
// It is distinct from ex's built-in commands, which are compiled in and
// registered at wiring time (see service.Command). Both appear in one list to
// clients, so the composer's "/" autocomplete does not care which is which.
type ExternalCommand struct {
	ID string `json:"id" dynamodbav:"id"`
	// Trigger is the word after the slash, without it — "deploy" for "/deploy".
	// Unique across all commands, built-in included, and always lowercase.
	Trigger string `json:"trigger" dynamodbav:"trigger"`
	// Title and Description are what the "/" autocomplete shows.
	Title       string `json:"title,omitempty" dynamodbav:"title,omitempty"`
	Description string `json:"description,omitempty" dynamodbav:"description,omitempty"`
	// AutocompleteHint describes the arguments, e.g. "[service] [version]".
	AutocompleteHint string `json:"autocomplete_hint,omitempty" dynamodbav:"autocompleteHint,omitempty"`
	// RequestURL is the integration endpoint; must be a public https URL.
	RequestURL string `json:"request_url" dynamodbav:"requestURL"`
	// Method is "P" (POST, default) or "G" (GET), matching MM's field.
	Method string `json:"method,omitempty" dynamodbav:"method,omitempty"`
	// Token is the shared secret sent in the request so the integration can
	// verify the call came from this ex instance. Never serialized to clients:
	// it is a credential, and the admin API returns it only at creation.
	Token string `json:"-" dynamodbav:"token"`
	// BotUserID, when set, is the bot account an in-channel response is authored
	// by — so the post has a real bot identity behind it rather than the generic
	// webhook sentinel. Optional.
	BotUserID string `json:"bot_user_id,omitempty" dynamodbav:"botUserID,omitempty"`
	// Username / IconURL override the display identity of an in-channel response,
	// as MM's command config does.
	Username string `json:"username,omitempty" dynamodbav:"username,omitempty"`
	IconURL  string `json:"icon_url,omitempty" dynamodbav:"iconURL,omitempty"`

	CreatedBy string    `json:"created_by" dynamodbav:"createdBy"`
	CreatedAt time.Time `json:"create_at" dynamodbav:"createdAt"`
	UpdatedAt time.Time `json:"update_at" dynamodbav:"updatedAt"`
}

// Command HTTP methods, matching Mattermost's single-letter field.
const (
	CommandMethodPost = "P"
	CommandMethodGet  = "G"
)

// NormalizedMethod resolves the stored method to CommandMethodPost or
// CommandMethodGet, defaulting to POST for an empty or unrecognized value.
func (c *ExternalCommand) NormalizedMethod() string {
	if strings.EqualFold(strings.TrimSpace(c.Method), CommandMethodGet) {
		return CommandMethodGet
	}
	return CommandMethodPost
}
