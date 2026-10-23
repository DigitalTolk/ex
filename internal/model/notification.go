package model

import "time"

// NotificationKind tags a notification with its semantic class so the client
// can apply different sounds, copy, and grouping rules without a large
// payload-shape switch on the receiver. Adding a new kind here is the
// single place a new notification flavor is registered.
type NotificationKind string

const (
	NotificationKindMessage     NotificationKind = "message"
	NotificationKindMention     NotificationKind = "mention"
	NotificationKindThreadReply NotificationKind = "thread_reply"
	// NotificationKindReminder is a self-set "remind me about this message"
	// alert firing at its scheduled time. Always notifiable — the user
	// explicitly asked to be alerted, so no gating applies.
	NotificationKindReminder NotificationKind = "reminder"
	// NotificationKindApproval fires when an agent the user invoked needs their
	// decision (request_approval / ask_user). It blocks the run until answered,
	// so it's always notifiable and the client renders it distinctly (it's an
	// action the user must take, not just something to read).
	NotificationKindApproval NotificationKind = "approval"
	// NotificationKindCatchUp fires when a watcher accumulated an OFFLINE
	// backlog on a local CLI harness and needs the creator's go-ahead to
	// process it (their machine, their tokens). Always notifiable — it waits
	// for a decision.
	NotificationKindCatchUp NotificationKind = "catchup"
)

// Notification is the user-facing alert payload of a `notification.new`
// frame, delivered over the same WebSocket pipe as state events (and, as the
// mobile-push fallback, through the push scheduler). It is intentionally
// minimal — title, body, where to go on click, and a stable client-side
// de-dup key. It lives in model so tygo mirrors it into src/types/generated.ts.
type Notification struct {
	Kind       NotificationKind `json:"kind"`
	Title      string           `json:"title"`
	Body       string           `json:"body"`
	DeepLink   string           `json:"deepLink"`
	ParentID   string           `json:"parentID"`   // channel/conversation ID
	ParentType string           `json:"parentType"` // "channel" | "conversation"
	MessageID  string           `json:"messageID,omitempty"`
	// AlertID identifies the alert itself when one message can legitimately
	// alert more than once — a fired reminder is a NEW alert about a message
	// the user may already have been notified about (or reminded of before).
	// When set it replaces MessageID as the delivery key (client dedup,
	// desktop ack, push idempotency); otherwise those stay keyed by MessageID.
	AlertID         string `json:"alertID,omitempty"`
	ParentMessageID string `json:"parentMessageID,omitempty"`
	// AuthorID is the message's author, for the client's own-author echo
	// suppression. A webhook post carries the "webhook" sentinel here, never
	// the webhook's creator.
	AuthorID string `json:"authorID,omitempty"`
	// Webhook marks a notification that originated from an incoming
	// webhook (CI alerts, deploy bots, etc.). The "author" is the webhook,
	// not a real sender, so the client exempts these from its own-author
	// echo suppression. Whether to notify at all is decided server-side by
	// the recipient's notification level, exactly like a regular message.
	Webhook   bool      `json:"webhook,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	// ParentUnreadNotifyCount is the recipient's authoritative alerted-unread
	// badge for the parent AFTER this notification (top-level messages only;
	// thread replies never touch parent counters). Clients SET their sidebar
	// badge to this value — never increment locally — so replayed or
	// duplicated events can't drift the count.
	ParentUnreadNotifyCount int64 `json:"parentUnreadNotifyCount,omitempty"`
}

// DeliveryKey is the identity the desktop ack and the mobile-push
// idempotency key on: the AlertID when set, else the MessageID. The client
// dedups and acks on the same key, so both sides always agree.
func (n Notification) DeliveryKey() string {
	if n.AlertID != "" {
		return n.AlertID
	}
	return n.MessageID
}
