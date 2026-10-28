package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// unreadableAttachmentStore fails every single-attachment read.
type unreadableAttachmentStore struct{ *mockAttachmentStore }

func (unreadableAttachmentStore) GetByID(context.Context, string) (*model.Attachment, error) {
	return nil, errors.New("dynamo down")
}

func TestLoadMany(t *testing.T) {
	ctx := context.Background()

	t.Run("batch arm: one read, keyed by ID, misses left out", func(t *testing.T) {
		storeM := &batchMockAttachmentStore{mockAttachmentStore: newMockAttachmentStore()}
		storeM.byID["a-1"] = &model.Attachment{ID: "a-1", Filename: "one.txt"}
		svc := NewAttachmentService(storeM, nil, newMockPublisher())
		got, err := svc.LoadMany(ctx, []string{"a-1", "a-gone"})
		if err != nil || len(got) != 1 || got["a-1"].Filename != "one.txt" || storeM.batchCalls != 1 {
			t.Fatalf("LoadMany = %v, %v (batch reads %d)", got, err, storeM.batchCalls)
		}
		storeM.batchErr = errors.New("dynamo down")
		if _, err := svc.LoadMany(ctx, []string{"a-1"}); err == nil {
			t.Fatal("a failed batch must fail the call, not read as no files")
		}
	})

	t.Run("plain store reads one by one", func(t *testing.T) {
		storeM := newMockAttachmentStore()
		storeM.byID["a-1"] = &model.Attachment{ID: "a-1"}
		svc := NewAttachmentService(storeM, nil, newMockPublisher())
		got, err := svc.LoadMany(ctx, []string{"a-1", "a-gone"})
		if err != nil || len(got) != 1 || got["a-1"] == nil {
			t.Fatalf("LoadMany = %v, %v", got, err)
		}
		failing := NewAttachmentService(unreadableAttachmentStore{newMockAttachmentStore()}, nil, newMockPublisher())
		if _, err := failing.LoadMany(ctx, []string{"a-1"}); err == nil {
			t.Fatal("a failed read must fail the call")
		}
	})

	t.Run("nothing asked, nothing read", func(t *testing.T) {
		storeM := &batchMockAttachmentStore{mockAttachmentStore: newMockAttachmentStore()}
		svc := NewAttachmentService(storeM, nil, newMockPublisher())
		got, err := svc.LoadMany(ctx, nil)
		if err != nil || len(got) != 0 || storeM.batchCalls != 0 {
			t.Fatalf("LoadMany(nil) = %v, %v (batch reads %d)", got, err, storeM.batchCalls)
		}
	})
}

// ReadyForReader hands out the same reader-bound media URL GetForUser does.
func TestReadyForReader_BindsTheMediaURLToTheReader(t *testing.T) {
	svc, access, a := grantFixture(t)
	ctx := context.Background()
	atts, err := svc.LoadMany(ctx, []string{a.ID})
	if err != nil {
		t.Fatal(err)
	}
	got := atts[a.ID]
	svc.ReadyForReader(ctx, got, MediaGrant{UserID: "u2", ParentID: "ch1", ParentType: ParentChannel, MessageID: "m1"})
	token, grant := mediaParts(t, got.URL)
	if grant == "" {
		t.Fatalf("media URL %q carries no grant", got.URL)
	}
	if err := openMedia(svc, token, grant); err != nil {
		t.Fatalf("open: %v", err)
	}
	if access.checks.Load() == 0 {
		t.Fatal("opening the media must check the reader's access")
	}
}
