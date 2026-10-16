package handler

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

type fakeRunFileLoader struct{ byID map[string]*model.Attachment }

func (f fakeRunFileLoader) LoadForPreview(_ context.Context, ids []string) []*model.Attachment {
	var out []*model.Attachment
	for _, id := range ids {
		if a, ok := f.byID[id]; ok {
			out = append(out, a)
		}
	}
	return out
}

// The drawer's file list: what a run was given, fetched and posted, in that
// order, deduped per role, and only files still in storage.
func TestRunFiles(t *testing.T) {
	h := &AgentHandler{}
	if got := h.runFiles(context.Background(), nil, nil); len(got) != 0 {
		t.Fatalf("no loader: %v", got)
	}
	img := func(id, name string) *model.Attachment {
		return &model.Attachment{ID: id, Filename: name, ContentType: "image/png", Size: 3, URL: "/m/" + id, ThumbnailURL: "/t/" + id, Width: 4, Height: 3}
	}
	h.SetRunFiles(fakeRunFileLoader{byID: map[string]*model.Attachment{
		"in": img("in", "request.png"), "screen": img("screen", "home.png"), "html": {ID: "html", Filename: "v1.html", ContentType: "text/html", Size: 9, URL: "/m/html"},
		"out": img("out", "v2.png"),
	}})
	runs := []*model.Run{{ID: "r1", AttachmentIDs: []string{"in", "gone"}}, {ID: "r2", AttachmentIDs: []string{"in"}}}
	evts := []*model.RunEvent{
		{RunID: "r2", Type: "workspace.file_fetched", Payload: map[string]any{"attachmentID": "screen", "source": "project_screen"}},
		{RunID: "r2", Type: "workspace.file_fetched", Payload: map[string]any{"attachmentID": "screen", "source": "project_screen"}},
		{RunID: "r2", Type: "workspace.file_fetched", Payload: map[string]any{"attachmentID": "html", "source": "message"}},
		{RunID: "r2", Type: "workspace.file_uploaded", Payload: map[string]any{"attachmentID": "out"}},
		{RunID: "r2", Type: "workspace.file_uploaded", Payload: map[string]any{}},
		{RunID: "r2", Type: "tool", Payload: map[string]any{"attachmentID": "ignored"}},
	}
	got := h.runFiles(context.Background(), runs, evts)
	var summary []string
	for _, f := range got {
		summary = append(summary, f["role"].(string)+":"+f["id"].(string)+":"+f["source"].(string)+":"+f["runID"].(string))
	}
	want := []string{"given:in:message:r1", "fetched:screen:project_screen:r2", "fetched:html:message:r2", "posted:out::r2"}
	if len(summary) != len(want) {
		t.Fatalf("files = %v, want %v", summary, want)
	}
	for i := range want {
		if summary[i] != want[i] {
			t.Fatalf("files = %v, want %v", summary, want)
		}
	}
	if got[1]["thumbnailURL"] != "/t/screen" || got[1]["filename"] != "home.png" || got[1]["width"] != 4 {
		t.Fatalf("resolved fields: %v", got[1])
	}
	if got := h.runFiles(context.Background(), []*model.Run{{ID: "x"}}, nil); len(got) != 0 {
		t.Fatalf("nothing to list: %v", got)
	}
}

func TestFetchedAttachmentID(t *testing.T) {
	cases := []struct {
		payload map[string]any
		want    string
	}{
		{map[string]any{"name": "mcp__ex__fetch_attachment", "input": map[string]any{"json": `{"attachment_id":"att:A1","message_id":"m:x"}`}}, "A1"},
		{map[string]any{"name": "fetch_attachment", "input": map[string]any{"json": `{"attachment_id":" B2 "}`}}, "B2"},
		{map[string]any{"name": "mcp__ex__post_message", "input": map[string]any{"json": `{"attachment_id":"att:A1"}`}}, ""},
		{map[string]any{"name": "mcp__ex__fetch_attachment", "input": map[string]any{"json": `not json`}}, ""},
		{map[string]any{"name": "mcp__ex__fetch_attachment"}, ""},
	}
	for i, tc := range cases {
		if got := fetchedAttachmentID(tc.payload); got != tc.want {
			t.Errorf("case %d: got %q, want %q", i, got, tc.want)
		}
	}
}

// Runs recorded before fetches were logged still list what they read, from
// their fetch_attachment tool calls — and a project screen is labelled so.
func TestRunFiles_FromToolCalls(t *testing.T) {
	fx := hrunnerCovNewFix(t)
	pst := newHProjectStore()
	pst.screens["sc1"] = &model.ProjectScreen{ID: "sc1", ProjectKey: "acme", AttachmentID: "screen"}
	fx.orch.SetProjects(service.NewProjectService(pst, &hProjectAtts{}))
	h := &AgentHandler{orch: fx.orch}
	h.SetRunFiles(fakeRunFileLoader{byID: map[string]*model.Attachment{
		"screen": {ID: "screen", Filename: "home.png", ContentType: "image/png"},
		"v1":     {ID: "v1", Filename: "v1.html", ContentType: "text/html"},
	}})
	run := &model.Run{ID: "r1", ProjectKey: "acme"}
	tool := func(id string) *model.RunEvent {
		return &model.RunEvent{RunID: "r1", Type: "tool", Payload: map[string]any{
			"name": "mcp__ex__fetch_attachment", "input": map[string]any{"json": `{"attachment_id":"att:` + id + `"}`}}}
	}
	got := h.runFiles(context.Background(), []*model.Run{run}, []*model.RunEvent{tool("screen"), tool("v1"),
		{RunID: "r1", Type: "workspace.file_fetched", Payload: map[string]any{"attachmentID": "v1", "source": "message"}}})
	if len(got) != 2 || got[0]["source"] != "project_screen" || got[1]["source"] != "message" || got[1]["role"] != "fetched" {
		t.Fatalf("files from tool calls: %v", got)
	}
}
