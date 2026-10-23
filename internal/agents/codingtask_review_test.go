package agents

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// A project's repo list is what every later task defaults to — and so what
// gets cloned onto the requester's machine. Changing it needs the project's
// creator or an admin on the Projects page, but create_coding_task merged any
// task-supplied repo into the shared project for whoever's run asked. Now a
// task's extra repos stay on that task unless its requester could manage the
// project; the same goes for the default branch a report "learns".
func TestCodingTaskService_TaskReposStayLocalUnlessRequesterManagesProject(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	if err := fx.tasks.CreateProject(ctx, &model.CodingProject{
		Key: "booking-portal", Name: "Booking Portal", CreatedBy: "u-alice",
		Repos: []model.ProjectRepo{{Path: "dt/booking-portal-api", Role: model.RepoRoleBackend, DefaultBranch: "main"}},
	}); err != nil {
		t.Fatal(err)
	}
	bobRun := fx.intakeRunAs(t, testDevID, "ask-bob", "u-bob")
	res, err := fx.svc.Create(ctx, bobRun, CreateTaskInput{Project: "Booking Portal", Title: "T", Goal: "g", Repos: []RepoInput{
		{Path: "dt/booking-portal-api", Role: "backend"},
		{Path: "evil/implant", Role: "frontend"},
	}})
	if err != nil {
		t.Fatalf("bob's task: %v", err)
	}
	if len(res.Task.Repos) != 2 {
		t.Fatalf("bob's task keeps the repos it named: %+v", res.Task.Repos)
	}
	p, _ := fx.tasks.GetProject(ctx, "booking-portal")
	if len(p.Repos) != 1 || p.Repos[0].Path != "dt/booking-portal-api" {
		t.Fatalf("a non-manager's task rewrote the shared project's repos: %+v", p.Repos)
	}

	// Bob's task run reporting a base branch must not retarget everyone's.
	bobTaskRun := &model.Run{ID: "r-bob-task", TaskID: res.Task.ID, InvokerID: "u-bob", Mode: model.RunModeTask}
	if _, err := fx.svc.Report(ctx, bobTaskRun, TaskUpdate{Repos: []RepoUpdate{{Path: "dt/booking-portal-api", BaseBranch: "attacker-base"}}}); err != nil {
		t.Fatalf("report: %v", err)
	}
	if p, _ := fx.tasks.GetProject(ctx, "booking-portal"); p.Repos[0].DefaultBranch != "main" {
		t.Fatalf("a non-manager's report changed the project's default branch: %+v", p.Repos[0])
	}

	// The creator's own task still teaches the project a new repo.
	aliceRun := fx.intakeRun(t, testDevID, "ask-alice")
	if _, err := fx.svc.Create(ctx, aliceRun, CreateTaskInput{Project: "Booking Portal", Title: "T2", Goal: "g", Repos: []RepoInput{
		{Path: "dt/booking-portal-frontend", Role: "frontend"},
	}}); err != nil {
		t.Fatalf("alice's task: %v", err)
	}
	if p, _ := fx.tasks.GetProject(ctx, "booking-portal"); len(p.Repos) != 2 {
		t.Fatalf("the project's creator must still extend it: %+v", p.Repos)
	}
}

// The task card renders the ticket URL and every MR URL as links. Both arrive
// from the agent, so a "javascript:" (or any non-web) URL was stored and
// rendered as-is. Only absolute http(s) URLs are accepted.
func TestCodingTaskService_TicketAndMRURLsMustBeHTTP(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	intake := fx.intakeRun(t, testDevID, "ask1")
	in := CreateTaskInput{
		Project: "Booking Portal", Repos: bookingRepos, Title: "Fix it", Goal: "g",
		Ticket: &model.TaskTicket{Connector: "jira", ID: "CS-7", URL: "javascript:alert(document.cookie)"},
	}
	if _, err := fx.svc.Create(ctx, intake, in); !errors.Is(err, service.ErrValidation) {
		t.Fatalf("javascript: ticket URL must be refused, got %v", err)
	}
	in.Ticket.URL = "https://jira.example.com/browse/CS-7"
	res, err := fx.svc.Create(ctx, intake, in)
	if err != nil {
		t.Fatalf("https ticket URL: %v", err)
	}

	run := fx.runsByMode(model.RunModeTask)[0]
	bad := TaskUpdate{Repos: []RepoUpdate{{Path: "dt/booking-portal-api", MRURL: "javascript:alert(1)"}}}
	if _, err := fx.svc.Report(ctx, run, bad); !errors.Is(err, service.ErrValidation) {
		t.Fatalf("javascript: MR URL must be refused, got %v", err)
	}
	got, _ := fx.tasks.GetTask(ctx, res.Task.ID)
	if r := got.Repo("dt/booking-portal-api"); r.MRURL != "" {
		t.Fatalf("refused MR URL was stored: %q", r.MRURL)
	}
	good := TaskUpdate{Repos: []RepoUpdate{{Path: "dt/booking-portal-api", MRURL: "https://gitlab.example.com/dt/api/-/merge_requests/1"}}}
	if _, err := fx.svc.Report(ctx, run, good); err != nil {
		t.Fatalf("https MR URL: %v", err)
	}
}
