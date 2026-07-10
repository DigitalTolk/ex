package service

import (
	"context"
	"errors"
	"image"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	nativewebp "github.com/HugoSmits86/nativewebp"

	"github.com/DigitalTolk/ex/internal/model"
)

// Second sweep of remaining branch arms across the service package.

func TestRandomWebhookIDEntropyFailure(t *testing.T) {
	orig := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("entropy exhausted") }
	defer func() { randRead = orig }()
	if _, err := randomWebhookID(); err == nil {
		t.Fatal("expected entropy failure to surface")
	}
}

func TestWebhookCreateEntropyFailureSurfaces(t *testing.T) {
	orig := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("entropy exhausted") }
	defer func() { randRead = orig }()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	svc := NewIncomingWebhookService(&fakeWebhookStore{}, fakeWebhookChannels{
		byID: map[string]*model.Channel{ch.ID: ch},
	}, nil, fakeWebhookImageProxy{}, "https://chat.example")
	if _, err := svc.Create(context.Background(), "admin-1", &model.IncomingWebhook{Title: "CI", ChannelID: ch.ID}); err == nil {
		t.Fatal("expected Create to surface the id-generation failure")
	}
}

func TestWebhookTargetChannelGetError(t *testing.T) {
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	webhooks := &fakeWebhookStore{}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	svc := NewIncomingWebhookService(webhooks, fakeWebhookChannels{
		byID: map[string]*model.Channel{ch.ID: ch},
	}, msgSvc, fakeWebhookImageProxy{}, "https://chat.example")
	wh, err := svc.Create(context.Background(), "admin-1", &model.IncomingWebhook{Title: "CI", ChannelID: ch.ID, LockToChannel: true})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// A second service over the SAME webhook store but with the channel gone
	// — Execute must surface the lookup failure.
	svc2 := NewIncomingWebhookService(webhooks, fakeWebhookChannels{byID: map[string]*model.Channel{}}, msgSvc, fakeWebhookImageProxy{}, "https://chat.example")
	if err := svc2.Execute(context.Background(), wh.ID, IncomingWebhookPayload{Text: "hi"}); err == nil {
		t.Fatal("expected channel lookup failure")
	}
}

