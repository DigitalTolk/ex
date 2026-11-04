package service

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// fakeMemberCache is the shared copy in memory: per channel the generation it
// holds, whether it is complete, and its rows; gens is each channel's current
// generation.
type fakeMemberCache struct {
	gens     map[string]string
	held     map[string]string
	complete map[string]bool
	rows     map[string]map[string]*model.ChannelMembership
	readErr  error
	putErr   error
}

func newFakeMemberCache() *fakeMemberCache {
	return &fakeMemberCache{gens: map[string]string{}, held: map[string]string{}, complete: map[string]bool{}, rows: map[string]map[string]*model.ChannelMembership{}}
}

// move is a membership write elsewhere moving the channel's generation.
func (f *fakeMemberCache) move(channelID string) {
	n, _ := strconv.Atoi(f.gens[channelID])
	f.gens[channelID] = strconv.Itoa(n + 1)
}

func (f *fakeMemberCache) valid(channelID string) bool {
	_, ok := f.held[channelID]
	return ok && f.held[channelID] == f.gens[channelID]
}

func (f *fakeMemberCache) Member(_ context.Context, channelID, userID string) (*model.ChannelMembership, string, error) {
	if f.readErr != nil {
		return nil, "", f.readErr
	}
	if !f.valid(channelID) {
		return nil, f.gens[channelID], nil
	}
	return f.rows[channelID][userID], f.gens[channelID], nil
}

func (f *fakeMemberCache) Members(_ context.Context, channelID string) ([]*model.ChannelMembership, string, bool, error) {
	if f.readErr != nil {
		return nil, "", false, f.readErr
	}
	if !f.valid(channelID) || !f.complete[channelID] {
		return nil, f.gens[channelID], false, nil
	}
	out := make([]*model.ChannelMembership, 0, len(f.rows[channelID]))
	for _, r := range f.rows[channelID] {
		out = append(out, r)
	}
	return out, f.gens[channelID], true, nil
}

func (f *fakeMemberCache) PutMember(_ context.Context, channelID, gen string, row *model.ChannelMembership) error {
	if f.putErr != nil {
		return f.putErr
	}
	if held, ok := f.held[channelID]; !ok || held != gen {
		f.held[channelID], f.complete[channelID], f.rows[channelID] = gen, false, map[string]*model.ChannelMembership{}
	}
	f.rows[channelID][row.UserID] = row
	return nil
}

func (f *fakeMemberCache) PutMembers(_ context.Context, channelID, gen string, rows []*model.ChannelMembership) error {
	if f.putErr != nil {
		return f.putErr
	}
	f.held[channelID], f.complete[channelID], f.rows[channelID] = gen, true, map[string]*model.ChannelMembership{}
	for _, r := range rows {
		f.rows[channelID][r.UserID] = r
	}
	return nil
}

// consistentMembershipStore adds the store's consistent reads to the fake and
// counts them.
type consistentMembershipStore struct {
	*mockMembershipStore
	consistentGets  int
	consistentLists int
	renamed         []string
}

func (s *consistentMembershipStore) GetMembershipConsistent(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	s.consistentGets++
	return s.GetMembership(ctx, channelID, userID)
}

func (s *consistentMembershipStore) ListMembersConsistent(ctx context.Context, channelID string) ([]*model.ChannelMembership, error) {
	s.consistentLists++
	return s.ListMembers(ctx, channelID)
}

func (s *consistentMembershipStore) SetUserChannelName(_ context.Context, channelID, userID, name string) error {
	s.renamed = append(s.renamed, channelID+"/"+userID+"="+name)
	return nil
}

func cachedMembershipsFixture() (*CachedMemberships, *consistentMembershipStore, *fakeMemberCache) {
	raw := &consistentMembershipStore{mockMembershipStore: newMockMembershipStore()}
	raw.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleAdmin}
	raw.memberships["ch1#u2"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u2", Role: model.ChannelRoleMember}
	c := newFakeMemberCache()
	return NewCachedMemberships(raw, c), raw, c
}

// The access check behind nearly every request reads the shared copy: a
// member's first check fills their row (consistently), the rest are served
// from it until a membership write moves the channel's generation.
func TestCachedMemberships_ChecksAreServedFromTheCopy(t *testing.T) {
	m, raw, c := cachedMembershipsFixture()
	ctx := context.Background()
	for range 3 {
		got, err := m.GetMembership(ctx, "ch1", "u1")
		if err != nil || got.Role != model.ChannelRoleAdmin {
			t.Fatalf("GetMembership = %+v (err %v), want u1 as admin", got, err)
		}
	}
	if raw.consistentGets != 1 {
		t.Fatalf("store reads = %d, want 1 (then the copy)", raw.consistentGets)
	}

	// A role change elsewhere moves the generation: the next check re-reads.
	raw.memberships["ch1#u1"].Role = model.ChannelRoleMember
	c.move("ch1")
	if got, err := m.GetMembership(ctx, "ch1", "u1"); err != nil || got.Role != model.ChannelRoleMember || raw.consistentGets != 2 {
		t.Fatalf("after the move = %+v (err %v, reads %d), want the new role from a re-read", got, err, raw.consistentGets)
	}
}

