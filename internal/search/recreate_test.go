package search

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// fakeRebuilder records the zero-downtime rebuild lifecycle (begin →
// bulk into staging → promote → repair bulk/deletes) so unit tests can
// assert ordering, abort-on-failure, and that only source docs end up
// written.
type fakeRebuilder struct {
	calls      []string            // "begin:<name>", "promote:<name>:<staging>", "abort:<staging>"
	bulked     map[string][]string // index (staging or logical) → doc IDs appended per Bulk call
	deleted    []string            // "<index>/<id>" repair deletions
	beginErr   map[string]error    // logical name → BeginIndexRebuild error
	promoteErr map[string]error    // logical name → PromoteIndex error
	bulkErr    map[string]error    // target index → Bulk error
	deleteErr  error               // DeleteDoc error
}

func (f *fakeRebuilder) BeginIndexRebuild(_ context.Context, name string) (string, error) {
	f.calls = append(f.calls, "begin:"+name)
	if err := f.beginErr[name]; err != nil {
		return "", err
	}
	return name + "-staging", nil
}

func (f *fakeRebuilder) PromoteIndex(_ context.Context, name, staging string) error {
	f.calls = append(f.calls, "promote:"+name+":"+staging)
	return f.promoteErr[name]
}

func (f *fakeRebuilder) AbortIndexRebuild(_ context.Context, staging string) {
	f.calls = append(f.calls, "abort:"+staging)
}

func (f *fakeRebuilder) Bulk(_ context.Context, index string, entries []BulkEntry) error {
	if f.bulked == nil {
		f.bulked = map[string][]string{}
	}
	for _, e := range entries {
		f.bulked[index] = append(f.bulked[index], e.ID)
	}
	return f.bulkErr[index]
}

func (f *fakeRebuilder) DeleteDoc(_ context.Context, index, id string) error {
	f.deleted = append(f.deleted, index+"/"+id)
	return f.deleteErr
}

// seqSources returns successive results per List call so tests can make
// the repair pass (second listing) observe different data than the
// build pass. The last configured list repeats once exhausted; errs are
// aligned by call index.
type seqSources struct {
	userLists    [][]*model.User
	channelLists [][]*model.Channel
	userErrs     []error
	channelErrs  []error
	uCall, cCall int
}

func (s *seqSources) ListUsers(context.Context) ([]*model.User, error) {
	i := s.uCall
	s.uCall++
	if i < len(s.userErrs) && s.userErrs[i] != nil {
		return nil, s.userErrs[i]
	}
	if len(s.userLists) == 0 {
		return nil, nil
	}
	if i >= len(s.userLists) {
		i = len(s.userLists) - 1
	}
	return s.userLists[i], nil
}

func (s *seqSources) ListChannels(context.Context) ([]*model.Channel, error) {
	i := s.cCall
	s.cCall++
	if i < len(s.channelErrs) && s.channelErrs[i] != nil {
		return nil, s.channelErrs[i]
	}
	if len(s.channelLists) == 0 {
		return nil, nil
	}
	if i >= len(s.channelLists) {
		i = len(s.channelLists) - 1
	}
	return s.channelLists[i], nil
}

