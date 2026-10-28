package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

func asAdmin(id string) WebhookActor  { return WebhookActor{ID: id, Role: model.SystemRoleAdmin} }
func asMember(id string) WebhookActor { return WebhookActor{ID: id, Role: model.SystemRoleMember} }

// webhookOwnerFixture: a public channel, a private channel "alice" belongs
// to, and one webhook each by alice and bob.
func webhookOwnerFixture() (*IncomingWebhookService, *fakeWebhookStore) {
	pub := &model.Channel{ID: "ch-pub", Name: "builds", Slug: "builds", Type: model.ChannelTypePublic}
	priv := &model.Channel{ID: "ch-priv", Name: "ops", Slug: "ops", Type: model.ChannelTypePrivate}
	webhooks := &fakeWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh-alice": {ID: "wh-alice", Title: "Alice CI", ChannelID: pub.ID, CreatedBy: "alice"},
		"wh-bob":   {ID: "wh-bob", Title: "Bob CI", ChannelID: pub.ID, CreatedBy: "bob"},
	}}
	svc := NewIncomingWebhookService(webhooks, fakeWebhookChannels{
		byID: map[string]*model.Channel{pub.ID: pub, priv.ID: priv},
	}, nil, fakeWebhookImageProxy{}, "https://chat.example")
	svc.SetMembershipResolver(fakeWebhookMemberships{members: map[string]bool{"ch-priv|alice": true}})
	return svc, webhooks
}

func webhookTitles(items []*model.IncomingWebhook) map[string]bool {
	out := map[string]bool{}
	for _, wh := range items {
		out[wh.Title] = true
	}
	return out
}

func TestIncomingWebhookService_MembersSeeOnlyTheirOwnWebhooks(t *testing.T) {
	svc, _ := webhookOwnerFixture()
	ctx := context.Background()

	mine, err := svc.List(ctx, asMember("alice"))
	if err != nil {
		t.Fatal(err)
	}
	if got := webhookTitles(mine); len(got) != 1 || !got["Alice CI"] {
		t.Fatalf("alice sees %v, want only her own", got)
	}
	none, err := svc.List(ctx, asMember("carol"))
	if err != nil || len(none) != 0 {
		t.Fatalf("carol sees %d webhooks (err %v), want none", len(none), err)
	}
	all, err := svc.List(ctx, asAdmin("root"))
	if err != nil {
		t.Fatal(err)
	}
	if got := webhookTitles(all); len(got) != 2 {
		t.Fatalf("an admin sees %v, want every webhook", got)
	}
}

func TestIncomingWebhookService_MemberCreatesAWebhook(t *testing.T) {
	svc, webhooks := webhookOwnerFixture()
	wh, err := svc.Create(context.Background(), asMember("carol"), &model.IncomingWebhook{Title: "Deploys", ChannelID: "ch-pub"})
	if err != nil {
		t.Fatalf("a member creates a webhook: %v", err)
	}
	if webhooks.items[wh.ID].CreatedBy != "carol" {
		t.Fatalf("created by %q, want carol", webhooks.items[wh.ID].CreatedBy)
	}
}

func TestIncomingWebhookService_GuestsCannotManageWebhooks(t *testing.T) {
	svc, webhooks := webhookOwnerFixture()
	ctx := context.Background()
	guest := WebhookActor{ID: "alice", Role: model.SystemRoleGuest}
	in := &model.IncomingWebhook{Title: "x", ChannelID: "ch-pub"}

	if _, err := svc.List(ctx, guest); !errors.Is(err, apperr.ErrForbidden) {
		t.Errorf("list: %v, want forbidden", err)
	}
	if _, err := svc.Create(ctx, guest, in); !errors.Is(err, apperr.ErrForbidden) {
		t.Errorf("create: %v, want forbidden", err)
	}
	// Not even webhooks made before a demotion to guest.
	if _, err := svc.Update(ctx, guest, "wh-alice", in); !errors.Is(err, apperr.ErrForbidden) {
		t.Errorf("update: %v, want forbidden", err)
	}
	if err := svc.Delete(ctx, guest, "wh-alice"); !errors.Is(err, apperr.ErrForbidden) {
		t.Errorf("delete: %v, want forbidden", err)
	}
	if len(webhooks.items) != 2 {
		t.Fatalf("webhooks = %d, want the two from the fixture", len(webhooks.items))
	}
}

func TestIncomingWebhookService_SomeoneElsesWebhookIsNotFound(t *testing.T) {
	svc, webhooks := webhookOwnerFixture()
	ctx := context.Background()

	if _, err := svc.Update(ctx, asMember("alice"), "wh-bob", &model.IncomingWebhook{Title: "Mine now", ChannelID: "ch-pub"}); !errors.Is(err, apperr.ErrNotFound) {
		t.Errorf("update another's: %v, want not found", err)
	}
	if err := svc.Delete(ctx, asMember("alice"), "wh-bob"); !errors.Is(err, apperr.ErrNotFound) {
		t.Errorf("delete another's: %v, want not found", err)
	}
	if webhooks.items["wh-bob"] == nil || webhooks.items["wh-bob"].Title != "Bob CI" {
		t.Fatalf("bob's webhook = %+v, want untouched", webhooks.items["wh-bob"])
	}

	// The owner and an admin may.
	if _, err := svc.Update(ctx, asMember("bob"), "wh-bob", &model.IncomingWebhook{Title: "Bob deploys", ChannelID: "ch-pub"}); err != nil {
		t.Fatalf("owner update: %v", err)
	}
	if err := svc.Delete(ctx, asAdmin("root"), "wh-bob"); err != nil {
		t.Fatalf("admin delete: %v", err)
	}
	if err := svc.Delete(ctx, asMember("alice"), "wh-alice"); err != nil {
		t.Fatalf("owner delete: %v", err)
	}
	if len(webhooks.items) != 0 {
		t.Fatalf("webhooks left = %d, want none", len(webhooks.items))
	}
}

func TestIncomingWebhookService_PrivateTargetNeedsTheCreatorAsMember(t *testing.T) {
	svc, webhooks := webhookOwnerFixture()
	ctx := context.Background()
	toPriv := &model.IncomingWebhook{Title: "Ops", ChannelID: "ch-priv"}

	if _, err := svc.Create(ctx, asMember("carol"), toPriv); !errors.Is(err, apperr.ErrForbidden) {
		t.Errorf("carol (not in ops) creates into ops: %v, want forbidden", err)
	}
	if _, err := svc.Create(ctx, asMember("alice"), toPriv); err != nil {
		t.Errorf("alice (in ops) creates into ops: %v", err)
	}
	// An admin editing bob's webhook is held to bob's memberships.
	if _, err := svc.Update(ctx, asAdmin("root"), "wh-bob", toPriv); !errors.Is(err, apperr.ErrForbidden) {
		t.Errorf("move bob's webhook into ops: %v, want forbidden", err)
	}
	if webhooks.items["wh-bob"].ChannelID != "ch-pub" {
		t.Fatalf("bob's webhook moved to %q", webhooks.items["wh-bob"].ChannelID)
	}
}
