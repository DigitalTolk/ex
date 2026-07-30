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
)

// Outgoing-webhook transport: lets an EXTERNAL service be a bot. When a bot has a
// callback URL, an @mention event is POSTed to it (HMAC-signed) and its response
// is posted back — the generic way third-party bots integrate. It implements the
// same BotHandler role as an in-process bot, over HTTP. Identity per
// docs/rfc-generic-bots-mcp.md §5: the event carries the attested asker id; the
// reply posts back as the bot, access-checked against the asker.

// BotWebhookTarget is an external bot's outgoing-webhook config.
type BotWebhookTarget struct {
	URL    string
	Secret string
	Name   string
}

// BotDirectory resolves a bot user id to its outgoing-webhook config (if any).
// Satisfied by *BotService.
type BotDirectory interface {
	WebhookBot(ctx context.Context, botUserID string) (BotWebhookTarget, bool)
}

// SetBotDirectory wires the external-bot resolver so mentions of webhook bots are
// dispatched over HTTP. Optional — unset means only in-process bots run.
func (s *MessageService) SetBotDirectory(d BotDirectory) { s.botDir = d }

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
	// Bounded: an external bot must answer promptly (delayed replies via a
	// response_url callback are a later enhancement).
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
}

// External bots don't participate in thread continuity in v1 (only @mention).
func (webhookBotHandler) OwnsThread(context.Context, string) bool { return false }

func (h webhookBotHandler) Handle(ctx context.Context, ev BotEvent) (string, error) {
	// ex's own JSON event contract (docs/rfc-generic-bots-mcp.md §9) — NOT
	// Mattermost's form-encoded outgoing-webhook shape. Only the REPLY contract
	// (text + response_type) is MM/Slack-style; the request is bespoke and
	// authenticated by an HMAC signature rather than a body token.
	body, _ := json.Marshal(map[string]any{
		"bot_user_id":  ev.BotUserID,
		"user_id":      ev.AskerID, // attested by ex (signed); NOT a credential
		"channel_id":   ev.ParentID,
		"channel_type": ev.ParentType,
		"root_id":      ev.RootMessageID,
		"text":         ev.Prompt,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.target.URL, bytes.NewReader(body))
	if err != nil {
		return "", err
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

	res, err := botWebhookClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _, _ = io.Copy(io.Discard, res.Body); _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("bot webhook: status %d", res.StatusCode)
	}

	var out struct {
		Text         string `json:"text"`
		ResponseType string `json:"response_type"` // MM/Slack: "ephemeral" | "in_channel"
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out)
	if strings.EqualFold(strings.TrimSpace(out.ResponseType), "ephemeral") {
		return "", nil // ephemeral replies aren't posted publicly (v1)
	}
	return out.Text, nil
}
