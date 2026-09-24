package service

import (
	"context"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// Skill picks share the connector /token grammar: "/weekly-report …" attaches
// the "Weekly Report" skill's full instructions to the run, in channels and
// DMs alike, and the token is stripped from the prompt like a connector pick.

func seedSkill(fx *orchFixture, id, name, instructions string) {
	fx.dir.mu.Lock()
	defer fx.dir.mu.Unlock()
	if fx.dir.skills == nil {
		fx.dir.skills = map[string]*model.Skill{}
	}
	fx.dir.skills[id] = &model.Skill{ID: id, Name: name, Description: "desc of " + name, Instructions: instructions}
}

func TestSkillToken(t *testing.T) {
	for _, tc := range []struct{ name, want string }{
		{"Weekly Report", "weekly-report"},
		{"  Weekly   Report  ", "weekly-report"},
		{"TL;DR!", "tl-dr"},
		{"release-notes", "release-notes"},
		{"Ünïcode Ok", "n-code-ok"},
		{"---", ""},
		{"", ""},
	} {
		if got := skillToken(tc.name); got != tc.want {
			t.Fatalf("skillToken(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestMergeSkillIDs(t *testing.T) {
	if got := mergeSkillIDs([]string{"a", "b"}, nil); len(got) != 2 || got[0] != "a" {
		t.Fatalf("no picks must return attached as-is: %v", got)
	}
	got := mergeSkillIDs([]string{"a", "", "b"}, []string{"b", "c", "c", ""})
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Fatalf("merge = %v, want [a b c]", got)
	}
}

func TestOrchestrator_SkillPickExplicit(t *testing.T) {
	fx := newOrchFixture(t)
	seedSkill(fx, "sk-w", "Weekly Report", "Gather the week's threads and summarize by team.")

	run := startPickRun(t, fx, &model.Message{
		ID: "m-s1", ParentID: "chan1", AuthorID: "u-alice",
		Body: "/weekly-report do the usual, and /notaskill stays text",
	})
	if !containsStr(run.SkillIDs, "sk-w") {
		t.Fatalf("picked skill not on run: %v", run.SkillIDs)
	}
	if strings.Contains(run.Prompt, "/weekly-report") {
		t.Fatalf("picked token not stripped: %q", run.Prompt)
	}
	if !strings.Contains(run.Prompt, "/notaskill") {
		t.Fatalf("unknown token must stay as typed: %q", run.Prompt)
	}

	// The bundle carries the picked skill's FULL instructions in the attached
	// section, and drops it from the ambient index (no double listing).
	bundle, _ := fx.orch.buildBundle(context.Background(), run)
	if !strings.Contains(bundle, "Gather the week's threads") {
		t.Fatalf("picked skill instructions missing from bundle")
	}
	if strings.Contains(bundle, "[sk:sk-w]") {
		t.Fatalf("picked skill must leave the ambient index: %s", bundle)
	}
}

func TestOrchestrator_SkillPickInDM(t *testing.T) {
	fx := newOrchFixture(t)
	seedSkill(fx, "sk-w", "Weekly Report", "Gather the week's threads.")

	agent, _ := fx.users.GetUser(context.Background(), testGGID)
	invoker, _ := fx.users.GetUser(context.Background(), "u-alice")
	resolved, err := fx.orch.agentSvc.Resolve(context.Background(), agent, invoker.ID)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	run, err := fx.orch.startRun(context.Background(), invocation{
		agent: agent, invoker: invoker, parentType: ParentConversation,
		msg: &model.Message{ID: "m-dm1", ParentID: "conv1", AuthorID: "u-alice", Body: "/weekly-report please"},
	}, resolved)
	if err != nil {
		t.Fatalf("start DM run: %v", err)
	}
	if !containsStr(run.SkillIDs, "sk-w") {
		t.Fatalf("DM pick not attached: %v", run.SkillIDs)
	}
	if strings.Contains(run.Prompt, "/weekly-report") {
		t.Fatalf("DM pick not stripped: %q", run.Prompt)
	}
}

func TestOrchestrator_SkillPickThreadStickiness(t *testing.T) {
	fx := newOrchFixture(t)
	seedSkill(fx, "sk-w", "Weekly Report", "Gather the week's threads.")
	fx.msgs.thread = []*model.Message{
		{ID: "root", ParentID: "chan1", AuthorID: "u-alice", Body: "/weekly-report kick it off"},
		{ID: "r1", ParentID: "chan1", ParentMessageID: "root", AuthorID: testGGID, Body: "done"},
	}

	run := startPickRun(t, fx, &model.Message{
		ID: "m-s2", ParentID: "chan1", ParentMessageID: "root", AuthorID: "u-alice",
		Body: "same again for last week please",
	})
	if !containsStr(run.SkillIDs, "sk-w") {
		t.Fatalf("follow-up must inherit the thread's skill pick: %v", run.SkillIDs)
	}
}

func TestOrchestrator_RunSkillBadges(t *testing.T) {
	fx := newOrchFixture(t)
	seedSkill(fx, "sk-w", "Weekly Report", "i")
	seedSkill(fx, "sk-a", "Audit", "i")
	ctx := context.Background()

	if got := fx.orch.RunSkillBadges(ctx, ""); got != nil {
		t.Fatalf("empty run id: %v", got)
	}

	run := startPickRun(t, fx, &model.Message{
		ID: "m-b1", ParentID: "chan1", AuthorID: "u-alice", Body: "/weekly-report go",
	})
	if len(run.PickedSkillIDs) != 1 || run.PickedSkillIDs[0] != "sk-w" {
		t.Fatalf("picked ids: %v", run.PickedSkillIDs)
	}

	// Picked only → the picked skill's name.
	if got := fx.orch.RunSkillBadges(ctx, run.ID); len(got) != 1 || got[0] != "Weekly Report" {
		t.Fatalf("picked badge: %v", got)
	}

	// invoke_skill adds a badge; repeats and picked∩invoked collapse to one.
	skA, _ := fx.orch.agentSvc.GetSkill(ctx, "sk-a")
	skW, _ := fx.orch.agentSvc.GetSkill(ctx, "sk-w")
	fx.orch.RecordSkillInvoked(ctx, run, skA)
	fx.orch.RecordSkillInvoked(ctx, run, skA)
	fx.orch.RecordSkillInvoked(ctx, run, skW)
	got := fx.orch.RunSkillBadges(ctx, run.ID)
	if len(got) != 2 || !containsStr(got, "Audit") || !containsStr(got, "Weekly Report") {
		t.Fatalf("invoked+picked badges: %v", got)
	}

	// A run the store can't load still reports its invoked names.
	ghost := &model.Run{ID: "ghost-run", AgentID: testGGID, InvokerID: "u-alice", ParentID: "chan1"}
	fx.orch.RecordSkillInvoked(ctx, ghost, skA)
	if got := fx.orch.RunSkillBadges(ctx, "ghost-run"); len(got) != 1 || got[0] != "Audit" {
		t.Fatalf("ghost run badges: %v", got)
	}

	// The badge row is capped.
	many := &model.Run{ID: "many-run", AgentID: testGGID, InvokerID: "u-alice", ParentID: "chan1"}
	for i := 0; i < runSkillBadgeCap+2; i++ {
		id := "sk-cap-" + string(rune('a'+i))
		seedSkill(fx, id, "Cap "+string(rune('A'+i)), "i")
		sk, _ := fx.orch.agentSvc.GetSkill(ctx, id)
		fx.orch.RecordSkillInvoked(ctx, many, sk)
	}
	if got := fx.orch.RunSkillBadges(ctx, "many-run"); len(got) != runSkillBadgeCap {
		t.Fatalf("cap: %d badges %v", len(got), got)
	}

	// A picked skill that was deleted since is skipped, never fails the post.
	run2 := startPickRun(t, fx, &model.Message{
		ID: "m-b2", ParentID: "chan2", AuthorID: "u-alice", Body: "/audit go",
	})
	fx.dir.mu.Lock()
	delete(fx.dir.skills, "sk-a")
	fx.dir.mu.Unlock()
	if got := fx.orch.RunSkillBadges(ctx, run2.ID); len(got) != 0 {
		t.Fatalf("deleted picked skill must not badge: %v", got)
	}
}

func containsStr(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
