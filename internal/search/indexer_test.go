package search

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

type recordingWriter struct {
	indexed   []indexCall
	deleted   []deleteCall
	getDocs   map[string]map[string]any
	indexErr  error
	deleteErr error
}

type indexCall struct {
	index string
	id    string
	doc   any
}
type deleteCall struct {
	index string
	id    string
}

func (r *recordingWriter) IndexDoc(_ context.Context, index, id string, doc any) error {
	r.indexed = append(r.indexed, indexCall{index, id, doc})
	return r.indexErr
}
func (r *recordingWriter) DeleteDoc(_ context.Context, index, id string) error {
	r.deleted = append(r.deleted, deleteCall{index, id})
	return r.deleteErr
}
func (r *recordingWriter) GetDoc(_ context.Context, index, id string) (map[string]any, error) {
	if r.getDocs == nil {
		return nil, nil
	}
	return r.getDocs[index+"/"+id], nil
}

// stubAttachmentResolver implements AttachmentResolver via a static map.
type stubAttachmentResolver struct {
	byID map[string]*model.Attachment
}

func (s *stubAttachmentResolver) ResolveFilenames(_ context.Context, ids []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if a, ok := s.byID[id]; ok && a.Filename != "" {
			out = append(out, a.Filename)
		}
	}
	return out
}
func (s *stubAttachmentResolver) ResolveAttachments(_ context.Context, ids []string) []*model.Attachment {
	out := make([]*model.Attachment, 0, len(ids))
	for _, id := range ids {
		if a, ok := s.byID[id]; ok {
			out = append(out, a)
		}
	}
	return out
}

func TestLiveIndexer_IndexMessage_UpsertsFileDocs(t *testing.T) {
	w := &recordingWriter{}
	idx := &LiveIndexer{w: w}
	idx.SetAttachmentResolver(&stubAttachmentResolver{byID: map[string]*model.Attachment{
		"a-1": {ID: "a-1", Filename: "design.pdf", ContentType: "application/pdf", Size: 4096, CreatedBy: "u-1"},
	}})
	m := &model.Message{ID: "m-1", ParentID: "ch-7", AuthorID: "u-1", Body: "see attached", AttachmentIDs: []string{"a-1"}}
	if err := idx.IndexMessage(context.Background(), m, "channel"); err != nil {
		t.Fatalf("IndexMessage: %v", err)
	}
	if len(w.indexed) != 2 {
		t.Fatalf("expected 2 IndexDoc calls (message + file), got %d", len(w.indexed))
	}
	if w.indexed[0].index != IndexMessages || w.indexed[1].index != IndexFiles {
		t.Errorf("call order = %v / %v", w.indexed[0].index, w.indexed[1].index)
	}
	fileDoc := w.indexed[1].doc.(map[string]any)
	if fileDoc["filename"] != "design.pdf" {
		t.Errorf("filename = %v", fileDoc["filename"])
	}
	if pids, _ := fileDoc["parentIds"].([]string); len(pids) != 1 || pids[0] != "ch-7" {
		t.Errorf("parentIds = %v, want [ch-7]", fileDoc["parentIds"])
	}
}

func TestLiveIndexer_IndexMessage_FileDocMergesExistingParents(t *testing.T) {
	// Same attachment shared in a new parent: GetDoc returns the
	// existing doc; upsert must keep the prior parent in the set.
	w := &recordingWriter{
		getDocs: map[string]map[string]any{
			IndexFiles + "/a-1": {
				"id":         "a-1",
				"filename":   "design.pdf",
				"parentIds":  []any{"ch-old"},
				"messageIds": []any{"m-old"},
			},
		},
	}
	idx := &LiveIndexer{w: w}
	idx.SetAttachmentResolver(&stubAttachmentResolver{byID: map[string]*model.Attachment{
		"a-1": {ID: "a-1", Filename: "design.pdf"},
	}})
	m := &model.Message{ID: "m-new", ParentID: "ch-new", AuthorID: "u-1", AttachmentIDs: []string{"a-1"}}
	if err := idx.IndexMessage(context.Background(), m, "channel"); err != nil {
		t.Fatalf("IndexMessage: %v", err)
	}
	fileDoc := w.indexed[1].doc.(map[string]any)
	pids, _ := fileDoc["parentIds"].([]string)
	if len(pids) != 2 {
		t.Fatalf("parentIds = %v, want [ch-new ch-old]", pids)
	}
	seen := map[string]bool{}
	for _, p := range pids {
		seen[p] = true
	}
	if !seen["ch-new"] || !seen["ch-old"] {
		t.Errorf("merged set must contain both parents, got %v", pids)
	}
}

