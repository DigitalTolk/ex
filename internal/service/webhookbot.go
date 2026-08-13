package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Outgoing-webhook transport: lets an EXTERNAL service be a bot. When a bot has a
// callback URL, an @mention or trigger-word event is POSTed to it and its
// response is posted back — the generic way third-party bots integrate. It
// implements the same BotHandler role as an in-process bot, over HTTP. Identity
// per docs/rfc-generic-bots-mcp.md §5: the event carries the attested asker id;
// the reply posts back as the bot, access-checked against the asker.
//
// Two wire formats are supported, selected per bot by model.BotTransport:
//
//   - "ex" — ex's own JSON event, authenticated by an HMAC X-Ex-Signature.
//     Signed request bodies are strictly better security than a bearer token in
//     the payload, so this stays the default for new integrations.
//   - "mattermost" — Mattermost's form-encoded outgoing-webhook fields with the
//     shared secret as the body's `token`. Weaker, but it is what every existing
//     MM outgoing-webhook receiver already parses, so an unmodified MM bot works.
//
// The REPLY shape is MM/Slack-style for both (text + response_type + attachments).

// BotWebhookTarget is an external bot's outgoing-webhook config.
type BotWebhookTarget struct {
	URL    string
	Secret string
	Name   string
	// Transport selects the request wire format. Zero value means ex's own.
	Transport model.BotTransport
	// TriggerWords / TriggerWhen mirror the bot account's trigger config. Carried
	// here so the dispatcher can report which word fired in the payload.
	TriggerWords []string
	TriggerWhen  model.BotTriggerWhen
}

// BotDirectory resolves a bot user id to its outgoing-webhook config (if any).
// Satisfied by *BotService.
type BotDirectory interface {
	WebhookBot(ctx context.Context, botUserID string) (BotWebhookTarget, bool)
}

// BotTriggerIndex resolves a message's leading (or contained) trigger word to the
// external bot that registered it. It is consulted on the synchronous send path,
// so implementations MUST be non-blocking and I/O-free — *BotService serves it
// from an atomically-swapped in-memory snapshot (see bottriggers.go).
type BotTriggerIndex interface {
	// TriggerBot returns the bot user id registered for a trigger word, matching
	// case-insensitively. word is already lowercased by the caller.
	TriggerBot(word string) (botUserID string, when model.BotTriggerWhen, ok bool)
	// HasContainsTriggers reports whether any registered trigger uses
	// BotTriggerWhenContains. When false, the dispatcher can skip the
	// scan-every-word pass and only test the first word — which is the common
	// case, so the hot send path stays a single map lookup.
	HasContainsTriggers() bool
}

// SetBotDirectory wires the external-bot resolver so mentions of webhook bots are
// dispatched over HTTP. Optional — unset means only in-process bots run.
func (s *MessageService) SetBotDirectory(d BotDirectory) { s.botDir = d }

// SetBotTriggerIndex wires trigger-word dispatch (MM's outgoing-webhook trigger
// model). Optional — unset means bots fire on @mention only.
func (s *MessageService) SetBotTriggerIndex(i BotTriggerIndex) { s.botTriggers = i }

// SetBotContextResolver wires the channel/user name lookups that MM-shaped
// payloads carry. Optional — see BotContextResolver.
func (s *MessageService) SetBotContextResolver(r BotContextResolver) { s.botCtx = r }

// ErrInvalidCallbackURL is returned when an outgoing-webhook URL is not a safe,
// public https endpoint. Callers map it to a 400.
var ErrInvalidCallbackURL = errors.New("invalid callback URL")

// botWebhookClient POSTs events to external bots. It reuses safeDialContext (the
// same SSRF boundary the unfurler uses): connections are blocked at DIAL time,
// after DNS resolution, so a public hostname that resolves — or rebinds — to an
// internal address is still refused. Redirects are refused too. Together this
// closes the SSRF path where a callback points at the internal network and has
// the response echoed back into the chat.
var botWebhookClient = &http.Client{
	// Bounded: an external bot must answer promptly. A slow integration should
	// answer immediately and finish the work over a delayed response instead
	// (see the slash-command response_url in extcommand.go).
	Timeout: 25 * time.Second,
	Transport: &http.Transport{
		DialContext:         safeDialContext,
		TLSHandshakeTimeout: 5 * time.Second,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("webhook: redirects are not allowed")
	},
}

// validateCallbackURL enforces that an external bot's callback is a public https
// endpoint. Literal-IP hosts are rejected here if internal; DNS-name hosts are
// additionally re-checked at dial time (safeDialContext), defeating rebinding.
func validateCallbackURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidCallbackURL, err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("%w: must be https", ErrInvalidCallbackURL)
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("%w: missing host", ErrInvalidCallbackURL)
	}
	if ip := net.ParseIP(host); ip != nil && !isPublicIP(ip) {
		return fmt.Errorf("%w: host is not a public address", ErrInvalidCallbackURL)
	}
	return nil
}

// webhookBotHandler dispatches one event to an external bot's callback URL.
type webhookBotHandler struct {
	target BotWebhookTarget
	// resolver supplies the channel/user names MM's payload carries. Nil is fine
	// (those fields go out empty).
	resolver BotContextResolver
}

// External bots don't participate in thread continuity in v1 (only @mention or
// trigger word).
func (webhookBotHandler) OwnsThread(context.Context, string) bool { return false }

