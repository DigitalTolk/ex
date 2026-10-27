//go:build integration

package importer

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

func addUsers(t *testing.T, e *env, ids ...string) {
	t.Helper()
	for _, id := range ids {
		_, err := e.im.UpsertUser(context.Background(), UserSpec{ID: id, Email: id + "@example.com", DisplayName: strings.ToUpper(id), CreatedAt: t0})
		mustNoErr(t, err)
	}
}

func TestEnsureChannel(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	spec := ChannelSpec{ID: "c1", Slug: "general-talk", Description: " hi ", Type: "public", CreatedBy: "u1", CreatedAt: t0}
	created, err := e.im.EnsureChannel(ctx, spec)
	if err != nil || !created {
		t.Fatalf("create: %v %v", created, err)
	}
	ch, err := store.NewChannelStore(e.db).GetChannel(ctx, "c1")
	mustNoErr(t, err)
	if ch.Name != "general-talk" || ch.Description != "hi" || !ch.CreatedAt.Equal(t0) || ch.Archived {
		t.Fatalf("channel = %+v", ch)
	}
	if created, err := e.im.EnsureChannel(ctx, spec); err != nil || created {
		t.Fatalf("re-run: %v %v", created, err)
	}
	// Archived, private.
	_, err = e.im.EnsureChannel(ctx, ChannelSpec{ID: "c2", Slug: "old", Type: "private", Archived: true, CreatedAt: t0})
	mustNoErr(t, err)
	// Slug held by another channel.
	_, err = e.im.EnsureChannel(ctx, ChannelSpec{ID: "c3", Slug: "old", Type: "public"})
	var taken *SlugTakenError
	if !errors.As(err, &taken) || taken.ExistingID != "c2" || !strings.Contains(err.Error(), "c2") {
		t.Fatalf("want SlugTakenError, got %v", err)
	}

	chans, err := e.im.Channels(ctx)
	mustNoErr(t, err)
	if len(chans) != 2 {
		t.Fatalf("channels = %+v", chans)
	}
	for _, c := range chans {
		if c.ID == "c2" && (!c.Archived || c.Type != "private") {
			t.Fatalf("c2 = %+v", c)
		}
	}
	_, err = e.faulty(failOn("Scan", 0)).Channels(ctx)
	wantErr(t, err, errFault)

	c2, err := e.im.Channel(ctx, "c2")
	mustNoErr(t, err)
	if c2 != (Channel{ID: "c2", Slug: "old", Name: "old", Type: "private", Archived: true}) {
		t.Fatalf("Channel(c2) = %+v", c2)
	}
	if _, err := e.im.Channel(ctx, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Channel(nope): want ErrNotFound, got %v", err)
	}

	for _, bad := range []ChannelSpec{
		{Slug: "x", Type: "public"},
		{ID: "b", Slug: "Bad Slug", Type: "public"},
		{ID: "b", Slug: "ok", Name: "Bad Name", Type: "public"},
		{ID: "b", Slug: "ok", Type: "public", Description: strings.Repeat("d", 300)},
		{ID: "b", Slug: "ok", Type: "secret"},
	} {
		if _, err := e.im.EnsureChannel(ctx, bad); !errors.Is(err, ErrInvalidSpec) {
			t.Errorf("%+v: want ErrInvalidSpec, got %v", bad, err)
		}
	}
}

func TestEnsureChannelErrors(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	spec := ChannelSpec{ID: "c1", Slug: "c-one", Type: "public", CreatedAt: t0}
	_, err := e.faulty(failOn("GetItem", 1)).EnsureChannel(ctx, spec)
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("TransactWriteItems", 0)).EnsureChannel(ctx, spec)
	wantErr(t, err, errFault)

	// Lost the slug race to this very channel: reported as existing.
	cs := store.NewChannelStore(e.db)
	im := e.racing(func() {
		mustNoErr(t, cs.CreateChannel(ctx, &model.Channel{ID: "c1", Name: "c-one", Slug: "c-one", Type: model.ChannelTypePublic, CreatedAt: t0}))
	})
	if created, err := im.EnsureChannel(ctx, spec); err != nil || created {
		t.Fatalf("race: %v %v", created, err)
	}
	// Slug lookup after a lost race fails.
	spec2 := ChannelSpec{ID: "c9", Slug: "c-one", Type: "public"}
	_, err = e.faulty(failOn("Query", 0)).EnsureChannel(ctx, spec2)
	wantErr(t, err, errFault)

	idx, _ := New(Deps{DB: e.db, Indexer: errIndexer{}})
	_, err = idx.EnsureChannel(ctx, spec)
	wantErr(t, err, errFault)
	_, err = idx.EnsureChannel(ctx, ChannelSpec{ID: "c5", Slug: "c-five", Type: "public"})
	wantErr(t, err, errFault)
}

