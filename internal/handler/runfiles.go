package handler

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
)

// The Activity Drawer's file list: every file a run was GIVEN (the invoking
// message's attachments), FETCHED (fetch_attachment — thread files and project
// reference screenshots) or POSTED (its own uploads), so "what did it look at
// and what did it make?" is answered by thumbnails, not guesswork. Timelines
// are invoker-only, and every listed file is one the invoker's run could read
// or wrote, so no extra gate is needed here.

// Run file roles, in display order.
const (
	runFileGiven   = "given"
	runFileFetched = "fetched"
	runFilePosted  = "posted"
)

type runFileRef struct {
	id, role, source, runID string
}

// runFiles lists the runs' files (deduped per role, in order) with viewable
// URLs. Files no longer in storage are left out.
func (h *AgentHandler) runFiles(ctx context.Context, runs []*model.Run, evts []*model.RunEvent) []JSON {
	out := []JSON{}
	if h.files == nil {
		return out
	}
	var refs []runFileRef
	seen := map[string]bool{}
	add := func(ref runFileRef) {
		if ref.id == "" || seen[ref.role+"|"+ref.id] {
			return
		}
		seen[ref.role+"|"+ref.id] = true
		refs = append(refs, ref)
	}
	for _, run := range runs {
		for _, id := range run.AttachmentIDs {
			add(runFileRef{id: id, role: runFileGiven, source: "message", runID: run.ID})
		}
	}
	byRun := make(map[string]*model.Run, len(runs))
	for _, run := range runs {
		byRun[run.ID] = run
	}
	for _, e := range evts {
		id, _ := e.Payload["attachmentID"].(string)
		switch e.Type {
		case "tool":
			// The fetch_attachment call itself names the file: runs recorded
			// before the server logged fetches still list what they read.
			if fid := fetchedAttachmentID(e.Payload); fid != "" {
				source := "message"
				if h.orch != nil && h.orch.RunMayReadScreen(ctx, byRun[e.RunID], fid) {
					source = "project_screen"
				}
				add(runFileRef{id: fid, role: runFileFetched, source: source, runID: e.RunID})
			}
		case "workspace.file_fetched":
			source, _ := e.Payload["source"].(string)
			add(runFileRef{id: id, role: runFileFetched, source: source, runID: e.RunID})
		case "workspace.file_uploaded":
			add(runFileRef{id: id, role: runFilePosted, runID: e.RunID})
		}
	}
	if len(refs) == 0 {
		return out
	}
	ids := make([]string, 0, len(refs))
	for _, ref := range refs {
		ids = append(ids, ref.id)
	}
	byID := map[string]*model.Attachment{}
	for _, a := range h.files.LoadForPreview(ctx, ids) {
		byID[a.ID] = a
	}
	for _, ref := range refs {
		a := byID[ref.id]
		if a == nil {
			continue
		}
		out = append(out, JSON{
			"id": a.ID, "role": ref.role, "source": ref.source, "runID": ref.runID,
			"filename": a.Filename, "contentType": a.ContentType, "size": a.Size,
			"url": a.URL, "downloadURL": a.DownloadURL, "thumbnailURL": a.ThumbnailURL,
			"width": a.Width, "height": a.Height,
		})
	}
	return out
}

// fetchedAttachmentID reads the attachment id out of a fetch_attachment tool
// event (input {"json": "{\"attachment_id\":\"att:<id>\"}"}); "" otherwise.
func fetchedAttachmentID(payload map[string]any) string {
	name, _ := payload["name"].(string)
	if !strings.HasSuffix(name, "fetch_attachment") {
		return ""
	}
	input, _ := payload["input"].(map[string]any)
	raw, _ := input["json"].(string)
	var args struct {
		AttachmentID string `json:"attachment_id"`
	}
	if json.Unmarshal([]byte(raw), &args) != nil {
		return ""
	}
	return strings.TrimPrefix(strings.TrimSpace(args.AttachmentID), "att:")
}
