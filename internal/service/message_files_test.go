package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

// filesFixture is a channel ("ch-f", member u-bob) whose FILE# index and
// messages agree, plus the attachments behind them.
type filesFixture struct {
	svc      *MessageService
	messages *mockMessageStore
	idx      *mockParentIndex
	refs     *fakeAttachmentRefMgr
	base     time.Time
}

func newFilesFixture(t *testing.T) *filesFixture {
	t.Helper()
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch-f#u-bob"] = &model.ChannelMembership{ChannelID: "ch-f", UserID: "u-bob", Role: model.ChannelRoleMember}
	idx := newMockParentIndex()
	svc.SetParentIndex(idx)
	refs := &fakeAttachmentRefMgr{atts: map[string]*model.Attachment{}}
	svc.SetAttachmentManager(refs)
	return &filesFixture{svc: svc, messages: messages, idx: idx, refs: refs, base: time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)}
}

// share posts attachment att (named name) in message msgID, minutes after the
// fixture's base time, and indexes it.
func (f *filesFixture) share(att, name, msgID string, minutes int) {
	at := f.base.Add(time.Duration(minutes) * time.Minute)
	m := f.messages.messages["ch-f#"+msgID]
	if m == nil {
		m = &model.Message{ID: msgID, ParentID: "ch-f", AuthorID: "u-alice", CreatedAt: at}
		f.messages.messages["ch-f#"+msgID] = m
	}
	m.AttachmentIDs = append(m.AttachmentIDs, att)
	f.refs.atts[att] = &model.Attachment{ID: att, Filename: name}
	_ = f.idx.SetFileIndex(context.Background(), "ch-f", att, msgID, "u-alice", at)
}

func (f *filesFixture) list(t *testing.T, q FileQuery) *FilePage {
	t.Helper()
	page, err := f.svc.ListFiles(context.Background(), "u-bob", "ch-f", ParentChannel, q)
	if err != nil {
		t.Fatalf("ListFiles(%+v): %v", q, err)
	}
	return page
}

func fileIDs(page *FilePage) []string {
	ids := make([]string, 0, len(page.Files))
	for _, e := range page.Files {
		ids = append(ids, e.AttachmentID)
	}
	return ids
}

func TestListFiles_NewestFirstWithAttachmentsReadyForTheReader(t *testing.T) {
	f := newFilesFixture(t)
	f.share("att-old", "old.pdf", "m-1", 0)
	f.share("att-new", "new.png", "m-2", 10)
	f.share("att-new-2", "also-new.txt", "m-2", 10) // same message, same time

	page := f.list(t, FileQuery{})
	if got := fileIDs(page); !slices.Equal(got, []string{"att-new-2", "att-new", "att-old"}) {
		t.Fatalf("order = %v", got)
	}
	if page.NextCursor != "" {
		t.Fatalf("one page holds everything; cursor = %q", page.NextCursor)
	}
	first := page.Files[0]
	if first.MessageID != "m-2" || first.AuthorID != "u-alice" || !first.CreatedAt.Equal(f.base.Add(10*time.Minute)) {
		t.Fatalf("entry = %+v", first)
	}
	if first.Attachment == nil || first.Attachment.Filename != "also-new.txt" || first.Attachment.URL != "https://media/att-new-2?m=m-2" {
		t.Fatalf("attachment = %+v", first.Attachment)
	}
	// Each file is readied for the reader and the message that shared it.
	want := MediaGrant{UserID: "u-bob", ParentID: "ch-f", ParentType: ParentChannel, MessageID: "m-1"}
	if !slices.Contains(f.refs.readied, want) {
		t.Fatalf("grants = %+v, want one like %+v", f.refs.readied, want)
	}
	// One read for the whole page's attachments.
	if len(f.refs.loads) != 1 || len(f.refs.loads[0]) != 3 {
		t.Fatalf("attachment reads = %v", f.refs.loads)
	}
}

func TestListFiles_PagesWithACursor(t *testing.T) {
	f := newFilesFixture(t)
	for i := range 5 {
		f.share(fmt.Sprintf("att-%d", i), fmt.Sprintf("f%d.txt", i), fmt.Sprintf("m-%d", i), i)
	}
	var all []string
	cursor := ""
	for range 3 {
		page := f.list(t, FileQuery{Limit: 2, Cursor: cursor})
		all = append(all, fileIDs(page)...)
		cursor = page.NextCursor
	}
	if cursor != "" {
		t.Fatalf("the third page is the last; cursor = %q", cursor)
	}
	if !slices.Equal(all, []string{"att-4", "att-3", "att-2", "att-1", "att-0"}) {
		t.Fatalf("pages = %v", all)
	}
}

