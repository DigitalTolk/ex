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

type fakeOnboarder struct {
	calls []string // "username|token"
	err   error
}

func (f *fakeOnboarder) Onboard(_ context.Context, username, token string) error {
	f.calls = append(f.calls, username+"|"+token)
	return f.err
}

func newWorkbenchEnv() (*rtEnv, *fakeOnboarder) {
	env := newRTEnv()
	env.users.users["u-alice"].Email = "alice@example.com"
	wb := &fakeOnboarder{}
	env.svc.SetWorkbench(wb)
	return env, wb
}

func TestWorkbench_ConnectIssuesTokenAndOnboards(t *testing.T) {
	ctx := context.Background()
	env, wb := newWorkbenchEnv()
	if !env.svc.WorkbenchEnabled() {
		t.Fatal("workbench should be on")
	}
	if err := env.svc.ConnectWorkbench(ctx, "u-alice"); err != nil {
		t.Fatalf("ConnectWorkbench: %v", err)
	}
	rec := env.store.tokens["rt-1"]
	if rec == nil || !rec.Workbench || rec.Label != WorkbenchLabel || rec.UserID != "u-alice" {
		t.Fatalf("stored token = %+v", rec)
	}
	want := "alice@example.com|jwt:u-alice:rt-1:" + rec.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z07:00")
	if len(wb.calls) != 1 || wb.calls[0] != want {
		t.Fatalf("onboard calls = %v, want [%s]", wb.calls, want)
	}

	// Already connected: refused, nothing new issued or sent.
	if err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, ErrWorkbenchConnected) {
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
	if err := env.svc.ConnectWorkbench(context.Background(), "u-alice"); err != nil {
		t.Fatalf("ConnectWorkbench beside a paired laptop: %v", err)
	}
	if len(wb.calls) != 1 {
		t.Fatalf("onboard calls = %d", len(wb.calls))
	}
}

func TestWorkbench_FailedOnboardingKeepsTheToken(t *testing.T) {
	ctx := context.Background()
	env, wb := newWorkbenchEnv()
	wb.err = errRTFake
	if err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, ErrWorkbenchFailed) {
		t.Fatalf("want ErrWorkbenchFailed, got %v", err)
	}
	if rec := env.store.tokens["rt-1"]; rec == nil || !rec.Workbench {
		t.Fatalf("token not kept: %v", env.store.tokens)
	}
	// Kept, so it counts as connected until disconnected.
	if err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, ErrWorkbenchConnected) {
		t.Fatalf("retry: want ErrWorkbenchConnected, got %v", err)
	}
	if err := env.svc.Revoke(ctx, "u-alice", "rt-1"); err != nil {
		t.Fatal(err)
	}
	wb.err = nil
	if err := env.svc.ConnectWorkbench(ctx, "u-alice"); err != nil {
		t.Fatalf("after disconnecting: %v", err)
	}
}

func TestWorkbench_Refusals(t *testing.T) {
	ctx := context.Background()

	off := newRTEnv()
	if off.svc.WorkbenchEnabled() {
		t.Fatal("workbench should be off by default")
	}
	if err := off.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, ErrWorkbenchOff) {
		t.Fatalf("off: want ErrWorkbenchOff, got %v", err)
	}

	env, wb := newWorkbenchEnv()
	if err := env.svc.ConnectWorkbench(ctx, "u-ghost"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown user: want ErrNotFound, got %v", err)
	}
	for _, uid := range []string{"a-gg", "u-gone"} {
		if err := env.svc.ConnectWorkbench(ctx, uid); !errors.Is(err, service.ErrForbidden) {
			t.Fatalf("%s: want ErrForbidden, got %v", uid, err)
		}
	}
	env.store.fail["ListRunnerTokens"] = errRTFake
	if err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, errRTFake) {
		t.Fatalf("list failure: want errRTFake, got %v", err)
	}
	delete(env.store.fail, "ListRunnerTokens")
	env.minter.err = errRTFake
	if err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, errRTFake) {
		t.Fatalf("mint failure: want errRTFake, got %v", err)
	}
	env.minter.err = nil
	env.store.fail["PutRunnerToken"] = errRTFake
	if err := env.svc.ConnectWorkbench(ctx, "u-alice"); !errors.Is(err, errRTFake) {
		t.Fatalf("store failure: want errRTFake, got %v", err)
	}
	if len(wb.calls) != 0 {
		t.Fatalf("refusals reached the workbench: %v", wb.calls)
	}
}

func TestWorkbench_UseWorkbenchURL(t *testing.T) {
	env := newRTEnv()
	env.svc.UseWorkbenchURL("", "https://ex.example.com")
	if env.svc.WorkbenchEnabled() {
		t.Fatal("empty URL turned the workbench on")
	}
	env.svc.UseWorkbenchURL("https://wb.example.com/", "https://ex.example.com")
	c, ok := env.svc.workbench.(*WorkbenchClient)
	if !ok || c.url != "https://wb.example.com" || c.server != "https://ex.example.com" {
		t.Fatalf("workbench = %#v", env.svc.workbench)
	}
}

func TestWorkbenchClient_Onboard(t *testing.T) {
	var got map[string]string
	var path, ctype string
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, ctype = r.URL.Path, r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(" no such person \n"))
	}))
	defer srv.Close()
	ctx := context.Background()

	c := NewWorkbenchClient(srv.URL+"/", "https://ex.example.com")
	if err := c.Onboard(ctx, "alice@example.com", "tok"); err != nil {
		t.Fatalf("Onboard: %v", err)
	}
	if path != "/onboard" || ctype != "application/json" {
		t.Fatalf("path=%q content-type=%q", path, ctype)
	}
	want := map[string]string{"username": "alice@example.com", "runner_token": "tok", "server": "https://ex.example.com"}
	if len(got) != len(want) || got["username"] != want["username"] || got["runner_token"] != want["runner_token"] || got["server"] != want["server"] {
		t.Fatalf("body = %v", got)
	}

	status = http.StatusNotFound
	err := c.Onboard(ctx, "alice@example.com", "tok")
	if err == nil || !strings.Contains(err.Error(), "404: no such person") {
		t.Fatalf("non-2xx: got %v", err)
	}

	srv.Close()
	if err := c.Onboard(ctx, "alice@example.com", "tok"); err == nil {
		t.Fatal("unreachable workbench: want an error")
	}
	if err := NewWorkbenchClient("http://bad host", "x").Onboard(ctx, "a", "b"); err == nil {
		t.Fatal("bad URL: want an error")
	}
}
