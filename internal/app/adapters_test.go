package app

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/service"
)

type fakeAttachments map[string]*model.Attachment

func (f fakeAttachments) GetByID(_ context.Context, id string) (*model.Attachment, error) {
	if id == "broken" {
		return nil, errors.New("read failed")
	}
	return f[id], nil
}

func TestAttachmentResolverSkipsMissingAndFailedReads(t *testing.T) {
	r := newAttachmentResolver(fakeAttachments{
		"a1": {ID: "a1", Filename: "report.pdf"},
		"a2": {ID: "a2"}, // no filename: resolved, but not a name
	})
	ctx := context.Background()
	got := r.ResolveAttachments(ctx, []string{"a1", "missing", "broken", "a2"})
	if len(got) != 2 || got[0].ID != "a1" || got[1].ID != "a2" {
		t.Fatalf("attachments = %v, want a1 and a2", got)
	}
	if names := r.ResolveFilenames(ctx, []string{"a1", "a2", "broken"}); !reflect.DeepEqual(names, []string{"report.pdf"}) {
		t.Fatalf("filenames = %v, want [report.pdf]", names)
	}
	if got := r.ResolveAttachments(ctx, nil); got != nil {
		t.Fatalf("no ids = %v, want nil", got)
	}
}

type fakeSources struct {
	userPages map[string][]*model.User
	msgErr    error
	msgPages  map[string][]*model.Message
	hasMore   map[string]bool
}

func (f *fakeSources) ListUsers(_ context.Context, limit int, cursor string) ([]*model.User, string, error) {
	if limit != 200 {
		return nil, "", errors.New("unexpected page size")
	}
	if cursor == "" {
		return f.userPages[""], "p2", nil
	}
	return f.userPages[cursor], "", nil
}

func (f *fakeSources) ListAllChannels(context.Context) ([]*model.Channel, error) {
	return []*model.Channel{{ID: "c1"}}, nil
}

func (f *fakeSources) ListAllConversations(context.Context) ([]*model.Conversation, error) {
	return []*model.Conversation{{ID: "d1"}}, nil
}

func (f *fakeSources) ListMessages(_ context.Context, _, before string, _ int) ([]*model.Message, bool, error) {
	if f.msgErr != nil {
		return nil, false, f.msgErr
	}
	return f.msgPages[before], f.hasMore[before], nil
}

func TestReindexSourcesPageThroughTheStores(t *testing.T) {
	f := &fakeSources{
		userPages: map[string][]*model.User{"": {{ID: "u1"}}, "p2": {{ID: "u2"}}},
		msgPages: map[string][]*model.Message{
			"":   {{ID: "m1"}, {ID: "m2"}},
			"m2": {{ID: "m3"}},
		},
		hasMore: map[string]bool{"": true},
	}
	src := newReindexSources(f, f, f, f)
	ctx := context.Background()

	users, err := src.ListUsers(ctx)
	if err != nil || len(users) != 2 || users[1].ID != "u2" {
		t.Fatalf("users = %v, %v; want both pages", users, err)
	}
	if ch, err := src.ListChannels(ctx); err != nil || len(ch) != 1 {
		t.Fatalf("channels = %v, %v", ch, err)
	}
	if cv, err := src.ListConversations(ctx); err != nil || len(cv) != 1 {
		t.Fatalf("conversations = %v, %v", cv, err)
	}
	msgs, err := src.ListMessages(ctx, "c1")
	if err != nil || len(msgs) != 3 || msgs[2].ID != "m3" {
		t.Fatalf("messages = %v, %v; want the next page keyed by the last ID", msgs, err)
	}
}

func TestReindexSourcesMessagesEdgeCases(t *testing.T) {
	ctx := context.Background()
	// "More" with an empty page ends the walk rather than looping.
	empty := &fakeSources{msgPages: map[string][]*model.Message{}, hasMore: map[string]bool{"": true}}
	if msgs, err := newReindexSources(empty, empty, empty, empty).ListMessages(ctx, "c1"); err != nil || len(msgs) != 0 {
		t.Fatalf("empty page = %v, %v", msgs, err)
	}
	boom := errors.New("dynamo down")
	failing := &fakeSources{msgErr: boom}
	if _, err := newReindexSources(failing, failing, failing, failing).ListMessages(ctx, "c1"); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the store error", err)
	}
}

// fakeSearcher answers Users/Channels with res/err; the rest of the
// interface is unused here.
type fakeSearcher struct {
	search.Searcher
	res     *search.SearchResult
	err     error
	channel search.ChannelQuery
}