func TestListFiles_CursorSurvivesItsRowGoingAway(t *testing.T) {
	f := newFilesFixture(t)
	for i := range 4 {
		f.share(fmt.Sprintf("att-%d", i), "f.txt", fmt.Sprintf("m-%d", i), i)
	}
	page := f.list(t, FileQuery{Limit: 2})
	_ = f.idx.DeleteFileIndex(context.Background(), "ch-f", "att-2") // the cursor's row
	next := f.list(t, FileQuery{Limit: 2, Cursor: page.NextCursor})
	if got := fileIDs(next); !slices.Equal(got, []string{"att-1", "att-0"}) {
		t.Fatalf("after the cursor = %v", got)
	}
}

func TestListFiles_PageSizeDefaultsTo50AndStopsAt100(t *testing.T) {
	f := newFilesFixture(t)
	for i := range 120 {
		f.share(fmt.Sprintf("att-%03d", i), "f.txt", fmt.Sprintf("m-%03d", i), i)
	}
	if n := len(f.list(t, FileQuery{}).Files); n != 50 {
		t.Fatalf("default page = %d, want 50", n)
	}
	if n := len(f.list(t, FileQuery{Limit: 500}).Files); n != 100 {
		t.Fatalf("capped page = %d, want 100", n)
	}
}

func TestListFiles_FiltersByName(t *testing.T) {
	f := newFilesFixture(t)
	f.share("att-a", "Invoice March.pdf", "m-1", 0)
	f.share("att-b", "photo.png", "m-2", 1)
	f.share("att-c", "INVOICE-april.xlsx", "m-3", 2)

	page := f.list(t, FileQuery{Query: "  invoice "})
	if got := fileIDs(page); !slices.Equal(got, []string{"att-c", "att-a"}) {
		t.Fatalf("matches = %v", got)
	}
	// The names were read from the attachments once, then remembered on the
	// index, so the next search doesn't read them again.
	waitForCond(t, func() bool { return f.idx.fileNamesSet() == 3 }, "file names remembered")
	if row := f.idx.files["ch-f"]["att-b"]; row.Filename != "photo.png" {
		t.Fatalf("remembered name = %q", row.Filename)
	}
	f.refs.loads = nil
	page = f.list(t, FileQuery{Query: "PHOTO"})
	if got := fileIDs(page); !slices.Equal(got, []string{"att-b"}) {
		t.Fatalf("second search = %v", got)
	}
	if len(f.refs.loads) != 1 || !slices.Equal(f.refs.loads[0], []string{"att-b"}) {
		t.Fatalf("second search read %v; want only the page's attachment", f.refs.loads)
	}
}

func TestListFiles_FilterStillAnswersWhenNamesCantBeSaved(t *testing.T) {
	f := newFilesFixture(t)
	f.idx.setNameErr = errors.New("index down")
	f.share("att-a", "notes.md", "m-1", 0)
	page := f.list(t, FileQuery{Query: "notes"})
	if got := fileIDs(page); !slices.Equal(got, []string{"att-a"}) {
		t.Fatalf("matches = %v", got)
	}
	waitForCond(t, func() bool { return f.idx.fileNamesSet() == 1 }, "name write attempted")
}

func TestListFiles_FileWhoseAttachmentIsGoneHasNoName(t *testing.T) {
	f := newFilesFixture(t)
	f.share("att-a", "notes.md", "m-1", 0)
	delete(f.refs.atts, "att-a")
	page := f.list(t, FileQuery{Query: "notes"})
	if len(page.Files) != 0 || f.idx.fileNamesSet() != 0 {
		t.Fatalf("files = %v, names saved = %d", fileIDs(page), f.idx.fileNamesSet())
	}
}

