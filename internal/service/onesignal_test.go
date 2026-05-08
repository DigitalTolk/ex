package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
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
	if got.URL != "https://chat.example.com/base/channel/general?thread=root-1#msg-root-1" {
		t.Fatalf("url = %q", got.URL)
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
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var got oneSignalNotificationRequest
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		gotURLs = append(gotURLs, got.URL)
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
		t.Fatalf("absolute URL = %q", gotURLs[0])
	}
	if gotURLs[1] != "https://chat.example.com" {
		t.Fatalf("empty deep link URL = %q", gotURLs[1])
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
