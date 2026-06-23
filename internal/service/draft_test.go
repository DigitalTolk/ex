package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

type mockDraftStore struct {
	rows         map[string]*model.MessageDraft
	upsertErr    error
	getErr       error
	listErr      error
	deleteErr    error
	lastDeleteTs int64
}

func newMockDraftStore() *mockDraftStore {
	return &mockDraftStore{rows: map[string]*model.MessageDraft{}}
}

func (m *mockDraftStore) key(userID, id string) string { return userID + "#" + id }

func (m *mockDraftStore) Upsert(_ context.Context, draft *model.MessageDraft) error {
	if m.upsertErr != nil {
		return m.upsertErr
	}
	cp := *draft
	cp.AttachmentIDs = append([]string(nil), draft.AttachmentIDs...)
	m.rows[m.key(draft.UserID, draft.ID)] = &cp
	return nil
}

func (m *mockDraftStore) Get(_ context.Context, userID, id string) (*model.MessageDraft, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	row, ok := m.rows[m.key(userID, id)]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *row
	cp.AttachmentIDs = append([]string(nil), row.AttachmentIDs...)
	return &cp, nil
}

func (m *mockDraftStore) List(_ context.Context, userID string) ([]*model.MessageDraft, error) {
	if m.listErr != nil {
		return nil, m.listErr
	}
	out := []*model.MessageDraft{}
	for _, row := range m.rows {
		if row.UserID != userID {
			continue
		}
		cp := *row
		cp.AttachmentIDs = append([]string(nil), row.AttachmentIDs...)
		out = append(out, &cp)
	}
	return out, nil
}

func (m *mockDraftStore) Delete(_ context.Context, userID, id string, ts int64) error {
	m.lastDeleteTs = ts
	if m.deleteErr != nil {
		return m.deleteErr
	}
	delete(m.rows, m.key(userID, id))
	return nil
}

func newDraftTestService() (*DraftService, *mockDraftStore, *mockPublisher) {
	drafts := newMockDraftStore()
	messages := newMockMessageStore()
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	publisher := newMockPublisher()
	memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1"}
	conversations.conversations["dm-1"] = &model.Conversation{ID: "dm-1", ParticipantIDs: []string{"u-1", "u-2"}}
	messages.messages["ch-1#root-1"] = &model.Message{ID: "root-1", ParentID: "ch-1", AuthorID: "u-2", Body: "root"}
	return NewDraftService(drafts, messages, memberships, conversations, publisher), drafts, publisher
}

func TestDraftService_List_SortsNewestFirst(t *testing.T) {
	svc, drafts, _ := newDraftTestService()
	drafts.rows["u-1#old"] = &model.MessageDraft{ID: "old", UserID: "u-1", UpdatedAt: time.Unix(1000, 0)}
	drafts.rows["u-1#new"] = &model.MessageDraft{ID: "new", UserID: "u-1", UpdatedAt: time.Unix(2000, 0)}
	got, err := svc.List(context.Background(), "u-1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 || got[0].ID != "new" || got[1].ID != "old" {
		t.Fatalf("expected newest-first [new, old], got %+v", got)
	}
}

func TestDraftService_UpsertListDeleteAndPublish(t *testing.T) {
	svc, drafts, publisher := newDraftTestService()
	ctx := context.Background()

	draft, err := svc.Upsert(ctx, "u-1", "ch-1", ParentChannel, "root-1", "reply later", []string{"att-1", ""})
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if draft.ParentMessageID != "root-1" || draft.Body != "reply later" || len(draft.AttachmentIDs) != 1 {
		t.Fatalf("draft = %+v", draft)
	}

	list, err := svc.List(ctx, "u-1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].ID != draft.ID {
		t.Fatalf("List = %+v", list)
	}
	if len(publisher.published) == 0 || publisher.published[0].channel != pubsub.UserChannel("u-1") || publisher.published[0].event.Type != events.EventDraftUpdated {
		t.Fatalf("published = %+v", publisher.published)
	}

	if _, err := svc.Upsert(ctx, "u-1", "ch-1", ParentChannel, "root-1", "", nil); err != nil {
		t.Fatalf("empty Upsert deletes draft: %v", err)
	}
	if _, err := drafts.Get(ctx, "u-1", draft.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("draft after empty upsert err = %v, want ErrNotFound", err)
	}
}

func TestDraftService_SilentUpsertPersistsWithoutBroadcast(t *testing.T) {
	svc, drafts, publisher := newDraftTestService()
	ctx := context.Background()

	// A silent (keystroke) save persists the draft but emits no event, so the
	// sidebar "draft available" indicator doesn't surface mid-typing.
	draft, err := svc.Upsert(ctx, "u-1", "ch-1", ParentChannel, "", "typing…", nil, WithSilent(true))
	if err != nil {
		t.Fatalf("silent Upsert: %v", err)
	}
	if stored, getErr := drafts.Get(ctx, "u-1", draft.ID); getErr != nil || stored.Body != "typing…" {
		t.Fatalf("draft not persisted by silent upsert: stored=%+v err=%v", stored, getErr)
	}
	if len(publisher.published) != 0 {
		t.Fatalf("silent upsert must not publish; got %+v", publisher.published)
	}

	// The follow-up non-silent save (composer blur) broadcasts so the
	// indicator appears on this and other devices.
	if _, err := svc.Upsert(ctx, "u-1", "ch-1", ParentChannel, "", "typing done", nil); err != nil {
		t.Fatalf("notify Upsert: %v", err)
	}
	if len(publisher.published) != 1 || publisher.published[0].event.Type != events.EventDraftUpdated {
		t.Fatalf("expected one draft.updated after notify save; got %+v", publisher.published)
	}

	// A silent delete (cleared composer mid-typing) also stays quiet.
	if _, err := svc.Upsert(ctx, "u-1", "ch-1", ParentChannel, "", "", nil, WithSilent(true)); err != nil {
		t.Fatalf("silent empty Upsert: %v", err)
	}
	if len(publisher.published) != 1 {
		t.Fatalf("silent delete must not publish; got %+v", publisher.published)
	}
}

