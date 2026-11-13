package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// Connect to Claude end to end through the real router: ex issues a runner
// token, posts it to the workbench, and that token then works as a runner.
func TestHRT_ConnectWorkbench(t *testing.T) {
	env := newHRTEnv()
	env.users.users["u-alice"].Email = "alice@example.com"
	session := env.session(t, "u-alice")

	// Not configured: 404, and the settings say it's off.
	rec := env.do(http.MethodPost, "/api/v1/runner-tokens/workbench", session, "")
	hrtWant(t, rec, http.StatusNotFound)
	if code := hrtErrCode(t, rec); code != "workbench_off" {
		t.Fatalf("code = %q", code)
	}

	var got map[string]string
	status := http.StatusOK
	wb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(status)
	}))
	defer wb.Close()
	env.h.svc.UseWorkbenchURL(wb.URL, "https://ex.example.com")

	// The workbench refusing: 424, and the install is kept to look into.
	status = http.StatusBadGateway
	rec = env.do(http.MethodPost, "/api/v1/runner-tokens/workbench", session, "")
	hrtWant(t, rec, http.StatusFailedDependency)
	if code := hrtErrCode(t, rec); code != "workbench_failed" {
		t.Fatalf("code = %q", code)
	}
	kept := env.list(t)
	if len(kept) != 1 {
		t.Fatalf("installs after a failed onboarding = %v", kept)
	}
	for id := range kept {
		hrtWant(t, env.do(http.MethodDelete, "/api/v1/runner-tokens/"+id, session, ""), http.StatusNoContent)
	}

	status = http.StatusOK
	rec = env.do(http.MethodPost, "/api/v1/runner-tokens/workbench", session, "")
	hrtWant(t, rec, http.StatusNoContent)
	if rec.Body.Len() != 0 {
		t.Fatalf("the token came back to the browser: %s", rec.Body.String())
	}
	if got["username"] != "alice@example.com" || got["server"] != "https://ex.example.com" || got["runner_token"] == "" {
		t.Fatalf("onboard body = %v", got)
	}

	// The handed-over token is a working runner token.
	hrtWant(t, env.do(http.MethodPost, "/api/v1/agent/runner/renew", got["runner_token"], ""), http.StatusOK)

	// The Runners list marks it as the workbench install.
	rec = env.do(http.MethodGet, "/api/v1/runner-tokens", session, "")
	hrtWant(t, rec, http.StatusOK)
	var listed struct {
		Runners []struct {
			Label     string `json:"label"`
			Workbench bool   `json:"workbench"`
		} `json:"runners"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Runners) != 1 || !listed.Runners[0].Workbench || listed.Runners[0].Label != "Agent workbench" {
		t.Fatalf("listed = %+v", listed.Runners)
	}

	// Already connected: 409.
	rec = env.do(http.MethodPost, "/api/v1/runner-tokens/workbench", session, "")
	hrtWant(t, rec, http.StatusConflict)
	if code := hrtErrCode(t, rec); code != "workbench_connected" {
		t.Fatalf("code = %q", code)
	}
}

func TestSettingsCarryWorkbenchEnabled(t *testing.T) {
	h := &AdminHandler{}
	if h.newSettingsResponse(&model.WorkspaceSettings{}).WorkbenchEnabled {
		t.Fatal("workbench on by default")
	}
	h.SetWorkbenchEnabled(true)
	if !h.newSettingsResponse(&model.WorkspaceSettings{}).WorkbenchEnabled {
		t.Fatal("workbench not reported")
	}
}