func (h webhookBotHandler) Handle(ctx context.Context, ev BotEvent) (BotReply, error) {
	req, err := h.buildRequest(ctx, ev)
	if err != nil {
		return BotReply{}, err
	}
	res, err := botWebhookClient.Do(req)
	if err != nil {
		return BotReply{}, err
	}
	defer func() { _, _ = io.Copy(io.Discard, res.Body); _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return BotReply{}, fmt.Errorf("bot webhook: status %d", res.StatusCode)
	}
	return decodeBotReply(res.Body)
}

// buildRequest encodes the event in whichever wire format this bot speaks.
func (h webhookBotHandler) buildRequest(ctx context.Context, ev BotEvent) (*http.Request, error) {
	if h.target.Transport.Normalized() == model.BotTransportMattermost {
		return h.buildMattermostRequest(ctx, ev)
	}
	return h.buildExRequest(ctx, ev)
}

// buildExRequest encodes ex's own JSON event, signed with an HMAC header.
func (h webhookBotHandler) buildExRequest(ctx context.Context, ev BotEvent) (*http.Request, error) {
	// Every value is a string, so this marshal cannot fail — no error guard, which
	// would be unreachable (and uncoverable) code.
	body, _ := json.Marshal(map[string]any{
		"bot_user_id":  ev.BotUserID,
		"user_id":      ev.AskerID, // attested by ex (signed); NOT a credential
		"channel_id":   ev.ParentID,
		"channel_type": ev.ParentType,
		"root_id":      ev.RootMessageID,
		"post_id":      ev.MessageID,
		"trigger_word": ev.TriggerWord,
		"text":         ev.Prompt,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.target.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if h.target.Secret != "" {
		// Slack-style signing: HMAC over "<timestamp>:<body>", so the signature
		// is bound to a moment and the receiver can reject replays outside a
		// freshness window (compare X-Ex-Signature in constant time).
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		mac := hmac.New(sha256.New, []byte(h.target.Secret))
		mac.Write([]byte(ts))
		mac.Write([]byte(":"))
		mac.Write(body)
		req.Header.Set("X-Ex-Timestamp", ts)
		req.Header.Set("X-Ex-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	return req, nil
}

// buildMattermostRequest encodes Mattermost's outgoing-webhook payload: an
// application/x-www-form-urlencoded body whose `token` field is the shared
// secret. Field names and semantics match MM's own outgoing webhooks so an
// existing receiver needs no changes.
//
// Two fields are ex approximations, both documented in mmcompat.go: team_id /
// team_domain are synthetic (ex has no teams) and user_name is derived from the
// user's email. Receivers must key on user_id, not user_name.
func (h webhookBotHandler) buildMattermostRequest(ctx context.Context, ev BotEvent) (*http.Request, error) {
	mc := resolveMMContext(ctx, h.resolver, ev.ParentID, ev.ParentType, ev.AskerID)
	form := url.Values{}
	form.Set("token", h.target.Secret)
	form.Set("team_id", MMSyntheticTeamID)
	form.Set("team_domain", MMSyntheticTeamDomain)
	form.Set("channel_id", ev.ParentID)
	form.Set("channel_name", mc.ChannelSlug)
	form.Set("user_id", ev.AskerID)
	form.Set("user_name", mc.UserName)
	form.Set("post_id", ev.MessageID)
	form.Set("text", ev.Prompt)
	form.Set("trigger_word", ev.TriggerWord)
	// Milliseconds, not seconds: MM's docs show a seconds example, but a real
	// server (verified against MM 11.9) sends epoch milliseconds here.
	form.Set("timestamp", strconv.FormatInt(time.Now().UnixMilli(), 10))
	// MM's outgoing webhooks have no thread field; ex adds root_id so a receiver
	// that wants thread context can use it. An MM receiver ignores unknown fields.
	form.Set("root_id", ev.RootMessageID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.target.URL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	return req, nil
}

// botReplyWire is the MM/Slack-style response both transports return.
type botReplyWire struct {
	Text         string                    `json:"text"`
	ResponseType string                    `json:"response_type"` // "ephemeral" | "in_channel"
	Username     string                    `json:"username"`
	IconURL      string                    `json:"icon_url"`
	IconEmoji    string                    `json:"icon_emoji"`
	Attachments  []model.MessageAttachment `json:"attachments"`
}

// botReplyMaxBytes bounds how much of a bot's response ex will read. An
// integration is not trusted to be well-behaved, and the reply becomes a message
// row, so the body is capped before decoding.
const botReplyMaxBytes = 1 << 20

func decodeBotReply(r io.Reader) (BotReply, error) {
	var w botReplyWire
	// A malformed or empty body is not an error: an integration that did the work
	// and has nothing to say answers 200 with no JSON, which must post nothing
	// rather than surface a failure message in the channel.
	_ = json.NewDecoder(io.LimitReader(r, botReplyMaxBytes)).Decode(&w)
	return BotReply{
		Text:        w.Text,
		Attachments: w.Attachments,
		Username:    w.Username,
		IconURL:     w.IconURL,
		IconEmoji:   w.IconEmoji,
		Ephemeral:   strings.EqualFold(strings.TrimSpace(w.ResponseType), MMResponseTypeEphemeral),
	}, nil
}
