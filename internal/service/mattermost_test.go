package service

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

type fakeMMChannels struct {
	channels  map[string]*model.Channel
	getErr    error
	createErr error
	addErr    error
	created   []*model.Channel
	added     []string
}

func (f *fakeMMChannels) Create(_ context.Context, userID, name string, chanType model.ChannelType, description string) (*model.Channel, error) {
	if f.createErr != nil {
		return nil, f.createErr
	}
	ch := &model.Channel{ID: "ch-" + name, Name: name, Slug: name, Type: chanType, Description: description, CreatedBy: userID}
	f.created = append(f.created, ch)
	return ch, nil
}

func (f *fakeMMChannels) GetByID(_ context.Context, id string) (*model.Channel, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	ch, ok := f.channels[id]
	if !ok {
		return nil, fmt.Errorf("channel: get: %w", store.ErrNotFound)
	}
	return ch, nil
}

func (f *fakeMMChannels) AddMember(_ context.Context, actorID, channelID, userID string, role model.ChannelRole) error {
	f.added = append(f.added, actorID+">"+channelID+">"+userID+">"+role.String())
	return f.addErr
}

type mmSent struct{ author, parentID, parentType, body, root string }

type fakeMMMessages struct {
	sent []mmSent
	err  error
}

func (f *fakeMMMessages) Send(_ context.Context, userID, parentID, parentType, body, parentMessageID string, _ ...string) (*model.Message, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.sent = append(f.sent, mmSent{userID, parentID, parentType, body, parentMessageID})
	return &model.Message{ID: "m-1", ParentID: parentID, AuthorID: userID, Body: body}, nil
}

type fakeMMDMs struct {
	pairs [][2]string
	err   error
}

func (f *fakeMMDMs) GetOrCreateDM(_ context.Context, a, b string) (*model.Conversation, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.pairs = append(f.pairs, [2]string{a, b})
	return &model.Conversation{ID: "dm-" + a + "-" + b, ParticipantIDs: []string{a, b}}, nil
}

type fakeMarkup struct{}

func (fakeMarkup) TranslateMarkup(_ context.Context, text string) string { return "ex:" + text }

type fakeMMMemberships struct {
	members map[string]*model.ChannelMembership
	err     error
}

func (f *fakeMMMemberships) GetMembership(_ context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	if f.err != nil {
		return nil, f.err
	}
	m, ok := f.members[channelID+"#"+userID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return m, nil
}

type mmFixture struct {
	svc      *MattermostService
	channels *fakeMMChannels
	members  *fakeMMMemberships
	users    *mockUserStore
	messages *fakeMMMessages
	dms      *fakeMMDMs
}

func newMMFixture() *mmFixture {
	f := &mmFixture{
		channels: &fakeMMChannels{channels: map[string]*model.Channel{"ch-1": {ID: "ch-1", Name: "incidents"}}},
		members:  &fakeMMMemberships{members: map[string]*model.ChannelMembership{}},
		users:    newMockUserStore(),
		messages: &fakeMMMessages{},
		dms:      &fakeMMDMs{},
	}
	f.users.users["u-alice"] = &model.User{ID: "u-alice", DisplayName: "Alice"}
	f.svc = NewMattermostService(f.channels, f.members, f.users, f.messages, f.dms, fakeMarkup{})
	return f
}

func TestMattermost_CreateChannelOwnedByTheBot(t *testing.T) {
	f := newMMFixture()
	ctx := context.Background()
	open, err := f.svc.CreateChannel(ctx, "b-1", "inc-0007", false, "Incident channel for INC-0007")
	if err != nil || open.Type != model.ChannelTypePublic || open.Description != "Incident channel for INC-0007" || open.CreatedBy != "b-1" {
		t.Fatalf("public CreateChannel = %+v, %v", open, err)
	}
	private, err := f.svc.CreateChannel(ctx, "b-1", "inc-0008", true, "")
	if err != nil || private.Type != model.ChannelTypePrivate {
		t.Fatalf("private CreateChannel = %+v, %v", private, err)
	}
	f.channels.createErr = ErrAlreadyExists
	if _, err := f.svc.CreateChannel(ctx, "b-1", "inc-0007", false, ""); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("CreateChannel of a taken name = %v", err)
	}
}

