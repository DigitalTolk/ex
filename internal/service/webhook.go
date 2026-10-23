package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
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
	Update(ctx context.Context, wh *model.IncomingWebhook) error
	Delete(ctx context.Context, id string) error
}

type WebhookChannelResolver interface {
	GetByID(ctx context.Context, id string) (*model.Channel, error)
	GetBySlug(ctx context.Context, slug string) (*model.Channel, error)
}

type WebhookImageProxy interface {
	ProxyImageURL(ctx context.Context, rawURL string) string
	ProxyImageWithSize(ctx context.Context, rawURL string) (string, int, int)
}

type WebhookDMResolver interface {
	GetOrCreateDM(ctx context.Context, userA, userB string) (*model.Conversation, error)
}

// WebhookUserResolver resolves a DM target or an @mention to a user: by exact
// email, by ID, or through the user search index (display names, email
// local-parts). Implemented by UserService. There is deliberately no
// directory walk: paging every user on an unauthenticated ingress, once per
// unknown name, cost O(directory) reads per payload.
type WebhookUserResolver interface {
	GetByID(ctx context.Context, id string) (*model.User, error)
	GetByEmail(ctx context.Context, email string) (*model.User, error)
	Search(ctx context.Context, query string, limit int) ([]*model.User, error)
}

const (
	// maxWebhookRefLookups caps how many distinct @user refs — and, separately,
	// how many distinct ~channel refs — one payload gets looked up. A 1 MiB
	// payload can name thousands; past the cap a ref stays the plain text the
	// sender wrote.
	maxWebhookRefLookups = 20
	// webhookUserSearchLimit is how many search candidates a display-name
	// lookup considers: the exact match ranks at the top, and every candidate
	// costs the search a user read.
	webhookUserSearchLimit = 10
	// webhookImageConcurrency bounds one payload's parallel image lookups.
	webhookImageConcurrency = 8
)

// WebhookBotProvisioner creates (or returns) the machine account a webhook
// direct-messages from. Implemented by UserService.
type WebhookBotProvisioner interface {
	EnsureBotUser(ctx context.Context, botID, displayName string) (*model.User, error)
}

// WebhookMembershipResolver checks whether the webhook creator is a member
// of a channel — used to gate channel overrides into private channels.
type WebhookMembershipResolver interface {
	GetMembership(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error)
}

type IncomingWebhookPayload struct {
	Text        string                    `json:"text"`
	Channel     string                    `json:"channel"`
	Username    string                    `json:"username"`
	IconURL     string                    `json:"icon_url"`
	IconEmoji   string                    `json:"icon_emoji"`
	Attachments []model.MessageAttachment `json:"attachments"`
	// RootID posts the message as a reply in the thread of an earlier post
	// by this webhook (the id ExecuteMessage returned for it).
	RootID string `json:"root_id"`
}

type IncomingWebhookService struct {
	store       IncomingWebhookStore
	channels    WebhookChannelResolver
	messages    *MessageService
	images      WebhookImageProxy
	dms         WebhookDMResolver
	users       WebhookUserResolver
	bots        WebhookBotProvisioner
	memberships WebhookMembershipResolver
	publisher   Publisher
	baseURL     string
}

func NewIncomingWebhookService(store IncomingWebhookStore, channels WebhookChannelResolver, messages *MessageService, images WebhookImageProxy, baseURL string) *IncomingWebhookService {
	return &IncomingWebhookService{store: store, channels: channels, messages: messages, images: images, baseURL: strings.TrimRight(baseURL, "/")}
}

func (s *IncomingWebhookService) SetDMResolver(dms WebhookDMResolver) { s.dms = dms }

func (s *IncomingWebhookService) SetUserResolver(users WebhookUserResolver) { s.users = users }

func (s *IncomingWebhookService) SetBotProvisioner(b WebhookBotProvisioner) { s.bots = b }

func (s *IncomingWebhookService) SetMembershipResolver(m WebhookMembershipResolver) {
	s.memberships = m
}

func (s *IncomingWebhookService) SetPublisher(p Publisher) { s.publisher = p }

