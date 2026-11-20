package agents

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

type fakeWorkbench struct {
	calls  []string // "username|token"
	jobID  string
	err    error
	job    *WorkbenchJob
	jobErr error
	asked  []string
}

func (f *fakeWorkbench) Onboard(_ context.Context, username, token string) (string, error) {
	f.calls = append(f.calls, username+"|"+token)
	return f.jobID, f.err
}

func (f *fakeWorkbench) Job(_ context.Context, id string) (*WorkbenchJob, error) {
	f.asked = append(f.asked, id)
	return f.job, f.jobErr
}

func newWorkbenchEnv() (*rtEnv, *fakeWorkbench) {
	env := newRTEnv()
	env.users.users["u-alice"].Email = "alice@example.com"
	wb := &fakeWorkbench{jobID: "job-1"}
	env.svc.SetWorkbench(wb)
	return env, wb
}

func TestWorkbench_ConnectIssuesTokenOnboardsAndKeepsTheJob(t *testing.T) {
	ctx := context.Background()
	env, wb := newWorkbenchEnv()
	if !env.svc.WorkbenchEnabled() {
		t.Fatal("workbench should be on")
	}
	job, err := env.svc.ConnectWorkbench(ctx, "u-alice")
	if err != nil {
		t.Fatalf("ConnectWorkbench: %v", err)
	}
	if job.ID != "job-1" || job.State != "queued" {
		t.Fatalf("job = %+v", job)
	}
	rec := env.store.tokens["rt-1"]
	if rec == nil || !rec.Workbench || rec.WorkbenchJob != "job-1" || rec.Label != WorkbenchLabel || rec.UserID != "u-alice" {
		t.Fatalf("stored token = %+v", rec)
	}
	want := "alice@example.com|jwt:u-alice:rt-1:" + rec.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z07:00")
	if len(wb.calls) != 1 || wb.calls[0] != want {
		t.Fatalf("onboard calls = %v, want [%s]", wb.calls, want)
	}

	// Already connected: refused, nothing new issued or sent.
	if _, err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, ErrWorkbenchConnected) {
		t.Fatalf("second connect: want ErrWorkbenchConnected, got %v", err)
	}
	if len(env.store.tokens) != 1 || len(wb.calls) != 1 {
		t.Fatalf("second connect issued or sent: tokens=%d calls=%d", len(env.store.tokens), len(wb.calls))
	}
}

func TestWorkbench_PairedComputerDoesNotCount(t *testing.T) {
	env, wb := newWorkbenchEnv()
	code, verifier := env.grant(t, "laptop")
	if _, err := env.svc.Exchange(context.Background(), code, verifier); err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if _, err := env.svc.ConnectWorkbench(context.Background(), "u-alice"); err != nil {
		t.Fatalf("ConnectWorkbench beside a paired laptop: %v", err)
	}
	if len(wb.calls) != 1 {
		t.Fatalf("onboard calls = %d", len(wb.calls))
	}
}

func TestWorkbench_FailedOnboardingKeepsTheToken(t *testing.T) {
	ctx := context.Background()
	env, wb := newWorkbenchEnv()
	wb.jobID, wb.err = "", errRTFake
	if _, err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, ErrWorkbenchFailed) {
		t.Fatalf("want ErrWorkbenchFailed, got %v", err)
	}
	if rec := env.store.tokens["rt-1"]; rec == nil || !rec.Workbench || rec.WorkbenchJob != "" {
		t.Fatalf("token not kept: %v", env.store.tokens)
	}
	// It reads as a failed setup, without asking the workbench.
	job, err := env.svc.WorkbenchStatus(ctx, "u-alice")
	if err != nil || job.State != WorkbenchJobFailed || len(wb.asked) != 0 {
		t.Fatalf("status = %+v, %v (asked %v)", job, err, wb.asked)
	}
	// Kept, so it counts as connected until disconnected.
	if _, err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, ErrWorkbenchConnected) {
		t.Fatalf("retry: want ErrWorkbenchConnected, got %v", err)
	}
	if err := env.svc.Revoke(ctx, "u-alice", "rt-1"); err != nil {
		t.Fatal(err)
	}
	wb.jobID, wb.err = "job-2", nil
	if _, err := env.svc.ConnectWorkbench(ctx, "u-alice"); err != nil {
		t.Fatalf("after disconnecting: %v", err)
	}
}

