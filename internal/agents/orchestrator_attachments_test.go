package agents

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// fakeRunAttachments is the orchestrator's attachment surface in tests.
type fakeRunAttachments struct {
	rows      map[string]*model.Attachment
	data      map[string][]byte
	getErr    error
	openErr   error
	uploadErr error
	uploads   []service.AgentUploadParams
	opened    []string
	// readErr makes the opened body fail mid-read.
	readErr error
}

type brokenBody struct{ err error }

func (b brokenBody) Read([]byte) (int, error) { return 0, b.err }
func (brokenBody) Close() error               { return nil }

func (f *fakeRunAttachments) GetMany(_ context.Context, ids []string) ([]*model.Attachment, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	var out []*model.Attachment
	for _, id := range ids {
		if a, ok := f.rows[id]; ok {
			out = append(out, a)
		}
	}
	return out, nil
}

func (f *fakeRunAttachments) OpenForUser(_ context.Context, _, id, _, _, _ string) (io.ReadCloser, *model.Attachment, error) {
	f.opened = append(f.opened, id)
	if f.openErr != nil {
		return nil, nil, f.openErr
	}
	a, ok := f.rows[id]
	if !ok {
		return nil, nil, store.ErrNotFound
	}
	if f.readErr != nil {
		return brokenBody{err: f.readErr}, a, nil
	}
	return io.NopCloser(bytes.NewReader(f.data[id])), a, nil
}

func (f *fakeRunAttachments) UploadForAgent(_ context.Context, p service.AgentUploadParams) (*model.Attachment, error) {
	f.uploads = append(f.uploads, p)
	if f.uploadErr != nil {
		return nil, f.uploadErr
	}
	data, _ := io.ReadAll(p.Body)
	a := &model.Attachment{ID: "up-" + p.Filename, Filename: p.Filename, Size: int64(len(data)), CreatedBy: p.AgentID, RunID: p.RunID}
	if f.rows == nil {
		f.rows = map[string]*model.Attachment{}
	}
	f.rows[a.ID] = a
	return a, nil
}

func attachmentRows() *fakeRunAttachments {
	return &fakeRunAttachments{
		rows: map[string]*model.Attachment{
			"a-img": {ID: "a-img", Filename: "shot.png", ContentType: "image/png", Size: 120 * 1024, CreatedBy: "u-alice"},
			"a-pdf": {ID: "a-pdf", Filename: "weird\n[name].pdf", ContentType: "application/pdf", Size: 3 << 20, CreatedBy: "u-alice"},
		},
		data: map[string][]byte{"a-img": bytes.Repeat([]byte("p"), 120*1024), "a-pdf": bytes.Repeat([]byte("d"), 3<<20)},
	}
}

func TestOrchestrator_RunCarriesTheInvokingMessagesFiles(t *testing.T) {
	fx := newOrchFixture(t)
	att := attachmentRows()
	fx.orch.SetAttachments(att)
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] look", AttachmentIDs: []string{"a-img", "gone", "a-pdf"}}
	agent, _ := fx.users.GetUser(context.Background(), testGGID)
	invoker, _ := fx.users.GetUser(context.Background(), "u-alice")
	resolved, _ := fx.orch.agentSvc.Resolve(context.Background(), agent, invoker.ID)
	run, err := fx.orch.startRun(context.Background(), invocation{agent: agent, invoker: invoker, msg: msg, parentType: service.ParentChannel}, resolved)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if strings.Join(run.AttachmentIDs, ",") != "a-img,gone,a-pdf" {
		t.Fatalf("run.AttachmentIDs = %v", run.AttachmentIDs)
	}
	as := fx.claim(t)
	// Rows that no longer exist are absent; names are display-cleaned.
	if len(as.Attachments) != 2 || as.Attachments[0].ID != "a-img" || as.Attachments[1].Filename != "weird  name .pdf" || as.Attachments[1].MessageID != "m1" {
		t.Fatalf("assignment attachments = %+v", as.Attachments)
	}
}

func TestOrchestrator_RunAttachmentListWithoutServiceOrOnError(t *testing.T) {
	fx := newOrchFixture(t)
	run := &model.Run{ID: "r", MessageID: "m1", AttachmentIDs: []string{"a-img"}}
	if got := fx.orch.runAttachmentList(context.Background(), run); got != nil {
		t.Fatalf("no service: %v", got)
	}
	fx.orch.SetAttachments(&fakeRunAttachments{getErr: errors.New("dynamo")})
	if got := fx.orch.runAttachmentList(context.Background(), run); got != nil {
		t.Fatalf("lookup error: %v", got)
	}
	if got := fx.orch.attachmentIndex(context.Background(), nil); got != nil {
		t.Fatalf("empty ids: %v", got)
	}
}