func (s *IncomingWebhookService) Create(ctx context.Context, actorID string, in *model.IncomingWebhook) (*model.IncomingWebhook, error) {
	if actorID == "" {
		return nil, apperr.Invalid("webhook: actor required")
	}
	if in == nil || strings.TrimSpace(in.Title) == "" || in.ChannelID == "" {
		return nil, apperr.Invalid("webhook: title and channel are required")
	}
	if len([]rune(in.Description)) > 500 {
		return nil, apperr.Invalid("webhook: description must be 500 characters or fewer")
	}
	ch, err := s.channels.GetByID(ctx, in.ChannelID)
	if err != nil {
		return nil, fmt.Errorf("webhook: channel: %w", err)
	}
	if ch.Archived {
		return nil, fmt.Errorf("webhook: %w", ErrChannelArchived)
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
	s.publishChanged(ctx)
	return wh, nil
}

func (s *IncomingWebhookService) List(ctx context.Context) ([]*model.IncomingWebhook, error) {
	return s.store.List(ctx)
}

// Update edits an existing webhook's configurable fields. The ID, secret
// (the ID is the secret), creator, and creation time are preserved; the
// target channel is re-resolved so name/slug stay consistent.
func (s *IncomingWebhookService) Update(ctx context.Context, id string, in *model.IncomingWebhook) (*model.IncomingWebhook, error) {
	if id == "" {
		return nil, apperr.Invalid("webhook: id required")
	}
	if in == nil || strings.TrimSpace(in.Title) == "" || in.ChannelID == "" {
		return nil, apperr.Invalid("webhook: title and channel are required")
	}
	if len([]rune(in.Description)) > 500 {
		return nil, apperr.Invalid("webhook: description must be 500 characters or fewer")
	}
	existing, err := s.store.Get(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("webhook: get: %w", err)
	}
	ch, err := s.channels.GetByID(ctx, in.ChannelID)
	if err != nil {
		return nil, fmt.Errorf("webhook: channel: %w", err)
	}
	if ch.Archived {
		return nil, fmt.Errorf("webhook: %w", ErrChannelArchived)
	}
	existing.Title = strings.TrimSpace(in.Title)
	existing.Description = strings.TrimSpace(in.Description)
	existing.ChannelID = ch.ID
	existing.ChannelName = ch.Name
	existing.ChannelSlug = ch.Slug
	existing.LockToChannel = in.LockToChannel
	existing.Username = strings.TrimSpace(in.Username)
	if existing.Username == "" {
		existing.Username = "webhook"
	}
	existing.ProfileImageURL = s.proxyImage(ctx, in.ProfileImageURL)
	existing.UpdatedAt = time.Now()
	if err := s.store.Update(ctx, existing); err != nil {
		return nil, fmt.Errorf("webhook: update: %w", err)
	}
	s.publishChanged(ctx)
	return existing, nil
}

func (s *IncomingWebhookService) Delete(ctx context.Context, id string) error {
	if id == "" {
		return apperr.Invalid("webhook: id required")
	}
	if err := s.store.Delete(ctx, id); err != nil {
		return err
	}
	s.publishChanged(ctx)
	return nil
}

// publishChanged broadcasts a data-less nudge on the global channel so
// connected admin clients refetch the webhook list. The payload carries
// no webhook details — the list endpoint is admin-gated, so non-admin
// clients learn nothing from the event itself.
func (s *IncomingWebhookService) publishChanged(ctx context.Context) {
	if s.publisher == nil {
		return
	}
	events.Publish(ctx, s.publisher, pubsub.GlobalChannelEvents(), events.EventWebhookChanged, map[string]any{})
}

func (s *IncomingWebhookService) URL(wh *model.IncomingWebhook) string {
	if wh == nil || s.baseURL == "" {
		return ""
	}
	return s.baseURL + "/hooks/" + wh.ID
}

// ErrWebhookDMRejected marks an Execute payload whose direct-message target
// cannot be served (resolver not wired, or the webhook tried to DM its own
// creator). A sentinel rather than string matching: the handler maps it to a
// 400 with a FIXED user-facing message — the wrapped detail is for logs only,
// never for the unauthenticated caller.
var ErrWebhookDMRejected = errors.New("webhook: direct-message target rejected")

// ErrWebhookUnavailable marks an infrastructure failure rather than a bad
// request. The handler maps it to 503 so the caller retries.
var ErrWebhookUnavailable = errors.New("webhook: delivery temporarily unavailable")

func (s *IncomingWebhookService) Execute(ctx context.Context, id string, payload IncomingWebhookPayload) error {
	_, err := s.ExecuteMessage(ctx, id, payload)
	return err
}

// ExecuteMessage delivers a webhook payload and returns the stored message,
// so callers can thread follow-ups under it via RootID.
func (s *IncomingWebhookService) ExecuteMessage(ctx context.Context, id string, payload IncomingWebhookPayload) (*model.Message, error) {
	wh, err := s.store.Get(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("webhook: get: %w", err)
	}
	// The payload limits come first: every later step — the DM target lookup,
	// mention lookups, image fetches into S3 — costs work bounded only by them.
	if err := validateWebhookPayload(payload); err != nil {
		return nil, err
	}
	target, err := s.targetParent(ctx, wh, payload.Channel)
	if err != nil {
		return nil, err
	}
	username := strings.TrimSpace(payload.Username)
	if username == "" {
		username = wh.Username
	}
	if username == "" {
		username = "webhook"
	}
	refs := s.newRefs()
	body := refs.translate(ctx, payload.Text)
	attachments := make([]model.MessageAttachment, len(payload.Attachments))
	for i, a := range payload.Attachments {
		attachments[i] = refs.sanitizeAttachment(ctx, a)
	}
	iconURL := payload.IconURL
	iconEmoji := normalizeEmojiName(payload.IconEmoji)
	if iconEmoji != "" {
		// icon_emoji wins over icon_url and the creation-time avatar; the
		// emoji is rendered as the avatar client-side.
		iconURL = ""
	}
	avatarURL := s.proxyImages(ctx, iconURL, attachments)
	if iconEmoji == "" && avatarURL == "" {
		avatarURL = wh.ProfileImageURL
	}
	// Webhook posts are authored by the webhook bot, NOT the human who created
	// the webhook. Attributing them to wh.CreatedBy would make the message
	// "their own" everywhere that keys off AuthorID — suppressing their unread
	// badge, hiding their desktop alert's counterpart, and even letting them
	// edit/delete the bot's message. The creator is just the configurer; the
	// private-channel post gate still uses wh.CreatedBy from the webhook record.
	//
	// Channel posts carry the "webhook" sentinel, since the webhook is not a
	// channel member. DM posts carry the bot's real account ID: the bot is a
	// participant of the conversation, and the notification fan-out excludes
	// the author from its audience — which is precisely what leaves the
	// recipient as the only person notified.
	return s.messages.SendWebhook(ctx, WebhookMessageInput{
		ParentID:        target.parentID,
		ParentType:      target.parentType,
		AuthorID:        target.authorID,
		Body:            body,
		Username:        username,
		AvatarURL:       avatarURL,
		IconEmoji:       iconEmoji,
		Attachments:     attachments,
		ParentMessageID: strings.TrimSpace(payload.RootID),
		WebhookID:       wh.ID,
	})
}

// errWebhookEmptyPayload rejects a payload with neither text nor attachments.
var errWebhookEmptyPayload = apperr.Invalid("webhook: text or attachments required")

// validateWebhookPayload applies SendWebhook's payload limits before anything
// is looked up or fetched for the payload. SendWebhook checks them again on
// the translated result.
func validateWebhookPayload(p IncomingWebhookPayload) error {
	if p.Text == "" && len(p.Attachments) == 0 {
		return errWebhookEmptyPayload
	}
	if err := ValidateAttachmentCount(len(p.Attachments)); err != nil {
		return err
	}
	return ValidateMessageBody(p.Text)
}

// normalizeEmojiName strips the optional surrounding colons and
// whitespace from an icon_emoji value (Mattermost accepts ":tada:" or
// "tada"). Returns "" when nothing usable remains.
func normalizeEmojiName(raw string) string {
	return strings.Trim(strings.TrimSpace(raw), ":")
}

// webhookTarget is where a delivery lands and who it is authored as.
type webhookTarget struct {
	parentID   string
	parentType string
	authorID   string
}

// isDMTarget reports whether the channel field names a person: Mattermost's
// "@name" or a bare email. Channel slugs never contain "@".
func isDMTarget(raw string) bool { return strings.Contains(strings.TrimSpace(raw), "@") }

func (s *IncomingWebhookService) targetParent(ctx context.Context, wh *model.IncomingWebhook, raw string) (webhookTarget, error) {
	if isDMTarget(raw) {
		// Reject rather than quietly redirect to the bound channel.
		if wh.LockToChannel {
			return webhookTarget{}, fmt.Errorf("%w: webhook is locked to its channel and cannot direct-message", ErrWebhookDMRejected)
		}
		return s.targetDM(ctx, wh, raw)
	}
	ch, err := s.targetChannel(ctx, wh, raw)
	if err != nil {
		return webhookTarget{}, err
	}
	return webhookTarget{parentID: ch.ID, parentType: ParentChannel, authorID: WebhookAuthorID}, nil
}

func (s *IncomingWebhookService) targetChannel(ctx context.Context, wh *model.IncomingWebhook, raw string) (*model.Channel, error) {
	if wh.LockToChannel || strings.TrimSpace(raw) == "" {
		ch, err := s.channels.GetByID(ctx, wh.ChannelID)
		if err != nil {
			return nil, err
		}
		if ch.Archived {
			return nil, ErrChannelArchived
		}
		// Re-check the creator can still post: a webhook bound to a private
		// channel must stop posting once its creator loses access to that
		// channel (same gate as channel overrides). Public channels always
		// pass, so default public webhooks are unaffected.
		if err := s.ensureCreatorCanPost(ctx, wh, ch); err != nil {
			return nil, err
		}
		return ch, nil
	}
	name := strings.TrimSpace(raw)
	if strings.HasPrefix(name, "@") {
		return nil, store.ErrNotFound
	}
	name = strings.TrimPrefix(name, "#")
	ch := s.resolveChannel(ctx, name)
	if ch == nil {
		return nil, store.ErrNotFound
	}
	if err := s.ensureCreatorCanPost(ctx, wh, ch); err != nil {
		return nil, err
	}
	return ch, nil
}

// resolveChannel looks up a channel by slug then by ID, skipping archived
// channels. Returns nil when nothing matches.
func (s *IncomingWebhookService) resolveChannel(ctx context.Context, name string) *model.Channel {
	if ch, err := s.channels.GetBySlug(ctx, name); err == nil && ch != nil && !ch.Archived {
		return ch
	}
	if ch, err := s.channels.GetByID(ctx, name); err == nil && ch != nil && !ch.Archived {
		return ch
	}
	return nil
}

// ensureCreatorCanPost gates channel overrides: posting to a public
// channel is always allowed, but posting to a private channel requires
// the webhook creator to be a member (mirroring Mattermost). When the
// membership resolver isn't wired we fail closed for private channels.
func (s *IncomingWebhookService) ensureCreatorCanPost(ctx context.Context, wh *model.IncomingWebhook, ch *model.Channel) error {
	if ch.Type != model.ChannelTypePrivate {
		return nil
	}
	if s.memberships == nil || wh.CreatedBy == "" {
		return store.ErrNotFound
	}
	if _, err := s.memberships.GetMembership(ctx, ch.ID, wh.CreatedBy); err != nil {
		return store.ErrNotFound
	}
	return nil
}

// targetDM resolves a DM target to the bot↔recipient conversation. The
// creator configures the integration; they are not a party to its messages.
func (s *IncomingWebhookService) targetDM(ctx context.Context, wh *model.IncomingWebhook, raw string) (webhookTarget, error) {
	if s.dms == nil || s.users == nil || s.bots == nil {
		return webhookTarget{}, fmt.Errorf("%w: resolver is not configured", ErrWebhookDMRejected)
	}
	targetName := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "@"))
	if targetName == "" {
		return webhookTarget{}, store.ErrNotFound
	}
	target, err := s.findWebhookTargetUser(ctx, targetName)
	if err != nil {
		return webhookTarget{}, err
	}
	// Addressable by ID despite being hidden from search; a bot-to-bot DM has
	// no reader.
	if target.IsBot {
		return webhookTarget{}, fmt.Errorf("%w: cannot direct-message a bot account", ErrWebhookDMRejected)
	}
	bot, err := s.bots.EnsureBotUser(ctx, WebhookBotUserID(wh.ID), wh.Username)
	if err != nil {
		return webhookTarget{}, fmt.Errorf("%w: provision bot: %w", ErrWebhookUnavailable, err)
	}
	conv, err := s.dms.GetOrCreateDM(ctx, bot.ID, target.ID)
	if err != nil {
		// A missing user still surfaces as ErrNotFound; the handler checks
		// that first.
		return webhookTarget{}, fmt.Errorf("%w: open conversation: %w", ErrWebhookUnavailable, err)
	}
	return webhookTarget{parentID: conv.ID, parentType: ParentConversation, authorID: bot.ID}, nil
}

