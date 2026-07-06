package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Remaining branch arms in the message service.

// seedMembership makes userID a member of channelID for both the access check
// (channel-side row) and the ListUserThreads parent enumeration (user-side).
func seedMembership(m *mockMembershipStore, channelID, userID string) {
	m.memberships[channelID+"#"+userID] = &model.ChannelMembership{ChannelID: channelID, UserID: userID, Role: model.ChannelRoleMember}
	m.userChannels = append(m.userChannels, &model.UserChannel{UserID: userID, ChannelID: channelID})
}

func TestAttachRenderedSkipsNilMessages(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	svc.SetMarkdownRenderer(NewMarkdownRenderer())
	msg := &model.Message{ID: "m-1", Body: "**hi**"}
	svc.attachRendered(nil, msg) // the nil entry must be skipped, not crash
	if msg.Rendered == nil {
		t.Fatal("expected the non-nil message to be rendered")
	}
}

func TestSendRollbackDeleteFailureIsNonFatal(t *testing.T) {
	// Attachment bind fails AND the rollback delete fails — the send still
	// reports the bind error (the message row is orphaned, logged at WARN).
	svc, messages, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "user-1")
	refs := &fakeAttachmentRefMgr{addErr: errors.New("bind boom")}
	svc.SetAttachmentManager(refs)
	messages.deleteErr = errors.New("delete boom")

	_, err := svc.Send(context.Background(), "user-1", "ch1", ParentChannel, "body", "", "att-1")
	if err == nil || !strings.Contains(err.Error(), "bind boom") {
		t.Fatalf("Send: want bind error, got %v", err)
	}
}

func TestSendWebhookValidationAndCreateArms(t *testing.T) {
	svc, messages, _, _, _ := setupMessageService()

	t.Run("oversized body rejected", func(t *testing.T) {
		_, err := svc.SendWebhook(context.Background(), WebhookMessageInput{
			ChannelID: "ch1", Body: strings.Repeat("a", 100_001),
		})
		if err == nil {
			t.Fatal("expected body validation error")
		}
	})

	t.Run("create error surfaces", func(t *testing.T) {
		messages.createErr = errors.New("create boom")
		defer func() { messages.createErr = nil }()
		_, err := svc.SendWebhook(context.Background(), WebhookMessageInput{ChannelID: "ch1", Body: "hi"})
		if err == nil || !strings.Contains(err.Error(), "create boom") {
			t.Fatalf("SendWebhook: want create error, got %v", err)
		}
	})
}

func TestFollowMentionedThreadUsersDedupsMentions(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "user-1")
	seedMembership(memberships, "ch1", "u-dup") // mention follow requires membership
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	messages.messages["ch1#root-1"] = &model.Message{ID: "root-1", ParentID: "ch1", AuthorID: "user-9", Body: "root"}

	// The same user mentioned twice in one reply must be followed once.
	body := "@[u-dup|Dup] and again @[u-dup|Dup]"
	if _, err := svc.Send(context.Background(), "user-1", "ch1", ParentChannel, body, "root-1"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if _, ok := follows.follows[threadFollowMockKey("u-dup", "ch1", "root-1")]; !ok {
		t.Fatal("mentioned user should be followed")
	}
	// Exactly one batched entry — the duplicate mention was skipped.
	if follows.setManyMaxBatch != 1 {
		t.Fatalf("batch size = %d, want 1 (duplicate mention must dedup)", follows.setManyMaxBatch)
	}
}

func TestListUserThreadsGuardArms(t *testing.T) {
	ctx := context.Background()

	t.Run("non-thread user-state items and foreign-parent keys are skipped", func(t *testing.T) {
		svc, messages, memberships, _, _ := setupMessageService()
		seedMembership(memberships, "ch1", "user-1")
		userState := newMockUserStateStore()
		userState.rows[userState.key("user-1", model.UserStateHiddenConversation, "y")] = &model.UserStateItem{UserID: "user-1", Kind: model.UserStateHiddenConversation, ParentID: "x", TargetID: "y"}                            // wrong kind → skipped
		userState.rows[userState.key("user-1", model.UserStateThreadNotification, "r")] = &model.UserStateItem{UserID: "user-1", Kind: model.UserStateThreadNotification, ParentID: "", ThreadRootID: "r"}                         // empty parent → skipped
		userState.rows[userState.key("user-1", model.UserStateThreadNotification, "r-other")] = &model.UserStateItem{UserID: "user-1", Kind: model.UserStateThreadNotification, ParentID: "OTHER-parent", ThreadRootID: "r-other"} // foreign parent → prefix miss
		svc.SetUserStateStore(userState)
		follows := newMockThreadFollowStore()
		follows.follows[threadFollowMockKey("user-1", "OTHER-parent", "r-o")] = &model.ThreadFollow{UserID: "user-1", ParentID: "OTHER-parent", ThreadRootID: "r-o", Following: true} // foreign parent override
		svc.SetThreadFollowStore(follows)
		messages.messages["ch1#root-1"] = &model.Message{ID: "root-1", ParentID: "ch1", AuthorID: "user-1", Body: "root", ReplyCount: 1}

		got, err := svc.ListUserThreads(ctx, "user-1")
		if err != nil {
			t.Fatalf("ListUserThreads: %v", err)
		}
		if len(got) != 1 || got[0].ThreadRootID != "root-1" {
			t.Fatalf("threads = %v, want only ch1/root-1", got)
		}
	})

	t.Run("root missing from the window is skipped", func(t *testing.T) {
		svc, _, memberships, _, _ := setupMessageService()
		seedMembership(memberships, "ch1", "user-1")
		follows := newMockThreadFollowStore()
		follows.follows[threadFollowMockKey("user-1", "ch1", "gone-root")] = &model.ThreadFollow{UserID: "user-1", ParentID: "ch1", ThreadRootID: "gone-root", Following: true}
		svc.SetThreadFollowStore(follows)
		got, err := svc.ListUserThreads(ctx, "user-1")
		if err != nil {
			t.Fatalf("ListUserThreads: %v", err)
		}
		if len(got) != 0 {
			t.Fatalf("threads = %v, want none (root not in window)", got)
		}
	})

	t.Run("failed parent list yields nil window and is skipped", func(t *testing.T) {
		svc, messages, memberships, _, _ := setupMessageService()
		seedMembership(memberships, "ch1", "user-1")
		messages.listErr = errors.New("list boom")
		got, err := svc.ListUserThreads(ctx, "user-1")
		if err != nil {
			t.Fatalf("ListUserThreads: %v", err)
		}
		if len(got) != 0 {
			t.Fatalf("threads = %v, want none", got)
		}
	})
}