func TestWebhookTargetDMEmptyName(t *testing.T) {
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	svc := NewIncomingWebhookService(&fakeWebhookStore{}, fakeWebhookChannels{
		byID: map[string]*model.Channel{ch.ID: ch},
	}, msgSvc, fakeWebhookImageProxy{}, "https://chat.example")
	svc.SetDMResolver(&fakeWebhookDMResolver{})
	svc.SetUserResolver(fakeWebhookUsers{})
	wh, err := svc.Create(context.Background(), "admin-1", &model.IncomingWebhook{Title: "CI", ChannelID: ch.ID, CreatedBy: "admin-1"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := svc.Execute(context.Background(), wh.ID, IncomingWebhookPayload{Text: "hi", Channel: "@  "}); err == nil {
		t.Fatal("expected empty DM target to be rejected")
	}
}

func TestListUserThreadsDedupsDuplicateParents(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	// The same channel appearing twice in the membership list (a dual-write
	// artifact) must not produce duplicate thread rows.
	seedMembership(memberships, "ch1", "user-1")
	seedMembership(memberships, "ch1", "user-1")
	messages.messages["ch1#root-1"] = &model.Message{ID: "root-1", ParentID: "ch1", AuthorID: "user-1", Body: "root", ReplyCount: 1}
	got, err := svc.ListUserThreads(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("ListUserThreads: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("threads = %d, want 1 (duplicate parent deduped)", len(got))
	}
}

func TestListAroundNewerWindowFailure(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "user-1")
	messages.messages["ch1#m-x"] = &model.Message{ID: "m-x", ParentID: "ch1", AuthorID: "u", Body: "b"}
	messages.listAfterErr = errors.New("newer boom")
	_, _, _, err := svc.ListAround(context.Background(), "user-1", "ch1", ParentChannel, "m-x", 3, 3)
	if err == nil || !strings.Contains(err.Error(), "newer boom") {
		t.Fatalf("ListAround: want newer-window error, got %v", err)
	}
}

func TestEditFileIndexDeleteWarnArm(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "user-1")
	svc.SetAttachmentManager(&fakeAttachmentRefMgr{})
	pi := newMockParentIndex()
	pi.files["ch1"] = map[string]FileIndexEntry{"att-1": {MessageID: "m-e2", AttachmentID: "att-1"}}
	pi.deleteFileErr = errors.New("index boom")
	svc.SetParentIndex(pi)
	messages.messages["ch1#m-e2"] = &model.Message{ID: "m-e2", ParentID: "ch1", AuthorID: "user-1", Body: "b", AttachmentIDs: []string{"att-1"}, CreatedAt: time.Now()}

	if _, err := svc.Edit(context.Background(), "user-1", "ch1", ParentChannel, "m-e2", "new", []string{}); err != nil {
		t.Fatalf("Edit: %v", err)
	}
}

func TestPostSystemMessagePublishesOnSuccess(t *testing.T) {
	svc, _, _, _, publisher := setupMessageService()
	svc.postSystemMessage(context.Background(), "ch1", "notice")
	found := false
	for _, p := range publisher.published {
		if p.event.Type == "message.new" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected the system message to be published")
	}
}

func TestChannelRoleChangeErrorArms(t *testing.T) {
	ctx := context.Background()

	t.Run("actor membership fetch failure during owner promotion", func(t *testing.T) {
		svc, _, memberships, _, _ := setupChannelService()
		memberships.memberships["ch1#target"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "target", Role: model.ChannelRoleMember}
		memberships.memberships["ch1#actor"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "actor", Role: model.ChannelRoleAdmin}
		// checkPermission's fetch succeeds; the owner-promotion re-fetch fails.
		memberships.getErrForUser = "actor"
		memberships.getErrForUserSkip = 1
		err := svc.UpdateMemberRole(ctx, "actor", "ch1", "target", model.ChannelRoleOwner)
		if err == nil || !strings.Contains(err.Error(), "actor membership") {
			t.Fatalf("want actor membership error, got %v", err)
		}
	})

	t.Run("role update failure", func(t *testing.T) {
		svc, _, memberships, _, _ := setupChannelService()
		memberships.memberships["ch1#target"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "target", Role: model.ChannelRoleMember}
		memberships.memberships["ch1#actor"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "actor", Role: model.ChannelRoleOwner}
		memberships.updateRoleErr = errors.New("update boom")
		err := svc.UpdateMemberRole(ctx, "actor", "ch1", "target", model.ChannelRoleAdmin)
		if err == nil || !strings.Contains(err.Error(), "update boom") {
			t.Fatalf("want update error, got %v", err)
		}
	})
}

func TestRefreshSuccessorLookupArms(t *testing.T) {
	ctx := context.Background()

	t.Run("successor row already gone counts as unused", func(t *testing.T) {
		env := setupAuthService()
		user := &model.User{ID: "u-sg", Email: "sg@x.io", DisplayName: "S", SystemRole: model.SystemRoleMember, Status: "active"}
		env.users.users[user.ID] = user
		seedRefreshToken(env, user.ID, "raw-A")
		hashB := pointJWTAt(env, "raw-B")
		if _, _, err := env.svc.RefreshAccessToken(ctx, "raw-A"); err != nil {
			t.Fatalf("first refresh: %v", err)
		}
		delete(env.tokens.tokens, hashB) // successor expired/revoked out-of-band
		pointJWTAt(env, "raw-C")
		if _, _, err := env.svc.RefreshAccessToken(ctx, "raw-A"); err != nil {
			t.Fatalf("retry with missing successor must be honored: %v", err)
		}
	})

	t.Run("successor lookup infrastructure failure propagates", func(t *testing.T) {
		env := setupAuthService()
		user := &model.User{ID: "u-sf", Email: "sf@x.io", DisplayName: "S", SystemRole: model.SystemRoleMember, Status: "active"}
		env.users.users[user.ID] = user
		seedRefreshToken(env, user.ID, "raw-A")
		hashB := pointJWTAt(env, "raw-B")
		if _, _, err := env.svc.RefreshAccessToken(ctx, "raw-A"); err != nil {
			t.Fatalf("first refresh: %v", err)
		}
		env.tokens.getErrHash = map[string]error{hashB: errors.New("dynamo down")}
		_, _, err := env.svc.RefreshAccessToken(ctx, "raw-A")
		if err == nil || !strings.Contains(err.Error(), "successor") {
			t.Fatalf("want successor lookup error, got %v", err)
		}
	})
}

func TestUnfurlLoadImageDimsCacheMiss(t *testing.T) {
	svc := NewUnfurlService(newMockCache())
	w, h := svc.loadImageDims(context.Background(), "missing-key")
	if w != 0 || h != 0 {
		t.Fatalf("dims = %dx%d, want 0x0 on cache miss", w, h)
	}
}

func TestSafeDialContextDialsPublicIPs(t *testing.T) {
	// TEST-NET-3 (203.0.113.0/24) is classified public but never routed —
	// the dial line executes and fails fast under the context deadline.
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	conn, err := safeDialContext(ctx, "tcp", net.JoinHostPort("203.0.113.1", "80"))
	if conn != nil {
		_ = conn.Close()
	}
	if err == nil {
		t.Fatal("expected the blackhole dial to fail")
	}
	if strings.Contains(err.Error(), "blocked private IP") {
		t.Fatalf("TEST-NET must pass the private filter, got %v", err)
	}
}

func TestMustHelpersPanic(t *testing.T) {
	t.Run("mustThumb", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Fatal("mustThumb must panic on error")
			}
		}()
		mustThumb(nil, errors.New("boom"))
	})
	t.Run("mustJSONBody", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Fatal("mustJSONBody must panic on error")
			}
		}()
		mustJSONBody(nil, errors.New("boom"))
	})
	t.Run("passthrough", func(t *testing.T) {
		if got := string(mustThumb([]byte("t"), nil)); got != "t" {
			t.Fatalf("mustThumb = %q", got)
		}
		if got := string(mustJSONBody([]byte("j"), nil)); got != "j" {
			t.Fatalf("mustJSONBody = %q", got)
		}
	})
}