func TestMattermost_AddChannelMember(t *testing.T) {
	f := newMMFixture()
	ctx := context.Background()
	f.members.members["ch-1#u-alice"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-alice", Role: model.ChannelRoleMember}
	m, err := f.svc.AddChannelMember(ctx, "b-1", "ch-1", "u-alice")
	if err != nil || m.UserID != "u-alice" {
		t.Fatalf("AddChannelMember = %+v, %v", m, err)
	}
	if len(f.channels.added) != 1 || f.channels.added[0] != "b-1>ch-1>u-alice>"+model.ChannelRoleMember.String() {
		t.Fatalf("added %v, want the bot adding alice as a member", f.channels.added)
	}
}

// An integration re-invites whoever is relevant; someone already in the
// channel stays as they are, and the answer is the same.
func TestMattermost_AddChannelMemberAlreadyThere(t *testing.T) {
	f := newMMFixture()
	f.channels.addErr = fmt.Errorf("channel: add member: %w", store.ErrAlreadyExists)
	f.members.members["ch-1#u-alice"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-alice", Role: model.ChannelRoleAdmin}
	m, err := f.svc.AddChannelMember(context.Background(), "b-1", "ch-1", "u-alice")
	if err != nil || m.Role != model.ChannelRoleAdmin {
		t.Fatalf("AddChannelMember of a member = %+v, %v; want their admin membership unchanged", m, err)
	}
}

func TestMattermost_AddChannelMemberRefusals(t *testing.T) {
	ctx := context.Background()
	t.Run("unknown user", func(t *testing.T) {
		f := newMMFixture()
		if _, err := f.svc.AddChannelMember(ctx, "b-1", "ch-1", "u-ghost"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("= %v, want not found", err)
		}
		if len(f.channels.added) != 0 {
			t.Fatal("a ghost was added")
		}
	})
	t.Run("user lookup fails", func(t *testing.T) {
		f := newMMFixture()
		boom := errors.New("boom")
		f.users.getUserErr = boom
		if _, err := f.svc.AddChannelMember(ctx, "b-1", "ch-1", "u-alice"); !errors.Is(err, boom) || errors.Is(err, ErrNotFound) {
			t.Fatalf("= %v", err)
		}
	})
	t.Run("not allowed", func(t *testing.T) {
		f := newMMFixture()
		f.channels.addErr = ErrForbidden
		if _, err := f.svc.AddChannelMember(ctx, "b-1", "ch-1", "u-alice"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("= %v", err)
		}
	})
	t.Run("membership read fails", func(t *testing.T) {
		f := newMMFixture()
		boom := errors.New("boom")
		f.members.err = boom
		if _, err := f.svc.AddChannelMember(ctx, "b-1", "ch-1", "u-alice"); !errors.Is(err, boom) {
			t.Fatalf("= %v", err)
		}
	})
}

func TestMattermost_CreatePost(t *testing.T) {
	f := newMMFixture()
	ctx := context.Background()
	if _, err := f.svc.CreatePost(ctx, "b-1", "ch-1", "@all see ~inc-0007", ""); err != nil {
		t.Fatalf("CreatePost to a channel: %v", err)
	}
	if _, err := f.svc.CreatePost(ctx, "b-1", "dm-1", "You manage INC-0007", "root-1"); err != nil {
		t.Fatalf("CreatePost to a conversation: %v", err)
	}
	want := []mmSent{
		{"b-1", "ch-1", ParentChannel, "ex:@all see ~inc-0007", ""},
		{"b-1", "dm-1", ParentConversation, "ex:You manage INC-0007", "root-1"},
	}
	if len(f.messages.sent) != 2 || f.messages.sent[0] != want[0] || f.messages.sent[1] != want[1] {
		t.Fatalf("sent %+v, want %+v", f.messages.sent, want)
	}

	f.messages.err = ErrForbidden
	if _, err := f.svc.CreatePost(ctx, "b-1", "ch-1", "x", ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("CreatePost refused = %v", err)
	}
	boom := errors.New("boom")
	f.channels.getErr = boom
	f.messages.err = nil
	if _, err := f.svc.CreatePost(ctx, "b-1", "ch-1", "x", ""); !errors.Is(err, boom) {
		t.Fatalf("CreatePost with a failed channel read = %v", err)
	}
	if len(f.messages.sent) != 2 {
		t.Fatal("posted although the channel read failed")
	}
}

func TestMattermost_DirectChannel(t *testing.T) {
	f := newMMFixture()
	ctx := context.Background()
	for _, ids := range [][]string{{"b-1", "u-alice"}, {"u-alice", "b-1"}} {
		conv, err := f.svc.DirectChannel(ctx, "b-1", ids)
		if err != nil || conv.ID != "dm-b-1-u-alice" {
			t.Fatalf("DirectChannel(%v) = %+v, %v", ids, conv, err)
		}
	}
	if _, err := f.svc.DirectChannel(ctx, "b-1", []string{"b-1"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("one ID = %v", err)
	}
	if _, err := f.svc.DirectChannel(ctx, "b-1", []string{"u-alice", "u-bob"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("without the bot = %v", err)
	}
	f.dms.err = fmt.Errorf("conversation: get user B: %w", store.ErrNotFound)
	if _, err := f.svc.DirectChannel(ctx, "b-1", []string{"b-1", "u-ghost"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("with an unknown user = %v", err)
	}
}

// The Mattermost API posts through the webhooks' markup translation: what the
// incident workflow writes comes out as ex mentions.
func TestIncomingWebhookService_TranslateMarkup(t *testing.T) {
	ch := &model.Channel{ID: "ch-7", Name: "inc-0007", Slug: "inc-0007"}
	svc := NewIncomingWebhookService(nil, fakeWebhookChannels{
		byID:   map[string]*model.Channel{ch.ID: ch},
		bySlug: map[string]*model.Channel{ch.Slug: ch},
	}, nil, nil, "")
	got := svc.TranslateMarkup(context.Background(), "@all Further discussion on Incident INC-0007 at ~inc-0007")
	if want := "@all Further discussion on Incident INC-0007 at ~[ch-7|inc-0007]"; got != want {
		t.Fatalf("TranslateMarkup = %q, want %q", got, want)
	}
}