func TestDraftService_RejectsUnauthorizedParent(t *testing.T) {
	svc, _, _ := newDraftTestService()

	_, err := svc.Upsert(context.Background(), "u-3", "dm-1", ParentConversation, "", "nope", nil)
	if err == nil || err.Error() != "draft: not a conversation participant" {
		t.Fatalf("err = %v, want participant rejection", err)
	}
}

func TestDraftService_DeleteAndConversationDraft(t *testing.T) {
	svc, _, _ := newDraftTestService()
	ctx := context.Background()

	draft, err := svc.Upsert(ctx, "u-1", "dm-1", ParentConversation, "", "dm draft", nil)
	if err != nil {
		t.Fatalf("conversation Upsert: %v", err)
	}
	if draft.ParentType != ParentConversation {
		t.Fatalf("ParentType = %q", draft.ParentType)
	}
	if err := svc.Delete(ctx, "u-1", draft.ID, 0); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := svc.Delete(ctx, "u-1", "", 0); err == nil {
		t.Fatal("Delete empty ID: expected error")
	}
}

func TestDraftService_DeleteForScope(t *testing.T) {
	svc, drafts, publisher := newDraftTestService()
	ctx := context.Background()

	d, err := svc.Upsert(ctx, "u-1", "ch-1", ParentChannel, "", "draft", nil)
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if err := svc.DeleteForScope(ctx, "u-1", "ch-1", ParentChannel, "", 5000); err != nil {
		t.Fatalf("DeleteForScope: %v", err)
	}
	if _, err := drafts.Get(ctx, "u-1", d.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("draft should be cleared, got err=%v", err)
	}
	if drafts.lastDeleteTs != 5000 {
		t.Fatalf("delete ts = %d, want 5000", drafts.lastDeleteTs)
	}
	if len(publisher.published) == 0 {
		t.Fatal("DeleteForScope should publish a draft.updated event")
	}

	// ts=0 falls back to server now (non-zero).
	drafts.lastDeleteTs = 0
	if err := svc.DeleteForScope(ctx, "u-1", "ch-1", ParentChannel, "", 0); err != nil {
		t.Fatalf("DeleteForScope ts=0: %v", err)
	}
	if drafts.lastDeleteTs == 0 {
		t.Fatal("ts=0 must default to server now")
	}

	// Store error surfaces.
	drafts.deleteErr = errors.New("redis down")
	if err := svc.DeleteForScope(ctx, "u-1", "ch-1", ParentChannel, "", 1); err == nil {
		t.Fatal("DeleteForScope should surface a store error")
	}
}

func TestDraftService_ValidationErrors(t *testing.T) {
	svc, _, _ := newDraftTestService()
	ctx := context.Background()

	cases := []struct {
		name       string
		userID     string
		parentID   string
		parentType string
		threadRoot string
	}{
		{name: "missing user", userID: "", parentID: "ch-1", parentType: ParentChannel},
		{name: "missing parent", userID: "u-1", parentID: "", parentType: ParentChannel},
		{name: "unknown parent type", userID: "u-1", parentID: "ch-1", parentType: "bogus"},
		{name: "missing thread root", userID: "u-1", parentID: "ch-1", parentType: ParentChannel, threadRoot: "missing"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := svc.Upsert(ctx, tc.userID, tc.parentID, tc.parentType, tc.threadRoot, "x", nil); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestDraftService_StoreErrors(t *testing.T) {
	svc, drafts, _ := newDraftTestService()
	ctx := context.Background()

	drafts.getErr = errors.New("boom")
	if _, err := svc.Upsert(ctx, "u-1", "ch-1", ParentChannel, "", "x", nil); err == nil {
		t.Fatal("expected get existing error")
	}
	drafts.getErr = nil

	drafts.upsertErr = errors.New("boom")
	if _, err := svc.Upsert(ctx, "u-1", "ch-1", ParentChannel, "", "x", nil); err == nil {
		t.Fatal("expected upsert error")
	}
	drafts.upsertErr = nil

	drafts.listErr = errors.New("boom")
	if _, err := svc.List(ctx, "u-1"); err == nil {
		t.Fatal("expected list error")
	}
	drafts.listErr = nil

	drafts.deleteErr = errors.New("boom")
	if _, err := svc.Upsert(ctx, "u-1", "ch-1", ParentChannel, "", "", nil); err == nil {
		t.Fatal("expected empty delete error")
	}
	if err := svc.Delete(ctx, "u-1", "draft-1", 0); err == nil {
		t.Fatal("expected delete error")
	}
}
