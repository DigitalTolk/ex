package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/cenkalti/backoff/v5"
)

// ErrPushUndeliverable marks a push failure that retrying cannot fix — a 4xx
// from the push provider, most commonly "no registered device for this user"
// (the user never installed/enabled the mobile app, or their device token
// lapsed). The async worker logs these LOUDLY (ERROR), because for an incident
// channel it means the offline fallback produced no alert at all and a human
// should know that recipient is unreachable on mobile. Transient failures
// (network blip / 5xx) that merely exhausted retries stay at WARN.
var ErrPushUndeliverable = errors.New("push undeliverable (no device / rejected by provider)")

const defaultOneSignalNotificationsURL = "https://api.onesignal.com/notifications?c=push"

// oneSignalResponseLimit bounds how much of the (normally tiny) create-
// notification response body is read for the accepted-but-undelivered check.
const oneSignalResponseLimit = 64 << 10

// oneSignalCreateResponse is the slice of OneSignal's create-notification
// response the delivery check needs: a non-empty id means a notification was
// created for at least one target; errors carries the reason when it wasn't
// (shape varies — string array or object — so it stays raw).
type oneSignalCreateResponse struct {
	ID     string          `json:"id"`
	Errors json.RawMessage `json:"errors"`
}

// classifyOneSignalAccepted decides whether a 2xx response actually created a
// notification. Fail-open on unreadable/unparseable bodies (treated as
// delivered): a retry after a body-transport hiccup would double-push, and a
// provider format drift must not turn every success into a retry storm.
func classifyOneSignalAccepted(body []byte, readErr error) error {
	if readErr != nil {
		return nil
	}
	var parsed oneSignalCreateResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil
	}
	if parsed.ID != "" {
		// A notification exists — delivered (partial per-target errors with a
		// created id are the provider's problem to report, not a total miss).
		return nil
	}
	if len(parsed.Errors) > 0 {
		// Accepted-but-created-nothing: for a single-recipient send this means
		// THIS recipient is unreachable (no subscription / invalid alias).
		// Retrying the identical request cannot fix it — permanent.
		return backoff.Permanent(fmt.Errorf("onesignal: accepted but undelivered: %s: %w", string(parsed.Errors), ErrPushUndeliverable))
	}
	return nil
}

// defaultOneSignalRetries / defaultOneSignalRetryInterval bound the retry of a
// transient OneSignal failure (network error or 5xx). A push that loses to a
// blip would otherwise just vanish; 4xx responses are permanent and not retried.
const (
	defaultOneSignalRetries       = 3
	defaultOneSignalRetryInterval = 250 * time.Millisecond
)

type OneSignalConfig struct {
	AppID      string
	APIKey     string
	PublicURL  string
	APIURL     string
	HTTPClient *http.Client
	// MaxRetries / RetryInterval override the transient-failure retry policy.
	// Zero values fall back to the defaults; tests set RetryInterval tiny so the
	// retry path runs instantly.
	MaxRetries    int
	RetryInterval time.Duration
}

type OneSignalPushSender struct {
	appID         string
	apiKey        string
	publicURL     *url.URL
	apiURL        string
	client        *http.Client
	maxRetries    uint64
	retryInterval time.Duration
}

