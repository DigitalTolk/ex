package handler

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/DigitalTolk/ex/internal/agents"
	"github.com/DigitalTolk/ex/internal/model"
)

// The Activity Drawer's file list: every file a run was GIVEN (the invoking
// message's attachments), FETCHED (fetch_attachment — thread files and project
// reference screenshots) or POSTED (its own uploads), so "what did it look at
// and what did it make?" is answered by thumbnails, not guesswork.
//
// The list hands out SIGNED URLs, so a timeline row naming a file is never
// enough on its own: runners report their own events, and a forged
// "workspace.file_fetched" (or a "tool" row naming fetch_attachment) used to
// turn any attachment id into a working download link. Every listed file is
// re-checked here against what the run could actually reach:
//   - file events count only when the SERVER recorded them (see
//     service.RunnerRecordedEvent); legacy "tool" rows are runner-reported by
//     nature and rely on the checks below alone;
//   - a posted file must be one this run uploaded itself;
//   - a fetched project screen must belong to the run's project;
//   - every other file must be readable by the run's INVOKER through a
//     message in the run's chat — the same rule the fetch endpoint applies.

// Run file roles, in display order.
const (
	runFileGiven   = "given"
	runFileFetched = "fetched"
	runFilePosted  = "posted"
)

type runFileRef struct {
	id, role, source, runID string
	// messageID is the message the file was read through, when the record
	// names one (the invoking message for given files).
	messageID string
}

// runFiles lists the runs' files (deduped per role, in order) with viewable
// URLs. Files no longer in storage, or no longer reachable by the run, are
// left out.
func (h *AgentHandler) runFiles(ctx context.Context, runs []*model.Run, evts []*model.RunEvent) []JSON {
	out := []JSON{}
	if h.files == nil {
		return out
	}
	byRun := make(map[string]*model.Run, len(runs))
	for _, run := range runs {
		byRun[run.ID] = run
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
			add(runFileRef{id: id, role: runFileGiven, source: "message", runID: run.ID, messageID: run.MessageID})
		}
	}
	for _, e := range evts {
		if byRun[e.RunID] == nil {
			continue
		}
		id, _ := e.Payload["attachmentID"].(string)
		switch e.Type {
		case "tool":
			// The fetch_attachment call itself names the file: runs recorded
			// before the server logged fetches still list what they read.
			add(runFileRef{id: fetchedAttachmentID(e.Payload), role: runFileFetched, runID: e.RunID})
		case "workspace.file_fetched":
			if agents.RunnerRecordedEvent(e) {
				continue // a runner cannot vouch for what the server served
			}
			source, _ := e.Payload["source"].(string)
			msgID, _ := e.Payload["messageID"].(string)
			add(runFileRef{id: id, role: runFileFetched, source: source, runID: e.RunID, messageID: msgID})
		case "workspace.file_uploaded":
			if agents.RunnerRecordedEvent(e) {
				continue
			}
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
	check := &runFileAccess{h: h, ctx: ctx, readable: map[string]map[string]bool{}}
	for _, ref := range refs {
		a := byID[ref.id]
		if a == nil {
			continue
		}
		source, ok := check.reachable(byRun[ref.runID], ref, a)
		if !ok {
			continue
		}
		out = append(out, JSON{
			"id": a.ID, "role": ref.role, "source": source, "runID": ref.runID,
			"filename": a.Filename, "contentType": a.ContentType, "size": a.Size,
			"url": a.URL, "downloadURL": a.DownloadURL, "thumbnailURL": a.ThumbnailURL,
			"width": a.Width, "height": a.Height,
		})
	}
	return out
}

// runFileAccess decides whether a run could reach a file, memoizing the
// per-message attachment sets (one membership + message read per message).
type runFileAccess struct {
	h        *AgentHandler
	ctx      context.Context
	readable map[string]map[string]bool // runID#messageID → attachment ids
}

// reachable reports whether the run could reach the file, and the source the
// drawer labels it with.
func (c *runFileAccess) reachable(run *model.Run, ref runFileRef, a *model.Attachment) (string, bool) {
	if ref.role == runFilePosted {
		// The run's own output: stored by this run, as this run's agent.
		return "", a.RunID == run.ID && a.CreatedBy == run.AgentID
	}
	if ref.role == runFileFetched && c.h.orch != nil && c.h.orch.RunMayReadScreen(c.ctx, run, a.ID) {
		return "project_screen", true
	}
	return "message", c.invokerCanRead(run, ref, a)
}

// invokerCanRead reports whether the run's invoker can read the attachment
// through a message in the run's chat: the message the record names, or any
// message that carries the file.
func (c *runFileAccess) invokerCanRead(run *model.Run, ref runFileRef, a *model.Attachment) bool {
	if c.h.access == nil {
		return false // nothing to check access with: fail closed
	}
	candidates := a.MessageIDs
	if ref.messageID != "" {
		candidates = append([]string{ref.messageID}, candidates...)
	}
	for _, msgID := range candidates {
		key := run.ID + "#" + msgID
		ids, ok := c.readable[key]
		if !ok {
			var err error
			if ids, err = c.h.access.MessageAttachmentIDs(c.ctx, run.InvokerID, run.ParentID, run.ParentType, msgID); err != nil {
				ids = nil // denied or unreadable: this message grants nothing
			}
			c.readable[key] = ids
		}
		if ids[a.ID] {
			return true
		}
	}
	return false
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
