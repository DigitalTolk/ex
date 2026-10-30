package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

func blocksWebhookFixture(users WebhookUserResolver) (*IncomingWebhookService, *mockMessageStore) {
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	svc := NewIncomingWebhookService(&fakeWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", ChannelID: ch.ID, Username: "MeetingMind"},
	}}, fakeWebhookChannels{byID: map[string]*model.Channel{ch.ID: ch}, bySlug: map[string]*model.Channel{ch.Slug: ch}},
		msgSvc, fakeWebhookImageProxy{}, "")
	if users != nil {
		svc.SetUserResolver(users)
	}
	return svc, messages
}

func TestIncomingWebhook_PostsBlocksWithTheirFallbackText(t *testing.T) {
	ctx := context.Background()
	svc, messages := blocksWebhookFixture(fakeWebhookUsers{users: []*model.User{
		{ID: "u-virpal", Email: "virpal@ex.test"}, {ID: "u-manisha", Email: "manisha@ex.test"},
	}})
	take := btn("take", "Take it")
	take.ExAction = model.ExActionVote
	take.AllowedUsers = []string{"u-manisha", "virpal@ex.test", "nobody", "nobody@ex.test"}
	msg, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{
		Blocks: model.Blocks{
			{Type: model.BlockHeader, Text: plain("Platform sync")},
			{Type: model.BlockActions, Elements: []model.BlockElement{take}},
		},
		Attachments: []model.MessageAttachment{{Color: "#D97706", Blocks: model.Blocks{
			{Type: model.BlockSection, Text: md("**A3** <!channel>")},
		}}},
	})
	if err != nil {
		t.Fatalf("ExecuteMessage: %v", err)
	}
	stored := onlyStoredMessage(t, messages)
	if stored.ID != msg.ID || stored.Body != "Platform sync\n**A3** @all" {
		t.Fatalf("fallback body = %q", stored.Body)
	}
	if got := stored.Blocks[1].Elements[0].AllowedUsers; len(got) != 2 || got[0] != "u-manisha" || got[1] != "u-virpal" {
		t.Fatalf("allowed users = %v", got)
	}
	if card := stored.MessageAttachments[0].Blocks[0]; card.Text.Type != model.TextMarkdown || card.Text.Text != "**A3** @all" || card.BlockID != "b3" {
		t.Fatalf("card block = %#v", card)
	}
}

func TestIncomingWebhook_TextStaysWhenGivenAndButtonsOnlyPost(t *testing.T) {
	ctx := context.Background()
	svc, messages := blocksWebhookFixture(nil)
	// Only a row of buttons: no fallback text to draw, the message still posts.
	ok := btn("ok", "OK")
	ok.ExAction = model.ExActionAck
	if _, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{
		Blocks: model.Blocks{{Type: model.BlockActions, Elements: []model.BlockElement{ok}}},
	}); err != nil {
		t.Fatalf("buttons only: %v", err)
	}
	if m := onlyStoredMessage(t, messages); m.Body != "" || len(m.Blocks) != 1 {
		t.Fatalf("buttons-only message = %#v", m)
	}
}

func TestIncomingWebhook_BlockRefusalsStopThePost(t *testing.T) {
	ctx := context.Background()
	svc, messages := blocksWebhookFixture(nil)
	// Without a user directory, allowed_users can name nobody.
	b := btn("x", "X")
	b.AllowedUsers = []string{"u-1"}
	_, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Text: "t", Blocks: model.Blocks{{Type: model.BlockActions, Elements: []model.BlockElement{b}}}})
	wantInvalid(t, err, "names no ex user")
	if len(messages.messages) != 0 {
		t.Fatalf("a refused payload posted %d messages", len(messages.messages))
	}
	if _, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{}); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("empty payload: %v", err)
	}
}

func TestIncomingWebhook_AllowedUsersResolveByIDOrExactEmailOnly(t *testing.T) {
	svc, _ := blocksWebhookFixture(fakeWebhookUsers{users: []*model.User{{ID: "u-1", Email: "one@ex.test", DisplayName: "One"}}})
	resolve := svc.blockNormalizer(context.Background(), svc.newRefs()).user
	for ref, want := range map[string]string{"u-1": "u-1", "ONE@ex.test": "u-1", "One": "", "two@ex.test": "", "": ""} {
		if got := resolve(context.Background(), ref); got != want {
			t.Errorf("resolve(%q) = %q, want %q", ref, got, want)
		}
	}
}

func TestIncomingWebhook_PreviewShowsWithoutPosting(t *testing.T) {
	ctx := context.Background()
	svc, messages := blocksWebhookFixture(nil)
	msg, err := svc.PreviewMessage(ctx, WebhookActor{ID: "u-1", Role: model.SystemRoleMember}, IncomingWebhookPayload{
		Username:  " ",
		IconEmoji: ":robot:",
		Blocks:    model.Blocks{{Type: model.BlockSection, Text: md("hi")}},
		Attachments: []model.MessageAttachment{{
			Text: "card", ImageURL: "https://img.ex.test/a.png",
		}},
	})
	if err != nil {
		t.Fatalf("PreviewMessage: %v", err)
	}
	if len(messages.messages) != 0 {
		t.Fatal("a preview posted a message")
	}
	if msg.Body != "hi" || msg.WebhookUsername != "webhook" || msg.WebhookIconEmoji != "robot" || msg.Blocks[0].BlockID != "b1" {
		t.Fatalf("preview = %#v", msg)
	}
	if msg.MessageAttachments[0].ImageURL != "https://img.ex.test/a.png" {
		t.Fatalf("a preview must not fetch images: %q", msg.MessageAttachments[0].ImageURL)
	}
	named, err := svc.PreviewMessage(ctx, WebhookActor{ID: "u-1", Role: model.SystemRoleMember}, IncomingWebhookPayload{Text: "t", Username: "MM"})
	if err != nil || named.WebhookUsername != "MM" {
		t.Fatalf("named preview: %#v %v", named, err)
	}
}

func TestIncomingWebhook_PreviewRefusals(t *testing.T) {
	ctx := context.Background()
	svc, _ := blocksWebhookFixture(nil)
	member := WebhookActor{ID: "u-1", Role: model.SystemRoleMember}
	if _, err := svc.PreviewMessage(ctx, WebhookActor{ID: "g", Role: model.SystemRoleGuest}, IncomingWebhookPayload{Text: "t"}); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("guest: %v", err)
	}
	if _, err := svc.PreviewMessage(ctx, member, IncomingWebhookPayload{}); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("empty: %v", err)
	}
	_, err := svc.PreviewMessage(ctx, member, IncomingWebhookPayload{Blocks: model.Blocks{{Type: model.BlockHeader}}})
	wantInvalid(t, err, "a header needs text")
}

func TestMessageService_SendWebhookTakesBlocksAlone(t *testing.T) {
	svc := NewMessageService(newMockMessageStore(), nil, nil, newMockPublisher(), nil)
	ctx := context.Background()
	if _, err := svc.SendWebhook(ctx, WebhookMessageInput{ChannelID: "ch-1"}); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("nothing to post: %v", err)
	}
	msg, err := svc.SendWebhook(ctx, WebhookMessageInput{ChannelID: "ch-1", Blocks: model.Blocks{{Type: model.BlockDivider, BlockID: "b1"}}})
	if err != nil || len(msg.Blocks) != 1 {
		t.Fatalf("blocks only: %#v %v", msg, err)
	}
}