func TestListAroundErrorArms(t *testing.T) {
	ctx := context.Background()

	t.Run("target fetch failure propagates", func(t *testing.T) {
		svc, messages, memberships, _, _ := setupMessageService()
		seedMembership(memberships, "ch1", "user-1")
		messages.getErr = errors.New("target boom")
		_, _, _, err := svc.ListAround(ctx, "user-1", "ch1", ParentChannel, "m-x", 3, 3)
		if err == nil || !strings.Contains(err.Error(), "target boom") {
			t.Fatalf("ListAround: want target error, got %v", err)
		}
	})

	t.Run("window fetch failure propagates", func(t *testing.T) {
		svc, messages, memberships, _, _ := setupMessageService()
		seedMembership(memberships, "ch1", "user-1")
		messages.messages["ch1#m-x"] = &model.Message{ID: "m-x", ParentID: "ch1", AuthorID: "u", Body: "b"}
		messages.listErr = errors.New("window boom")
		_, _, _, err := svc.ListAround(ctx, "user-1", "ch1", ParentChannel, "m-x", 3, 3)
		if err == nil || !strings.Contains(err.Error(), "window boom") {
			t.Fatalf("ListAround: want window error, got %v", err)
		}
	})
}

func TestListTopLevelStoreHasMoreArms(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "user-1")
	messages.messages["ch1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch1", AuthorID: "u", Body: "b", CreatedAt: time.Now()}
	messages.listHasMore = true

	_, hasMore, err := svc.List(context.Background(), "user-1", "ch1", ParentChannel, "", 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if !hasMore {
		t.Fatal("expected hasMore=true from the store's page signal")
	}

	_, hasMore, err = svc.ListAfter(context.Background(), "user-1", "ch1", ParentChannel, "m-0", 10)
	if err != nil {
		t.Fatalf("ListAfter: %v", err)
	}
	if !hasMore {
		t.Fatal("expected hasMore=true from the store's page signal (after)")
	}
}

func TestEditFileIndexDeleteFailureIsNonFatal(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "user-1")
	refs := &fakeAttachmentRefMgr{}
	svc.SetAttachmentManager(refs)
	pi := newMockParentIndex()
	pi.deleteFileErr = errors.New("index boom")
	svc.SetParentIndex(pi)
	messages.messages["ch1#m-e"] = &model.Message{ID: "m-e", ParentID: "ch1", AuthorID: "user-1", Body: "b", AttachmentIDs: []string{"att-1"}, CreatedAt: time.Now()}

	// Removing the attachment triggers the file-index delete, which fails —
	// the edit itself must still succeed.
	got, err := svc.Edit(context.Background(), "user-1", "ch1", ParentChannel, "m-e", "new body", []string{})
	if err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if len(got.AttachmentIDs) != 0 {
		t.Fatalf("AttachmentIDs = %v, want removed", got.AttachmentIDs)
	}
}

func TestSoftDeleteFileIndexArms(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "user-1")
	refs := &fakeAttachmentRefMgr{}
	svc.SetAttachmentManager(refs)
	pi := newMockParentIndex()
	pi.files["ch1"] = map[string]FileIndexEntry{
		// Row owned by this message but for an attachment NOT on it (a
		// re-share superseded it) → the not-attached continue arm.
		"att-foreign": {MessageID: "m-d", AttachmentID: "att-foreign"},
		// Row for the real attachment — its delete fails (WARN, non-fatal).
		"att-1": {MessageID: "m-d", AttachmentID: "att-1"},
	}
	pi.deleteFileErr = errors.New("index boom")
	svc.SetParentIndex(pi)
	messages.messages["ch1#m-d"] = &model.Message{ID: "m-d", ParentID: "ch1", AuthorID: "user-1", Body: "b", AttachmentIDs: []string{"att-1"}, CreatedAt: time.Now()}

	if err := svc.Delete(context.Background(), "user-1", "ch1", ParentChannel, "m-d"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
}

func TestSetNoUnfurlAccessDenied(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	_, err := svc.SetNoUnfurl(context.Background(), "user-stranger", "ch1", ParentChannel, "m-1", true)
	if err == nil {
		t.Fatal("expected membership denial")
	}
}

func TestPostSystemMessageCreateFailureStaysSilent(t *testing.T) {
	svc, messages, _, _, publisher := setupMessageService()
	messages.createErr = errors.New("create boom")
	svc.postSystemMessage(context.Background(), "ch1", "notice")
	for _, p := range publisher.published {
		if p.event.Type == "message.new" {
			t.Fatal("no event may be published when the system message row was not created")
		}
	}
}
