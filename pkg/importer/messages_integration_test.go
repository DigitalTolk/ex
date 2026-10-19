//go:build integration

package importer

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// mid builds a message ID for time at with a fixed entropy byte.
func mid(at time.Time, b byte) string {
	return ulid.MustNew(ulid.Timestamp(at), bytes.NewReader(bytes.Repeat([]byte{b}, 16))).String()
}

func at(min int) time.Time { return t0.Add(time.Duration(min) * time.Minute) }

func TestPutMessages(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	ms := store.NewMessageStore(e.db)
	_, err := e.im.PutAttachment(ctx, AttachmentSpec{ID: "a1", Filename: "f.txt"}, bodyOf("data"))
	mustNoErr(t, err)

	// A message already written natively in ex, later than the import.
	native := &model.Message{ID: mid(at(30), 9), ParentID: "c1", AuthorID: "u9", Body: "native", CreatedAt: at(30)}
	mustNoErr(t, ms.CreateMessage(ctx, native))

	root := MessageSpec{ID: mid(at(1), 1), AuthorID: "u1", Body: "root", CreatedAt: at(1), AttachmentIDs: []string{"a1"},
		Reactions: map[string][]string{"👍": {"u2"}}, Pinned: true, PinnedBy: "u2"}
	reply := MessageSpec{ID: mid(at(2), 2), AuthorID: "u2", Body: "reply", CreatedAt: at(2), ParentMessageID: root.ID}
	sys := MessageSpec{ID: mid(at(3), 3), AuthorID: SystemAuthorID, Body: "u3 joined the channel", CreatedAt: at(3), System: true}
	pinnedAt := at(5)
	later := MessageSpec{ID: mid(at(4), 4), AuthorID: WebhookAuthorID, Body: "deploy done", CreatedAt: at(4), WebhookUsername: "ci",
		Pinned: true, PinnedAt: &pinnedAt}
	older := MessageSpec{ID: mid(at(0), 5), AuthorID: "u1", Body: "first", CreatedAt: at(0)}

	res, err := e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{root, reply, sys, later, older, root})
	mustNoErr(t, err)
	if res.Inserted != 5 || res.Existing != 1 || res.TopLevelInserted != 3 || len(res.ThreadRootIDs) != 1 ||
		res.ThreadRootIDs[0] != root.ID || !res.LastCreatedAt.Equal(at(4)) {
		t.Fatalf("result = %+v", res)
	}
	// Re-run: nothing new.
	res, err = e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{root, reply})
	if err != nil || res.Inserted != 0 || res.Existing != 2 {
		t.Fatalf("re-run = %+v %v", res, err)
	}

	// Imported history interleaves with the native message by time.
	list, _, err := ms.ListMessages(ctx, "c1", "", 20)
	mustNoErr(t, err)
	order := make([]string, 0, len(list))
	for _, m := range list {
		order = append(order, m.Body)
	}
	if strings.Join(order, "|") != "native|deploy done|u3 joined the channel|reply|root|first" {
		t.Fatalf("order = %v", order)
	}

	// Side rows: thread index, attachment refcount, file and pin index.
	replies, err := ms.ListThreadReplies(ctx, root.ID)
	mustNoErr(t, err)
	if len(replies) != 1 || replies[0].ID != reply.ID {
		t.Fatalf("thread index = %+v", replies)
	}
	a, _ := store.NewAttachmentStore(e.db).GetByID(ctx, "a1")
	if len(a.MessageIDs) != 1 || a.MessageIDs[0] != root.ID {
		t.Fatalf("refs = %v", a.MessageIDs)
	}
	pi := store.NewParentIndexStore(e.db)
	files, _ := pi.ListFileIndex(ctx, "c1")
	pins, _ := pi.ListPinIndex(ctx, "c1")
	if len(files) != 1 || len(pins) != 2 {
		t.Fatalf("files=%d pins=%d", len(files), len(pins))
	}
	got, _ := ms.GetMessage(ctx, "c1", root.ID)
	if got.PinnedAt == nil || !got.PinnedAt.Equal(at(1)) || len(got.Reactions["👍"]) != 1 {
		t.Fatalf("root = %+v", got)
	}
}

