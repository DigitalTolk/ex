//go:build integration

package handler

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/DigitalTolk/ex/pkg/importer"
)

// A member the history importer adds to a channel is alerted by that
// channel's very next message on a running instance: the importer moves the
// audience generation the notifier's cache checks, so the member list cached
// before the import is never used again. Without that move the cached list
// would stand for the cache's whole expiry (two minutes) — the control below
// shows the gap the move closes.
func TestImportedMember_AlertedAtOnce(t *testing.T) {
	db := setupDynamoForAdapters(t)
	rc, err := cache.NewRedisCache("redis://" + redisAddrForTest(t))
	if err != nil {
		t.Fatalf("redis: %v", err)
	}
	t.Cleanup(func() { _ = rc.Client().Close() })
	ctx := context.Background()

	pub := &stubPublisher{}
	notifier := service.NewNotificationService(pub, store.NewMembershipStore(db), store.NewConversationStore(db),
		store.NewChannelStore(db), store.NewUserStore(db), store.NewMessageStore(db))
	notifier.SetAudienceCache(service.NewAudienceCache(service.NewRedisAudienceGenerations(rc.Client())))
	alerted := func(t *testing.T, channelID, msgID, mentionedID string) bool {
		t.Helper()
		pub.mu.Lock()
		pub.hits = nil
		pub.mu.Unlock()
		notifier.NotifyForMessage(ctx, &model.Message{
			ID: msgID, ParentID: channelID, AuthorID: "imp-author",
			Body: "deploy is rolling back @[" + mentionedID + "|someone]", CreatedAt: time.Now(),
		}, service.ParentChannel, nil)
		pub.mu.Lock()
		defer pub.mu.Unlock()
		for _, h := range pub.hits {
			if h.evt.Type == events.EventNotificationNew && h.topic == pubsub.UserChannel(mentionedID) {
				return true
			}
		}
		return false
	}

	run := func(t *testing.T, deps importer.Deps, channelID, slug string) bool {
		t.Helper()
		im, err := importer.New(deps)
		if err != nil {
			t.Fatalf("importer: %v", err)
		}
		for _, id := range []string{"imp-author", "imp-early", "imp-late"} {
			if _, err := im.UpsertUser(ctx, importer.UserSpec{ID: id, Email: id + "@example.com", DisplayName: id}); err != nil {
				t.Fatalf("UpsertUser %s: %v", id, err)
			}
		}
		if _, err := im.EnsureChannel(ctx, importer.ChannelSpec{ID: channelID, Slug: slug, Type: "public"}); err != nil {
			t.Fatalf("EnsureChannel: %v", err)
		}
		if _, err := im.AddChannelMembers(ctx, channelID, []importer.MemberSpec{{UserID: "imp-author"}, {UserID: "imp-early"}}); err != nil {
			t.Fatalf("AddChannelMembers: %v", err)
		}
		// A message the running instance fans out caches the channel's
		// audience as it is now.
		if !alerted(t, channelID, channelID+"-m1", "imp-early") {
			t.Fatal("warm-up: the mentioned member was not alerted")
		}
		if _, err := im.AddChannelMembers(ctx, channelID, []importer.MemberSpec{{UserID: "imp-late"}}); err != nil {
			t.Fatalf("AddChannelMembers: %v", err)
		}
		return alerted(t, channelID, channelID+"-m2", "imp-late")
	}

	if !run(t, importer.Deps{DB: db, Audiences: rc}, "imp-ch-1", "imp-one") {
		t.Fatal("a member the import added was not alerted by the channel's next message")
	}
	if run(t, importer.Deps{DB: db}, "imp-ch-2", "imp-two") {
		t.Fatal("control: without the audience move the cached member list should still stand — is the audience cache in play?")
	}
}
