package main

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
)

// spyRebuilder records every rebuild-lifecycle call so the dry-run
// contract ("never touches OpenSearch") is a test failure, not a hope —
// a refactor that moves the rebuild above the dry-run guard would
// destructively rebuild production indices from a command that claims
// to be a preview.
type spyRebuilder struct {
	calls []string
}

func (s *spyRebuilder) BeginIndexRebuild(_ context.Context, name string) (string, error) {
	s.calls = append(s.calls, "begin:"+name)
	return name + "-staging", nil
}

func (s *spyRebuilder) PromoteIndex(_ context.Context, name, _ string) error {
	s.calls = append(s.calls, "promote:"+name)
	return nil
}

func (s *spyRebuilder) AbortIndexRebuild(_ context.Context, staging string) {
	s.calls = append(s.calls, "abort:"+staging)
}

func (s *spyRebuilder) Bulk(_ context.Context, index string, _ []search.BulkEntry) error {
	s.calls = append(s.calls, "bulk:"+index)
	return nil
}

func (s *spyRebuilder) DeleteDoc(_ context.Context, index, id string) error {
	s.calls = append(s.calls, "delete:"+index+"/"+id)
	return nil
}

type fakeReindexSrc struct {
	users    []*model.User
	channels []*model.Channel
	usersErr error
	chansErr error
}

func (f *fakeReindexSrc) ListUsers(context.Context) ([]*model.User, error) {
	return f.users, f.usersErr
}

func (f *fakeReindexSrc) ListChannels(context.Context) ([]*model.Channel, error) {
	return f.channels, f.chansErr
}

func TestSearchReindex_DryRunNeverWrites(t *testing.T) {
	rc := &spyRebuilder{}
	src := &fakeReindexSrc{
		users:    []*model.User{{ID: "u1"}, {ID: "u2"}},
		channels: []*model.Channel{{ID: "c1"}},
	}
	if code := searchReindex(context.Background(), rc, src, true); code != 0 {
		t.Fatalf("dry-run exit code = %d, want 0", code)
	}
	if len(rc.calls) != 0 {
		t.Fatalf("dry-run performed rebuilder calls: %v — the default mode must not touch OpenSearch", rc.calls)
	}
}

func TestSearchReindex_ApplyRebuildsBothIndices(t *testing.T) {
	rc := &spyRebuilder{}
	src := &fakeReindexSrc{
		users:    []*model.User{{ID: "u1"}},
		channels: []*model.Channel{{ID: "c1"}},
	}
	if code := searchReindex(context.Background(), rc, src, false); code != 0 {
		t.Fatalf("apply exit code = %d, want 0", code)
	}
	var begun, promoted int
	for _, c := range rc.calls {
		switch c {
		case "begin:" + search.IndexUsers, "begin:" + search.IndexChannels:
			begun++
		case "promote:" + search.IndexUsers, "promote:" + search.IndexChannels:
			promoted++
		}
	}
	if begun != 2 || promoted != 2 {
		t.Fatalf("apply must rebuild+promote both indices, calls: %v", rc.calls)
	}
}

func TestSearchReindex_ErrorsExitNonZero(t *testing.T) {
	boom := errors.New("boom")
	t.Run("dry-run list users error", func(t *testing.T) {
		src := &fakeReindexSrc{usersErr: boom}
		if code := searchReindex(context.Background(), &spyRebuilder{}, src, true); code != 1 {
			t.Fatalf("exit code = %d, want 1", code)
		}
	})
	t.Run("dry-run list channels error", func(t *testing.T) {
		src := &fakeReindexSrc{chansErr: boom}
		if code := searchReindex(context.Background(), &spyRebuilder{}, src, true); code != 1 {
			t.Fatalf("exit code = %d, want 1", code)
		}
	})
	t.Run("apply rebuild error", func(t *testing.T) {
		src := &fakeReindexSrc{usersErr: boom}
		if code := searchReindex(context.Background(), &spyRebuilder{}, src, false); code != 1 {
			t.Fatalf("exit code = %d, want 1", code)
		}
	})
}