func TestLiveIndexer_IndexMessage_FileDocCarriesParentMessageID_TopLevel(t *testing.T) {
	// First index of an attachment on a top-level message: messageIds
	// gets the message ID, parentMessageIds gets "" at the same index
	// so a frontend deep-link knows it's not in a thread.
	w := &recordingWriter{}
	idx := &LiveIndexer{w: w}
	idx.SetAttachmentResolver(&stubAttachmentResolver{byID: map[string]*model.Attachment{
		"a-1": {ID: "a-1", Filename: "doc.pdf"},
	}})
	m := &model.Message{ID: "m-1", ParentID: "ch-1", AuthorID: "u-1", AttachmentIDs: []string{"a-1"}}
	if err := idx.IndexMessage(context.Background(), m, "channel"); err != nil {
		t.Fatalf("IndexMessage: %v", err)
	}
	fileDoc := w.indexed[1].doc.(map[string]any)
	msgIDs, _ := fileDoc["messageIds"].([]string)
	parentMsgIDs, _ := fileDoc["parentMessageIds"].([]string)
	if len(msgIDs) != 1 || msgIDs[0] != "m-1" {
		t.Fatalf("messageIds = %v, want [m-1]", msgIDs)
	}
	if len(parentMsgIDs) != 1 || parentMsgIDs[0] != "" {
		t.Fatalf("parentMessageIds = %v, want [\"\"]", parentMsgIDs)
	}
}

func TestLiveIndexer_IndexMessage_FileDocCarriesParentMessageID_ThreadReply(t *testing.T) {
	// Attachment on a thread reply: parentMessageIds carries the
	// thread root so a click on the file hit lands in the thread
	// panel with the reply highlighted.
	w := &recordingWriter{}
	idx := &LiveIndexer{w: w}
	idx.SetAttachmentResolver(&stubAttachmentResolver{byID: map[string]*model.Attachment{
		"a-1": {ID: "a-1", Filename: "doc.pdf"},
	}})
	m := &model.Message{
		ID:              "reply-1",
		ParentID:        "ch-1",
		ParentMessageID: "root-1",
		AuthorID:        "u-1",
		AttachmentIDs:   []string{"a-1"},
	}
	if err := idx.IndexMessage(context.Background(), m, "channel"); err != nil {
		t.Fatalf("IndexMessage: %v", err)
	}
	fileDoc := w.indexed[1].doc.(map[string]any)
	parentMsgIDs, _ := fileDoc["parentMessageIds"].([]string)
	if len(parentMsgIDs) != 1 || parentMsgIDs[0] != "root-1" {
		t.Fatalf("parentMessageIds = %v, want [root-1]", parentMsgIDs)
	}
}

