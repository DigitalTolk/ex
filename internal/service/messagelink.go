package service

import (
	"context"
	"net/url"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Narrow read-only surfaces the message-link resolver needs. Defined as
// interfaces so the resolver is unit-testable with simple fakes; the concrete
// impls are the existing store adapters / services wired in main.go.
type messageLinkChannels interface {
	GetChannelBySlug(ctx context.Context, slug string) (*model.Channel, error)
	GetChannel(ctx context.Context, id string) (*model.Channel, error)
}
type messageLinkMemberships interface {
	GetMembership(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error)
}
type messageLinkConversations interface {
	GetConversation(ctx context.Context, id string) (*model.Conversation, error)
}
type messageLinkMessages interface {
	GetMessage(ctx context.Context, parentID, msgID string) (*model.Message, error)
}
type messageLinkUsers interface {
	GetByID(ctx context.Context, id string) (*model.User, error)
}
type messageLinkAttachments interface {
	Get(ctx context.Context, id string) (*model.Attachment, error)
}

// messagePreviewBodyMax caps the body excerpt shown in a link preview.
const messagePreviewBodyMax = 500

// MessageLinkService turns a deep link to a message *inside this workspace*
// into a rich preview (author, channel, body, image) — the Slack / Mattermost
// "message link unfurl". It enforces the viewer's access: a link to a channel
// or DM the viewer can't see resolves to no preview rather than leaking the
// message, and never falls back to scraping our own host.
type MessageLinkService struct {
	host          string
	channels      messageLinkChannels
	memberships   messageLinkMemberships
	conversations messageLinkConversations
	messages      messageLinkMessages
	users         messageLinkUsers
	attachments   messageLinkAttachments
}

// NewMessageLinkService derives the workspace host from baseURL (BASE_URL) so
// only links to this deployment unfurl as message previews.
func NewMessageLinkService(
	baseURL string,
	channels messageLinkChannels,
	memberships messageLinkMemberships,
	conversations messageLinkConversations,
	messages messageLinkMessages,
	users messageLinkUsers,
	attachments messageLinkAttachments,
) *MessageLinkService {
	host := ""
	if u, err := url.Parse(baseURL); err == nil {
		host = u.Host
	}
	return &MessageLinkService{
		host:          host,
		channels:      channels,
		memberships:   memberships,
		conversations: conversations,
		messages:      messages,
		users:         users,
		attachments:   attachments,
	}
}

type messageLinkRef struct {
	parentKind string // "channel" | "conversation"
	ref        string // channel slug or conversation id
	messageID  string
}

// parseMessageLink returns the ref when rawURL is a deep link to a message on
// this host (`/channel/<slug>#msg-<id>` or `/conversation/<id>#msg-<id>`, with
// an optional `?thread=` query). ok=false for any other URL.
func (s *MessageLinkService) parseMessageLink(rawURL string) (messageLinkRef, bool) {
	if s.host == "" {
		return messageLinkRef{}, false
	}
	u, err := url.Parse(rawURL)
	if err != nil || !strings.EqualFold(u.Host, s.host) {
		return messageLinkRef{}, false
	}
	msgID := strings.TrimPrefix(u.Fragment, "msg-")
	if msgID == u.Fragment || msgID == "" {
		return messageLinkRef{}, false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 2 || parts[1] == "" {
		return messageLinkRef{}, false
	}
	switch parts[0] {
	case "channel":
		return messageLinkRef{parentKind: "channel", ref: parts[1], messageID: msgID}, true
	case "conversation":
		return messageLinkRef{parentKind: "conversation", ref: parts[1], messageID: msgID}, true
	}
	return messageLinkRef{}, false
}

// Preview resolves rawURL. The bool reports whether rawURL is an internal
// message link at all; when true and the preview is nil, the link points
// somewhere the viewer can't see (the caller must NOT then web-fetch our own
// host). (nil, false) means rawURL isn't one of our message links.
func (s *MessageLinkService) Preview(ctx context.Context, viewerID, rawURL string) (*UnfurlPreview, bool) {
	ref, ok := s.parseMessageLink(rawURL)
	if !ok {
		return nil, false
	}

	var parentID, label string
	switch ref.parentKind {
	case "channel":
		ch, err := s.channels.GetChannelBySlug(ctx, ref.ref)
		if err != nil || ch == nil || ch.Archived {
			return nil, true
		}
		// Public channels are visible to everyone in the workspace (even
		// before joining); private channels require membership so we never
		// leak their content.
		if ch.Type != model.ChannelTypePublic {
			if _, err := s.memberships.GetMembership(ctx, ch.ID, viewerID); err != nil {
				return nil, true
			}
		}
		parentID, label = ch.ID, "~"+ch.Slug
	default: // "conversation"
		conv, err := s.conversations.GetConversation(ctx, ref.ref)
		if err != nil || conv == nil || !containsString(conv.ParticipantIDs, viewerID) {
			return nil, true
		}
		parentID, label = conv.ID, conversationLabel(conv)
	}

	msg, err := s.messages.GetMessage(ctx, parentID, ref.messageID)
	if err != nil || msg == nil || msg.Deleted || msg.System {
		return nil, true
	}

	preview := &UnfurlPreview{
		Kind:         "message",
		URL:          rawURL,
		SiteName:     s.host,
		ChannelLabel: label,
		Body:         messagePreviewBody(msg.Body),
		CreatedAt:    msg.CreatedAt.UTC().Format(time.RFC3339),
	}
	s.resolveAuthor(ctx, msg, preview)
	preview.Image = s.resolveImage(ctx, msg)
	return preview, true
}

func (s *MessageLinkService) resolveAuthor(ctx context.Context, msg *model.Message, preview *UnfurlPreview) {
	if msg.WebhookUsername != "" {
		preview.AuthorName = msg.WebhookUsername
		preview.AuthorAvatarURL = msg.WebhookAvatarURL
		return
	}
	if u, err := s.users.GetByID(ctx, msg.AuthorID); err == nil && u != nil {
		preview.AuthorName = u.DisplayName
		preview.AuthorAvatarURL = u.AvatarURL
	}
}

// resolveImage returns the first displayable image for the message: a rich
// (webhook) attachment image, else the first image file attachment.
func (s *MessageLinkService) resolveImage(ctx context.Context, msg *model.Message) string {
	for _, a := range msg.MessageAttachments {
		if a.ImageURL != "" {
			return a.ImageURL
		}
	}
	if s.attachments == nil {
		return ""
	}
	for _, id := range msg.AttachmentIDs {
		att, err := s.attachments.Get(ctx, id)
		if err != nil || att == nil || !att.IsImage() {
			continue
		}
		if att.URL != "" {
			return att.URL
		}
	}
	return ""
}

func conversationLabel(conv *model.Conversation) string {
	if conv.Type == model.ConversationTypeGroup && strings.TrimSpace(conv.Name) != "" {
		return conv.Name
	}
	return "Direct message"
}

func messagePreviewBody(body string) string {
	// Keep the raw markdown (including `@[id|name]` / `~[id|slug]` mention
	// syntax and `:emoji:` shortcodes) so the client renders the excerpt with
	// the same markdown/mention/emoji treatment as the chat itself.
	body = strings.TrimSpace(body)
	runes := []rune(body)
	if len(runes) > messagePreviewBodyMax {
		return strings.TrimSpace(string(runes[:messagePreviewBodyMax])) + "…"
	}
	return body
}

func containsString(haystack []string, needle string) bool {
	for _, v := range haystack {
		if v == needle {
			return true
		}
	}
	return false
}
