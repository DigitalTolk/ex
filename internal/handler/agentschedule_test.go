package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// hschedDM stands in for the conversation service: the invoker's DM with the
// agent, which a "dm" destination files the order in.
type hschedDM struct{}

func (hschedDM) GetOrCreateDM(context.Context, string, string) (*model.Conversation, error) {
	return &model.Conversation{ID: hrunnerCovConv}, nil
}

func TestScheduleChangeAllowed(t *testing.T) {
	for mode, want := range map[string]bool{
		model.RunModeDirect: true, model.RunModeFollowUp: true, "": true,
		model.RunModeWatch: false, model.RunModeHeartbeat: false, model.RunModeScheduled: false, model.RunModeTask: false,
	} {
		if got := scheduleChangeAllowed(&model.Run{Mode: mode}); got != want {
			t.Fatalf("mode %q: got %v, want %v", mode, got, want)
		}
	}
}

// An agent asked directly can create, list and remove its invoker's scheduled
// orders; the destination decides where it posts and how (private vs public).
func TestAgentRunTool_Schedules(t *testing.T) {
	fx := hrunnerCovNewFix(t)
	fx.toolH.agents.SetDMResolver(hschedDM{})
	run := fx.addRun(&model.Run{})
	claims := hrunnerCovToolClaims(run.ID)

	// Empty to begin with.
	rec := hrunnerCovDo(t, fx.toolH.ListSchedules, "GET", "", claims, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "(no scheduled orders)") {
		t.Fatalf("empty list: %d %s", rec.Code, rec.Body)
	}

	// Default destination "here" — this channel, posted publicly, in the
	// invoker's zone; pins are normalised.
	rec = hrunnerCovDo(t, fx.toolH.CreateSchedule, "POST",
		`{"instruction":"sprint tldr","schedule":"0 9 * * 1-5","timezone":"Asia/Kolkata","connectors":["/cliffhub"],"skills":["[sk:none]"]}`, claims, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "for gg: 09:00 on Mon-Fri Asia/Kolkata → [ch:"+hrunnerCovChan+"]") {
		t.Fatalf("create here: %d %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "UTC because") {
		t.Fatalf("zone note shown although a zone was given: %s", rec.Body)
	}
	here := fx.dir.subs[0]
	if here.ParentID != hrunnerCovChan || here.ActionMode != model.WatchActionAutonomous ||
		len(here.ConnectorSlugs) != 1 || here.ConnectorSlugs[0] != "cliffhub" || len(here.SkillIDs) != 0 {
		t.Fatalf("here order = %+v", here)
	}

	// "dm" — the invoker's DM with the agent, private (notify). No zone given
	// and none on their profile, so the reply says the times are UTC.
	rec = hrunnerCovDo(t, fx.toolH.CreateSchedule, "POST", `{"instruction":"dm me","schedule":"30 8 * * *","destination":"dm"}`, claims, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "→ a DM.") || !strings.Contains(rec.Body.String(), "Times are UTC") {
		t.Fatalf("create dm: %d %s", rec.Code, rec.Body)
	}
	if dm := fx.dir.subs[1]; dm.ParentID != hrunnerCovConv || dm.ActionMode != model.WatchActionNotify {
		t.Fatalf("dm order = %+v", dm)
	}

	// A channel the invoker is in, by [ch:id].
	rec = hrunnerCovDo(t, fx.toolH.CreateSchedule, "POST", `{"instruction":"c","schedule":"0 7 * * *","destination":"[ch:`+hrunnerCovChan+`]","agent":"@gg"}`, claims, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("create channel: %d %s", rec.Code, rec.Body)
	}

	// The list shows all three, channel and DM alike.
	rec = hrunnerCovDo(t, fx.toolH.ListSchedules, "GET", "", claims, nil)
	body := rec.Body.String()
	if strings.Count(body, "[sch:") != 3 || !strings.Contains(body, "gg — 09:00 on Mon-Fri Asia/Kolkata → [ch:") ||
		!strings.Contains(body, "name agents without @") || !strings.Contains(body, "→ a DM — dm me") {
		t.Fatalf("list: %s", body)
	}

	// Remove one by its [sch:] marker.
	rec = hrunnerCovDo(t, fx.toolH.DeleteSchedule, "DELETE", "", claims, map[string]string{"id": "[sch:" + here.ID + "]"})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Removed [sch:"+here.ID+"] (gg") {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	if len(fx.dir.subs) != 2 {
		t.Fatalf("delete left %d orders", len(fx.dir.subs))
	}
	rec = hrunnerCovDo(t, fx.toolH.DeleteSchedule, "DELETE", "", claims, map[string]string{"id": here.ID})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete twice: %d %s", rec.Code, rec.Body)
	}
}

