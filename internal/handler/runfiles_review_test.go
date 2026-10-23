package handler

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/agents"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// fileAccess answers MessageAttachmentIDs from a table: message id → the
// attachment ids that message carries for the invoker; anything else is a
// denial (not a member, or the message is gone).
type fileAccess struct {
	byMsg map[string][]string
	asked []string
}

func (f *fileAccess) CheckAccess(context.Context, string, string, string) error { return nil }

func (f *fileAccess) MessageAttachmentIDs(_ context.Context, userID, parentID, _, messageID string) (map[string]bool, error) {
	f.asked = append(f.asked, userID+"@"+parentID+"/"+messageID)
	ids, ok := f.byMsg[messageID]
	if !ok {
		return nil, service.ErrForbidden
	}
	out := map[string]bool{}
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

// The drawer's file list returns SIGNED URLs, and it used to take a file's
// name straight from the timeline: a runner could report a forged
// "workspace.file_fetched" (or a "tool" event naming fetch_attachment) for any
// attachment id and get a working download link for it. Now only
// server-recorded file events count, and every listed file must be one the
// run's invoker can read (through a message in the run's chat), a project
// screen the run may read, or a file the run itself uploaded.
func TestRunFiles_ListsOnlyFilesTheInvokerCanReach(t *testing.T) {
	fx := hrunnerCovNewFix(t)
	pst := newHProjectStore()
	pst.screens["sc1"] = &model.ProjectScreen{ID: "sc1", ProjectKey: "acme", AttachmentID: "screen"}
	fx.orch.SetProjects(agents.NewProjectService(pst, &hProjectAtts{}))
	access := &fileAccess{byMsg: map[string][]string{"m-in": {"in"}, "m-thread": {"thread-file"}}}
	h := &AgentHandler{orch: fx.orch, access: access}
	att := func(id string, msgIDs ...string) *model.Attachment {
		return &model.Attachment{ID: id, Filename: id + ".png", ContentType: "image/png", URL: "/signed/" + id, MessageIDs: msgIDs}
	}
	h.SetRunFiles(fakeRunFileLoader{byID: map[string]*model.Attachment{
		"in":          att("in", "m-in"),
		"lost":        att("lost", "m-left"), // a given file on a message the invoker can no longer read
		"thread-file": att("thread-file", "m-thread"),
		"secret":      att("secret", "m-private"), // someone else's file in a channel the invoker isn't in
		"screen":      att("screen"),
		"mine":        {ID: "mine", Filename: "out.png", RunID: "r1", CreatedBy: "a-gg", URL: "/signed/mine"},
		"theirs":      {ID: "theirs", Filename: "x.png", RunID: "r-other", CreatedBy: "a-gg", URL: "/signed/theirs"},
	}})
	run := &model.Run{ID: "r1", AgentID: "a-gg", InvokerID: "u-inv", ParentID: "chan-1", ParentType: service.ParentChannel,
		MessageID: "m-in", ProjectKey: "acme", AttachmentIDs: []string{"in", "lost"}}
	const runnerSeq = 1_000_000 + 5
	serverSeq := int64(1_700_000_000_000_000_000)
	tool := func(id string) *model.RunEvent {
		return &model.RunEvent{RunID: "r1", Seq: runnerSeq, Type: "tool", Payload: map[string]any{
			"name": "mcp__ex__fetch_attachment", "input": map[string]any{"json": `{"attachment_id":"att:` + id + `"}`}}}
	}
	evts := []*model.RunEvent{
		// Forged by the runner (runner sequence band): ignored outright.
		{RunID: "r1", Seq: runnerSeq, Type: "workspace.file_fetched", Payload: map[string]any{"attachmentID": "secret", "source": "message"}},
		{RunID: "r1", Seq: runnerSeq, Type: "workspace.file_uploaded", Payload: map[string]any{"attachmentID": "theirs"}},
		// Server-recorded, but naming files the invoker cannot reach.
		{RunID: "r1", Seq: serverSeq, Type: "workspace.file_fetched", Payload: map[string]any{"attachmentID": "secret", "source": "message"}},
		{RunID: "r1", Seq: serverSeq, Type: "workspace.file_fetched", Payload: map[string]any{"attachmentID": "secret", "source": "project_screen"}},
		{RunID: "r1", Seq: serverSeq, Type: "workspace.file_uploaded", Payload: map[string]any{"attachmentID": "theirs"}},
		// Legacy tool events are runner-reported by nature: access decides.
		tool("secret"), tool("thread-file"), tool("screen"),
		// Genuine server records.
		{RunID: "r1", Seq: serverSeq, Type: "workspace.file_fetched", Payload: map[string]any{"attachmentID": "thread-file", "source": "message", "messageID": "m-thread"}},
		{RunID: "r1", Seq: serverSeq, Type: "workspace.file_uploaded", Payload: map[string]any{"attachmentID": "mine"}},
		// An event for a run that is not in view is ignored.
		{RunID: "r-elsewhere", Seq: serverSeq, Type: "workspace.file_uploaded", Payload: map[string]any{"attachmentID": "mine"}},
	}
	got := h.runFiles(context.Background(), []*model.Run{run}, evts)
	var summary []string
	for _, f := range got {
		summary = append(summary, f["role"].(string)+":"+f["id"].(string)+":"+f["source"].(string))
	}
	want := []string{"given:in:message", "fetched:thread-file:message", "fetched:screen:project_screen", "posted:mine:"}
	if len(summary) != len(want) {
		t.Fatalf("files = %v, want %v", summary, want)
	}
	for i := range want {
		if summary[i] != want[i] {
			t.Fatalf("files = %v, want %v", summary, want)
		}
	}
	for _, q := range access.asked {
		if q[:len("u-inv@chan-1/")] != "u-inv@chan-1/" {
			t.Fatalf("access must be checked as the invoker in the run's chat, asked %q", q)
		}
	}

	// Without an access checker message files fail closed; the run's own
	// uploads and project screens still list.
	h.access = nil
	got = h.runFiles(context.Background(), []*model.Run{run}, evts)
	if len(got) != 2 || got[0]["id"] != "screen" || got[1]["id"] != "mine" {
		t.Fatalf("no checker: %v", got)
	}
}
