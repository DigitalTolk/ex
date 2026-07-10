package service

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// The sidebar's numeric badge counts ONLY messages that actually alerted the
// recipient (the notification decision), not every unread message. These
// tests pin the bump rules end to end through NotifyForMessage.

// bumpMockMembershipStore adds the notifyCountBumper capability. Mutex-
// guarded: the notify path bumps recipients in bounded-parallel goroutines.
type bumpMockMembershipStore struct {
	*mockMembershipStore
	mu      sync.Mutex
	counts  map[string]int64 // parentID + "#" + userID
	bumpErr error
}

func (m *bumpMockMembershipStore) IncrementNotifyCount(_ context.Context, parentID, userID string) (int64, error) {
	if m.bumpErr != nil {
		return 0, m.bumpErr
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.counts == nil {
		m.counts = map[string]int64{}
	}
	m.counts[parentID+"#"+userID]++
	return m.counts[parentID+"#"+userID], nil
}

type bumpMockConversationStore struct {
	*mockConversationStore
	mu     sync.Mutex
	counts map[string]int64
}

func (m *bumpMockConversationStore) IncrementNotifyCount(_ context.Context, parentID, userID string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.counts == nil {
		m.counts = map[string]int64{}
	}
	m.counts[parentID+"#"+userID]++
	return m.counts[parentID+"#"+userID], nil
}

func setupBumpNotifier(t *testing.T) (*NotificationService, *mockPublisher, *bumpMockMembershipStore, *bumpMockConversationStore, *mockChannelStore, *mockUserStore) {
	t.Helper()
	pub := newMockPublisher()
	members := &bumpMockMembershipStore{mockMembershipStore: newMockMembershipStore()}
	conv := &bumpMockConversationStore{mockConversationStore: newMockConversationStore()}
	chans := newMockChannelStore()
	users := newMockUserStore()
	msgs := newMockMessageStore()
	svc := NewNotificationService(pub, members, conv, chans, users, msgs)
	return svc, pub, members, conv, chans, users
}

// notifCountFor extracts ParentUnreadNotifyCount from the notification.new
// published to the given user channel (0 if none published).
func notifCountFor(t *testing.T, pub *mockPublisher, userID string) (int64, bool) {
	t.Helper()
	for _, p := range pub.published {
		if p.channel != pubsub.UserChannel(userID) || p.event.Type != "notification.new" {
			continue
		}
		var n Notification
		if err := json.Unmarshal(p.event.Data, &n); err != nil {
			t.Fatalf("decode notification: %v", err)
		}
		return n.ParentUnreadNotifyCount, true
	}
	return 0, false
}

func TestNotifyCount_MentionBumpsOnlyAlertedRecipients(t *testing.T) {
	svc, pub, members, _, chans, users := setupBumpNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-mentioned"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-mentioned"}
	members.memberships["ch1#u-bystander"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bystander"}

	msg := &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hey @[u-mentioned|Bob]"}
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

	// The mentioned member was alerted → their badge advanced and the
	// authoritative count rode the notification.
	if got := members.counts["ch1#u-mentioned"]; got != 1 {
		t.Fatalf("mentioned bump = %d, want 1", got)
	}
	if n, ok := notifCountFor(t, pub, "u-mentioned"); !ok || n != 1 {
		t.Fatalf("payload count = %d (published=%v), want 1", n, ok)
	}
	// The bystander (default mentions-only level) was NOT alerted → no badge
	// movement: their sidebar shows only the "message available" indicator
	// driven by the seq counters.
	if got := members.counts["ch1#u-bystander"]; got != 0 {
		t.Fatalf("bystander bump = %d, want 0", got)
	}
	// The author never self-alerts.
	if got := members.counts["ch1#u-author"]; got != 0 {
		t.Fatalf("author bump = %d, want 0", got)
	}
}

func TestNotifyCount_MuteSemantics(t *testing.T) {
	svc, _, members, _, chans, users := setupBumpNotifier(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	// The muted member listens at "all messages" — mute must still silence
	// plain messages (no alert → no badge)…
	all := model.DefaultNotificationSettings()
	all.DesktopLevel = model.NotificationLevelAll
	users.users["u-muted"] = &model.User{ID: "u-muted", DisplayName: "Bob", NotificationSettings: &all}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-muted"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-muted"}
	members.mutes["ch1#u-muted"] = true

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "plain message"}, ParentChannel, nil)
	if got := members.counts["ch1#u-muted"]; got != 0 {
		t.Fatalf("muted plain-message bump = %d, want 0 (mute suppresses the alert, so no badge)", got)
	}

	// …while an explicit @-mention overrides mute (the product rule), so the
	// badge advances with the alert.
	svc.NotifyForMessage(ctx, &model.Message{ID: "m2", ParentID: "ch1", AuthorID: "u-author", Body: "hey @[u-muted|Bob]"}, ParentChannel, nil)
	if got := members.counts["ch1#u-muted"]; got != 1 {
		t.Fatalf("muted mention bump = %d, want 1 (mention overrides mute)", got)
	}
}