func TestAgentRunTool_SchedulesRefusals(t *testing.T) {
	fx := hrunnerCovNewFix(t)
	run := fx.addRun(&model.Run{})
	claims := hrunnerCovToolClaims(run.ID)
	create := func(body string) (int, string) {
		rec := hrunnerCovDo(t, fx.toolH.CreateSchedule, "POST", body, claims, nil)
		return rec.Code, rec.Body.String()
	}
	for _, tc := range []struct {
		name, body string
		code       int
		want       string
	}{
		{"bad json", `{`, http.StatusBadRequest, "invalid body"},
		{"no schedule", `{"instruction":"x"}`, http.StatusBadRequest, "five-field cron"},
		{"bad spec", `{"instruction":"x","schedule":"every day"}`, http.StatusBadRequest, "bad_request"},
		{"not a member", `{"instruction":"x","schedule":"0 9 * * *","destination":"other-chan"}`, http.StatusForbidden, "isn't in that channel"},
		{"no such agent", `{"instruction":"x","schedule":"0 9 * * *","agent":"nobody"}`, http.StatusNotFound, "no agent @nobody"},
		// No DM resolver wired → the service refuses a parent-less order.
		{"dm unavailable", `{"instruction":"x","schedule":"0 9 * * *","destination":"dm"}`, http.StatusBadRequest, "channel is required"},
	} {
		if code, body := create(tc.body); code != tc.code || !strings.Contains(body, tc.want) {
			t.Fatalf("%s: %d %s", tc.name, code, body)
		}
	}

	// Store write failure.
	fx.dir.putSubErr = errors.New("down")
	if code, body := create(`{"instruction":"x","schedule":"0 9 * * *"}`); code != http.StatusInternalServerError || !strings.Contains(body, "could not save") {
		t.Fatalf("put failure: %d %s", code, body)
	}
	fx.dir.putSubErr = nil

	// Another agent can't be filed into THIS agent's DM with the invoker.
	dmRun := fx.addRun(&model.Run{ID: "hsched-dm-run", ParentID: hrunnerCovConv, ParentType: service.ParentConversation})
	rec := hrunnerCovDo(t, fx.toolH.CreateSchedule, "POST", `{"instruction":"x","schedule":"0 9 * * *","agent":"qib"}`, hrunnerCovToolClaims(dmRun.ID), nil)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "another agent") {
		t.Fatalf("other agent into own DM: %d %s", rec.Code, rec.Body)
	}
	// …but this agent can.
	rec = hrunnerCovDo(t, fx.toolH.CreateSchedule, "POST", `{"instruction":"x","schedule":"0 9 * * *"}`, hrunnerCovToolClaims(dmRun.ID), nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "→ a DM") {
		t.Fatalf("own DM: %d %s", rec.Code, rec.Body)
	}

	// A watcher/scheduled run may not change orders.
	watch := fx.addRun(&model.Run{ID: "hsched-watch", Mode: model.RunModeScheduled})
	wc := hrunnerCovToolClaims(watch.ID)
	if rec := hrunnerCovDo(t, fx.toolH.CreateSchedule, "POST", `{"instruction":"x","schedule":"0 9 * * *"}`, wc, nil); rec.Code != http.StatusForbidden {
		t.Fatalf("scheduled run created an order: %d", rec.Code)
	}
	if rec := hrunnerCovDo(t, fx.toolH.DeleteSchedule, "DELETE", "", wc, map[string]string{"id": "x"}); rec.Code != http.StatusForbidden {
		t.Fatalf("scheduled run deleted an order: %d", rec.Code)
	}
	// …but it may still list them.
	if rec := hrunnerCovDo(t, fx.toolH.ListSchedules, "GET", "", wc, nil); rec.Code != http.StatusOK {
		t.Fatalf("scheduled run list: %d", rec.Code)
	}

	// No live run → every tool refuses.
	gone := hrunnerCovToolClaims("hsched-no-run")
	for name, h := range map[string]http.HandlerFunc{"list": fx.toolH.ListSchedules, "create": fx.toolH.CreateSchedule, "delete": fx.toolH.DeleteSchedule} {
		if rec := hrunnerCovDo(t, h, "POST", `{}`, gone, map[string]string{"id": "x"}); rec.Code != http.StatusNotFound {
			t.Fatalf("%s without a run: %d", name, rec.Code)
		}
	}

	// Store read failures.
	fx.dir.listSubsErr = errors.New("down")
	if rec := hrunnerCovDo(t, fx.toolH.ListSchedules, "GET", "", claims, nil); rec.Code != http.StatusInternalServerError {
		t.Fatalf("list failure: %d", rec.Code)
	}
	if rec := hrunnerCovDo(t, fx.toolH.DeleteSchedule, "DELETE", "", claims, map[string]string{"id": "x"}); rec.Code != http.StatusInternalServerError {
		t.Fatalf("delete list failure: %d", rec.Code)
	}
	fx.dir.listSubsErr = nil
	fx.dir.deleteSubErr = errors.New("down")
	id := fx.dir.subs[0].ID
	if rec := hrunnerCovDo(t, fx.toolH.DeleteSchedule, "DELETE", "", claims, map[string]string{"id": id}); rec.Code != http.StatusInternalServerError {
		t.Fatalf("delete failure: %d %s", rec.Code, rec.Body)
	}
	fx.dir.deleteSubErr = nil
	fx.dir.listTemplatesErr = errors.New("down")
	if code, body := create(`{"instruction":"x","schedule":"0 9 * * *"}`); code != http.StatusInternalServerError || !strings.Contains(body, "resolve this agent") {
		t.Fatalf("slug failure: %d %s", code, body)
	}
}
