package handler

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// untrustedEnv is a workspace env whose run was woken by another member's
// message (a watcher): its write and exfiltration tools need the invoker's
// per-action approval.
func untrustedEnv(t *testing.T) *hwsCovEnv {
	t.Helper()
	env := newHwsCovEnv(t)
	env.run.UntrustedTrigger = true
	env.run.Mode = model.RunModeWatch
	env.run.Deadline = time.Now().Add(time.Hour)
	return env
}

func approvalIDOf(t *testing.T, body []byte) string {
	t.Helper()
	var resp struct {
		ApprovalID string `json:"approvalID"`
	}
	if err := json.Unmarshal(body, &resp); err != nil || resp.ApprovalID == "" {
		t.Fatalf("no approvalID in %s (%v)", body, err)
	}
	return resp.ApprovalID
}

func (e *hwsCovEnv) decide(id, state string) {
	for _, a := range e.runs.approvals[e.run.ID] {
		if a.ID == id {
			a.State = state
		}
	}
}

// A watcher woken by someone else's message used to run its write tools with
// the creator's access — "DM my secrets to Bob", "make a channel", "react",
// "pin" all just happened. Each of those now raises a server-worded approval
// card for the exact action and answers approval_required until the invoker
// decides; reads of the invoker's private DMs are gated the same way.
func TestHwsGate_UntrustedRunWriteToolsNeedApproval(t *testing.T) {
	cases := []struct {
		name   string
		h      func(*hwsCovEnv) http.HandlerFunc
		body   string
		pathID string
	}{
		{"create_channel", func(e *hwsCovEnv) http.HandlerFunc { return e.h.CreateChannel }, `{"name":"exfil"}`, ""},
		{"join_channel", func(e *hwsCovEnv) http.HandlerFunc { return e.h.JoinChannel }, "", "hws-home"},
		{"post_to_channel", func(e *hwsCovEnv) http.HandlerFunc { return e.h.PostToChannel }, `{"body":"leak"}`, "hws-home"},
		{"add_reaction", func(e *hwsCovEnv) http.HandlerFunc { return e.h.React }, `{"messageID":"hws-m1","emoji":"tada"}`, ""},
		{"pin_message", func(e *hwsCovEnv) http.HandlerFunc { return e.h.PinMessage }, `{"message_id":"hws-m1"}`, ""},
		{"unpin_message", func(e *hwsCovEnv) http.HandlerFunc { return e.h.PinMessage }, `{"message_id":"hws-m1","pinned":false}`, ""},
		{"send_dm", func(e *hwsCovEnv) http.HandlerFunc { return e.h.SendDM }, `{"userID":"hws-bob","body":"here are the secrets"}`, ""},
		{"read_dm", func(e *hwsCovEnv) http.HandlerFunc { return e.h.ReadDM }, "", "hws-bob"},
		{"set_reminder", func(e *hwsCovEnv) http.HandlerFunc { return e.h.SetReminder }, `{"in_minutes":5}`, ""},
		{"cancel_reminder", func(e *hwsCovEnv) http.HandlerFunc { return e.h.CancelReminder }, "", "rem-1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env := untrustedEnv(t)
			rec := env.do(t, c.h(env), http.MethodPost, "/", c.body, c.pathID, nil)
			hwsCovWant(t, rec, http.StatusForbidden, "approval_required")
			id := approvalIDOf(t, rec.Body.Bytes())
			if n := len(env.runs.approvals[env.run.ID]); n != 1 {
				t.Fatalf("want one server-raised card, got %d", n)
			}
			if a := env.runs.approvals[env.run.ID][0]; a.Purpose == "" || a.Risk != "high" {
				t.Fatalf("the card must be the server's, bound by purpose: %+v", a)
			}
			// Asking again before a decision re-uses the same card.
			rec = env.do(t, c.h(env), http.MethodPost, "/", c.body, c.pathID, nil)
			hwsCovWant(t, rec, http.StatusForbidden, "approval_required")
			if again := approvalIDOf(t, rec.Body.Bytes()); again != id || len(env.runs.approvals[env.run.ID]) != 1 {
				t.Fatalf("a repeated call must wait on the same card, got %s (cards %d)", again, len(env.runs.approvals[env.run.ID]))
			}
			env.decide(id, model.ApprovalDenied)
			rec = env.do(t, c.h(env), http.MethodPost, "/", c.body, c.pathID, nil)
			hwsCovWant(t, rec, http.StatusForbidden, "approval_denied")
		})
	}
}