func TestLiveIndexer_IndexMessage_FileDocKeepsParentMessageIdsAlignedAcrossReshares(t *testing.T) {
	// File previously shared in a top-level message; now re-shared in
	// a thread reply. Both messages must show up — messageIds and
	// parentMessageIds index-aligned. Legacy docs without
	// parentMessageIds get padded with "" before the new entry.
	w := &recordingWriter{
		getDocs: map[string]map[string]any{
			IndexFiles + "/a-1": {
				"id":         "a-1",
				"filename":   "doc.pdf",
				"parentIds":  []any{"ch-1"},
				"messageIds": []any{"m-old"},
				// parentMessageIds intentionally absent — legacy v1 doc.
			},
		},
	}
	idx := &LiveIndexer{w: w}
	idx.SetAttachmentResolver(&stubAttachmentResolver{byID: map[string]*model.Attachment{
		"a-1": {ID: "a-1", Filename: "doc.pdf"},
	}})
	m := &model.Message{
		ID:              "m-new",
		ParentID:        "ch-1",
		ParentMessageID: "root-7",
		AuthorID:        "u-1",
		AttachmentIDs:   []string{"a-1"},
	}
	if err := idx.IndexMessage(context.Background(), m, "channel"); err != nil {
		t.Fatalf("IndexMessage: %v", err)
	}
	fileDoc := w.indexed[1].doc.(map[string]any)
	msgIDs, _ := fileDoc["messageIds"].([]string)
	parentMsgIDs, _ := fileDoc["parentMessageIds"].([]string)
	// Two entries, index-aligned: m-old (legacy, padded "") and m-new
	// (its own thread root).
	if len(msgIDs) != 2 || msgIDs[0] != "m-old" || msgIDs[1] != "m-new" {
		t.Fatalf("messageIds = %v, want [m-old m-new]", msgIDs)
	}
	if len(parentMsgIDs) != 2 || parentMsgIDs[0] != "" || parentMsgIDs[1] != "root-7" {
		t.Fatalf("parentMessageIds = %v, want [\"\" root-7]", parentMsgIDs)
	}
}

func TestLiveIndexer_IndexMessage_PropagatesGetDocError(t *testing.T) {
	w := &recordingWriter{}
	w.indexErr = errors.New("indexdoc fell over")
	idx := &LiveIndexer{w: w}
	idx.SetAttachmentResolver(&stubAttachmentResolver{byID: map[string]*model.Attachment{}})
	if err := idx.IndexMessage(context.Background(), &model.Message{ID: "m", AttachmentIDs: nil}, "channel"); err == nil {
		t.Fatal("expected wrapped IndexDoc error")
	}
}

func TestLiveIndexer_IndexMessage_SkipsSystemMessages(t *testing.T) {
	w := &recordingWriter{}
	idx := &LiveIndexer{w: w}
	if err := idx.IndexMessage(context.Background(), &model.Message{ID: "m", System: true}, "channel"); err != nil {
		t.Fatalf("system message must be skipped silently: %v", err)
	}
	if len(w.indexed) != 0 {
		t.Errorf("system message must not produce IndexDoc calls, got %d", len(w.indexed))
	}
}

func TestNewIndexer_NilClientReturnsNoop(t *testing.T) {
	idx := NewIndexer(nil)
	if _, ok := idx.(NoopIndexer); !ok {
		t.Fatalf("NewIndexer(nil) = %T, want NoopIndexer", idx)
	}
}

func TestLiveIndexer_RoutesUsersToCorrectIndex(t *testing.T) {
	w := &recordingWriter{}
	idx := &LiveIndexer{w: w}
	u := &model.User{ID: "u-1", DisplayName: "Alice", Email: "a@b.c", SystemRole: "member", Status: "active"}
	if err := idx.IndexUser(context.Background(), u); err != nil {
		t.Fatalf("IndexUser: %v", err)
	}
	if len(w.indexed) != 1 || w.indexed[0].index != IndexUsers || w.indexed[0].id != "u-1" {
		t.Errorf("unexpected index call: %+v", w.indexed)
	}
	doc, ok := w.indexed[0].doc.(map[string]any)
	if !ok {
		t.Fatalf("doc type = %T", w.indexed[0].doc)
	}
	if doc["displayName"] != "Alice" {
		t.Errorf("doc = %+v", doc)
	}
}

func TestLiveIndexer_DeleteUser(t *testing.T) {
	w := &recordingWriter{}
	idx := &LiveIndexer{w: w}
	if err := idx.DeleteUser(context.Background(), "u-1"); err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}
	if len(w.deleted) != 1 || w.deleted[0].index != IndexUsers || w.deleted[0].id != "u-1" {
		t.Errorf("unexpected delete call: %+v", w.deleted)
	}
}

