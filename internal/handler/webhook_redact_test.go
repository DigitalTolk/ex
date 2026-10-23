package handler

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// captureHandlerLogs routes slog output into a buffer for one test.
func captureHandlerLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// Regression: an incoming webhook's ID is its only credential, and both
// failure WARN lines printed it verbatim.
func TestWebhookExecuteFailureLogsNeverCarryTheWebhookID(t *testing.T) {
	const secretID = "wh-secret-777"
	general := &model.Channel{ID: "ch-general", Name: "General", Slug: "general"}
	channels := handlerWebhookChannels{
		byID:   map[string]*model.Channel{general.ID: general},
		bySlug: map[string]*model.Channel{general.Slug: general},
	}
	webhooks := &handlerWebhookStore{items: map[string]*model.IncomingWebhook{
		secretID: {ID: secretID, Title: "CI", ChannelID: general.ID, ChannelName: general.Name, ChannelSlug: general.Slug, Username: "ci-bot", CreatedBy: "creator-1"},
	}}
	msgSvc := service.NewMessageService(&handlerWebhookMessageStore{messages: map[string]*model.Message{}}, nil, nil, nil, nil)
	svc := service.NewIncomingWebhookService(webhooks, channels, msgSvc, nil, "")
	svc.SetDMResolver(handlerWebhookDMs{})
	svc.SetUserResolver(handlerWebhookUsers{})
	svc.SetBotProvisioner(handlerWebhookBotsDown{})
	h := NewWebhookHandler(svc)

	for name, body := range map[string]string{
		"generic failure":   `{"text":"` + strings.Repeat("a", 100_001) + `"}`,
		"transient failure": `{"text":"build failed","channel":"bob@example.com"}`,
	} {
		logs := captureHandlerLogs(t)
		req := httptest.NewRequest(http.MethodPost, "/hooks/"+secretID, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.SetPathValue("id", secretID)
		rec := httptest.NewRecorder()
		h.Execute(rec, req)
		if rec.Code < 400 {
			t.Fatalf("%s: status %d, want a failure", name, rec.Code)
		}
		if !strings.Contains(logs.String(), "webhook execute") {
			t.Fatalf("%s: expected a WARN line, got %q", name, logs.String())
		}
		if strings.Contains(logs.String(), secretID) {
			t.Fatalf("%s: log leaked the webhook id: %q", name, logs.String())
		}
	}
}