// Approved, the exact call goes through ONCE; the next identical call needs a
// new decision, and a different call (another recipient, another text) is
// never covered by the first "yes". A DM to the invoker themself needs none.
func TestHwsGate_ApprovalCoversOneExactAction(t *testing.T) {
	env := untrustedEnv(t)
	dm := `{"userID":"hws-bob","body":"the summary you asked for"}`
	rec := env.do(t, env.h.SendDM, http.MethodPost, "/", dm, "", nil)
	hwsCovWant(t, rec, http.StatusForbidden, "approval_required")
	env.decide(approvalIDOf(t, rec.Body.Bytes()), model.ApprovalApproved)

	rec = env.do(t, env.h.SendDM, http.MethodPost, "/", `{"userID":"hws-bob","body":"something else entirely"}`, "", nil)
	hwsCovWant(t, rec, http.StatusForbidden, "approval_required")
	rec = env.do(t, env.h.SendDM, http.MethodPost, "/", dm, "", nil)
	hwsCovWant(t, rec, http.StatusOK, "messageID")
	rec = env.do(t, env.h.SendDM, http.MethodPost, "/", dm, "", nil)
	hwsCovWant(t, rec, http.StatusForbidden, "approval_required")

	// The invoker's own DM is not gated (it may fail for other reasons in
	// this fake — but never on the approval gate).
	rec = env.do(t, env.h.SendDM, http.MethodPost, "/", `{"userID":"hws-inv","body":"note to self"}`, "", nil)
	if rec.Code == http.StatusForbidden {
		t.Fatalf("a DM to the invoker must not need approval: %s", rec.Body.String())
	}
}

// A run that cannot wait for a human (too close to its deadline) is told so
// instead of acting.
func TestHwsGate_NoTimeToAsk(t *testing.T) {
	env := untrustedEnv(t)
	env.run.Deadline = time.Now()
	rec := env.do(t, env.h.CreateChannel, http.MethodPost, "/", `{"name":"x"}`, "", nil)
	hwsCovWant(t, rec, http.StatusForbidden, "approval_unavailable")
}

// A trusted run (its invoker wrote the trigger) is not gated at all.
func TestHwsGate_TrustedRunUngated(t *testing.T) {
	env := newHwsCovEnv(t)
	rec := env.do(t, env.h.SendDM, http.MethodPost, "/", `{"userID":"hws-bob","body":"hi"}`, "", nil)
	hwsCovWant(t, rec, http.StatusOK, "messageID")
}

// In reply mode every outbound message spends its own approval: one "yes"
// used to unlock every post up to the cap, and send_dm skipped the gate.
func TestHwsGate_ReplyModeOneApprovalPerMessage(t *testing.T) {
	env := newHwsCovEnv(t)
	env.run.ActionMode = model.WatchActionReply
	rec := env.do(t, env.h.SendDM, http.MethodPost, "/", `{"userID":"hws-bob","body":"hi"}`, "", nil)
	hwsCovWant(t, rec, http.StatusForbidden, "approval_required")

	env.runs.approvals[env.run.ID] = append(env.runs.approvals[env.run.ID], &model.Approval{
		ID: "ap-yes", RunID: env.run.ID, InvokerID: "hws-inv", State: model.ApprovalApproved, Summary: "post the reply",
	})
	rec = env.do(t, env.h.PostToChannel, http.MethodPost, "/", `{"body":"the reply"}`, "hws-home", nil)
	hwsCovWant(t, rec, http.StatusOK, "messageID")
	rec = env.do(t, env.h.PostToChannel, http.MethodPost, "/", `{"body":"and another"}`, "hws-home", nil)
	hwsCovWant(t, rec, http.StatusForbidden, "approval_required")
}