func TestLiveIndexer_RoutesChannel(t *testing.T) {
	w := &recordingWriter{}
	idx := &LiveIndexer{w: w}
	ch := &model.Channel{ID: "ch-1", Name: "general", Slug: "general", Type: "public", Archived: false}
	_ = idx.IndexChannel(context.Background(), ch)
	_ = idx.DeleteChannel(context.Background(), "ch-1")
	if len(w.indexed) != 1 || w.indexed[0].index != IndexChannels {
		t.Errorf("index calls = %+v", w.indexed)
	}
	if len(w.deleted) != 1 || w.deleted[0].index != IndexChannels {
		t.Errorf("delete calls = %+v", w.deleted)
	}
}

func TestLiveIndexer_SkipsSystemMessages(t *testing.T) {
	w := &recordingWriter{}
	idx := &LiveIndexer{w: w}
	m := &model.Message{ID: "m-1", System: true, Body: "X joined"}
	if err := idx.IndexMessage(context.Background(), m, "channel"); err != nil {
		t.Fatalf("IndexMessage: %v", err)
	}
	if len(w.indexed) != 0 {
		t.Error("system message must not be indexed")
	}
}

func TestLiveIndexer_NilMessageIsNoop(t *testing.T) {
	w := &recordingWriter{}
	idx := &LiveIndexer{w: w}
	if err := idx.IndexMessage(context.Background(), nil, "channel"); err != nil {
		t.Fatalf("IndexMessage(nil): %v", err)
	}
	if len(w.indexed) != 0 {
		t.Error("nil message must not be indexed")
	}
}

func TestLiveIndexer_MessageDocCarriesParentTypeAndTags(t *testing.T) {
	w := &recordingWriter{}
	idx := &LiveIndexer{w: w}
	m := &model.Message{
		ID:        "m-1",
		ParentID:  "ch-1",
		AuthorID:  "u-1",
		Body:      "fix the #BUG please #urgent #bug",
		CreatedAt: time.Now(),
	}
	if err := idx.IndexMessage(context.Background(), m, "channel"); err != nil {
		t.Fatalf("IndexMessage: %v", err)
	}
	doc := w.indexed[0].doc.(map[string]any)
	if doc["parentType"] != "channel" {
		t.Errorf("parentType = %v", doc["parentType"])
	}
	tags, _ := doc["tags"].([]string)
	want := []string{"bug", "urgent"}
	if !reflect.DeepEqual(tags, want) {
		t.Errorf("tags = %v, want %v (lowercased + de-duped, preserving first-seen order)", tags, want)
	}
}

func TestLiveIndexer_DeleteMessage(t *testing.T) {
	w := &recordingWriter{}
	idx := &LiveIndexer{w: w}
	_ = idx.DeleteMessage(context.Background(), "m-1")
	if len(w.deleted) != 1 || w.deleted[0].index != IndexMessages {
		t.Errorf("delete = %+v", w.deleted)
	}
}

func TestNoopIndexer_AllOpsAreSilent(t *testing.T) {
	n := NoopIndexer{}
	ctx := context.Background()
	if err := n.IndexUser(ctx, &model.User{}); err != nil {
		t.Errorf("IndexUser: %v", err)
	}
	if err := n.DeleteUser(ctx, "x"); err != nil {
		t.Errorf("DeleteUser: %v", err)
	}
	if err := n.IndexChannel(ctx, &model.Channel{}); err != nil {
		t.Errorf("IndexChannel: %v", err)
	}
	if err := n.DeleteChannel(ctx, "x"); err != nil {
		t.Errorf("DeleteChannel: %v", err)
	}
	if err := n.IndexMessage(ctx, &model.Message{}, "channel"); err != nil {
		t.Errorf("IndexMessage: %v", err)
	}
	if err := n.DeleteMessage(ctx, "x"); err != nil {
		t.Errorf("DeleteMessage: %v", err)
	}
}

func TestExtractHashtags(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		{"hello world", []string{}},
		{"#bug fix", []string{"bug"}},
		{"#BUG and #bug are the same", []string{"bug"}},
		{"#one #TWO #three", []string{"one", "two", "three"}},
		// Unicode/underscore/hyphen are all valid; a single-char `#a` is
		// rejected by the {2,64} length floor.
		{"#café_é-1 #_underscore-tag#a", []string{"café_é-1", "_underscore-tag"}},
	}
	for _, tc := range tests {
		got := extractHashtags(tc.in)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("extractHashtags(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}
