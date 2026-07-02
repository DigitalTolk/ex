package search

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// fakeRecreator records RecreateIndex calls and the docs bulked into each
// index, so a unit test can assert the drop-and-rebuild order and that
// only source docs (never a stale orphan) end up written.
type fakeRecreator struct {
	recreated []string
	bulked    map[string][]string // index → doc IDs
	recreErr  map[string]error    // index → error on RecreateIndex
	bulkErr   map[string]error    // index → error on Bulk
}

func (f *fakeRecreator) RecreateIndex(_ context.Context, name string) error {
	f.recreated = append(f.recreated, name)
	if f.recreErr != nil {
		if err := f.recreErr[name]; err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeRecreator) Bulk(_ context.Context, index string, entries []BulkEntry) error {
	if f.bulked == nil {
		f.bulked = map[string][]string{}
	}
	for _, e := range entries {
		f.bulked[index] = append(f.bulked[index], e.ID)
	}
	if f.bulkErr != nil {
		if err := f.bulkErr[index]; err != nil {
			return err
		}
	}
	return nil
}

func TestRecreateUsersChannels_RecreatesThenReindexes(t *testing.T) {
	src := &fakeSources{
		users:    []*model.User{{ID: "u1", DisplayName: "Alice"}, {ID: "u2", DisplayName: "Bob"}},
		channels: []*model.Channel{{ID: "c1", Name: "general"}},
	}
	rc := &fakeRecreator{}
	users, channels, err := RecreateUsersChannels(context.Background(), rc, src)
	if err != nil {
		t.Fatalf("RecreateUsersChannels: %v", err)
	}
	if users != 2 || channels != 1 {
		t.Fatalf("counts = users %d channels %d, want 2/1", users, channels)
	}
	// Both indices dropped-and-recreated with the fresh mapping.
	if len(rc.recreated) != 2 || rc.recreated[0] != IndexUsers || rc.recreated[1] != IndexChannels {
		t.Fatalf("recreated = %v, want [%s %s]", rc.recreated, IndexUsers, IndexChannels)
	}
	// Only the SOURCE docs were bulked; a doc absent from the source
	// (e.g. a deleted-user ghost) can never appear because the index was
	// rebuilt from scratch.
	if got := rc.bulked[IndexUsers]; len(got) != 2 || got[0] != "u1" || got[1] != "u2" {
		t.Fatalf("bulked users = %v, want [u1 u2]", got)
	}
	if got := rc.bulked[IndexChannels]; len(got) != 1 || got[0] != "c1" {
		t.Fatalf("bulked channels = %v, want [c1]", got)
	}
}

func TestRecreateUsersChannels_DropsOrphan(t *testing.T) {
	// The source no longer contains "u-ghost" (deleted from DynamoDB).
	// After a recreate the rebuilt index only carries the live user, so
	// the orphan is gone — proven here by it never being bulked.
	src := &fakeSources{
		users:    []*model.User{{ID: "u-live", DisplayName: "Live"}},
		channels: []*model.Channel{},
	}
	rc := &fakeRecreator{}
	if _, _, err := RecreateUsersChannels(context.Background(), rc, src); err != nil {
		t.Fatalf("RecreateUsersChannels: %v", err)
	}
	for _, id := range rc.bulked[IndexUsers] {
		if id == "u-ghost" {
			t.Fatalf("orphan u-ghost must not be reindexed")
		}
	}
	if len(rc.bulked[IndexUsers]) != 1 || rc.bulked[IndexUsers][0] != "u-live" {
		t.Fatalf("bulked users = %v, want only [u-live]", rc.bulked[IndexUsers])
	}
}

func TestRecreateUsersChannels_ErrorBranches(t *testing.T) {
	base := func() *fakeSources {
		return &fakeSources{
			users:    []*model.User{{ID: "u1"}},
			channels: []*model.Channel{{ID: "c1"}},
		}
	}
	t.Run("list users error", func(t *testing.T) {
		src := base()
		src.listErr = errors.New("boom")
		if _, _, err := RecreateUsersChannels(context.Background(), &fakeRecreator{}, src); err == nil {
			t.Fatal("expected list-users error")
		}
	})
	t.Run("list channels error", func(t *testing.T) {
		src := base()
		src.channelsErr = errors.New("boom")
		if _, _, err := RecreateUsersChannels(context.Background(), &fakeRecreator{}, src); err == nil {
			t.Fatal("expected list-channels error")
		}
	})
	t.Run("recreate users error", func(t *testing.T) {
		rc := &fakeRecreator{recreErr: map[string]error{IndexUsers: errors.New("boom")}}
		if _, _, err := RecreateUsersChannels(context.Background(), rc, base()); err == nil {
			t.Fatal("expected recreate-users error")
		}
	})
	t.Run("bulk users error", func(t *testing.T) {
		rc := &fakeRecreator{bulkErr: map[string]error{IndexUsers: errors.New("boom")}}
		if _, _, err := RecreateUsersChannels(context.Background(), rc, base()); err == nil {
			t.Fatal("expected bulk-users error")
		}
	})
	t.Run("recreate channels error", func(t *testing.T) {
		rc := &fakeRecreator{recreErr: map[string]error{IndexChannels: errors.New("boom")}}
		if _, _, err := RecreateUsersChannels(context.Background(), rc, base()); err == nil {
			t.Fatal("expected recreate-channels error")
		}
	})
	t.Run("bulk channels error", func(t *testing.T) {
		rc := &fakeRecreator{bulkErr: map[string]error{IndexChannels: errors.New("boom")}}
		if _, _, err := RecreateUsersChannels(context.Background(), rc, base()); err == nil {
			t.Fatal("expected bulk-channels error")
		}
	})
}