func TestEncodeWebPThumbnailPanicsOnEncoderFault(t *testing.T) {
	orig := webpEncode
	webpEncode = func(io.Writer, image.Image, *nativewebp.Options) error { return errors.New("encoder fault") }
	defer func() { webpEncode = orig }()
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on encoder fault")
		}
	}()
	_, _ = encodeWebPThumbnail(image.NewNRGBA(image.Rect(0, 0, 4, 4)), thumbnailModeMessage)
}

func TestUpdateMemberRoleOwnerDemotionActorFetchFailure(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.memberships["ch1#target"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "target", Role: model.ChannelRoleOwner}
	memberships.memberships["ch1#actor"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "actor", Role: model.ChannelRoleAdmin}
	// checkPermission's fetch succeeds; the owner-demotion authority re-fetch fails.
	memberships.getErrForUser = "actor"
	memberships.getErrForUserSkip = 1
	err := svc.UpdateMemberRole(context.Background(), "actor", "ch1", "target", model.ChannelRoleMember)
	if err == nil || !strings.Contains(err.Error(), "actor membership") {
		t.Fatalf("want actor membership error, got %v", err)
	}
}

func TestIsSafeURLNonSchemeByteIsRelative(t *testing.T) {
	// A byte that can't be part of a scheme before the ':' means the value is
	// a relative reference, not a scheme'd URL — safe.
	if !isSafeURL("ab~c:javascript") {
		t.Fatal("non-scheme byte before ':' must classify as relative/safe")
	}
}

func TestNotifyAuthorThreadSeenMarkFailureIsNonFatal(t *testing.T) {
	svc, _, members, _, chans, users, msgs, follows := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()
	stateStore := newMockUserStateStore()
	stateStore.setErr = errors.New("state boom")
	svc.SetUserStateService(NewUserStateService(stateStore, nil))

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	for _, uid := range []string{"u-author", "u-bob"} {
		users.users[uid] = &model.User{ID: uid, DisplayName: uid}
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	msgs.messages["ch1#root1"] = &model.Message{ID: "root1", ParentID: "ch1", AuthorID: "u-author", Body: "root", CreatedAt: time.Now()}
	if err := follows.SetThreadFollow(ctx, &model.ThreadFollow{
		UserID: "u-bob", ParentID: "ch1", ParentType: ParentChannel, ThreadRootID: "root1", Following: true, UpdatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}

	// The author's own thread-seen mark failing must only WARN — the
	// notification fan-out itself proceeds.
	svc.NotifyForMessage(ctx, &model.Message{
		ID: "r1", ParentID: "ch1", AuthorID: "u-author", ParentMessageID: "root1", Body: "reply",
	}, ParentChannel, nil)
}

func TestPublishThreadUpdateNilPublisherIsNoop(t *testing.T) {
	svc := NewNotificationService(nil, newMockMembershipStore(), newMockConversationStore(), newMockChannelStore(), newMockUserStore(), newMockMessageStore())
	root := &model.Message{ID: "root1", ParentID: "ch1", CreatedAt: time.Now()}
	msg := &model.Message{ID: "r1", ParentID: "ch1", ParentMessageID: "root1"}
	svc.publishThreadUpdate(context.Background(), msg, ParentChannel, root, map[string]bool{"u-1": true})
}

func TestResolveThreadRecipientsSkipsTheMessageItself(t *testing.T) {
	svc, _, _, _, _, _, msgs, _ := setupNotifierWithMessagesAndFollows(t)
	msgs.messages["ch1#root1"] = &model.Message{ID: "root1", ParentID: "ch1", AuthorID: "u-root", Body: "root", CreatedAt: time.Now()}
	// The reply being notified is already visible in the thread window — its
	// own author entry must not feed back into the recipient set.
	msgs.messages["ch1#r1"] = &model.Message{ID: "r1", ParentID: "ch1", ParentMessageID: "root1", AuthorID: "u-author", Body: "reply", CreatedAt: time.Now()}

	got := svc.resolveThreadRecipients(context.Background(),
		&model.Message{ID: "r1", ParentID: "ch1", ParentMessageID: "root1", AuthorID: "u-author"},
		memberSnapshot{memberIDs: []string{"u-root", "u-author"}})
	if len(got) != 1 || got[0] != "u-root" {
		t.Fatalf("recipients = %v, want only the root author", got)
	}
}

func TestWebhookUserMentionLookupFailure(t *testing.T) {
	svc := NewIncomingWebhookService(&fakeWebhookStore{}, fakeWebhookChannels{}, nil, fakeWebhookImageProxy{}, "https://chat.example")
	svc.SetUserResolver(fakeWebhookUsers{err: errors.New("directory down")})
	if got, ok := svc.userMention(context.Background(), "nobody"); ok || got != "" {
		t.Fatalf("userMention = %q,%v — want miss on resolver failure", got, ok)
	}
}
