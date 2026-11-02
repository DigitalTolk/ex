package model

import "time"

// ViewModal is the one kind of view: a form in a dialog.
const ViewModal = "modal"

// View is a form an app opens for one person (Slack's modal): a title,
// submit and close labels, and blocks — a message's blocks plus input
// fields. This is the shape the app sends and the person's client draws;
// what ex keeps beside it is StoredView.
type View struct {
	ID              string      `json:"id"`
	Type            string      `json:"type"`
	CallbackID      string      `json:"callback_id,omitempty"`
	Title           TextObject  `json:"title"`
	Submit          *TextObject `json:"submit,omitempty"`
	Close           *TextObject `json:"close,omitempty"`
	Blocks          Blocks      `json:"blocks"`
	PrivateMetadata string      `json:"private_metadata,omitempty"`
	ExternalID      string      `json:"external_id,omitempty"`
	// NotifyOnClose has ex tell the app (view_closed) when the person
	// closes the form without submitting it.
	NotifyOnClose bool `json:"notify_on_close,omitempty"`
	// PreviousViewID / RootViewID place a pushed form in its stack: the
	// form under it, and the first form. Set by ex.
	PreviousViewID string `json:"previous_view_id,omitempty"`
	RootViewID     string `json:"root_view_id,omitempty"`
	// Hash changes with every update; an app's views.update naming an old
	// hash is refused, so two updates can't silently overwrite each other.
	Hash string `json:"hash"`
}

// StoredView is an open form as ex keeps it (in Redis, while it is open):
// the view, whose it is, and which app and click it came from. Submissions
// are checked against it, never against what the browser sends back.
type StoredView struct {
	View      View   `json:"view"`
	WebhookID string `json:"webhookID"`
	UserID    string `json:"userID"`
	ClickID   string `json:"clickID,omitempty"`
	IconEmoji string `json:"iconEmoji,omitempty"`
	// Depth is the form's place in its stack: 0 for the first, 1 for one
	// pushed on it, and so on.
	Depth    int       `json:"depth,omitempty"`
	OpenedAt time.Time `json:"openedAt"`
}

// TriggerRecord is what a trigger_id stands for: one person's click (or
// form submission) on one app, allowing that app to open one form for them
// within seconds. ClickID names the browser tab that clicked.
type TriggerRecord struct {
	WebhookID string `json:"webhookID"`
	UserID    string `json:"userID"`
	ClickID   string `json:"clickID,omitempty"`
	// IconEmoji is the icon the clicked message showed, so the form wears
	// the same face.
	IconEmoji string `json:"iconEmoji,omitempty"`
	// ViewID is the form the interaction came from, when it did: only a
	// trigger from a form can push another form on top of it.
	ViewID string `json:"viewID,omitempty"`
}