// findWebhookTargetUser resolves a @name / id / email to a user: an exact
// email or ID with one indexed read each, a display name or email local-part
// through the user search index. A miss after those is a miss —
// store.ErrNotFound; a failed search is ErrWebhookUnavailable, so a DM
// caller retries instead of being told its target does not exist.
func (s *IncomingWebhookService) findWebhookTargetUser(ctx context.Context, targetName string) (*model.User, error) {
	needle := strings.ToLower(strings.TrimSpace(targetName))
	if strings.Contains(needle, "@") {
		if user, err := s.users.GetByEmail(ctx, needle); err == nil && user != nil {
			return user, nil
		}
	}
	// ULID target (webhook configs may carry raw user IDs). A miss is one
	// cheap point read.
	if user, err := s.users.GetByID(ctx, targetName); err == nil && user != nil && user.ID == targetName {
		return user, nil
	}
	candidates, err := s.users.Search(ctx, needle, webhookUserSearchLimit)
	if err != nil {
		return nil, fmt.Errorf("%w: search users: %w", ErrWebhookUnavailable, err)
	}
	if user := matchWebhookUser(candidates, targetName, needle); user != nil {
		return user, nil
	}
	return nil, store.ErrNotFound
}

// matchWebhookUser returns the first user in the page matching by ID,
// display name, email, or email local-part.
func matchWebhookUser(users []*model.User, targetName, needle string) *model.User {
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
			return user
		}
	}
	return nil
}

