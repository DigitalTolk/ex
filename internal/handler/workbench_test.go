package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// Connect to Claude end to end through the real router: ex issues a runner
// token, posts it to the workbench with the API token, keeps the job, and
// reports its progress; the handed-over token then works as a runner.
func TestHRT_ConnectWorkbench(t *testing.T) {
	env := newHRTEnv()
	env.users.users["u-alice"].Email = "alice@example.com"
	session := env.session(t, "u-alice")
	post := func() *httptest.ResponseRecorder {
		return env.do(http.MethodPost, "/api/v1/runner-tokens/workbench", session, "")
	}
	status := func() *httptest.ResponseRecorder {
		return env.do(http.MethodGet, "/api/v1/runner-tokens/workbench", session, "")
	}
	wantCode := func(rec *httptest.ResponseRecorder, code int, errCode string) {
		t.Helper()
		hrtWant(t, rec, code)
		if got := hrtErrCode(t, rec); got != errCode {
			t.Fatalf("error code = %q, want %q", got, errCode)
		}
	}

	// Not configured.
	wantCode(post(), http.StatusNotFound, "workbench_off")
	wantCode(status(), http.StatusNotFound, "workbench_off")

	var got map[string]string
	var auth string
	answer, answerStatus := `{"id":"job-1","state":"queued"}`, http.StatusOK
	wb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		if r.Method == http.MethodPost {
			_ = json.NewDecoder(r.Body).Decode(&got)
		}
		w.WriteHeader(answerStatus)
		_, _ = w.Write([]byte(answer))
	}))
	defer wb.Close()
	env.h.svc.UseWorkbenchURL(wb.URL, "wb-secret", "https://ex.example.com")

	wantCode(status(), http.StatusNotFound, "workbench_not_connected")

	// The workbench refusing: 424, the install is kept and reads as failed.
	answerStatus = http.StatusBadGateway
	wantCode(post(), http.StatusFailedDependency, "workbench_failed")
	rec := status()
	hrtWant(t, rec, http.StatusOK)
	if body := hrtDecode(t, rec); body["state"] != "failed" {
		t.Fatalf("status after a refused onboarding = %v", body)
	}
	kept := env.list(t)
	if len(kept) != 1 {
		t.Fatalf("installs after a failed onboarding = %v", kept)
	}
	for id := range kept {
		hrtWant(t, env.do(http.MethodDelete, "/api/v1/runner-tokens/"+id, session, ""), http.StatusNoContent)
	}

	answerStatus = http.StatusOK
	rec = post()
	hrtWant(t, rec, http.StatusAccepted)
	if body := hrtDecode(t, rec); body["id"] != "job-1" || body["state"] != "queued" || body["token"] != nil || body["runner_token"] != nil {
		t.Fatalf("connect answer = %v", body)
	}
	if auth != "Bearer wb-secret" || got["username"] != "alice@example.com" || got["server"] != "https://ex.example.com" || got["runner_token"] == "" {
		t.Fatalf("onboard auth=%q body=%v", auth, got)
	}

	// The handed-over token is a working runner token.
	hrtWant(t, env.do(http.MethodPost, "/api/v1/agent/runner/renew", got["runner_token"], ""), http.StatusOK)

	// Progress comes from the workbench, status and result passed through.
	answer = `{"id":"job-1","state":"done","username":"alice","created_at":"c","started_at":"s","finished_at":"f","status":"ok","result":{"user":"alice"}}`
	rec = status()
	hrtWant(t, rec, http.StatusOK)
	body := hrtDecode(t, rec)
	if body["state"] != "done" || body["startedAt"] != "s" || body["finishedAt"] != "f" || body["status"] != "ok" {
		t.Fatalf("status = %v", body)
	}
	if res, _ := body["result"].(map[string]any); res["user"] != "alice" {
		t.Fatalf("result = %v", body["result"])
	}
	answerStatus = http.StatusInternalServerError
	wantCode(status(), http.StatusFailedDependency, "workbench_unreachable")

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

	wantCode(post(), http.StatusConflict, "workbench_connected")
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