func TestListFiles_LeavesOutFilesTheMessageNoLongerCarries(t *testing.T) {
	f := newFilesFixture(t)
	f.share("att-kept", "kept.txt", "m-1", 0)
	f.share("att-edited-out", "edited.txt", "m-2", 1)
	f.share("att-msg-deleted", "deleted.txt", "m-3", 2)
	f.share("att-record-gone", "gone.txt", "m-4", 3)
	f.messages.messages["ch-f#m-2"].AttachmentIDs = nil
	delete(f.messages.messages, "ch-f#m-3")
	delete(f.refs.atts, "att-record-gone")

	// A page of one has to look past three rows to fill.
	page := f.list(t, FileQuery{Limit: 1})
	if got := fileIDs(page); !slices.Equal(got, []string{"att-kept"}) || page.NextCursor != "" {
		t.Fatalf("page = %v, cursor %q", got, page.NextCursor)
	}
}

func TestListFiles_StopsLookingAfterMaxListRounds(t *testing.T) {
	f := newFilesFixture(t)
	f.share("att-valid", "valid.txt", "m-valid", 0)
	for i := range maxListRounds + 2 {
		id := fmt.Sprintf("att-stale-%d", i)
		f.share(id, "stale.txt", fmt.Sprintf("m-stale-%d", i), 10+i)
		delete(f.messages.messages, fmt.Sprintf("ch-f#m-stale-%d", i))
	}
	page := f.list(t, FileQuery{Limit: 1})
	if len(page.Files) != 0 || page.NextCursor == "" {
		t.Fatalf("an all-stale stretch ends the page with a cursor: %v %q", fileIDs(page), page.NextCursor)
	}
	next := f.list(t, FileQuery{Limit: 1, Cursor: page.NextCursor})
	if got := fileIDs(next); !slices.Equal(got, []string{"att-valid"}) {
		t.Fatalf("next page = %v", got)
	}
}

func TestListFiles_BatchedMessageRead(t *testing.T) {
	f := newFilesFixture(t)
	batch := &batchMockMessageStore{mockMessageStore: f.messages}
	f.svc.messages = batch
	f.share("att-a", "a.txt", "m-1", 0)
	f.share("att-b", "b.txt", "m-1", 0)
	f.share("att-c", "c.txt", "m-2", 1)
	if got := fileIDs(f.list(t, FileQuery{})); !slices.Equal(got, []string{"att-c", "att-b", "att-a"}) {
		t.Fatalf("files = %v", got)
	}
	if batch.batchCalls != 1 {
		t.Fatalf("message reads = %d, want 1", batch.batchCalls)
	}

	batch.batchErr = errors.New("dynamo down")
	if _, err := f.svc.ListFiles(context.Background(), "u-bob", "ch-f", ParentChannel, FileQuery{}); err == nil {
		t.Fatal("a failed message read must fail the page")
	}
}

func TestListFiles_Refusals(t *testing.T) {
	f := newFilesFixture(t)
	f.share("att-a", "a.txt", "m-1", 0)
	for _, q := range []FileQuery{
		{Cursor: "no-dot"},
		{Cursor: "abc.att-a"},
		{Cursor: "123."},
		{Query: strings.Repeat("x", maxFileQueryRunes+1)},
	} {
		_, err := f.svc.ListFiles(context.Background(), "u-bob", "ch-f", ParentChannel, q)
		if !errors.Is(err, apperr.ErrValidation) {
			t.Errorf("ListFiles(%+v) = %v, want a validation error", q, err)
		}
	}
}

func TestListFiles_ReadFailuresFailTheRequest(t *testing.T) {
	t.Run("message read", func(t *testing.T) {
		f := newFilesFixture(t)
		f.share("att-a", "a.txt", "m-1", 0)
		f.messages.getErr = errors.New("dynamo down")
		if _, err := f.svc.ListFiles(context.Background(), "u-bob", "ch-f", ParentChannel, FileQuery{}); err == nil {
			t.Fatal("want an error")
		}
	})
	t.Run("attachment read", func(t *testing.T) {
		f := newFilesFixture(t)
		f.share("att-a", "a.txt", "m-1", 0)
		f.refs.loadErr = errors.New("dynamo down")
		if _, err := f.svc.ListFiles(context.Background(), "u-bob", "ch-f", ParentChannel, FileQuery{}); err == nil {
			t.Fatal("want an error")
		}
	})
	t.Run("file names", func(t *testing.T) {
		f := newFilesFixture(t)
		f.share("att-a", "a.txt", "m-1", 0)
		f.refs.loadErr = errors.New("dynamo down")
		if _, err := f.svc.ListFiles(context.Background(), "u-bob", "ch-f", ParentChannel, FileQuery{Query: "a"}); err == nil {
			t.Fatal("want an error")
		}
	})
}