func TestAddChannelMembers(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	addUsers(t, e, "u1", "u2")
	_, err := e.im.EnsureChannel(ctx, ChannelSpec{ID: "c1", Slug: "c-one", Type: "private", CreatedAt: t0})
	mustNoErr(t, err)
	cs := store.NewChannelStore(e.db)
	_, err = cs.AddMessageSeq(ctx, "c1", 3) // pre-existing messages
	mustNoErr(t, err)

	members := []MemberSpec{{UserID: "u1", Role: model.ChannelRoleOwner, JoinedAt: t0, Favorite: true}, {UserID: "u2", JoinedAt: t0, Muted: true}}
	n, err := e.im.AddChannelMembers(ctx, "c1", members)
	if err != nil || n != 2 {
		t.Fatalf("add: %d %v", n, err)
	}
	if n, err := e.im.AddChannelMembers(ctx, "c1", members); err != nil || n != 0 {
		t.Fatalf("re-run: %d %v", n, err)
	}
	ms := store.NewMembershipStore(e.db)
	list, err := ms.ListMembers(ctx, "c1")
	mustNoErr(t, err)
	roles := map[string]model.ChannelRole{}
	for _, m := range list {
		roles[m.UserID] = m.Role
		if m.DisplayName == "" {
			t.Fatalf("display name not denormalized: %+v", m)
		}
	}
	if roles["u1"] != model.ChannelRoleOwner || roles["u2"] != model.ChannelRoleMember {
		t.Fatalf("roles = %v", roles)
	}
	ucs, err := ms.ListUserChannels(ctx, "u2")
	mustNoErr(t, err)
	if len(ucs) != 1 || ucs[0].LastReadSeq != 3 || !ucs[0].Muted || ucs[0].ChannelName != "c-one" {
		t.Fatalf("u2 channel row = %+v", ucs)
	}

	_, err = e.im.AddChannelMembers(ctx, "nope", members)
	wantErr(t, err, store.ErrNotFound)
	_, err = e.faulty(failOn("BatchGetItem", 0)).AddChannelMembers(ctx, "c1", members)
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("TransactWriteItems", 0)).AddChannelMembers(ctx, "c1", []MemberSpec{{UserID: "u3"}})
	wantErr(t, err, errFault)
}

