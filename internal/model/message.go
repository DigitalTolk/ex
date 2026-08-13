package model

import (
	"encoding/json"
	"time"
)

type Message struct {
	ID         string `json:"id" dynamodbav:"id"`
	ParentID   string `json:"parentID" dynamodbav:"parentID"` // channel or conversation ID
	ParentType string `json:"parentType,omitempty" dynamodbav:"-"`
	AuthorID   string `json:"authorID" dynamodbav:"authorID"`
	Body       string `json:"body" dynamodbav:"body"`
	System     bool   `json:"system,omitempty" dynamodbav:"system,omitempty"`
	// NoIndex keeps the message out of the search index (live indexing AND
	// admin reindex) — for machine-posted ephemera like /mstmeetings join
	// links, where a stale meeting URL surfacing in search is noise. Internal
	// only, never serialized to clients.
	NoIndex         bool       `json:"-" dynamodbav:"noIndex,omitempty"`
	ParentMessageID string     `json:"parentMessageID,omitempty" dynamodbav:"parentMessageID,omitempty"` // root message of the thread
	ReplyCount      int        `json:"replyCount,omitempty" dynamodbav:"replyCount,omitempty"`           // count of replies (only set on root messages)
	LastReplyAt     *time.Time `json:"lastReplyAt,omitempty" dynamodbav:"lastReplyAt,omitempty"`         // timestamp of the latest reply (only set on root messages)
	// RecentReplyAuthorIDs holds up to 3 most-recent distinct author IDs
	// for the thread, newest first. Used by the client to render an
	// avatar stack on the thread-action bar without re-fetching the full
	// thread. Only set on root messages.
	RecentReplyAuthorIDs []string            `json:"recentReplyAuthorIDs,omitempty" dynamodbav:"recentReplyAuthorIDs,omitempty"`
	Reactions            map[string][]string `json:"reactions,omitempty" dynamodbav:"reactions,omitempty"`         // emoji -> userIDs that reacted
	AttachmentIDs        []string            `json:"attachmentIDs,omitempty" dynamodbav:"attachmentIDs,omitempty"` // ordered list of attachments referenced by this message
	Pinned               bool                `json:"pinned,omitempty" dynamodbav:"pinned,omitempty"`               // pinned to the parent (channel/conversation)
	PinnedAt             *time.Time          `json:"pinnedAt,omitempty" dynamodbav:"pinnedAt,omitempty"`
	PinnedBy             string              `json:"pinnedBy,omitempty" dynamodbav:"pinnedBy,omitempty"`
	CreatedAt            time.Time           `json:"createdAt" dynamodbav:"createdAt"`
	EditedAt             *time.Time          `json:"editedAt,omitempty" dynamodbav:"editedAt,omitempty"`
	// Deleted is set on soft-delete: the row stays in the list so the
	// thread structure (replies referencing this ID) is preserved, but
	// Body / AttachmentIDs / Reactions are cleared and the client
	// renders a "(Message deleted)" placeholder.
	Deleted bool `json:"deleted,omitempty" dynamodbav:"deleted,omitempty"`
	// NoUnfurl suppresses the link-preview card the client would
	// otherwise render below the body. Set when the author dismisses
	// the unfurl — the suppression is global (every viewer sees it
	// off), which is what authors expect when the preview is wrong.
	NoUnfurl bool `json:"noUnfurl,omitempty" dynamodbav:"noUnfurl,omitempty"`
	// Rendered is the server-rendered hast tree for Body — populated
	// at read time, never persisted (the `dynamodbav:"-"` tag keeps
	// it out of DDB). Frontend consumers prefer this over re-parsing
	// the markdown source per render. nil means "not yet rendered"
	// (legacy messages, intermediate API paths) — clients fall back
	// to client-side parsing.
	Rendered *HastNode `json:"rendered,omitempty" dynamodbav:"-"`
	// Incoming webhook messages can override the displayed author and carry
	// Mattermost-compatible message attachments. AuthorID remains a stable
	// bot identifier for notifications/search, while these fields drive rendering.
	WebhookUsername    string              `json:"webhookUsername,omitempty" dynamodbav:"webhookUsername,omitempty"`
	WebhookAvatarURL   string              `json:"webhookAvatarURL,omitempty" dynamodbav:"webhookAvatarURL,omitempty"`
	WebhookIconEmoji   string              `json:"webhookIconEmoji,omitempty" dynamodbav:"webhookIconEmoji,omitempty"` // emoji name (no colons) from icon_emoji; rendered as the avatar
	MessageAttachments []MessageAttachment `json:"messageAttachments,omitempty" dynamodbav:"messageAttachments,omitempty"`
}

// Tombstone clears a message's content in place for a soft delete: it flags
// Deleted and wipes the body, attachments, reactions, and pin state. The row
// itself is kept so replies can still resolve their thread root. This is the
// single source of truth for the soft-delete field contract — the service
// soft-delete path and the offline migrations both call it.
func (m *Message) Tombstone() {
	m.Deleted = true
	m.Body = ""
	m.AttachmentIDs = nil
	m.Reactions = nil
	m.Pinned = false
	m.PinnedAt = nil
	m.PinnedBy = ""
}

