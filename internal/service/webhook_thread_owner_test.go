package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Regression: every channel webhook posts as the shared "webhook" sentinel,
// and the thread-root check compared only the author — so ANY webhook into a
// channel (an unauthenticated URL) could reply inside another webhook's
// threads. The root must have been posted by this very webhook.
func TestIncomingWebhookService_ExecuteMessageRejectsAnotherWebhooksRoot(t *testing.T) {
	ctx := context.Background()
	svc, messages, _ := newWebhookThreadFixture()
	webhooks := svc.store.(*fakeWebhookStore)
	webhooks.items["wh-other"] = &model.IncomingWebhook{ID: "wh-other", ChannelID: "ch-1", LockToChannel: true, Username: "other-bot", CreatedAt: time.Now()}

	foreign, err := svc.ExecuteMessage(ctx, "wh-other", IncomingWebhookPayload{Text: "another integration's alert"})
	if err != nil {
		t.Fatalf("ExecuteMessage foreign root: %v", err)
	}
	if foreign.WebhookID != "wh-other" {
		t.Fatalf("root WebhookID = %q, want the posting webhook's id", foreign.WebhookID)
	}
	before := len(messages.messages)

	if _, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Text: "hijack", RootID: foreign.ID}); !errors.Is(err, ErrInvalidThreadRoot) {
		t.Fatalf("err = %v, want ErrInvalidThreadRoot for another webhook's root", err)
	}
	if len(messages.messages) != before {
		t.Fatal("a rejected reply was stored")
	}

	// Its own webhook still continues the thread.
	if _, err := svc.ExecuteMessage(ctx, "wh-other", IncomingWebhookPayload{Text: "update", RootID: foreign.ID}); err != nil {
		t.Fatalf("owning webhook reply: %v", err)
	}
}

// A channel root from before webhook ids were stamped carries only the shared
// sentinel — nothing proves which webhook posted it, so once it is no longer
// recent (this one has no creation time at all) no webhook may thread under
// it. A DM bot account is already one per webhook, so its legacy roots (no
// id) stay continuable by that bot.
func TestCheckWebhookThreadRoot_LegacyRoots(t *testing.T) {
	ctx := context.Background()
	messages := newMockMessageStore()
	svc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	messages.messages["ch-1#legacy"] = &model.Message{ID: "legacy", ParentID: "ch-1", AuthorID: WebhookAuthorID}
	messages.messages["dm-1#legacy-dm"] = &model.Message{ID: "legacy-dm", ParentID: "dm-1", AuthorID: "bot-1"}
	messages.messages["dm-1#other-wh"] = &model.Message{ID: "other-wh", ParentID: "dm-1", AuthorID: "bot-1", WebhookID: "wh-2"}

	if err := svc.checkWebhookThreadRoot(ctx, "ch-1", "legacy", WebhookAuthorID, "wh-1"); !errors.Is(err, ErrInvalidThreadRoot) {
		t.Fatalf("legacy sentinel root: err = %v, want ErrInvalidThreadRoot", err)
	}
	if err := svc.checkWebhookThreadRoot(ctx, "dm-1", "legacy-dm", "bot-1", "wh-1"); err != nil {
		t.Fatalf("legacy DM-bot root: err = %v, want nil", err)
	}
	if err := svc.checkWebhookThreadRoot(ctx, "dm-1", "other-wh", "bot-1", "wh-1"); !errors.Is(err, ErrInvalidThreadRoot) {
		t.Fatalf("DM root stamped by another webhook: err = %v, want ErrInvalidThreadRoot", err)
	}
}

// Roots posted before webhook ids were stamped can't prove which webhook
// posted them. Refusing every one of them would drop an alert's follow-up
// (a "resolved" reply) for a thread started just before the deploy, so a
// recent one is still continued. New roots are always stamped, so the window
// closes by itself legacyWebhookRootGrace after the deploy.
func TestCheckWebhookThreadRoot_RecentLegacySentinelRoots(t *testing.T) {
	ctx := context.Background()
	messages := newMockMessageStore()
	svc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	messages.messages["ch-1#recent"] = &model.Message{ID: "recent", ParentID: "ch-1", AuthorID: WebhookAuthorID, CreatedAt: time.Now().Add(-48 * time.Hour)}
	messages.messages["ch-1#old"] = &model.Message{ID: "old", ParentID: "ch-1", AuthorID: WebhookAuthorID, CreatedAt: time.Now().Add(-legacyWebhookRootGrace - time.Hour)}
	messages.messages["ch-1#stamped"] = &model.Message{ID: "stamped", ParentID: "ch-1", AuthorID: WebhookAuthorID, WebhookID: "wh-2", CreatedAt: time.Now()}

	if err := svc.checkWebhookThreadRoot(ctx, "ch-1", "recent", WebhookAuthorID, "wh-1"); err != nil {
		t.Fatalf("recent unstamped root: err = %v, want nil", err)
	}
	if err := svc.checkWebhookThreadRoot(ctx, "ch-1", "old", WebhookAuthorID, "wh-1"); !errors.Is(err, ErrInvalidThreadRoot) {
		t.Fatalf("old unstamped root: err = %v, want ErrInvalidThreadRoot", err)
	}
	if err := svc.checkWebhookThreadRoot(ctx, "ch-1", "stamped", WebhookAuthorID, "wh-1"); !errors.Is(err, ErrInvalidThreadRoot) {
		t.Fatalf("another webhook's stamped root: err = %v, want ErrInvalidThreadRoot", err)
	}
}