func TestOrchestrator_TranscriptShowsFiles(t *testing.T) {
	fx := newOrchFixture(t)
	fx.orch.SetAttachments(attachmentRows())
	at := time.Date(2026, 10, 15, 9, 30, 0, 0, time.UTC)
	msgs := []*model.Message{
		{ID: "m1", AuthorID: "u-alice", Body: "see attached", AttachmentIDs: []string{"a-img", "unknown"}, CreatedAt: at},
		{ID: "m2", AuthorID: "u-alice", AttachmentIDs: []string{"a-pdf"}, CreatedAt: at}, // file-only message
		{ID: "m3", AuthorID: "u-alice", Body: "plain", CreatedAt: at},
		{ID: "m4", AuthorID: "u-alice", Deleted: true, AttachmentIDs: []string{"a-img"}, CreatedAt: at},
		{ID: "m5", AuthorID: "u-alice", CreatedAt: at}, // empty: still skipped
	}
	out := fx.orch.RenderMessages(context.Background(), msgs)
	want := []string{
		"[m:m1] Alice (human) 09:30: see attached [files: shot.png (image/png, 120 KB) att:a-img; att:unknown]\n",
		"[m:m2] Alice (human) 09:30:  [files: weird  name .pdf (application/pdf, 3.0 MB) att:a-pdf]\n",
		"[m:m3] Alice (human) 09:30: plain\n",
	}
	if out != strings.Join(want, "") {
		t.Fatalf("transcript:\n%s", out)
	}
	// Without the service the markers degrade to bare ids and file-only
	// messages still show.
	fx.orch.SetAttachments(nil)
	if out := fx.orch.RenderMessages(context.Background(), msgs[1:2]); !strings.Contains(out, "[files: att:a-pdf]") {
		t.Fatalf("bare marker missing: %s", out)
	}
}

func TestHumanSizeAndDisplayFilename(t *testing.T) {
	for n, want := range map[int64]string{0: "0 B", 999: "999 B", 1024: "1 KB", 1536: "1 KB", 1 << 20: "1.0 MB", 5<<20 + 300<<10: "5.3 MB"} {
		if got := humanSize(n); got != want {
			t.Errorf("humanSize(%d) = %q, want %q", n, got, want)
		}
	}
	long := strings.Repeat("x", 90)
	for in, want := range map[string]string{"a.png": "a.png", "  ": "file", "\x00\x7f": "file", "[x]": "x", long: long[:80] + "…"} {
		if got := displayFilename(in); got != want {
			t.Errorf("displayFilename(%q) = %q, want %q", in, got, want)
		}
	}
	if filesMarker(&model.Message{}, nil) != "" {
		t.Fatal("no files → no marker")
	}
}

func TestOrchestrator_RunOwnedAttachmentsAndUploadCap(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	ctx := context.Background()
	att := &fakeRunAttachments{rows: map[string]*model.Attachment{
		"mine":      {ID: "mine", RunID: run.ID, CreatedBy: run.AgentID},
		"other-run": {ID: "other-run", RunID: "r-other", CreatedBy: run.AgentID},
		"not-agent": {ID: "not-agent", RunID: run.ID, CreatedBy: "u-alice"},
	}}
	fx.orch.SetAttachments(att)
	if got := fx.orch.runOwnedAttachments(ctx, run, nil); got != nil {
		t.Fatalf("empty: %v", got)
	}
	ids := []string{"other-run", "mine", "not-agent", "missing"}
	for i := 0; i < service.MaxAttachmentsPerMessage; i++ {
		ids = append(ids, "pad") // past the cap: ignored
	}
	if got := fx.orch.runOwnedAttachments(ctx, run, ids); strings.Join(got, ",") != "mine" {
		t.Fatalf("owned = %v", got)
	}

	for i := 1; i <= model.UploadsPerRun; i++ {
		remaining, err := fx.orch.RecordAgentUpload(ctx, run.ID)
		if err != nil || remaining != model.UploadsPerRun-i {
			t.Fatalf("upload %d: remaining=%d err=%v", i, remaining, err)
		}
	}
	if _, err := fx.orch.RecordAgentUpload(ctx, run.ID); !errors.Is(err, ErrUploadCap) {
		t.Fatalf("over cap: %v", err)
	}
	fx.runs.mu.Lock()
	fx.runs.failAddPostsOnce = errors.New("dynamo")
	fx.runs.mu.Unlock()
	if _, err := fx.orch.RecordAgentUpload(ctx, run.ID); err == nil || errors.Is(err, ErrRunClosed) {
		t.Fatalf("store error must pass through: %v", err)
	}
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID].State = model.RunStateCompleted
	fx.runs.mu.Unlock()
	if _, err := fx.orch.RecordAgentUpload(ctx, run.ID); !errors.Is(err, ErrRunClosed) {
		t.Fatalf("terminal run: %v", err)
	}
}

func TestOrchestrator_CompleteRunPostsTheRunsFiles(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)
	fx.orch.SetAttachments(&fakeRunAttachments{rows: map[string]*model.Attachment{
		"mine":  {ID: "mine", RunID: run.ID, CreatedBy: run.AgentID},
		"their": {ID: "their", RunID: "r-x", CreatedBy: run.AgentID},
	}})
	// An empty final text with a file still posts (the file IS the answer);
	// a foreign id is dropped silently.
	if err := fx.orch.CompleteRun(context.Background(), "u-alice", "r1", run.ID, "", nil, "their", "mine"); err != nil {
		t.Fatalf("complete: %v", err)
	}
	fx.msgs.mu.Lock()
	defer fx.msgs.mu.Unlock()
	if len(fx.msgs.postFiles) != 1 || strings.Join(fx.msgs.postFiles[0], ",") != "mine" {
		t.Fatalf("posted files = %v (posts %v)", fx.msgs.postFiles, fx.msgs.posts)
	}
}
