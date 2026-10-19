package search

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestIndexParentMessages(t *testing.T) {
	ctx := context.Background()
	msgs := []*model.Message{
		{ID: "m1", ParentID: "p", Body: "hello", AttachmentIDs: []string{"a1"}},
		{ID: "m2", ParentID: "p", ParentMessageID: "m1", Body: "reply", AttachmentIDs: []string{"a1"}},
		{ID: "s", ParentID: "p", System: true, Body: "joined"},
		{ID: "n", ParentID: "p", NoIndex: true},
	}
	res := &stubAttachmentResolver{byID: map[string]*model.Attachment{"a1": {ID: "a1", Filename: "f.txt"}}}
	w := &fakeBulk{}
	nMsgs, nFiles, err := IndexParentMessages(ctx, w, msgs, "channel", res)
	if err != nil || nMsgs != 2 || nFiles != 1 {
		t.Fatalf("got %d msgs, %d files, %v", nMsgs, nFiles, err)
	}
	if w.calls[IndexMessages] != 2 || w.calls[IndexFiles] != 1 {
		t.Fatalf("calls = %v", w.calls)
	}

	// Nothing indexable: no writes at all.
	w = &fakeBulk{}
	if m, f, err := IndexParentMessages(ctx, w, msgs[2:], "channel", res); err != nil || m != 0 || f != 0 || len(w.calls) != 0 {
		t.Fatalf("got %d %d %v calls=%v", m, f, err, w.calls)
	}
	// No resolver: messages only.
	if m, f, err := IndexParentMessages(ctx, &fakeBulk{}, msgs, "conversation", nil); err != nil || m != 2 || f != 0 {
		t.Fatalf("got %d %d %v", m, f, err)
	}
	if _, _, err := IndexParentMessages(ctx, &fakeBulk{errFor: IndexMessages}, msgs, "channel", res); err == nil {
		t.Fatal("want message bulk error")
	}
	if m, _, err := IndexParentMessages(ctx, &fakeBulk{errFor: IndexFiles}, msgs, "channel", res); err == nil || m != 2 {
		t.Fatalf("want file bulk error after messages, got %d %v", m, err)
	}
}