func TestRecreateUsersChannels_BuildsStagingThenPromotes(t *testing.T) {
	src := &seqSources{
		userLists:    [][]*model.User{{{ID: "u1", DisplayName: "Alice"}, {ID: "u2", DisplayName: "Bob"}}},
		channelLists: [][]*model.Channel{{{ID: "c1", Name: "general"}}},
	}
	rc := &fakeRebuilder{}
	users, channels, err := RecreateUsersChannels(context.Background(), rc, src)
	if err != nil {
		t.Fatalf("RecreateUsersChannels: %v", err)
	}
	if users != 2 || channels != 1 {
		t.Fatalf("counts = users %d channels %d, want 2/1", users, channels)
	}
	// Lifecycle: build+promote users, then build+promote channels — and
	// never an abort. The staging index is populated BEFORE the promote,
	// so the live index keeps serving until the swap.
	want := []string{
		"begin:" + IndexUsers, "promote:" + IndexUsers + ":" + IndexUsers + "-staging",
		"begin:" + IndexChannels, "promote:" + IndexChannels + ":" + IndexChannels + "-staging",
	}
	if len(rc.calls) != len(want) {
		t.Fatalf("calls = %v, want %v", rc.calls, want)
	}
	for i := range want {
		if rc.calls[i] != want[i] {
			t.Fatalf("calls[%d] = %q, want %q (all: %v)", i, rc.calls[i], want[i], rc.calls)
		}
	}
	// Build pass writes into staging; repair pass re-writes through the
	// logical (aliased) name.
	if got := rc.bulked[IndexUsers+"-staging"]; len(got) != 2 || got[0] != "u1" || got[1] != "u2" {
		t.Fatalf("staging users = %v, want [u1 u2]", got)
	}
	if got := rc.bulked[IndexUsers]; len(got) != 2 {
		t.Fatalf("repair users = %v, want the same 2 docs", got)
	}
	if got := rc.bulked[IndexChannels+"-staging"]; len(got) != 1 || got[0] != "c1" {
		t.Fatalf("staging channels = %v, want [c1]", got)
	}
	if len(rc.deleted) != 0 {
		t.Fatalf("deleted = %v, want none", rc.deleted)
	}
}

func TestRecreateUsersChannels_DropsOrphan(t *testing.T) {
	// The source no longer contains "u-ghost" (deleted from DynamoDB).
	// The rebuilt index only ever receives source docs, so the orphan is
	// gone — proven here by it never being bulked anywhere.
	src := &seqSources{
		userLists:    [][]*model.User{{{ID: "u-live", DisplayName: "Live"}}},
		channelLists: [][]*model.Channel{{}},
	}
	rc := &fakeRebuilder{}
	if _, _, err := RecreateUsersChannels(context.Background(), rc, src); err != nil {
		t.Fatalf("RecreateUsersChannels: %v", err)
	}
	for idx, ids := range rc.bulked {
		for _, id := range ids {
			if id == "u-ghost" {
				t.Fatalf("orphan u-ghost must not be reindexed (found in %s)", idx)
			}
		}
	}
	if got := rc.bulked[IndexUsers+"-staging"]; len(got) != 1 || got[0] != "u-live" {
		t.Fatalf("staging users = %v, want only [u-live]", got)
	}
}

// The repair pass must capture writes that raced the rebuild: a user
// created after the build snapshot is indexed via the second listing,
// and a user deleted mid-rebuild (in pass 1, gone in pass 2) is removed
// from the promoted index.
func TestRecreateUsersChannels_RepairPassCatchesRacedWrites(t *testing.T) {
	src := &seqSources{
		userLists: [][]*model.User{
			{{ID: "u1"}, {ID: "u-gone"}},          // build snapshot
			{{ID: "u1"}, {ID: "u-new-mid-build"}}, // repair snapshot
		},
		channelLists: [][]*model.Channel{{}},
	}
	rc := &fakeRebuilder{}
	users, _, err := RecreateUsersChannels(context.Background(), rc, src)
	if err != nil {
		t.Fatalf("RecreateUsersChannels: %v", err)
	}
	if users != 2 {
		t.Fatalf("users = %d, want 2 (the repair-pass population)", users)
	}
	repair := rc.bulked[IndexUsers]
	found := false
	for _, id := range repair {
		if id == "u-new-mid-build" {
			found = true
		}
	}
	if !found {
		t.Fatalf("repair bulk %v must include the user created during the rebuild", repair)
	}
	if len(rc.deleted) != 1 || rc.deleted[0] != IndexUsers+"/u-gone" {
		t.Fatalf("deleted = %v, want [%s/u-gone]", rc.deleted, IndexUsers)
	}
}

