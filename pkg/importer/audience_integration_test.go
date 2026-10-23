//go:build integration

package importer

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/store"
)

// Every membership write moves the channel's notification audience on — the
// Redis generation ex's notifier checks before it uses a cached member list —
// so running instances alert the new audience from the very next message.
// (internal/handler's TestImportedMember_AlertedAtOnce runs the whole chain.)

func realAudiences(t *testing.T) (*cache.RedisCache, func(channelID string) string) {
	t.Helper()
	if !redisReady {
		t.Skip("skipping: Redis not available")
	}
	c, err := cache.NewRedisCache("redis://" + redisAddr)
	mustNoErr(t, err)
	t.Cleanup(func() { _ = c.Client().Close() })
	gen := func(channelID string) string {
		return c.Client().Get(context.Background(), cache.ChannelAudienceKey(channelID)).Val()
	}
	return c, gen
}

func TestMembershipWritesMoveTheAudience(t *testing.T) {
	e := newEnv(t)
	aud, gen := realAudiences(t)
	im, err := New(Deps{DB: e.db, Audiences: aud})
	mustNoErr(t, err)
	ctx := context.Background()
	addUsers(t, e, "u1", "u2")
	// Redis is shared by the package's tests; the table name is not.
	id := "aud-" + e.db.Table
	_, err = im.EnsureChannel(ctx, ChannelSpec{ID: id, Slug: "aud-chan", Type: "private", CreatedAt: t0})
	mustNoErr(t, err)

	before := gen(id)
	if n, err := im.AddChannelMembers(ctx, id, []MemberSpec{{UserID: "u1"}, {UserID: "u2"}}); err != nil || n != 2 {
		t.Fatalf("add: %d %v", n, err)
	}
	added := gen(id)
	if added == "" || added == before {
		t.Fatalf("adding members left the audience generation at %q", added)
	}
	mustNoErr(t, im.RemoveMembers(ctx, id, []string{"u2"}))
	removed := gen(id)
	if removed == added {
		t.Fatal("removing a member left the audience generation unchanged")
	}
	_, err = im.RemoveChannel(ctx, RemoveChannelSpec{ChannelID: id, Force: true})
	mustNoErr(t, err)
	if gen(id) == removed {
		t.Fatal("removing the channel's members left the audience generation unchanged")
	}
}

type fakeAudiences struct {
	channels []string
	err      error
}

func (f *fakeAudiences) ChannelAudiencesChanged(_ context.Context, channelIDs ...string) error {
	f.channels = append(f.channels, channelIDs...)
	return f.err
}

var errMove = errors.New("redis unreachable")

// A failed membership write may still have committed, so the audience moves
// on anyway; an audience that could not be moved is reported, so the caller
// re-runs the (idempotent) call.
func TestMembershipWritesMoveTheAudience_Failures(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	addUsers(t, e, "u1", "u2")
	_, err := e.im.EnsureChannel(ctx, ChannelSpec{ID: "c1", Slug: "c-one", Type: "public", CreatedAt: t0})
	mustNoErr(t, err)
	aud := &fakeAudiences{}

	failing, err := New(Deps{DB: &store.DB{Client: &faultDynamo{DynamoAPI: e.db.Client, fail: failOn("TransactWriteItems", 0)}, Table: e.db.Table}, Audiences: aud})
	mustNoErr(t, err)
	_, err = failing.AddChannelMembers(ctx, "c1", []MemberSpec{{UserID: "u1"}})
	wantErr(t, err, errFault)
	if !slices.Equal(aud.channels, []string{"c1"}) {
		t.Fatalf("a failed add moved %v, want [c1]", aud.channels)
	}

	aud.channels, aud.err = nil, errMove
	im, err := New(Deps{DB: e.db, Audiences: aud})
	mustNoErr(t, err)
	n, err := im.AddChannelMembers(ctx, "c1", []MemberSpec{{UserID: "u1"}, {UserID: "u2"}})
	wantErr(t, err, errMove)
	if n != 2 {
		t.Fatalf("added %d, want 2 (the members were written)", n)
	}
	wantErr(t, im.RemoveMembers(ctx, "c1", []string{"u2"}), errMove)
	_, err = im.RemoveChannel(ctx, RemoveChannelSpec{ChannelID: "c1", Force: true})
	wantErr(t, err, errMove)
	if _, err := store.NewChannelStore(e.db).GetChannel(ctx, "c1"); err != nil {
		t.Fatalf("the channel was deleted although its audience could not be moved: %v", err)
	}
	// Re-running once the audience can be moved finishes the job.
	aud.err = nil
	_, err = im.RemoveChannel(ctx, RemoveChannelSpec{ChannelID: "c1", Force: true})
	mustNoErr(t, err)
	if !slices.Equal(aud.channels, []string{"c1", "c1", "c1", "c1"}) {
		t.Fatalf("moved %v, want c1 on every call", aud.channels)
	}
}