func TestPutMessagesValidation(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	good := MessageSpec{ID: mid(at(1), 1), AuthorID: "u1", Body: "x", CreatedAt: at(1)}
	cases := []MessageSpec{
		{ID: "not-a-ulid", AuthorID: "u1", CreatedAt: at(1)},
		{ID: mid(at(1), 1), AuthorID: "u1", CreatedAt: at(2)},
		{ID: mid(at(1), 1), CreatedAt: at(1)},
		{ID: mid(at(1), 1), AuthorID: "u1", CreatedAt: at(1), Body: strings.Repeat("x", 20000)},
		{ID: mid(at(1), 1), AuthorID: "u1", CreatedAt: at(1), AttachmentIDs: make([]string, 11)},
		{ID: mid(at(1), 1), AuthorID: "u1", CreatedAt: at(1), ParentMessageID: mid(at(1), 1)},
	}
	for i, c := range cases {
		if _, err := e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{good, c}); !strings.Contains(errString(err), "invalid spec") {
			t.Errorf("case %d: want invalid spec, got %v", i, err)
		}
	}
	_, err := e.im.PutMessages(ctx, "c1", "thread", []MessageSpec{good})
	wantErr(t, err, ErrInvalidSpec)
	_, err = e.im.PutMessages(ctx, "", ParentChannel, []MessageSpec{good})
	wantErr(t, err, ErrInvalidSpec)
	// Nothing was written.
	if l, _, _ := store.NewMessageStore(e.db).ListMessages(ctx, "c1", "", 5); len(l) != 0 {
		t.Fatalf("validation must precede writes, found %d", len(l))
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func TestPutMessagesErrors(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, err := e.im.PutAttachment(ctx, AttachmentSpec{ID: "a1", Filename: "f"}, bodyOf("x"))
	mustNoErr(t, err)
	plain := MessageSpec{ID: mid(at(1), 1), AuthorID: "u1", Body: "x", CreatedAt: at(1)}
	withFile := MessageSpec{ID: mid(at(2), 2), AuthorID: "u1", CreatedAt: at(2), AttachmentIDs: []string{"a1"}}
	pinned := MessageSpec{ID: mid(at(3), 3), AuthorID: "u1", CreatedAt: at(3), Pinned: true}

	_, err = e.faulty(failOn("BatchGetItem", 0)).PutMessages(ctx, "c1", ParentChannel, []MessageSpec{plain})
	wantErr(t, err, errFault)
	_, err = e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{{ID: mid(at(4), 4), AuthorID: "u1", CreatedAt: at(4), AttachmentIDs: []string{"missing"}}})
	if err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("unknown attachment: %v", err)
	}
	_, err = e.faulty(failOn("PutItem", 1)).PutMessages(ctx, "c1", ParentChannel, []MessageSpec{withFile}) // file index
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("PutItem", 1)).PutMessages(ctx, "c1", ParentChannel, []MessageSpec{pinned}) // pin index
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("PutItem", 1)).PutMessages(ctx, "c1", ParentChannel, []MessageSpec{plain}) // message row
	wantErr(t, err, errFault)

	// Lost race: the row appears between the existence check and the write.
	ms := store.NewMessageStore(e.db)
	racer := &faultDynamo{DynamoAPI: e.db.Client}
	racer.fail = func(op string, n int) bool {
		if op == "PutItem" && n == 1 {
			mustNoErr(t, ms.CreateMessage(ctx, toMessage("c1", plain)))
		}
		return false
	}
	im, _ := New(Deps{DB: &store.DB{Client: racer, Table: e.db.Table}})
	res, err := im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{plain})
	if err != nil || res.Existing != 1 || res.Inserted != 0 {
		t.Fatalf("race = %+v %v", res, err)
	}
}