func TestNotifyCount_DMAlwaysBumps(t *testing.T) {
	svc, pub, _, conv, _, users := setupBumpNotifier(t)
	ctx := context.Background()
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	conv.conversations["dm1"] = &model.Conversation{ID: "dm1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-author", "u-b"}}

	msg := &model.Message{ID: "m1", ParentID: "dm1", AuthorID: "u-author", Body: "hi"}
	svc.NotifyForMessage(ctx, msg, ParentConversation, nil)
	svc.NotifyForMessage(ctx, &model.Message{ID: "m2", ParentID: "dm1", AuthorID: "u-author", Body: "again"}, ParentConversation, nil)

	if got := conv.counts["dm1#u-b"]; got != 2 {
		t.Fatalf("DM bump = %d, want 2 (DM messages always alert)", got)
	}
	if n, ok := notifCountFor(t, pub, "u-b"); !ok || n < 1 {
		t.Fatalf("payload count = %d (published=%v), want >= 1", n, ok)
	}
}

func TestNotifyCount_ThreadReplyDoesNotTouchParentBadge(t *testing.T) {
	svc, _, members, _, chans, users := setupBumpNotifier(t)
	msgs := newMockMessageStore()
	svc.messages = msgs
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-root"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-root"}
	msgs.messages["ch1#root-1"] = &model.Message{ID: "root-1", ParentID: "ch1", AuthorID: "u-root", Body: "root"}

	reply := &model.Message{ID: "r1", ParentID: "ch1", ParentMessageID: "root-1", AuthorID: "u-author", Body: "reply @[u-root|Root]"}
	svc.NotifyForMessage(ctx, reply, ParentChannel, nil)

	// The root author IS alerted (thread participant + mention) but the
	// PARENT badge stays untouched — the Threads nav owns thread unreads.
	if got := members.counts["ch1#u-root"]; got != 0 {
		t.Fatalf("thread reply bumped the parent badge by %d, want 0", got)
	}
}

func TestNotifyCount_BumpFailureStillNotifies(t *testing.T) {
	svc, pub, members, _, chans, users := setupBumpNotifier(t)
	members.bumpErr = errors.New("dynamo down")
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-m"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-m"}

	msg := &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hey @[u-m|Bob]"}
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

	// The alert itself is never blocked by a badge write failure.
	if n, ok := notifCountFor(t, pub, "u-m"); !ok || n != 0 {
		t.Fatalf("notification published=%v count=%d, want published with count 0", ok, n)
	}
}

func TestNotifyCount_NonCapableStoreSkipsBump(t *testing.T) {
	// Plain stores (no IncrementNotifyCount): the notifier skips the badge
	// without error — the notification still goes out.
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-m"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-m"}

	msg := &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hey @[u-m|Bob]"}
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)
	if n, ok := notifCountFor(t, pub, "u-m"); !ok || n != 0 {
		t.Fatalf("published=%v count=%d, want published with count 0", ok, n)
	}
}

// Read-time clamp: the alerted badge can never exceed (or outlive) the plain
// unread count, whatever races the two detached write paths ran into.
func TestListUserChannels_ClampsNotifyCountToUnread(t *testing.T) {
	channels := &batchMockChannelStore{mockChannelStore: newMockChannelStore()}
	memberships := newMockMembershipStore()
	svc := NewChannelService(channels, memberships, nil, nil, nil, nil, nil)
	channels.channels["ch-1"] = &model.Channel{ID: "ch-1", MessageSeq: 10}
	channels.channels["ch-2"] = &model.Channel{ID: "ch-2", MessageSeq: 5}
	memberships.userChannels = []*model.UserChannel{
		// 2 unread, 7 claims alerted → clamp to 2.
		{UserID: "u-1", ChannelID: "ch-1", LastReadSeq: 8, UnreadNotifyCount: 7},
		// fully read but a racing bump left 1 → clamp to 0.
		{UserID: "u-1", ChannelID: "ch-2", LastReadSeq: 5, UnreadNotifyCount: 1},
	}
	got, err := svc.ListUserChannels(context.Background(), "u-1")
	if err != nil || len(got) != 2 {
		t.Fatalf("list = %+v (err=%v)", got, err)
	}
	byID := map[string]*model.UserChannel{}
	for _, uc := range got {
		byID[uc.ChannelID] = uc
	}
	if byID["ch-1"].UnreadNotifyCount != 2 || byID["ch-1"].UnreadCount != 2 {
		t.Fatalf("ch-1 = notify %d unread %d, want 2/2", byID["ch-1"].UnreadNotifyCount, byID["ch-1"].UnreadCount)
	}
	if byID["ch-2"].UnreadNotifyCount != 0 || byID["ch-2"].Unread {
		t.Fatalf("ch-2 = notify %d unread=%v, want 0/false", byID["ch-2"].UnreadNotifyCount, byID["ch-2"].Unread)
	}
}

func TestListUserConversations_ClampsNotifyCountToUnread(t *testing.T) {
	convs := &batchMockConversationStore{mockConversationStore: newMockConversationStore()}
	svc := NewConversationService(convs, newMockUserStore(), nil, nil, nil)
	convs.conversations["dm-1"] = &model.Conversation{ID: "dm-1", MessageSeq: 4, Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "u-2"}}
	convs.userConvs["u-1"] = []*model.UserConversation{
		{UserID: "u-1", ConversationID: "dm-1", Activated: true, LastReadSeq: 4, UnreadNotifyCount: 3},
	}
	got, err := svc.ListUserConversations(context.Background(), "u-1")
	if err != nil || len(got) != 1 {
		t.Fatalf("list = %+v (err=%v)", got, err)
	}
	if got[0].UnreadNotifyCount != 0 {
		t.Fatalf("clamped count = %d, want 0 on a fully-read conversation", got[0].UnreadNotifyCount)
	}
}