func TestEnsureConversation(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	addUsers(t, e, "u1", "u2", "u3")
	cv := store.NewConversationStore(e.db)

	id, created, err := e.im.EnsureConversation(ctx, ConversationSpec{Type: "dm", ParticipantIDs: []string{"u2", "u1"}, CreatedAt: t0})
	if err != nil || !created || id != store.DeriveDMConversationID("u1", "u2") {
		t.Fatalf("dm: %s %v %v", id, created, err)
	}
	ucs, err := cv.ListUserConversations(ctx, "u1")
	mustNoErr(t, err)
	if len(ucs) != 1 || ucs[0].DisplayName != "U2" || !ucs[0].Activated {
		t.Fatalf("u1 view = %+v", ucs)
	}
	if _, created, err := e.im.EnsureConversation(ctx, ConversationSpec{Type: "dm", ParticipantIDs: []string{"u1", "u2"}}); err != nil || created {
		t.Fatalf("re-run: %v %v", created, err)
	}
	// Self-DM: titled with the user's own name.
	selfID, _, err := e.im.EnsureConversation(ctx, ConversationSpec{Type: "dm", ParticipantIDs: []string{"u3", "u3"}, CreatedAt: t0})
	mustNoErr(t, err)
	if selfID != store.DeriveDMConversationID("u3", "u3") {
		t.Fatal("self-DM id")
	}
	// Groups: unnamed (others' names) and named.
	gid, _, err := e.im.EnsureConversation(ctx, ConversationSpec{Type: "group", ParticipantIDs: []string{"u3", "u1", "u2"}, CreatedBy: "u1", CreatedAt: t0})
	mustNoErr(t, err)
	if gid != store.DeriveGroupConversationID([]string{"u1", "u2", "u3"}) {
		t.Fatal("group id must match ex's derivation")
	}
	_, _, err = e.im.EnsureConversation(ctx, ConversationSpec{Type: "group", Name: "team", ParticipantIDs: []string{"u1", "u2"}, CreatedAt: t0})
	mustNoErr(t, err)
	titles := map[string]string{}
	ucs, _ = cv.ListUserConversations(ctx, "u1")
	for _, uc := range ucs {
		titles[uc.ConversationID] = uc.DisplayName
	}
	if titles[gid] != "U3, U2" && titles[gid] != "U2, U3" {
		t.Fatalf("group title = %q", titles[gid])
	}

	// An existing, not yet activated conversation (created in ex, no message
	// yet) gets activated.
	pending := &model.Conversation{ID: store.DeriveDMConversationID("u2", "u3"), Type: model.ConversationTypeDM, ParticipantIDs: []string{"u2", "u3"}}
	mustNoErr(t, cv.CreateConversation(ctx, pending, []*model.UserConversation{{UserID: "u2", ConversationID: pending.ID}, {UserID: "u3", ConversationID: pending.ID}}))
	_, _, err = e.im.EnsureConversation(ctx, ConversationSpec{Type: "dm", ParticipantIDs: []string{"u2", "u3"}})
	mustNoErr(t, err)
	got, _ := cv.GetConversation(ctx, pending.ID)
	if !got.Activated {
		t.Fatal("not activated")
	}

	for _, bad := range []ConversationSpec{
		{Type: "dm", ParticipantIDs: []string{"a", "b", "c"}},
		{Type: "dm"},
		{Type: "group", ParticipantIDs: []string{"a"}},
		{Type: "group", ParticipantIDs: make([]string, 60)},
		{Type: "channel", ParticipantIDs: []string{"a"}},
	} {
		if _, _, err := e.im.EnsureConversation(ctx, bad); !errors.Is(err, ErrInvalidSpec) {
			t.Errorf("%+v: want ErrInvalidSpec, got %v", bad, err)
		}
	}
}

func TestEnsureConversationErrors(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	addUsers(t, e, "u1", "u2")
	spec := ConversationSpec{Type: "dm", ParticipantIDs: []string{"u1", "u2"}, CreatedAt: t0}
	_, _, err := e.faulty(failOn("GetItem", 1)).EnsureConversation(ctx, spec)
	wantErr(t, err, errFault)
	_, _, err = e.faulty(failOn("BatchGetItem", 0)).EnsureConversation(ctx, spec)
	wantErr(t, err, errFault)
	_, _, err = e.faulty(failOn("TransactWriteItems", 0)).EnsureConversation(ctx, spec)
	wantErr(t, err, errFault)

	// Race: created concurrently between the lookup and the write.
	cv := store.NewConversationStore(e.db)
	id := store.DeriveDMConversationID("u1", "u2")
	im := e.racing(func() {
		mustNoErr(t, cv.CreateConversation(ctx, &model.Conversation{ID: id, Type: model.ConversationTypeDM, ParticipantIDs: []string{"u1", "u2"}, Activated: true},
			[]*model.UserConversation{{UserID: "u1", ConversationID: id}, {UserID: "u2", ConversationID: id}}))
	})
	if got, created, err := im.EnsureConversation(ctx, spec); err != nil || created || got != id {
		t.Fatalf("race: %s %v %v", got, created, err)
	}
	// Activation failure on an existing, inactive conversation.
	_, err = e.db.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(e.db.Table),
		Key:                       map[string]types.AttributeValue{"PK": &types.AttributeValueMemberS{Value: "CONV#" + id}, "SK": &types.AttributeValueMemberS{Value: "META"}},
		UpdateExpression:          aws.String("SET activated = :f"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":f": &types.AttributeValueMemberBOOL{Value: false}},
	})
	mustNoErr(t, err)
	_, _, err = e.faulty(failOn("TransactWriteItems", 0)).EnsureConversation(ctx, spec)
	wantErr(t, err, errFault)
}