// Someone the copy doesn't hold is always asked of the store: a non-member
// stays out, and a member whose join the copy missed (a generation move that
// was lost) is never locked out.
func TestCachedMemberships_TheStoreDecidesWhoTheCopyLacks(t *testing.T) {
	m, raw, c := cachedMembershipsFixture()
	ctx := context.Background()
	if _, err := m.ListMembers(ctx, "ch1"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := m.GetMembership(ctx, "ch1", "stranger"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("stranger: err = %v, want ErrNotFound", err)
		}
	}
	if raw.consistentGets != 2 {
		t.Fatalf("store reads for a non-member = %d, want one per check", raw.consistentGets)
	}

	// u3 joined, but the generation move was lost: the copy is "complete"
	// without them.
	raw.memberships["ch1#u3"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u3", Role: model.ChannelRoleMember}
	if got, err := m.GetMembership(ctx, "ch1", "u3"); err != nil || got.UserID != "u3" {
		t.Fatalf("u3 = %+v (err %v), want the store's row", got, err)
	}
	if c.rows["ch1"]["u3"] == nil {
		t.Fatal("u3's row was not added to the copy")
	}
}

// A channel's member list is read once (consistently) and then served from
// the copy until the generation moves.
func TestCachedMemberships_ListMembersFromTheCopy(t *testing.T) {
	m, raw, c := cachedMembershipsFixture()
	ctx := context.Background()
	for range 2 {
		rows, err := m.ListMembers(ctx, "ch1")
		if err != nil || len(rows) != 2 {
			t.Fatalf("ListMembers = %v (err %v), want 2", rows, err)
		}
	}
	if raw.consistentLists != 1 || raw.listMembersCalls.Load() != 1 {
		t.Fatalf("store lists = %d, want 1", raw.consistentLists)
	}
	// The complete copy answers access checks too.
	if _, err := m.GetMembership(ctx, "ch1", "u2"); err != nil || raw.consistentGets != 0 {
		t.Fatalf("check from the list copy: err %v, store reads %d", err, raw.consistentGets)
	}
	c.move("ch1")
	if _, err := m.ListMembers(ctx, "ch1"); err != nil || raw.consistentLists != 2 {
		t.Fatalf("after the move: err %v, lists %d, want a re-read", err, raw.consistentLists)
	}
}

// With Redis down (or a store without consistent reads) every read goes to the
// store as before, and store errors surface.
func TestCachedMemberships_FallsBackToTheStore(t *testing.T) {
	m, raw, c := cachedMembershipsFixture()
	ctx := context.Background()
	c.readErr = errors.New("redis down")
	if got, err := m.GetMembership(ctx, "ch1", "u1"); err != nil || got.UserID != "u1" {
		t.Fatalf("GetMembership with Redis down = %+v (err %v)", got, err)
	}
	if rows, err := m.ListMembers(ctx, "ch1"); err != nil || len(rows) != 2 {
		t.Fatalf("ListMembers with Redis down = %v (err %v)", rows, err)
	}
	if raw.consistentGets != 0 || raw.consistentLists != 0 {
		t.Fatal("Redis down: the plain store reads should serve")
	}
	c.readErr = nil

	// A failed copy write still answers.
	c.putErr = errors.New("redis full")
	if got, err := m.GetMembership(ctx, "ch1", "u1"); err != nil || got.UserID != "u1" {
		t.Fatalf("GetMembership with a failing put = %+v (err %v)", got, err)
	}
	if rows, err := m.ListMembers(ctx, "ch1"); err != nil || len(rows) != 2 {
		t.Fatalf("ListMembers with a failing put = %v (err %v)", rows, err)
	}
	c.putErr = nil

	raw.getErr = errors.New("dynamo down")
	if _, err := m.GetMembership(ctx, "ch1", "u2"); !errors.Is(err, raw.getErr) {
		t.Fatalf("store error = %v, want it surfaced", err)
	}
	raw.listMembersErr = errors.New("dynamo down")
	c.move("ch1")
	if _, err := m.ListMembers(ctx, "ch1"); !errors.Is(err, raw.listMembersErr) {
		t.Fatalf("list error = %v, want it surfaced", err)
	}

	plain := NewCachedMemberships(newMockMembershipStore(), newFakeMemberCache())
	if _, err := plain.GetMembership(ctx, "ch1", "u1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("plain store GetMembership err = %v", err)
	}
	if rows, err := plain.ListMembers(ctx, "ch1"); err != nil || len(rows) != 0 {
		t.Fatalf("plain store ListMembers = %v (err %v)", rows, err)
	}
}

// The channel service renames the sidebar copies through the store when it
// can; the wrapper passes that on.
func TestCachedMemberships_SetUserChannelName(t *testing.T) {
	m, raw, _ := cachedMembershipsFixture()
	if err := m.SetUserChannelName(context.Background(), "ch1", "u1", "renamed"); err != nil || len(raw.renamed) != 1 {
		t.Fatalf("rename = %v (err %v)", raw.renamed, err)
	}
	plain := NewCachedMemberships(newMockMembershipStore(), newFakeMemberCache())
	if err := plain.SetUserChannelName(context.Background(), "ch1", "u1", "renamed"); err != nil {
		t.Fatalf("plain store rename: %v", err)
	}
}