func TestRecreateUsersChannels_ErrorBranches(t *testing.T) {
	base := func() *seqSources {
		return &seqSources{
			userLists:    [][]*model.User{{{ID: "u1"}}},
			channelLists: [][]*model.Channel{{{ID: "c1"}}},
		}
	}
	boom := errors.New("boom")
	expectAborted := func(t *testing.T, rc *fakeRebuilder, staging string) {
		t.Helper()
		if !slices.Contains(rc.calls, "abort:"+staging) {
			t.Fatalf("calls %v missing abort of %s — a failed rebuild must clean up its staging index", rc.calls, staging)
		}
	}

	t.Run("list users error", func(t *testing.T) {
		src := base()
		src.userErrs = []error{boom}
		rc := &fakeRebuilder{}
		if _, _, err := RecreateUsersChannels(context.Background(), rc, src); err == nil {
			t.Fatal("expected list-users error")
		}
		if len(rc.calls) != 0 {
			t.Fatalf("no rebuild must start when listing fails, got %v", rc.calls)
		}
	})
	t.Run("list channels error", func(t *testing.T) {
		src := base()
		src.channelErrs = []error{boom}
		if _, _, err := RecreateUsersChannels(context.Background(), &fakeRebuilder{}, src); err == nil {
			t.Fatal("expected list-channels error")
		}
	})
	t.Run("begin users error", func(t *testing.T) {
		rc := &fakeRebuilder{beginErr: map[string]error{IndexUsers: boom}}
		if _, _, err := RecreateUsersChannels(context.Background(), rc, base()); err == nil {
			t.Fatal("expected begin-users error")
		}
	})
	t.Run("staging bulk error aborts", func(t *testing.T) {
		rc := &fakeRebuilder{bulkErr: map[string]error{IndexUsers + "-staging": boom}}
		if _, _, err := RecreateUsersChannels(context.Background(), rc, base()); err == nil {
			t.Fatal("expected staging-bulk error")
		}
		expectAborted(t, rc, IndexUsers+"-staging")
	})
	t.Run("promote error aborts", func(t *testing.T) {
		rc := &fakeRebuilder{promoteErr: map[string]error{IndexUsers: boom}}
		if _, _, err := RecreateUsersChannels(context.Background(), rc, base()); err == nil {
			t.Fatal("expected promote error")
		}
		expectAborted(t, rc, IndexUsers+"-staging")
	})
	t.Run("repair list error", func(t *testing.T) {
		src := base()
		src.userErrs = []error{nil, boom} // build listing ok, repair listing fails
		if _, _, err := RecreateUsersChannels(context.Background(), &fakeRebuilder{}, src); err == nil {
			t.Fatal("expected repair-list error")
		}
	})
	t.Run("repair bulk error", func(t *testing.T) {
		rc := &fakeRebuilder{bulkErr: map[string]error{IndexUsers: boom}}
		if _, _, err := RecreateUsersChannels(context.Background(), rc, base()); err == nil {
			t.Fatal("expected repair-bulk error")
		}
	})
	t.Run("repair delete error", func(t *testing.T) {
		src := &seqSources{
			userLists: [][]*model.User{
				{{ID: "u1"}, {ID: "u-gone"}},
				{{ID: "u1"}},
			},
			channelLists: [][]*model.Channel{{}},
		}
		rc := &fakeRebuilder{deleteErr: boom}
		if _, _, err := RecreateUsersChannels(context.Background(), rc, src); err == nil {
			t.Fatal("expected repair-delete error")
		}
	})
	t.Run("channels branch errors", func(t *testing.T) {
		rc := &fakeRebuilder{beginErr: map[string]error{IndexChannels: boom}}
		users, channels, err := RecreateUsersChannels(context.Background(), rc, base())
		if err == nil {
			t.Fatal("expected begin-channels error")
		}
		if users != 0 || channels != 0 {
			t.Fatalf("counts on error = %d/%d, want 0/0 (counts are success-only)", users, channels)
		}
	})
}
