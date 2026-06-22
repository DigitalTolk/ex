package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func resp(code int) *http.Response {
	return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader("{}")), Header: make(http.Header)}
}

func newRetrySender(t *testing.T, maxRetries int, rt roundTripFunc) *OneSignalPushSender {
	t.Helper()
	s, err := NewOneSignalPushSender(OneSignalConfig{
		AppID: "app", APIKey: "key", PublicURL: "https://chat.example.com/",
		APIURL: "https://api.onesignal.test/notifications", HTTPClient: &http.Client{Transport: rt},
		MaxRetries: maxRetries, RetryInterval: time.Nanosecond,
	})
	if err != nil {
		t.Fatalf("NewOneSignalPushSender: %v", err)
	}
	return s
}

func TestOneSignalPushSender_RetriesTransientThenSucceeds(t *testing.T) {
	var calls int
	s := newRetrySender(t, 3, func(*http.Request) (*http.Response, error) {
		calls++
		if calls < 3 {
			return resp(http.StatusServiceUnavailable), nil // 5xx → retryable
		}
		return resp(http.StatusOK), nil
	})
	if err := s.Send(context.Background(), "u-1", Notification{}); err != nil {
		t.Fatalf("Send after transient 5xx: %v", err)
	}
	if calls != 3 {
		t.Errorf("calls = %d, want 3 (2 retries then success)", calls)
	}
}

func TestOneSignalPushSender_RetryExhaustsOn5xx(t *testing.T) {
	var calls int
	s := newRetrySender(t, 2, func(*http.Request) (*http.Response, error) {
		calls++
		return resp(http.StatusBadGateway), nil
	})
	if err := s.Send(context.Background(), "u-1", Notification{}); err == nil {
		t.Fatal("expected error after exhausting retries")
	}
	if calls != 3 {
		t.Errorf("calls = %d, want 3 (initial + 2 retries)", calls)
	}
}

func TestOneSignalPushSender_4xxIsPermanentNoRetry(t *testing.T) {
	var calls int
	s := newRetrySender(t, 3, func(*http.Request) (*http.Response, error) {
		calls++
		return resp(http.StatusBadRequest), nil
	})
	if err := s.Send(context.Background(), "u-1", Notification{}); err == nil {
		t.Fatal("expected error for 4xx")
	}
	if calls != 1 {
		t.Errorf("calls = %d, want 1 (4xx is permanent, no retry)", calls)
	}
}

func TestOneSignalPushSender_RetriesNetworkError(t *testing.T) {
	var calls int
	s := newRetrySender(t, 1, func(*http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("dial timeout")
	})
	if err := s.Send(context.Background(), "u-1", Notification{}); err == nil {
		t.Fatal("expected error after network failures")
	}
	if calls != 2 {
		t.Errorf("calls = %d, want 2 (initial + 1 retry)", calls)
	}
}