type MessageAttachment struct {
	Fallback   string                   `json:"fallback,omitempty" dynamodbav:"fallback,omitempty"`
	Color      string                   `json:"color,omitempty" dynamodbav:"color,omitempty"`
	Pretext    string                   `json:"pretext,omitempty" dynamodbav:"pretext,omitempty"`
	Text       string                   `json:"text,omitempty" dynamodbav:"text,omitempty"`
	AuthorName string                   `json:"author_name,omitempty" dynamodbav:"authorName,omitempty"`
	AuthorLink string                   `json:"author_link,omitempty" dynamodbav:"authorLink,omitempty"`
	AuthorIcon string                   `json:"author_icon,omitempty" dynamodbav:"authorIcon,omitempty"`
	Title      string                   `json:"title,omitempty" dynamodbav:"title,omitempty"`
	TitleLink  string                   `json:"title_link,omitempty" dynamodbav:"titleLink,omitempty"`
	Fields     []MessageAttachmentField `json:"fields,omitempty" dynamodbav:"fields,omitempty"`
	ImageURL   string                   `json:"image_url,omitempty" dynamodbav:"imageURL,omitempty"`
	// ImageWidth/ImageHeight are the intrinsic pixel dimensions of the
	// S3-cached image_url, captured server-side at send time so the
	// client can render <img width height> and avoid layout shift in the
	// virtualised message list. Not part of the inbound webhook payload.
	ImageWidth  int    `json:"image_width,omitempty" dynamodbav:"imageWidth,omitempty"`
	ImageHeight int    `json:"image_height,omitempty" dynamodbav:"imageHeight,omitempty"`
	ThumbURL    string `json:"thumb_url,omitempty" dynamodbav:"thumbURL,omitempty"`
	Footer      string `json:"footer,omitempty" dynamodbav:"footer,omitempty"`
	FooterIcon  string `json:"footer_icon,omitempty" dynamodbav:"footerIcon,omitempty"`
	// Actions are interactive controls (buttons / select menus) rendered under
	// the attachment, in Mattermost's interactive-message shape. Clicking one
	// calls back into the integration that posted the attachment.
	Actions []MessageAction `json:"actions,omitempty" dynamodbav:"actions,omitempty"`
}

type MessageAttachmentField struct {
	Title string `json:"title,omitempty" dynamodbav:"title,omitempty"`
	Value string `json:"value,omitempty" dynamodbav:"value,omitempty"`
	Short bool   `json:"short,omitempty" dynamodbav:"short,omitempty"`
}

// MessageAction types, matching Mattermost's interactive message actions.
const (
	MessageActionTypeButton = "button"
	MessageActionTypeSelect = "select"
)

// MessageAction is one interactive control on an attachment. The client sends
// back only the action's ID; ex resolves the stored Integration server-side and
// calls it. That indirection is deliberate — see Integration below.
type MessageAction struct {
	// ID identifies this action within the message. Supplied by the integration
	// or minted at post time so it is always non-empty and unique per message.
	ID   string `json:"id" dynamodbav:"id"`
	Name string `json:"name" dynamodbav:"name"`
	// Type is MessageActionTypeButton (default) or MessageActionTypeSelect.
	Type string `json:"type,omitempty" dynamodbav:"type,omitempty"`
	// Style is MM's cosmetic hint: "default", "primary", "success", "good",
	// "warning", "danger", or a hex colour. Rendered as a button variant.
	Style string `json:"style,omitempty" dynamodbav:"style,omitempty"`
	// Disabled renders the control as non-interactive.
	Disabled bool `json:"disabled,omitempty" dynamodbav:"disabled,omitempty"`
	// Options are the choices for a select action.
	Options []MessageActionOption `json:"options,omitempty" dynamodbav:"options,omitempty"`
	// Integration is where ex POSTs when this action is used, plus the opaque
	// context the integration wants echoed back.
	//
	// It is NEVER serialized to clients (`json:"-"`): the URL is server-side
	// integration config and the context routinely carries integration-internal
	// identifiers, so shipping it to every channel member would leak both and
	// would let a client call the URL directly with a forged context. Inbound
	// JSON *does* populate it — see UnmarshalJSON — because the posting
	// integration supplies it in MM's payload under the "integration" key.
	Integration *ActionIntegration `json:"-" dynamodbav:"integration,omitempty"`
}

// MessageActionOption is one choice in a select action.
type MessageActionOption struct {
	Text  string `json:"text" dynamodbav:"text"`
	Value string `json:"value" dynamodbav:"value"`
}

// ActionIntegration is the server-side callback target of a MessageAction.
type ActionIntegration struct {
	URL string `json:"url" dynamodbav:"url"`
	// Context is arbitrary integration-owned JSON echoed back on invocation. It
	// is how an integration knows *which* thing the button referred to without
	// ex understanding its domain.
	Context map[string]any `json:"context,omitempty" dynamodbav:"context,omitempty"`
}

// messageActionWire is the inbound JSON shape of a MessageAction — identical to
// the outbound one except that "integration" is accepted. Declared separately so
// the asymmetry lives in exactly one place and can't drift from the struct.
type messageActionWire struct {
	ID          string                `json:"id"`
	Name        string                `json:"name"`
	Type        string                `json:"type"`
	Style       string                `json:"style"`
	Disabled    bool                  `json:"disabled"`
	Options     []MessageActionOption `json:"options"`
	Integration *ActionIntegration    `json:"integration"`
}

// UnmarshalJSON accepts "integration" on the way in even though MarshalJSON
// (via the `json:"-"` tag) never emits it on the way out.
func (a *MessageAction) UnmarshalJSON(data []byte) error {
	var w messageActionWire
	if err := json.Unmarshal(data, &w); err != nil {
		return err
	}
	// A direct conversion, not a field-by-field literal: the two structs are
	// identical apart from their tags, so this cannot silently drop a field the
	// way an enumerated literal would when one is added to only one of them.
	*a = MessageAction(w)
	return nil
}
