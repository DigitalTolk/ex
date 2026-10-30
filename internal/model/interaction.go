package model

import "time"

// ResponseURLRecord is what a response_url stands for: one interaction's
// message, its app and its clicker. Kept only for the URL's short life.
type ResponseURLRecord struct {
	WebhookID  string `json:"webhookID"`
	ParentID   string `json:"parentID"`
	ParentType string `json:"parentType"`
	MessageID  string `json:"messageID"`
	UserID     string `json:"userID"`
}

// Interaction kinds and results, as the webhooks panel's history lists them.
const (
	InteractionClick       = "click"
	InteractionResponseURL = "response_url"
	InteractionTest        = "test"
	// InteractionSubmission is a form submitted to the app; InteractionAPI
	// is a call the app made to ex (ActionID names the method).
	InteractionSubmission = "view_submission"
	InteractionAPI        = "api"

	InteractionOK      = "ok"
	InteractionFailed  = "failed"
	InteractionTimeout = "timeout"
)

// InteractionEntry is one line of an app's interaction history: a click or a
// form sent to it, a use of a response_url, a call it made, or a test.
type InteractionEntry struct {
	At        time.Time `json:"at"`
	Kind      string    `json:"kind"`
	UserID    string    `json:"userID,omitempty"`
	ActionID  string    `json:"actionID,omitempty"`
	Result    string    `json:"result"`
	Status    int       `json:"status,omitempty"`
	LatencyMs int64     `json:"latencyMs"`
	Error     string    `json:"error,omitempty"`
}
