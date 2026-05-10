package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

var (
	slackLinkPattern       = regexp.MustCompile(`<([^<>|!]+)(?:\|([^<>]+))?>`)
	mattermostUserPattern  = regexp.MustCompile(`(^|[^\w@])@([A-Za-z0-9._-]+)\b`)
	mattermostChannelToken = regexp.MustCompile(`(^|[^\w~])~([A-Za-z0-9][A-Za-z0-9_-]*)\b`)
)

type IncomingWebhookStore interface {
	Create(ctx context.Context, wh *model.IncomingWebhook) error
	Get(ctx context.Context, id string) (*model.IncomingWebhook, error)
	List(ctx context.Context) ([]*model.IncomingWebhook, error)
	Delete(ctx context.Context, id string) error
}

type WebhookChannelResolver interface {
	GetByID(ctx context.Context, id string) (*model.Channel, error)
	GetBySlug(ctx context.Context, slug string) (*model.Channel, error)
}

type WebhookImageProxy interface {
	ProxyImageURL(ctx context.Context, rawURL string) string
}

type WebhookDMResolver interface {
	GetOrCreateDM(ctx context.Context, userA, userB string) (*model.Conversation, error)
}

type WebhookUserResolver interface {
	List(ctx context.Context, limit int, cursor string) ([]*model.User, string, error)
}

type IncomingWebhookPayload struct {
	Text        string                    `json:"text"`
	Channel     string                    `json:"channel"`
	Username    string                    `json:"username"`
	IconURL     string                    `json:"icon_url"`
	IconEmoji   string                    `json:"icon_emoji"`
	Attachments []model.MessageAttachment `json:"attachments"`
}

type IncomingWebhookService struct {
	store    IncomingWebhookStore
	channels WebhookChannelResolver
	messages *MessageService
	images   WebhookImageProxy
	dms      WebhookDMResolver
	users    WebhookUserResolver
	baseURL  string
}

func NewIncomingWebhookService(store IncomingWebhookStore, channels WebhookChannelResolver, messages *MessageService, images WebhookImageProxy, baseURL string) *IncomingWebhookService {
	return &IncomingWebhookService{store: store, channels: channels, messages: messages, images: images, baseURL: strings.TrimRight(baseURL, "/")}
}

func (s *IncomingWebhookService) SetDMResolver(dms WebhookDMResolver) { s.dms = dms }

func (s *IncomingWebhookService) SetUserResolver(users WebhookUserResolver) { s.users = users }

