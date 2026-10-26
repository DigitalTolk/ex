package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// A group message becoming a private channel.

type fakeConverter struct {
	convs map[string]*model.Conversation
	rows  map[string]*model.UserConversation
	// rowsByConv, when it has an entry, answers for that conversation
	// instead of rows.
	rowsByConv map[string]map[string]*model.UserConversation
	getErr     error
	rowsErr    error
	convertErr error
	moveErr    error
	converted  *model.Channel
	members    []store.ConvertedMember
	moved      []store.ConvertedMember
}

func (f *fakeConverter) MoveMembersToChannel(_ context.Context, _ string, members []store.ConvertedMember) error {
	if f.moveErr != nil {
		return f.moveErr
	}
	f.moved = append(f.moved, members...)
	return nil
}

func (f *fakeConverter) GetConversation(_ context.Context, id string) (*model.Conversation, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	c, ok := f.convs[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return c, nil
}

func (f *fakeConverter) GetUserConversations(_ context.Context, convID string, _ []string) (map[string]*model.UserConversation, error) {
	if rows, ok := f.rowsByConv[convID]; ok {
		return rows, f.rowsErr
	}
	return f.rows, f.rowsErr
}

func (f *fakeConverter) ConvertGroupToChannel(_ context.Context, ch *model.Channel, members []store.ConvertedMember, _ time.Time) error {
	if f.convertErr != nil {
		return f.convertErr
	}
	f.converted, f.members = ch, members
	return nil
}

func convertSetup(t *testing.T) (*ChannelService, *fakeConverter, *mockChannelStore, *mockUserStore, *mockBroker, *mockPublisher) {
	t.Helper()
	svc, channels, _, users, broker, pub := setupChannelServiceWithUsers()
	for _, u := range []*model.User{{ID: "u-a", DisplayName: "Alice"}, {ID: "u-b", DisplayName: "Bob"}, {ID: "u-c", DisplayName: "Carol"}} {
		users.users[u.ID] = u
	}
	conv := &fakeConverter{
		convs: map[string]*model.Conversation{
			"g-1":    {ID: "g-1", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-a", "u-b", "u-c"}, MessageSeq: 9},
			"dm-1":   {ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-a", "u-b"}},
			"g-done": {ID: "g-done", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-a", "u-b"}, ConvertedToChannelID: "g-done"},
		},
		rows: map[string]*model.UserConversation{
			"u-a": {UserID: "u-a", LastReadSeq: 9, LastReadMsgID: "m-9", Favorite: true, SidebarPosition: 3},
			"u-b": {UserID: "u-b", LastReadSeq: 4, UnreadNotifyCount: 2, CategoryID: "cat-1", SidebarPosition: 5},
		},
		// A finished conversion moved everyone: nobody has a group row left.
		rowsByConv: map[string]map[string]*model.UserConversation{"g-done": {}},
	}
	svc.SetConversationConverter(conv, nil)
	return svc, conv, channels, users, broker, pub
}

type fakeDraftMover struct {
	userIDs        []string
	conversationID string
}

func (f *fakeDraftMover) MoveConversationDrafts(_ context.Context, userIDs []string, conversationID string) {
	f.userIDs, f.conversationID = userIDs, conversationID
}

// Everyone's drafts in the group go along to the channel.
func TestConvertGroupConversation_MovesDrafts(t *testing.T) {
	svc, conv, _, _, _, _ := convertSetup(t)
	mover := &fakeDraftMover{}
	svc.SetConversationConverter(conv, mover)
	if _, err := svc.ConvertGroupConversation(context.Background(), "u-a", "g-1", "ops"); err != nil {
		t.Fatal(err)
	}
	if mover.conversationID != "g-1" || strings.Join(mover.userIDs, ",") != "u-a,u-b,u-c" {
		t.Fatalf("drafts moved for %v in %q", mover.userIDs, mover.conversationID)
	}
	// A refused conversion moves nothing.
	mover.conversationID = ""
	if _, err := svc.ConvertGroupConversation(context.Background(), "u-x", "g-1", "ops"); err == nil {
		t.Fatal("someone outside the group converted it")
	}
	if mover.conversationID != "" {
		t.Fatal("a refused conversion moved drafts")
	}
}

func TestConvertGroupConversation(t *testing.T) {
	svc, conv, _, _, broker, pub := convertSetup(t)
	ctx := context.Background()
	ch, err := svc.ConvertGroupConversation(ctx, "u-b", "g-1", "ops")
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if ch.ID != "g-1" || ch.Slug != "ops" || ch.Type != model.ChannelTypePrivate || ch.MessageSeq != 9 || ch.CreatedBy != "u-b" {
		t.Fatalf("channel = %+v", ch)
	}
	byUser := map[string]store.ConvertedMember{}
	for _, m := range conv.members {
		byUser[m.Member.UserID] = m
	}
	if len(byUser) != 3 {
		t.Fatalf("members = %+v", conv.members)
	}
	// Whoever converts owns it; everyone keeps their place and their unread.
	if byUser["u-b"].Member.Role != model.ChannelRoleOwner || byUser["u-a"].Member.Role != model.ChannelRoleMember || byUser["u-a"].Member.DisplayName != "Alice" {
		t.Errorf("roles = %+v / %+v", byUser["u-b"].Member, byUser["u-a"].Member)
	}
	a, b, c := byUser["u-a"].UserChannel, byUser["u-b"].UserChannel, byUser["u-c"].UserChannel
	if a.LastReadSeq != 9 || a.LastReadMsgID != "m-9" || !a.Favorite || a.SidebarPosition != 0 {
		t.Errorf("u-a row = %+v", a)
	}
	if b.LastReadSeq != 4 || b.UnreadNotifyCount != 2 || b.CategoryID != "cat-1" || b.SidebarPosition != 5 || b.Role != model.ChannelRoleOwner {
		t.Errorf("u-b row = %+v", b)
	}
	if c.LastReadSeq != 0 || c.ChannelName != "ops" || c.ChannelType != model.ChannelTypePrivate {
		t.Errorf("u-c row = %+v", c)
	}

	// Everyone's sockets follow the channel now, and are told.
	for _, uid := range []string{"u-a", "u-b", "u-c"} {
		if !strings.Contains(strings.Join(broker.subscriptions[uid], ","), pubsub.ChannelName("g-1")) {
			t.Errorf("%s not subscribed to the channel: %v", uid, broker.subscriptions[uid])
		}
		if !strings.Contains(strings.Join(broker.unsubscriptions[uid], ","), pubsub.ConversationName("g-1")) {
			t.Errorf("%s still on the conversation: %v", uid, broker.unsubscriptions[uid])
		}
	}
	told := map[string]bool{}
	var systemMessage string
	for _, p := range pub.published {
		switch p.event.Type {
		case events.EventConversationConverted:
			var payload map[string]string
			if err := json.Unmarshal(p.event.Data, &payload); err != nil || payload["slug"] != "ops" || payload["channelID"] != "g-1" || payload["conversationID"] != "g-1" {
				t.Errorf("payload = %s", p.event.Data)
			}
			told[strings.TrimPrefix(p.channel, "user:")] = true
		case events.EventMessageNew:
			var msg model.Message
			_ = json.Unmarshal(p.event.Data, &msg)
			systemMessage = msg.Body
		case events.EventChannelNew:
			t.Error("a private channel was announced to everyone")
		}
	}
	if len(told) != 3 {
		t.Errorf("told = %v, want everyone in it", told)
	}
	if systemMessage != "Bob made this a private channel" {
		t.Errorf("system message = %q", systemMessage)
	}
}

func TestConvertGroupConversation_Refusals(t *testing.T) {
	svc, conv, channels, users, _, _ := convertSetup(t)
	ctx := context.Background()
	users.users["u-g"] = &model.User{ID: "u-g", SystemRole: model.SystemRoleGuest}
	conv.convs["g-guest"] = &model.Conversation{ID: "g-guest", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-g", "u-a"}}
	channels.channels["ch-taken"] = &model.Channel{ID: "ch-taken", Name: "taken", Slug: "taken"}

	cases := []struct {
		name, actor, conv, channelName string
		want                           error
	}{
		{"not in it", "u-x", "g-1", "ops", ErrForbidden},
		{"a DM", "u-a", "dm-1", "ops", ErrValidation},
		{"a channel already", "u-a", "g-done", "ops", ErrAlreadyExists},
		{"a guest", "u-g", "g-guest", "ops", ErrForbidden},
		{"a bad name", "u-a", "g-1", "Not A Slug!", nil},
		{"a name taken", "u-a", "g-1", "taken", ErrAlreadyExists},
		{"no such conversation", "u-a", "g-none", "ops", store.ErrNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.ConvertGroupConversation(ctx, tc.actor, tc.conv, tc.channelName)
			if err == nil || (tc.want != nil && !errors.Is(err, tc.want)) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
	if conv.converted != nil {
		t.Fatal("a refused conversion converted")
	}
}

func TestConvertGroupConversation_StoreFailures(t *testing.T) {
	svc, conv, _, _, _, _ := convertSetup(t)
	ctx := context.Background()
	for _, tc := range []struct {
		name  string
		setup func()
		want  error
	}{
		{"reading the group", func() { conv.getErr = errors.New("dynamo down") }, nil},
		{"reading its members", func() { conv.rowsErr = errors.New("dynamo down") }, nil},
		{"converted meanwhile", func() { conv.convertErr = store.ErrConversationConverted }, ErrAlreadyExists},
		{"name taken meanwhile", func() { conv.convertErr = store.ErrAlreadyExists }, ErrAlreadyExists},
		{"writing", func() { conv.convertErr = errors.New("dynamo down") }, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conv.getErr, conv.rowsErr, conv.convertErr = nil, nil, nil
			tc.setup()
			_, err := svc.ConvertGroupConversation(ctx, "u-a", "g-1", "ops")
			if err == nil || (tc.want != nil && !errors.Is(err, tc.want)) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
	// Without the converter wired there is nothing to convert with.
	bare, _, _, _, _, _ := setupChannelServiceWithUsers()
	if _, err := bare.ConvertGroupConversation(ctx, "u-a", "g-1", "ops"); !errors.Is(err, ErrValidation) {
		t.Fatalf("unwired = %v", err)
	}
}

// What was set up for the group goes to the channel: a scheduled message,
// an agent's reply, a reminder. Everything else addressed to the group is
// refused; the app finds the channel instead.
func TestConvertedConversation_ServedAsItsChannel(t *testing.T) {
	svc, messages, memberships, convs, pub := setupMessageService()
	ctx := context.Background()
	convs.conversations["g-1"] = &model.Conversation{ID: "g-1", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-a", "u-b"}, ConvertedToChannelID: "g-1"}
	memberships.memberships["g-1#u-a"] = &model.ChannelMembership{ChannelID: "g-1", UserID: "u-a"}

	msg, err := svc.Send(ctx, "u-a", "g-1", ParentConversation, "scheduled hello", "")
	if err != nil {
		t.Fatalf("send = %v", err)
	}
	toChannel := false
	for _, p := range pub.published {
		if p.event.Type == events.EventMessageNew {
			if p.channel != pubsub.ChannelName("g-1") {
				t.Fatalf("published to %s, want the channel", p.channel)
			}
			toChannel = true
		}
	}
	if !toChannel {
		t.Fatal("the message was not published")
	}
	if _, ok := messages.messages["g-1#"+msg.ID]; !ok {
		t.Fatal("message not stored with the channel")
	}
	if err := svc.CheckAccess(ctx, "u-a", "g-1", ParentConversation); err != nil {
		t.Fatalf("check access = %v", err)
	}
	if err := svc.CheckWriteAccess(ctx, "u-a", "g-1", ParentConversation); err != nil {
		t.Fatalf("check write access = %v", err)
	}
	// Someone who isn't in the channel gets nothing.
	if _, err := svc.Send(ctx, "u-b", "g-1", ParentConversation, "hi", ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("send by a non-member = %v", err)
	}
	if err := svc.CheckAccess(ctx, "u-b", "g-1", ParentConversation); !errors.Is(err, ErrForbidden) {
		t.Fatalf("access by a non-member = %v", err)
	}
	// The conversation itself is no more.
	if _, _, err := svc.List(ctx, "u-a", "g-1", ParentConversation, "", 10); !errors.Is(err, ErrConversationConverted) {
		t.Fatalf("list = %v", err)
	}
}

func TestGetOrCreateGroup_AfterTheGroupBecameAChannel(t *testing.T) {
	svc, convs, users, _, _ := setupConversationService()
	ctx := context.Background()
	for _, id := range []string{"u-a", "u-b"} {
		users.users[id] = &model.User{ID: id, DisplayName: id}
	}
	first, err := svc.GetOrCreateGroup(ctx, "u-a", []string{"u-b", "u-c"}, "")
	if err == nil {
		t.Fatalf("a group with an unknown person = %+v", first)
	}
	users.users["u-c"] = &model.User{ID: "u-c", DisplayName: "u-c"}
	first, err = svc.GetOrCreateGroup(ctx, "u-a", []string{"u-b", "u-c"}, "")
	if err != nil {
		t.Fatal(err)
	}
	first.ConvertedToChannelID = first.ID
	convs.conversations[first.ID] = first

	next, err := svc.GetOrCreateGroup(ctx, "u-a", []string{"u-b", "u-c"}, "")
	if err != nil || next.ID == first.ID || next.ID != store.NextGroupConversationID(first.ID) {
		t.Fatalf("next group = %+v, %v (first %s)", next, err, first.ID)
	}
	again, err := svc.GetOrCreateGroup(ctx, "u-c", []string{"u-a", "u-b"}, "")
	if err != nil || again.ID != next.ID {
		t.Fatalf("the same people again = %+v, %v", again, err)
	}
	convs.getErr = errors.New("dynamo down")
	if _, err := svc.GetOrCreateGroup(ctx, "u-a", []string{"u-b", "u-c"}, ""); err == nil {
		t.Fatal("a failed lookup created a group")
	}
}

// The store moves a large group in several transactions. When a later one
// failed, the conversation already reads as a channel and the people not yet
// moved have no way in, so converting again finishes the move — and what the
// first attempt never got to: sockets, the event, drafts, the system message.
func TestConvertGroupConversation_FinishesAPartialConversion(t *testing.T) {
	svc, conv, channels, _, broker, pub := convertSetup(t)
	ctx := context.Background()
	mover := &fakeDraftMover{}
	svc.SetConversationConverter(conv, mover)
	conv.convs["g-half"] = &model.Conversation{ID: "g-half", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-a", "u-b", "u-c"}, ConvertedToChannelID: "g-half"}
	conv.rowsByConv["g-half"] = map[string]*model.UserConversation{"u-c": {UserID: "u-c", LastReadSeq: 7, Favorite: true}}
	channels.channels["g-half"] = &model.Channel{ID: "g-half", Name: "ops", Slug: "ops", Type: model.ChannelTypePrivate, CreatedBy: "u-a"}

	ch, err := svc.ConvertGroupConversation(ctx, "u-c", "g-half", "another name")
	if err != nil {
		t.Fatalf("finishing: %v", err)
	}
	if ch.ID != "g-half" || ch.Name != "ops" {
		t.Fatalf("channel = %+v, want the one the group became", ch)
	}
	if len(conv.moved) != 1 || conv.moved[0].Member.UserID != "u-c" || conv.moved[0].Member.Role != model.ChannelRoleMember {
		t.Fatalf("moved = %+v, want only Carol, as a member", conv.moved)
	}
	if uc := conv.moved[0].UserChannel; uc.LastReadSeq != 7 || !uc.Favorite || uc.ChannelName != "ops" {
		t.Fatalf("Carol's row = %+v, want her read position and favourite kept", uc)
	}
	told, systemMessage := 0, ""
	for _, p := range pub.published {
		switch p.event.Type {
		case events.EventConversationConverted:
			told++
		case events.EventMessageNew:
			var msg model.Message
			_ = json.Unmarshal(p.event.Data, &msg)
			systemMessage = msg.Body
		}
	}
	if told != 3 || systemMessage != "Alice made this a private channel" {
		t.Fatalf("told %d, system message %q", told, systemMessage)
	}
	if !strings.Contains(strings.Join(broker.subscriptions["u-c"], ","), pubsub.ChannelName("g-half")) {
		t.Fatalf("Carol's sockets don't follow the channel: %v", broker.subscriptions["u-c"])
	}
	if mover.conversationID != "g-half" {
		t.Fatal("drafts were not moved")
	}
}

func TestConvertGroupConversation_FinishingFailures(t *testing.T) {
	svc, conv, channels, _, _, pub := convertSetup(t)
	ctx := context.Background()
	conv.convs["g-half"] = &model.Conversation{ID: "g-half", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-a", "u-c"}, ConvertedToChannelID: "g-half"}
	conv.rowsByConv["g-half"] = map[string]*model.UserConversation{"u-c": {UserID: "u-c"}}

	// The channel it became can't be read.
	if _, err := svc.ConvertGroupConversation(ctx, "u-c", "g-half", "ops"); err == nil {
		t.Fatal("finished without the channel")
	}
	channels.channels["g-half"] = &model.Channel{ID: "g-half", Name: "ops", Slug: "ops", CreatedBy: "u-a"}
	conv.moveErr = errors.New("dynamo down")
	if _, err := svc.ConvertGroupConversation(ctx, "u-c", "g-half", "ops"); err == nil {
		t.Fatal("a failed move was reported as done")
	}
	conv.moveErr, conv.rowsErr = nil, errors.New("dynamo down")
	if _, err := svc.ConvertGroupConversation(ctx, "u-c", "g-half", "ops"); err == nil {
		t.Fatal("finished without knowing who was left")
	}
	for _, p := range pub.published {
		if p.event.Type == events.EventConversationConverted {
			t.Fatal("people were told about a conversion that did not finish")
		}
	}
}