func NewOneSignalPushSender(cfg OneSignalConfig) (*OneSignalPushSender, error) {
	if strings.TrimSpace(cfg.AppID) == "" || strings.TrimSpace(cfg.APIKey) == "" {
		return nil, nil
	}
	publicURL, err := url.Parse(strings.TrimSpace(cfg.PublicURL))
	if err != nil || publicURL.Scheme == "" || publicURL.Host == "" {
		return nil, fmt.Errorf("onesignal: invalid public URL")
	}
	apiURL := strings.TrimSpace(cfg.APIURL)
	if apiURL == "" {
		apiURL = defaultOneSignalNotificationsURL
	}
	if _, err := url.ParseRequestURI(apiURL); err != nil {
		return nil, fmt.Errorf("onesignal: invalid API URL: %w", err)
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	retries := uint64(defaultOneSignalRetries)
	if cfg.MaxRetries > 0 {
		retries = uint64(cfg.MaxRetries)
	}
	interval := cfg.RetryInterval
	if interval <= 0 {
		interval = defaultOneSignalRetryInterval
	}
	return &OneSignalPushSender{
		appID:         strings.TrimSpace(cfg.AppID),
		apiKey:        strings.TrimSpace(cfg.APIKey),
		publicURL:     publicURL,
		apiURL:        apiURL,
		client:        client,
		maxRetries:    retries,
		retryInterval: interval,
	}, nil
}

func (s *OneSignalPushSender) Send(ctx context.Context, recipientUserID string, n Notification) error {
	if s == nil {
		return nil
	}
	recipientUserID = strings.TrimSpace(recipientUserID)
	if recipientUserID == "" {
		return nil
	}
	payload := oneSignalNotificationRequest{
		AppID:         s.appID,
		TargetChannel: "push",
		IncludeAliases: map[string][]string{
			"external_id": {oneSignalExternalID(recipientUserID)},
		},
		Headings: map[string]string{"en": n.Title},
		Contents: map[string]string{"en": n.Body},
		Data: map[string]string{
			"url":               s.absoluteURL(n.DeepLink),
			"kind":              string(n.Kind),
			"parent_id":         n.ParentID,
			"parent_type":       n.ParentType,
			"message_id":        n.MessageID,
			"parent_message_id": n.ParentMessageID,
		},
	}
	body := mustJSONBody(json.Marshal(payload))
	// Retry transient failures (network error / 5xx); 4xx is permanent. A push
	// that loses to a momentary blip would otherwise just disappear.
	attempt := func() error {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.apiURL, bytes.NewReader(body))
		if err != nil {
			return backoff.Permanent(fmt.Errorf("onesignal: create request: %w", err))
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Key "+s.apiKey)
		res, err := s.client.Do(req)
		if err != nil {
			return fmt.Errorf("onesignal: send request: %w", err)
		}
		defer func() { _, _ = io.Copy(io.Discard, res.Body); _ = res.Body.Close() }()
		if res.StatusCode >= 500 {
			return fmt.Errorf("onesignal: request failed with status %d", res.StatusCode)
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			// 4xx: permanent. Tag it ErrPushUndeliverable so the caller can tell
			// "this recipient cannot receive a push" (e.g. no registered device)
			// from a transient failure and escalate accordingly.
			return backoff.Permanent(fmt.Errorf("onesignal: request failed with status %d: %w", res.StatusCode, ErrPushUndeliverable))
		}
		// 2xx is NOT proof of delivery: OneSignal answers 200 with an empty
		// "id" and an "errors" payload when the target has no push
		// subscription (never registered / stale token) — the most common
		// real-world miss, previously recorded as success and never logged.
		// Parse the body and surface that as undeliverable so the worker's
		// ERROR-loudness contract covers it.
		return classifyOneSignalAccepted(io.ReadAll(io.LimitReader(res.Body, oneSignalResponseLimit)))
	}
	_, err := backoff.Retry(ctx, func() (struct{}, error) { return struct{}{}, attempt() },
		backoff.WithBackOff(backoff.NewConstantBackOff(s.retryInterval)),
		backoff.WithMaxTries(uint(s.maxRetries)+1))
	return err
}

func (s *OneSignalPushSender) absoluteURL(deepLink string) string {
	if strings.TrimSpace(deepLink) == "" {
		return s.publicURL.String()
	}
	u, err := url.Parse(deepLink)
	if err == nil && u.IsAbs() {
		return u.String()
	}
	base := *s.publicURL
	base.RawQuery = ""
	base.Fragment = ""
	if parsed, err := url.Parse(deepLink); err == nil {
		base.Path = strings.TrimRight(base.Path, "/") + "/" + strings.TrimLeft(parsed.Path, "/")
		base.RawQuery = parsed.RawQuery
		base.Fragment = parsed.Fragment
	} else {
		base.Path = strings.TrimRight(base.Path, "/") + "/" + strings.TrimLeft(deepLink, "/")
	}
	return base.String()
}

func oneSignalExternalID(userID string) string {
	return userID
}

type oneSignalNotificationRequest struct {
	AppID          string              `json:"app_id"`
	TargetChannel  string              `json:"target_channel"`
	IncludeAliases map[string][]string `json:"include_aliases"`
	Headings       map[string]string   `json:"headings"`
	Contents       map[string]string   `json:"contents"`
	URL            string              `json:"url,omitempty"`
	Data           map[string]string   `json:"data,omitempty"`
}

var _ MobilePushSender = (*OneSignalPushSender)(nil)