func (s *IncomingWebhookService) Create(ctx context.Context, actorID string, in *model.IncomingWebhook) (*model.IncomingWebhook, error) {
	if actorID == "" {
		return nil, errors.New("webhook: actor required")
	}
	if in == nil || strings.TrimSpace(in.Title) == "" || in.ChannelID == "" {
		return nil, errors.New("webhook: title and channel are required")
	}
	if len([]rune(in.Description)) > 500 {
		return nil, errors.New("webhook: description must be 500 characters or fewer")
	}
	ch, err := s.channels.GetByID(ctx, in.ChannelID)
	if err != nil {
		return nil, fmt.Errorf("webhook: channel: %w", err)
	}
	now := time.Now()
	id, err := randomWebhookID()
	if err != nil {
		return nil, err
	}
	profileURL := s.proxyImage(ctx, in.ProfileImageURL)
	wh := &model.IncomingWebhook{
		ID:              id,
		Title:           strings.TrimSpace(in.Title),
		Description:     strings.TrimSpace(in.Description),
		ChannelID:       ch.ID,
		ChannelName:     ch.Name,
		ChannelSlug:     ch.Slug,
		LockToChannel:   in.LockToChannel,
		Username:        strings.TrimSpace(in.Username),
		ProfileImageURL: profileURL,
		CreatedBy:       actorID,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if wh.Username == "" {
		wh.Username = "webhook"
	}
	if err := s.store.Create(ctx, wh); err != nil {
		return nil, fmt.Errorf("webhook: create: %w", err)
	}
	return wh, nil
}

func (s *IncomingWebhookService) List(ctx context.Context) ([]*model.IncomingWebhook, error) {
	return s.store.List(ctx)
}

func (s *IncomingWebhookService) Delete(ctx context.Context, id string) error {
	if id == "" {
		return errors.New("webhook: id required")
	}
	return s.store.Delete(ctx, id)
}

func (s *IncomingWebhookService) URL(wh *model.IncomingWebhook) string {
	if wh == nil || s.baseURL == "" {
		return ""
	}
	return s.baseURL + "/hooks/" + wh.ID
}

func (s *IncomingWebhookService) Execute(ctx context.Context, id string, payload IncomingWebhookPayload) error {
	wh, err := s.store.Get(ctx, id)
	if err != nil {
		return fmt.Errorf("webhook: get: %w", err)
	}
	parentID, parentType, err := s.targetParent(ctx, wh, payload.Channel)
	if err != nil {
		return err
	}
	username := strings.TrimSpace(payload.Username)
	if username == "" {
		username = wh.Username
	}
	if username == "" {
		username = "webhook"
	}
	avatarURL := s.proxyImage(ctx, payload.IconURL)
	iconEmojiOverride := strings.TrimSpace(payload.IconEmoji) != ""
	if iconEmojiOverride {
		avatarURL = ""
	} else if avatarURL == "" {
		avatarURL = wh.ProfileImageURL
	}
	attachments := make([]model.MessageAttachment, 0, len(payload.Attachments))
	for _, a := range payload.Attachments {
		attachments = append(attachments, s.sanitizeAttachment(ctx, a))
	}
	_, err = s.messages.SendWebhook(ctx, WebhookMessageInput{
		ParentID:    parentID,
		ParentType:  parentType,
		AuthorID:    wh.CreatedBy,
		Body:        s.translateMattermostMarkup(ctx, payload.Text),
		Username:    username,
		AvatarURL:   avatarURL,
		Attachments: attachments,
	})
	return err
}

func (s *IncomingWebhookService) targetParent(ctx context.Context, wh *model.IncomingWebhook, raw string) (string, string, error) {
	if !wh.LockToChannel && strings.HasPrefix(strings.TrimSpace(raw), "@") {
		conv, err := s.targetDM(ctx, wh, raw)
		if err != nil {
			return "", "", err
		}
		return conv.ID, ParentConversation, nil
	}
	ch, err := s.targetChannel(ctx, wh, raw)
	if err != nil {
		return "", "", err
	}
	return ch.ID, ParentChannel, nil
}

func (s *IncomingWebhookService) targetChannel(ctx context.Context, wh *model.IncomingWebhook, raw string) (*model.Channel, error) {
	if wh.LockToChannel || strings.TrimSpace(raw) == "" {
		return s.channels.GetByID(ctx, wh.ChannelID)
	}
	name := strings.TrimSpace(raw)
	if strings.HasPrefix(name, "@") {
		return nil, store.ErrNotFound
	}
	name = strings.TrimPrefix(name, "#")
	if ch, err := s.channels.GetBySlug(ctx, name); err == nil && ch != nil && !ch.Archived {
		return ch, nil
	}
	if ch, err := s.channels.GetByID(ctx, name); err == nil && ch != nil && !ch.Archived {
		return ch, nil
	}
	return nil, store.ErrNotFound
}

func (s *IncomingWebhookService) targetDM(ctx context.Context, wh *model.IncomingWebhook, raw string) (*model.Conversation, error) {
	if s.dms == nil || s.users == nil || wh.CreatedBy == "" {
		return nil, errors.New("webhook: direct-message resolver is not configured")
	}
	targetName := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "@"))
	if targetName == "" {
		return nil, store.ErrNotFound
	}
	target, err := s.findWebhookTargetUser(ctx, targetName)
	if err != nil {
		return nil, err
	}
	return s.dms.GetOrCreateDM(ctx, wh.CreatedBy, target.ID)
}

func (s *IncomingWebhookService) findWebhookTargetUser(ctx context.Context, targetName string) (*model.User, error) {
	users, _, err := s.users.List(ctx, 200, "")
	if err != nil {
		return nil, fmt.Errorf("webhook: list users: %w", err)
	}
	needle := strings.ToLower(strings.TrimSpace(targetName))
	for _, user := range users {
		if user == nil {
			continue
		}
		display := strings.ToLower(strings.TrimSpace(user.DisplayName))
		email := strings.ToLower(strings.TrimSpace(user.Email))
		local := email
		if at := strings.Index(local, "@"); at >= 0 {
			local = local[:at]
		}
		if user.ID == targetName || display == needle || email == needle || local == needle {
			return user, nil
		}
	}
	return nil, store.ErrNotFound
}