func TestWorkbench_ConnectRefusals(t *testing.T) {
	ctx := context.Background()

	off := newRTEnv()
	if off.svc.WorkbenchEnabled() {
		t.Fatal("workbench should be off by default")
	}
	if _, err := off.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, ErrWorkbenchOff) {
		t.Fatalf("off: want ErrWorkbenchOff, got %v", err)
	}

	env, wb := newWorkbenchEnv()
	if _, err := env.svc.ConnectWorkbench(ctx, "u-ghost"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown user: want ErrNotFound, got %v", err)
	}
	for _, uid := range []string{"a-gg", "u-gone"} {
		if _, err := env.svc.ConnectWorkbench(ctx, uid); !errors.Is(err, service.ErrForbidden) {
			t.Fatalf("%s: want ErrForbidden, got %v", uid, err)
		}
	}
	env.store.fail["ListRunnerTokens"] = errRTFake
	if _, err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, errRTFake) {
		t.Fatalf("list failure: want errRTFake, got %v", err)
	}
	delete(env.store.fail, "ListRunnerTokens")
	env.minter.err = errRTFake
	if _, err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, errRTFake) {
		t.Fatalf("mint failure: want errRTFake, got %v", err)
	}
	if len(wb.calls) != 0 {
		t.Fatalf("refusals reached the workbench: %v", wb.calls)
	}
	env.minter.err = nil
	env.store.fail["PutRunnerToken"] = errRTFake
	if _, err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, errRTFake) {
		t.Fatalf("store failure: want errRTFake, got %v", err)
	}
}

func TestWorkbench_Status(t *testing.T) {
	ctx := context.Background()

	off := newRTEnv()
	if _, err := off.svc.WorkbenchStatus(ctx, "u-alice"); !errors.Is(err, ErrWorkbenchOff) {
		t.Fatalf("off: want ErrWorkbenchOff, got %v", err)
	}

	env, wb := newWorkbenchEnv()
	if _, err := env.svc.WorkbenchStatus(ctx, "u-alice"); !errors.Is(err, ErrWorkbenchNotConnected) {
		t.Fatalf("not connected: want ErrWorkbenchNotConnected, got %v", err)
	}
	env.store.fail["ListRunnerTokens"] = errRTFake
	if _, err := env.svc.WorkbenchStatus(ctx, "u-alice"); !errors.Is(err, errRTFake) {
		t.Fatalf("list failure: want errRTFake, got %v", err)
	}
	delete(env.store.fail, "ListRunnerTokens")

	if _, err := env.svc.ConnectWorkbench(ctx, "u-alice"); err != nil {
		t.Fatal(err)
	}
	wb.job = &WorkbenchJob{ID: "job-1", State: "running"}
	job, err := env.svc.WorkbenchStatus(ctx, "u-alice")
	if err != nil || job.State != "running" || len(wb.asked) != 1 || wb.asked[0] != "job-1" {
		t.Fatalf("status = %+v, %v (asked %v)", job, err, wb.asked)
	}
	wb.jobErr = errRTFake
	if _, err := env.svc.WorkbenchStatus(ctx, "u-alice"); !errors.Is(err, ErrWorkbenchUnreachable) {
		t.Fatalf("workbench down: want ErrWorkbenchUnreachable, got %v", err)
	}
}

func TestWorkbench_UseWorkbenchURL(t *testing.T) {
	env := newRTEnv()
	env.svc.UseWorkbenchURL("", "secret", "https://ex.example.com")
	if env.svc.WorkbenchEnabled() {
		t.Fatal("empty URL turned the workbench on")
	}
	env.svc.UseWorkbenchURL("https://wb.example.com/", "secret", "https://ex.example.com")
	c, ok := env.svc.workbench.(*WorkbenchClient)
	if !ok || c.url != "https://wb.example.com" || c.token != "secret" || c.server != "https://ex.example.com" {
		t.Fatalf("workbench = %#v", env.svc.workbench)
	}
}