func (f *fakeSearcher) Users(context.Context, string, int) (*search.SearchResult, error) {
	return f.res, f.err
}

func (f *fakeSearcher) Channels(_ context.Context, q search.ChannelQuery) (*search.SearchResult, error) {
	f.channel = q
	return f.res, f.err
}

func TestIDSearcher(t *testing.T) {
	ctx := context.Background()
	hits := &fakeSearcher{res: &search.SearchResult{Hits: []search.SearchHit{{ID: "x1"}, {ID: "x2"}}}}
	ids := newIDSearcher(hits)
	if got, err := ids.Users(ctx, "al", 5); err != nil || !reflect.DeepEqual(got, []string{"x1", "x2"}) {
		t.Fatalf("Users = %v, %v", got, err)
	}
	if got, err := ids.Channels(ctx, "gen", 5); err != nil || !reflect.DeepEqual(got, []string{"x1", "x2"}) {
		t.Fatalf("Channels = %v, %v", got, err)
	}
	// Service-layer lookups resolve private channels too; callers apply
	// their own access checks.
	if want := (search.ChannelQuery{Q: "gen", Unscoped: true, Limit: 5}); !reflect.DeepEqual(hits.channel, want) {
		t.Fatalf("channel query = %+v, want %+v", hits.channel, want)
	}

	boom := errors.New("search down")
	failing := newIDSearcher(&fakeSearcher{err: boom})
	if got, err := failing.Users(ctx, "al", 5); got != nil || !errors.Is(err, boom) {
		t.Fatalf("failed Users = %v, %v", got, err)
	}
	if got, err := failing.Channels(ctx, "gen", 5); got != nil || !errors.Is(err, boom) {
		t.Fatalf("failed Channels = %v, %v", got, err)
	}
	none := newIDSearcher(&fakeSearcher{})
	if got, err := none.Users(ctx, "al", 5); got != nil || err != nil {
		t.Fatalf("no result Users = %v, %v", got, err)
	}
}

type fakeAudienceGenerations struct {
	gens map[string]string
	err  error
}

func (f fakeAudienceGenerations) Generations(_ context.Context, keys []string) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := make([]string, len(keys))
	for i, k := range keys {
		out[i] = f.gens[k]
	}
	return out, nil
}

func (fakeAudienceGenerations) Bump(context.Context, ...string) error { return nil }

func TestChannelGenerationsReadsTheChannelKey(t *testing.T) {
	g := channelGenerations{fakeAudienceGenerations{gens: map[string]string{cache.ChannelAudienceKey("c1"): "42"}}}
	if gen, err := g.ChannelGeneration(context.Background(), "c1"); err != nil || gen != "42" {
		t.Fatalf("generation = %q (err %v), want 42", gen, err)
	}
	down := channelGenerations{fakeAudienceGenerations{err: errors.New("redis down")}}
	if _, err := down.ChannelGeneration(context.Background(), "c1"); err == nil {
		t.Fatal("want the read error")
	}
}

// rowUsers is the slice of the user store the cached reader's misses reach.
type rowUsers struct {
	service.UserStore
	rows map[string]*model.User
}

func (u rowUsers) GetUser(_ context.Context, id string) (*model.User, error) {
	if r, ok := u.rows[id]; ok {
		return r, nil
	}
	return nil, errors.New("not found")
}

func (u rowUsers) GetUsersByIDs(_ context.Context, ids []string) ([]*model.User, error) {
	out := make([]*model.User, 0, len(ids))
	for _, id := range ids {
		if r, ok := u.rows[id]; ok {
			out = append(out, r)
		}
	}
	return out, nil
}

func TestCachedUserReaderGoesThroughTheUserService(t *testing.T) {
	users := service.NewUserService(rowUsers{rows: map[string]*model.User{"u1": {ID: "u1", DisplayName: "Ann"}}}, nil, nil, nil)
	r := cachedUserReader{users}
	if u, err := r.GetUser(context.Background(), "u1"); err != nil || u.DisplayName != "Ann" {
		t.Fatalf("GetUser = %+v (err %v)", u, err)
	}
	if _, err := r.GetUser(context.Background(), "ghost"); err == nil {
		t.Fatal("want an error for a missing user")
	}
	got, err := r.GetUsersByIDs(context.Background(), []string{"u1", "ghost"})
	if err != nil || len(got) != 1 || got[0].ID != "u1" {
		t.Fatalf("GetUsersByIDs = %+v (err %v), want u1", got, err)
	}
}