// webhookRefs resolves one payload's @user and ~channel references. Each
// distinct ref is looked up once, and at most maxWebhookRefLookups distinct
// refs of each kind are looked up at all — a user lookup is an ID read plus a
// search, and a 1 MiB payload can name thousands of refs. A memoised nil is a
// ref that resolved to nobody.
type webhookRefs struct {
	s        *IncomingWebhookService
	users    map[string]*model.User
	channels map[string]*model.Channel
}

func (s *IncomingWebhookService) newRefs() *webhookRefs {
	return &webhookRefs{s: s, users: map[string]*model.User{}, channels: map[string]*model.Channel{}}
}

func (r *webhookRefs) user(ctx context.Context, ref string) *model.User {
	if u, seen := r.users[ref]; seen || len(r.users) >= maxWebhookRefLookups {
		return u
	}
	u, err := r.s.findWebhookTargetUser(ctx, ref)
	if err != nil {
		u = nil
	}
	r.users[ref] = u
	return u
}

func (r *webhookRefs) channel(ctx context.Context, ref string) *model.Channel {
	if ch, seen := r.channels[ref]; seen || len(r.channels) >= maxWebhookRefLookups {
		return ch
	}
	ch := r.s.resolveChannel(ctx, ref)
	r.channels[ref] = ch
	return ch
}