// fakeWorkbenchServer records the last request and answers with status and
// body.
type fakeWorkbenchServer struct {
	srv          *httptest.Server
	method, path string
	auth, ctype  string
	got          map[string]string
	status       int
	body         string
}

func newFakeWorkbenchServer(t *testing.T) *fakeWorkbenchServer {
	f := &fakeWorkbenchServer{status: http.StatusOK}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.method, f.path = r.Method, r.URL.EscapedPath()
		f.auth, f.ctype = r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		f.got = nil
		_ = json.NewDecoder(r.Body).Decode(&f.got)
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(f.body))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func TestWorkbenchClient_Onboard(t *testing.T) {
	ctx := context.Background()
	f := newFakeWorkbenchServer(t)
	c := NewWorkbenchClient(f.srv.URL+"/", "secret", "https://ex.example.com")

	f.body = `{"id":"job-9","state":"queued","username":"alice","created_at":"now"}`
	id, err := c.Onboard(ctx, "alice@example.com", "tok")
	if err != nil || id != "job-9" {
		t.Fatalf("Onboard = %q, %v", id, err)
	}
	if f.method != http.MethodPost || f.path != "/onboard" || f.ctype != "application/json" || f.auth != "Bearer secret" {
		t.Fatalf("request = %s %s ctype=%q auth=%q", f.method, f.path, f.ctype, f.auth)
	}
	if len(f.got) != 3 || f.got["username"] != "alice@example.com" || f.got["runner_token"] != "tok" || f.got["server"] != "https://ex.example.com" {
		t.Fatalf("body = %v", f.got)
	}

	f.body = `{"state":"queued"}`
	if _, err := c.Onboard(ctx, "a", "b"); err == nil || !strings.Contains(err.Error(), "without a job id") {
		t.Fatalf("no id: got %v", err)
	}
	f.body = `not json`
	if _, err := c.Onboard(ctx, "a", "b"); err == nil || !strings.Contains(err.Error(), "workbench answer") {
		t.Fatalf("bad JSON: got %v", err)
	}
	f.status, f.body = http.StatusUnauthorized, " bad token \n"
	if _, err := c.Onboard(ctx, "a", "b"); err == nil || !strings.Contains(err.Error(), "401: bad token") {
		t.Fatalf("non-2xx: got %v", err)
	}

	// No API token configured: no Authorization header.
	f.status, f.body = http.StatusOK, `{"id":"job-10"}`
	if _, err := NewWorkbenchClient(f.srv.URL, "", "x").Onboard(ctx, "a", "b"); err != nil || f.auth != "" {
		t.Fatalf("tokenless: err=%v auth=%q", err, f.auth)
	}

	f.srv.Close()
	if _, err := c.Onboard(ctx, "a", "b"); err == nil {
		t.Fatal("unreachable workbench: want an error")
	}
	if _, err := NewWorkbenchClient("http://bad host", "", "x").Onboard(ctx, "a", "b"); err == nil {
		t.Fatal("bad URL: want an error")
	}
}

func TestWorkbenchClient_Job(t *testing.T) {
	ctx := context.Background()
	f := newFakeWorkbenchServer(t)
	c := NewWorkbenchClient(f.srv.URL, "secret", "x")

	f.body = `{"id":"job/9","state":"failed","username":"alice","created_at":"c","started_at":"s","finished_at":"f","status":"no such person","result":{"code":2}}`
	job, err := c.Job(ctx, "job/9")
	if err != nil {
		t.Fatalf("Job: %v", err)
	}
	if f.method != http.MethodGet || f.path != "/onboard/job%2F9" || f.auth != "Bearer secret" || f.ctype != "" {
		t.Fatalf("request = %s %s auth=%q ctype=%q", f.method, f.path, f.auth, f.ctype)
	}
	if job.State != "failed" || job.Username != "alice" || job.StartedAt != "s" || string(job.Status) != `"no such person"` || string(job.Result) != `{"code":2}` {
		t.Fatalf("job = %+v", job)
	}
	f.status = http.StatusNotFound
	if _, err := c.Job(ctx, "nope"); err == nil {
		t.Fatal("non-2xx: want an error")
	}
}
