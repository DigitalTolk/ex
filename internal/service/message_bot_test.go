package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// SendBotCard / PostBotCard: posting as a bot on a user's behalf. The requester's
// access is what is checked — a bot must never post somewhere the person driving
// it cannot.

func setupBotCard(t *testing.T) (*MessageService, *mockMessageStore) {
	t.Helper()
	svc, messages, memberships, _, _ := setupMessageService()
	if err := memberships.AddMember(context.Background(),
		&model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}, &model.UserChannel{}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	return svc, messages
}

// SendBotCard is the positional form kept for the Cliffy handler's interface.
func TestSendBotCard(t *testing.T) {
	svc, messages := setupBotCard(t)
	msg, err := svc.SendBotCard(context.Background(),
		"u1", "bot_cliffy", "Cliffy", "robot", "ch1", ParentChannel, "", "here you go",
		[]model.MessageAttachment{{Text: "card"}})
	if err != nil {
		t.Fatalf("SendBotCard: %v", err)
	}
	stored, err := messages.GetMessage(context.Background(), "ch1", msg.ID)
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if stored.AuthorID != "bot_cliffy" || stored.WebhookUsername != "Cliffy" ||
		stored.WebhookIconEmoji != "robot" || len(stored.MessageAttachments) != 1 {
		t.Errorf("stored = %+v, want the bot identity and its card", stored)
	}
}

func TestPostBotCard_RequiresARequester(t *testing.T) {
	// Without a requester there is no access to check, so there is no safe way to
	// decide whether the post is allowed.
	svc, _ := setupBotCard(t)
	_, err := svc.PostBotCard(context.Background(), BotCardInput{
		AuthorID: "bot_cliffy", ParentID: "ch1", ParentType: ParentChannel, Body: "hi",
	})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

func TestPostBotCard_ChecksRequesterAccess(t *testing.T) {
	svc, _ := setupBotCard(t)
	_, err := svc.PostBotCard(context.Background(), BotCardInput{
		RequestUserID: "stranger", AuthorID: "bot_cliffy",
		ParentID: "ch1", ParentType: ParentChannel, Body: "hi",
	})
	if err == nil {
		t.Fatal("a requester with no access must not be able to post as a bot")
	}
}

// A threaded bot post must reference a live root: replying under a deleted
// message would orphan the reply.
func TestSendWebhook_ThreadRootChecks(t *testing.T) {
	ctx := context.Background()

	t.Run("a missing root is rejected", func(t *testing.T) {
		svc, _ := setupBotCard(t)
		_, err := svc.SendWebhook(ctx, WebhookMessageInput{
			ParentID: "ch1", ParentType: ParentChannel, ParentMessageID: "gone", Body: "reply",
		})
		if err == nil {
			t.Fatal("want a rejection for a missing thread root")
		}
	})

	t.Run("a deleted root is rejected", func(t *testing.T) {
		svc, messages := setupBotCard(t)
		root := &model.Message{ID: "root1", ParentID: "ch1", AuthorID: "u1", Body: "", Deleted: true, CreatedAt: time.Now()}
		if err := messages.CreateMessage(ctx, root); err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		_, err := svc.SendWebhook(ctx, WebhookMessageInput{
			ParentID: "ch1", ParentType: ParentChannel, ParentMessageID: "root1", Body: "reply",
		})
		if !errors.Is(err, ErrThreadDeleted) {
			t.Fatalf("err = %v, want ErrThreadDeleted", err)
		}
	})

	t.Run("a metadata bump failure still posts the reply", func(t *testing.T) {
		// Thread bookkeeping is best-effort; losing the reply would not be.
		svc, messages := setupBotCard(t)
		root := &model.Message{ID: "root1", ParentID: "ch1", AuthorID: "u1", Body: "start", CreatedAt: time.Now()}
		if err := messages.CreateMessage(ctx, root); err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		messages.updateErr = errors.New("dynamo down")
		msg, err := svc.SendWebhook(ctx, WebhookMessageInput{
			ParentID: "ch1", ParentType: ParentChannel, ParentMessageID: "root1", Body: "reply",
		})
		if err != nil || msg == nil {
			t.Fatalf("SendWebhook = (%+v, %v), want the reply posted anyway", msg, err)
		}
	})
}
