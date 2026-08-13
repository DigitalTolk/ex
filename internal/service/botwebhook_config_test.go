package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// ConfigureWebhook and the BotDirectory lookup it feeds. The bot's outgoing-webhook
// config is what makes it dispatchable, so these cover both the accept and the
// refuse paths, plus the fail-closed behaviour on retirement.

func setupBotService(t *testing.T) (*BotService, *fakeBotStore) {
	t.Helper()
	bots := newFakeBotStore()
	users := newMockUserStore()
	return NewBotService(bots, users), bots
}

func seedWebhookBot(t *testing.T, bots *fakeBotStore, id string) {
	t.Helper()
	if err := bots.CreateBot(context.Background(), &model.BotAccount{UserID: id, Name: "Helper"}); err != nil {
		t.Fatalf("seed bot: %v", err)
	}
}

func TestConfigureWebhook(t *testing.T) {
	ctx := context.Background()

	t.Run("sets a callback, mints a secret, and normalizes the transport", func(t *testing.T) {
		svc, bots := setupBotService(t)
		seedWebhookBot(t, bots, "bot_a")
		secret, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{
			CallbackURL:  "https://bot.example.com/hook",
			TriggerWords: []string{"Deploy", "deploy", "status"},
			TriggerWhen:  model.BotTriggerWhenContains,
		})
		if err != nil {
			t.Fatalf("ConfigureWebhook: %v", err)
		}
		if secret == "" {
			t.Fatal("no signing secret returned; the receiver could never verify a call")
		}
		stored, err := bots.GetBot(ctx, "bot_a")
		if err != nil {
			t.Fatalf("GetBot: %v", err)
		}
		if stored.Transport != model.BotTransportEx {
			t.Errorf("Transport = %q, want the default resolved to %q", stored.Transport, model.BotTransportEx)
		}
		if len(stored.TriggerWords) != 2 {
			t.Errorf("TriggerWords = %+v, want deduped and lowercased", stored.TriggerWords)
		}
		if stored.TriggerWhen != model.BotTriggerWhenContains {
			t.Errorf("TriggerWhen = %d, want contains", stored.TriggerWhen)
		}
	})

	t.Run("keeps the existing secret when reconfiguring", func(t *testing.T) {
		// Rotating the secret on every edit would silently break a working receiver.
		svc, bots := setupBotService(t)
		seedWebhookBot(t, bots, "bot_a")
		first, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{CallbackURL: "https://bot.example.com/hook"})
		if err != nil {
			t.Fatalf("ConfigureWebhook: %v", err)
		}
		second, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{
			CallbackURL: "https://bot.example.com/hook2",
			Transport:   model.BotTransportMattermost,
		})
		if err != nil {
			t.Fatalf("ConfigureWebhook: %v", err)
		}
		if first != second {
			t.Errorf("secret changed on reconfigure: %q → %q", first, second)
		}
	})

	t.Run("clearing the URL clears the secret, transport, and triggers", func(t *testing.T) {
		// Otherwise a re-enabled bot would silently resurrect an old transport.
		svc, bots := setupBotService(t)
		seedWebhookBot(t, bots, "bot_a")
		if _, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{
			CallbackURL:  "https://bot.example.com/hook",
			Transport:    model.BotTransportMattermost,
			TriggerWords: []string{"deploy"},
			TriggerWhen:  model.BotTriggerWhenContains,
		}); err != nil {
			t.Fatalf("ConfigureWebhook: %v", err)
		}
		secret, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{CallbackURL: ""})
		if err != nil {
			t.Fatalf("ConfigureWebhook(clear): %v", err)
		}
		if secret != "" {
			t.Errorf("secret = %q, want empty after clearing", secret)
		}
		stored, _ := bots.GetBot(ctx, "bot_a")
		if stored.CallbackSecret != "" || stored.Transport != "" ||
			len(stored.TriggerWords) != 0 || stored.TriggerWhen != model.BotTriggerWhenStartsWith {
			t.Errorf("stored = %+v, want everything webhook-related cleared", stored)
		}
	})

	t.Run("rejects an unsafe callback URL", func(t *testing.T) {
		svc, bots := setupBotService(t)
		seedWebhookBot(t, bots, "bot_a")
		_, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{CallbackURL: "http://127.0.0.1/hook"})
		if !errors.Is(err, ErrInvalidCallbackURL) {
			t.Fatalf("err = %v, want ErrInvalidCallbackURL", err)
		}
	})

	t.Run("rejects an unknown transport", func(t *testing.T) {
		svc, bots := setupBotService(t)
		seedWebhookBot(t, bots, "bot_a")
		_, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{
			CallbackURL: "https://bot.example.com/hook", Transport: model.BotTransport("slack"),
		})
		if !errors.Is(err, ErrInvalidTransport) {
			t.Fatalf("err = %v, want ErrInvalidTransport", err)
		}
	})

	t.Run("rejects unusable trigger words", func(t *testing.T) {
		svc, bots := setupBotService(t)
		seedWebhookBot(t, bots, "bot_a")
		_, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{
			CallbackURL: "https://bot.example.com/hook", TriggerWords: []string{"two words"},
		})
		if !errors.Is(err, ErrInvalidTriggerWord) {
			t.Fatalf("err = %v, want ErrInvalidTriggerWord", err)
		}
	})

	t.Run("rejects triggers with no callback to dispatch to", func(t *testing.T) {
		// Accepting them would show configured triggers that can never fire.
		svc, bots := setupBotService(t)
		seedWebhookBot(t, bots, "bot_a")
		_, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{TriggerWords: []string{"deploy"}})
		if !errors.Is(err, ErrTriggerWordsNeedCallback) {
			t.Fatalf("err = %v, want ErrTriggerWordsNeedCallback", err)
		}
	})

	t.Run("an unknown bot is a not-found", func(t *testing.T) {
		svc, _ := setupBotService(t)
		_, err := svc.ConfigureWebhook(ctx, "bot_missing", BotWebhookConfig{CallbackURL: "https://bot.example.com/hook"})
		if !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})
}

func TestWebhookBotLookup(t *testing.T) {
	ctx := context.Background()
	svc, bots := setupBotService(t)
	seedWebhookBot(t, bots, "bot_a")

	// No callback configured → not dispatchable.
	if _, ok := svc.WebhookBot(ctx, "bot_a"); ok {
		t.Error("a bot with no callback URL must not resolve as a webhook bot")
	}
	if _, ok := svc.WebhookBot(ctx, "bot_missing"); ok {
		t.Error("an unknown bot must not resolve")
	}

	if _, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{
		CallbackURL:  "https://bot.example.com/hook",
		Transport:    model.BotTransportMattermost,
		TriggerWords: []string{"deploy"},
		TriggerWhen:  model.BotTriggerWhenContains,
	}); err != nil {
		t.Fatalf("ConfigureWebhook: %v", err)
	}
	target, ok := svc.WebhookBot(ctx, "bot_a")
	if !ok {
		t.Fatal("a configured bot must resolve as a webhook bot")
	}
	if target.Transport != model.BotTransportMattermost || target.TriggerWhen != model.BotTriggerWhenContains {
		t.Errorf("target = %+v, want the stored transport and trigger mode", target)
	}
	if len(target.TriggerWords) != 1 || target.TriggerWords[0] != "deploy" {
		t.Errorf("TriggerWords = %+v", target.TriggerWords)
	}
	if target.Name != "Helper" || target.Secret == "" {
		t.Errorf("target = %+v, want the bot's name and secret", target)
	}
}
