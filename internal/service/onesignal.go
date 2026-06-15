package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const defaultOneSignalNotificationsURL = "https://api.onesignal.com/notifications?c=push"

type OneSignalConfig struct {
	AppID      string
	APIKey     string
	PublicURL  string
	APIURL     string
	HTTPClient *http.Client
}

type OneSignalPushSender struct {
	appID     string
	apiKey    string
	publicURL *url.URL
	apiURL    string
	client    *http.Client
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
	return &OneSignalPushSender{
		appID:     strings.TrimSpace(cfg.AppID),
		apiKey:    strings.TrimSpace(cfg.APIKey),
		publicURL: publicURL,
		apiURL:    apiURL,
		client:    client,
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
	body, err := json.Marshal(payload)
	if err != nil { // coverage-ignore: oneSignalNotificationRequest is composed solely of strings and string maps/slices; json.Marshal of such scalar data cannot fail.
		return fmt.Errorf("onesignal: marshal request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.apiURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("onesignal: create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Key "+s.apiKey)
	res, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("onesignal: send request: %w", err)
	}
	defer func() { _, _ = io.Copy(io.Discard, res.Body); _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("onesignal: request failed with status %d", res.StatusCode)
	}
	return nil
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