func TestOneSignalPushSender_RequestConstruction(t *testing.T) {
	var gotAuth string
	var gotURL string
	var got oneSignalNotificationRequest
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		gotAuth = r.Header.Get("Authorization")
		gotURL = r.URL.String()
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q", r.Header.Get("Content-Type"))
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"id":"notif-1"}`)),
			Header:     make(http.Header),
		}, nil
	})}

	sender, err := NewOneSignalPushSender(OneSignalConfig{
		AppID:      "app-id",
		APIKey:     "secret-key",
		PublicURL:  "https://chat.example.com/base/",
		APIURL:     "https://api.onesignal.test/notifications?c=push",
		HTTPClient: client,
	})
	if err != nil {
		t.Fatalf("NewOneSignalPushSender: %v", err)
	}
	err = sender.Send(context.Background(), "u-123", Notification{
		Kind:            NotificationKindThreadReply,
		Title:           "Alice replied in ~general",
		Body:            "Short preview",
		DeepLink:        "/channel/general?thread=root-1#msg-root-1",
		ParentID:        "ch-1",
		ParentType:      ParentChannel,
		MessageID:       "m-1",
		ParentMessageID: "root-1",
		AuthorID:        "u-author",
		CreatedAt:       time.Now(),
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	if gotAuth != "Key secret-key" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if gotURL != "https://api.onesignal.test/notifications?c=push" {
		t.Fatalf("url = %q", gotURL)
	}
	if got.AppID != "app-id" {
		t.Fatalf("app_id = %q", got.AppID)
	}
	if got.TargetChannel != "push" {
		t.Fatalf("target_channel = %q", got.TargetChannel)
	}
	if got.IncludeAliases["external_id"][0] != "u-123" {
		t.Fatalf("external_id alias = %#v", got.IncludeAliases)
	}
	if got.Headings["en"] != "Alice replied in ~general" {
		t.Fatalf("heading = %#v", got.Headings)
	}
	if got.Contents["en"] != "Short preview" {
		t.Fatalf("contents = %#v", got.Contents)
	}
	if got.URL != "" {
		t.Fatalf("top-level url = %q, want empty", got.URL)
	}
	if got.Data["url"] != "https://chat.example.com/base/channel/general?thread=root-1#msg-root-1" {
		t.Fatalf("data.url = %q", got.Data["url"])
	}
	if got.Data["message_id"] != "m-1" || got.Data["parent_message_id"] != "root-1" {
		t.Fatalf("data = %#v", got.Data)
	}
}

func TestOneSignalPushSender_MissingConfigDisables(t *testing.T) {
	sender, err := NewOneSignalPushSender(OneSignalConfig{
		AppID:     "",
		APIKey:    "secret",
		PublicURL: "https://chat.example.com",
	})
	if err != nil {
		t.Fatalf("NewOneSignalPushSender returned error for missing config: %v", err)
	}
	if sender != nil {
		t.Fatal("sender should be nil when required OneSignal config is missing")
	}
}

func TestOneSignalPushSender_InvalidConfig(t *testing.T) {
	if _, err := NewOneSignalPushSender(OneSignalConfig{
		AppID:     "app-id",
		APIKey:    "secret",
		PublicURL: "://bad-url",
	}); err == nil {
		t.Fatal("expected invalid public URL error")
	}
	if _, err := NewOneSignalPushSender(OneSignalConfig{
		AppID:     "app-id",
		APIKey:    "secret",
		PublicURL: "https://chat.example.com",
		APIURL:    "://bad-api-url",
	}); err == nil {
		t.Fatal("expected invalid API URL error")
	}
}

func TestOneSignalPushSender_NoopsForNilSenderAndEmptyRecipient(t *testing.T) {
	var nilSender *OneSignalPushSender
	if err := nilSender.Send(context.Background(), "u-1", Notification{}); err != nil {
		t.Fatalf("nil Send error = %v", err)
	}
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	sender, err := NewOneSignalPushSender(OneSignalConfig{
		AppID:      "app-id",
		APIKey:     "secret",
		PublicURL:  "https://chat.example.com",
		APIURL:     "https://api.onesignal.test/notifications",
		HTTPClient: client,
	})
	if err != nil {
		t.Fatalf("NewOneSignalPushSender: %v", err)
	}
	if err := sender.Send(context.Background(), " ", Notification{}); err != nil {
		t.Fatalf("empty recipient Send error = %v", err)
	}
	if calls != 0 {
		t.Fatalf("transport calls = %d, want 0", calls)
	}
}

func TestOneSignalPushSender_AbsoluteDeepLinkAndEmptyDeepLink(t *testing.T) {
	var gotURLs []string
	var gotTopLevelURLs []string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var got oneSignalNotificationRequest
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		gotURLs = append(gotURLs, got.Data["url"])
		gotTopLevelURLs = append(gotTopLevelURLs, got.URL)
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	sender, err := NewOneSignalPushSender(OneSignalConfig{
		AppID:      "app-id",
		APIKey:     "secret",
		PublicURL:  "https://chat.example.com",
		APIURL:     "https://api.onesignal.test/notifications",
		HTTPClient: client,
	})
	if err != nil {
		t.Fatalf("NewOneSignalPushSender: %v", err)
	}
	if err := sender.Send(context.Background(), "u-1", Notification{DeepLink: "https://chat.example.com/channel/general"}); err != nil {
		t.Fatalf("Send absolute: %v", err)
	}
	if err := sender.Send(context.Background(), "u-1", Notification{}); err != nil {
		t.Fatalf("Send empty: %v", err)
	}
	if gotURLs[0] != "https://chat.example.com/channel/general" {
		t.Fatalf("absolute data.url = %q", gotURLs[0])
	}
	if gotURLs[1] != "https://chat.example.com" {
		t.Fatalf("empty deep link data.url = %q", gotURLs[1])
	}
	if gotTopLevelURLs[0] != "" || gotTopLevelURLs[1] != "" {
		t.Fatalf("top-level urls = %#v, want empty", gotTopLevelURLs)
	}
}

func TestOneSignalPushSender_FailureReturnsSanitizedError(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusUnauthorized,
			Body:       io.NopCloser(strings.NewReader("private provider body")),
			Header:     make(http.Header),
		}, nil
	})}
	sender, err := NewOneSignalPushSender(OneSignalConfig{
		AppID:      "app-id",
		APIKey:     "secret-key",
		PublicURL:  "https://chat.example.com",
		APIURL:     "https://api.onesignal.test/notifications",
		HTTPClient: client,
	})
	if err != nil {
		t.Fatalf("NewOneSignalPushSender: %v", err)
	}
	err = sender.Send(context.Background(), "u-1", Notification{Title: "Title", Body: "Body", DeepLink: "/channel/general"})
	if err == nil {
		t.Fatal("expected error")
	}
	if got := err.Error(); got != "onesignal: request failed with status 401" {
		t.Fatalf("error = %q", got)
	}
}

func TestOneSignalPushSender_DefaultsAPIURLAndClient(t *testing.T) {
	sender, err := NewOneSignalPushSender(OneSignalConfig{
		AppID:     "app-id",
		APIKey:    "secret",
		PublicURL: "https://chat.example.com",
		// APIURL empty → default; HTTPClient nil → default client.
	})
	if err != nil {
		t.Fatalf("NewOneSignalPushSender: %v", err)
	}
	if sender == nil {
		t.Fatal("expected non-nil sender")
	}
	if sender.apiURL != defaultOneSignalNotificationsURL {
		t.Errorf("apiURL = %q, want default", sender.apiURL)
	}
	if sender.client == nil {
		t.Error("expected default http client")
	}
}

func TestOneSignalPushSender_NewRequestError(t *testing.T) {
	// Bypass the constructor's URL validation to drive an apiURL that
	// http.NewRequestWithContext rejects (a control character in the URL).
	u, _ := url.Parse("https://chat.example.com")
	sender := &OneSignalPushSender{
		appID:     "app-id",
		apiKey:    "secret",
		publicURL: u,
		apiURL:    "http://example.com/\x7f",
		client:    &http.Client{},
	}
	if err := sender.Send(context.Background(), "u-1", Notification{}); err == nil {
		t.Fatal("expected create-request error")
	}
}

func TestOneSignalPushSender_TransportError(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		return nil, errors.New("network down")
	})}
	sender, err := NewOneSignalPushSender(OneSignalConfig{
		AppID:      "app-id",
		APIKey:     "secret",
		PublicURL:  "https://chat.example.com",
		APIURL:     "https://api.onesignal.test/notifications",
		HTTPClient: client,
	})
	if err != nil {
		t.Fatalf("NewOneSignalPushSender: %v", err)
	}
	if err := sender.Send(context.Background(), "u-1", Notification{}); err == nil {
		t.Fatal("expected transport error")
	}
}

func TestOneSignalPushSender_AbsoluteURL_UnparsableDeepLinkFallback(t *testing.T) {
	u, _ := url.Parse("https://chat.example.com/base")
	sender := &OneSignalPushSender{publicURL: u}
	// A deep link that fails url.Parse routes through the else fallback that
	// appends the raw string to the base path.
	got := sender.absoluteURL("/a/b\x7f")
	if got == "" {
		t.Fatal("expected a non-empty fallback URL")
	}
}