// sanitizeAttachment translates an attachment's markup and drops unsafe
// links. Its images are resolved separately, in parallel (proxyImages).
func (r *webhookRefs) sanitizeAttachment(ctx context.Context, a model.MessageAttachment) model.MessageAttachment {
	a.Pretext = r.translate(ctx, a.Pretext)
	a.Text = r.translate(ctx, a.Text)
	for i := range a.Fields {
		a.Fields[i].Value = r.translate(ctx, a.Fields[i].Value)
	}
	// Clickable link fields are author-controlled and rendered as <a href> by
	// the client — drop any non-http(s)/mailto scheme (javascript:, data:, …)
	// so a webhook payload can't smuggle a script-URL into a link. Mirrors the
	// markdown link authority (isSafeURL); image fields go through proxyImage.
	if !isSafeURL(a.AuthorLink) {
		a.AuthorLink = ""
	}
	if !isSafeURL(a.TitleLink) {
		a.TitleLink = ""
	}
	if len(a.Footer) > 300 {
		a.Footer = a.Footer[:300] + "..."
	}
	return a
}

// proxyImages resolves a payload's images — the icon, and each attachment's
// author icon, image, thumbnail and footer icon — concurrently, and returns
// the proxied icon. Each lookup writes only its own field, so the result does
// not depend on the order the lookups finish in. Done one after another, a
// post with two attachments waited on nine S3 round trips in a row.
func (s *IncomingWebhookService) proxyImages(ctx context.Context, iconURL string, atts []model.MessageAttachment) string {
	var g errgroup.Group
	g.SetLimit(webhookImageConcurrency)
	var icon string
	g.Go(func() error { icon = s.proxyImage(ctx, iconURL); return nil })
	for i := range atts {
		a := &atts[i]
		g.Go(func() error { a.AuthorIcon = s.proxyImage(ctx, a.AuthorIcon); return nil })
		// image_url is the only attachment image with a variable display box,
		// so we capture its intrinsic dimensions for the client to reserve
		// space. The thumb (fixed 75×75) and 16×16 icons don't need them.
		g.Go(func() error {
			a.ImageURL, a.ImageWidth, a.ImageHeight = s.proxyImageWithSize(ctx, a.ImageURL)
			return nil
		})
		g.Go(func() error { a.ThumbURL = s.proxyImage(ctx, a.ThumbURL); return nil })
		g.Go(func() error { a.FooterIcon = s.proxyImage(ctx, a.FooterIcon); return nil })
	}
	// The lookups report failure by clearing their field, never by error.
	_ = g.Wait()
	return icon
}