func TestUpdateAndTombstoneMessage(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	ms := store.NewMessageStore(e.db)
	pi := store.NewParentIndexStore(e.db)
	_, err := e.im.PutAttachment(ctx, AttachmentSpec{ID: "a1", Filename: "f"}, bodyOf("x"))
	mustNoErr(t, err)
	m := MessageSpec{ID: mid(at(1), 1), AuthorID: "u1", Body: "v1", CreatedAt: at(1), AttachmentIDs: []string{"a1"}}
	_, err = e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{m})
	mustNoErr(t, err)

	body, edited, yes, no := "v2", at(9), true, false
	mustNoErr(t, e.im.UpdateMessage(ctx, "c1", m.ID, MessagePatch{Body: &body, EditedAt: &edited, Reactions: map[string][]string{":tada:": {"u2"}}}))
	mustNoErr(t, e.im.UpdateMessage(ctx, "c1", m.ID, MessagePatch{Pinned: &yes, PinnedBy: "u2"}))
	pins, _ := pi.ListPinIndex(ctx, "c1")
	got, _ := ms.GetMessage(ctx, "c1", m.ID)
	if got.Body != "v2" || got.EditedAt == nil || !got.Pinned || len(pins) != 1 || got.Reactions[":tada:"][0] != "u2" {
		t.Fatalf("after update: %+v pins=%d", got, len(pins))
	}
	mustNoErr(t, e.im.UpdateMessage(ctx, "c1", m.ID, MessagePatch{Pinned: &yes})) // unchanged pin: no-op
	mustNoErr(t, e.im.UpdateMessage(ctx, "c1", m.ID, MessagePatch{Pinned: &no}))
	pins, _ = pi.ListPinIndex(ctx, "c1")
	if len(pins) != 0 {
		t.Fatal("pin index not cleared")
	}
	pinAt := at(8)
	mustNoErr(t, e.im.UpdateMessage(ctx, "c1", m.ID, MessagePatch{Pinned: &yes, PinnedAt: &pinAt}))

	long := strings.Repeat("x", 20000)
	wantErr(t, e.im.UpdateMessage(ctx, "c1", m.ID, MessagePatch{Body: &long}), ErrInvalidSpec)
	wantErr(t, e.im.UpdateMessage(ctx, "c1", "missing", MessagePatch{}), store.ErrNotFound)
	wantErr(t, e.faulty(failOn("PutItem", 1)).UpdateMessage(ctx, "c1", m.ID, MessagePatch{Body: &body}), errFault)
	wantErr(t, e.faulty(failOn("DeleteItem", 1)).UpdateMessage(ctx, "c1", m.ID, MessagePatch{Pinned: &no}), errFault)
	mustNoErr(t, e.im.UpdateMessage(ctx, "c1", m.ID, MessagePatch{Pinned: &no}))
	wantErr(t, e.faulty(failOn("PutItem", 1)).UpdateMessage(ctx, "c1", m.ID, MessagePatch{Pinned: &yes}), errFault)
	mustNoErr(t, e.im.UpdateMessage(ctx, "c1", m.ID, MessagePatch{Pinned: &yes}))

	// Tombstone failures leave the message intact.
	wantErr(t, e.faulty(failOn("GetItem", 1)).TombstoneMessage(ctx, "c1", m.ID), errFault)
	wantErr(t, e.faulty(failOn("UpdateItem", 1)).TombstoneMessage(ctx, "c1", m.ID), errFault)
	wantErr(t, e.faulty(failOn("DeleteItem", 1)).TombstoneMessage(ctx, "c1", m.ID), errFault) // file index
	wantErr(t, e.faulty(failOn("DeleteItem", 2)).TombstoneMessage(ctx, "c1", m.ID), errFault) // pin index
	wantErr(t, e.faulty(failOn("PutItem", 1)).TombstoneMessage(ctx, "c1", m.ID), errFault)
	e.search.deleteErr = errFault
	wantErr(t, e.im.TombstoneMessage(ctx, "c1", m.ID), errFault)
	e.search.deleteErr = nil

	// That last attempt already tombstoned the row; a fresh message for the
	// happy path.
	m2 := MessageSpec{ID: mid(at(2), 2), AuthorID: "u1", Body: "bye", CreatedAt: at(2), Pinned: true}
	_, err = e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{m2})
	mustNoErr(t, err)
	mustNoErr(t, e.im.TombstoneMessage(ctx, "c1", m2.ID))
	got, _ = ms.GetMessage(ctx, "c1", m2.ID)
	if !got.Deleted || got.Body != "" || got.Pinned {
		t.Fatalf("tombstone = %+v", got)
	}
	if len(e.search.deleted) == 0 {
		t.Fatal("search doc not removed")
	}
	mustNoErr(t, e.im.TombstoneMessage(ctx, "c1", m2.ID))     // already deleted
	mustNoErr(t, e.im.TombstoneMessage(ctx, "c1", "missing")) // unknown
	wantErr(t, e.im.UpdateMessage(ctx, "c1", m2.ID, MessagePatch{}), ErrMessageDeleted)
	noSearch, _ := New(Deps{DB: e.db})
	m3 := MessageSpec{ID: mid(at(3), 3), AuthorID: "u1", Body: "z", CreatedAt: at(3)}
	_, err = noSearch.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{m3})
	mustNoErr(t, err)
	mustNoErr(t, noSearch.TombstoneMessage(ctx, "c1", m3.ID))
}