func (s *IncomingWebhookService) sanitizeAttachment(ctx context.Context, a model.MessageAttachment) model.MessageAttachment {
	a.Pretext = s.translateMattermostMarkup(ctx, a.Pretext)
	a.Text = s.translateMattermostMarkup(ctx, a.Text)
	for i := range a.Fields {
		a.Fields[i].Value = s.translateMattermostMarkup(ctx, a.Fields[i].Value)
	}
	a.AuthorIcon = s.proxyImage(ctx, a.AuthorIcon)
	a.ImageURL = s.proxyImage(ctx, a.ImageURL)
	a.ThumbURL = s.proxyImage(ctx, a.ThumbURL)
	a.FooterIcon = s.proxyImage(ctx, a.FooterIcon)
	if len(a.Footer) > 300 {
		a.Footer = a.Footer[:300] + "..."
	}
	return a
}

func (s *IncomingWebhookService) translateMattermostMarkup(ctx context.Context, text string) string {
	text = strings.ReplaceAll(text, "<!channel>", "@all")
	text = strings.ReplaceAll(text, "<!all>", "@all")
	text = strings.ReplaceAll(text, "<!here>", "@here")
	text = slackLinkPattern.ReplaceAllStringFunc(text, func(match string) string {
		parts := slackLinkPattern.FindStringSubmatch(match)
		if len(parts) < 2 {
			return match
		}
		href := parts[1]
		label := parts[2]
		if strings.HasPrefix(href, "#") {
			if mention, ok := s.channelMention(ctx, strings.TrimPrefix(href, "#")); ok {
				return mention
			}
			if label != "" {
				return "~" + label
			}
		}
		if userRef := strings.TrimPrefix(href, "@"); userRef != href || label == "" {
			if mention, ok := s.userMention(ctx, userRef); ok {
				return mention
			}
		}
		if label == "" {
			return href
		}
		return "[" + label + "](" + href + ")"
	})
	text = mattermostChannelToken.ReplaceAllStringFunc(text, func(match string) string {
		parts := mattermostChannelToken.FindStringSubmatch(match)
		if len(parts) < 3 {
			return match
		}
		if mention, ok := s.channelMention(ctx, parts[2]); ok {
			return parts[1] + mention
		}
		return match
	})
	return mattermostUserPattern.ReplaceAllStringFunc(text, func(match string) string {
		parts := mattermostUserPattern.FindStringSubmatch(match)
		if len(parts) < 3 {
			return match
		}
		name := strings.ToLower(parts[2])
		switch name {
		case "all":
			return parts[1] + "@all"
		case "channel":
			return parts[1] + "@all"
		case "here":
			return parts[1] + "@here"
		}
		if mention, ok := s.userMention(ctx, parts[2]); ok {
			return parts[1] + mention
		}
		return match
	})
}

func (s *IncomingWebhookService) channelMention(ctx context.Context, ref string) (string, bool) {
	if s.channels == nil {
		return "", false
	}
	ref = strings.TrimSpace(strings.TrimPrefix(ref, "#"))
	if ref == "" {
		return "", false
	}
	if ch, err := s.channels.GetBySlug(ctx, ref); err == nil && ch != nil && !ch.Archived {
		return "~[" + ch.ID + "|" + ch.Slug + "]", true
	}
	if ch, err := s.channels.GetByID(ctx, ref); err == nil && ch != nil && !ch.Archived {
		return "~[" + ch.ID + "|" + ch.Slug + "]", true
	}
	return "", false
}

func (s *IncomingWebhookService) userMention(ctx context.Context, ref string) (string, bool) {
	if s.users == nil {
		return "", false
	}
	user, err := s.findWebhookTargetUser(ctx, ref)
	if err != nil || user == nil {
		return "", false
	}
	name := strings.TrimSpace(user.DisplayName)
	if name == "" {
		name = user.Email
	}
	if name == "" {
		name = user.ID
	}
	return "@[" + user.ID + "|" + name + "]", true
}

func (s *IncomingWebhookService) proxyImage(ctx context.Context, raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || s.images == nil {
		return raw
	}
	if u, err := url.Parse(raw); err != nil || !u.IsAbs() || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	return s.images.ProxyImageURL(ctx, raw)
}

func randomWebhookID() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("webhook: random id: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}