func (r *webhookRefs) translate(ctx context.Context, text string) string {
	text = strings.ReplaceAll(text, "<!channel>", "@all")
	text = strings.ReplaceAll(text, "<!all>", "@all")
	text = strings.ReplaceAll(text, "<!here>", "@here")
	text = slackLinkPattern.ReplaceAllStringFunc(text, func(match string) string {
		// FindStringSubmatch of a string the SAME pattern just matched
		// always yields the full group set — no guard needed.
		parts := slackLinkPattern.FindStringSubmatch(match)
		href := parts[1]
		label := parts[2]
		if strings.HasPrefix(href, "#") {
			if mention, ok := r.channelMention(ctx, strings.TrimPrefix(href, "#")); ok {
				return mention
			}
			if label != "" {
				return "~" + label
			}
		}
		if userRef := strings.TrimPrefix(href, "@"); userRef != href || label == "" {
			if mention, ok := r.userMention(ctx, userRef); ok {
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
		if mention, ok := r.channelMention(ctx, parts[2]); ok {
			return parts[1] + mention
		}
		return match
	})
	return mattermostUserPattern.ReplaceAllStringFunc(text, func(match string) string {
		parts := mattermostUserPattern.FindStringSubmatch(match)
		name := strings.ToLower(parts[2])
		switch name {
		case "all":
			return parts[1] + "@all"
		case "channel":
			return parts[1] + "@all"
		case "here":
			return parts[1] + "@here"
		}
		if mention, ok := r.userMention(ctx, parts[2]); ok {
			return parts[1] + mention
		}
		return match
	})
}

func (r *webhookRefs) channelMention(ctx context.Context, ref string) (string, bool) {
	if r.s.channels == nil {
		return "", false
	}
	ref = strings.TrimSpace(strings.TrimPrefix(ref, "#"))
	if ref == "" {
		return "", false
	}
	ch := r.channel(ctx, ref)
	if ch == nil {
		return "", false
	}
	return "~[" + ch.ID + "|" + ch.Slug + "]", true
}

func (r *webhookRefs) userMention(ctx context.Context, ref string) (string, bool) {
	if r.s.users == nil {
		return "", false
	}
	user := r.user(ctx, ref)
	if user == nil {
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

// proxyImageWithSize is the dimension-aware variant of proxyImage used
// for attachment image_url. It returns the cached URL plus intrinsic
// width/height (0,0 when unknown or when no proxy is configured).
func (s *IncomingWebhookService) proxyImageWithSize(ctx context.Context, raw string) (string, int, int) {
	raw = strings.TrimSpace(raw)
	if raw == "" || s.images == nil {
		return raw, 0, 0
	}
	if u, err := url.Parse(raw); err != nil || !u.IsAbs() || (u.Scheme != "http" && u.Scheme != "https") {
		return "", 0, 0
	}
	return s.images.ProxyImageWithSize(ctx, raw)
}

func randomWebhookID() (string, error) {
	var b [32]byte
	if _, err := randRead(b[:]); err != nil {
		return "", fmt.Errorf("webhook: random id: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}
