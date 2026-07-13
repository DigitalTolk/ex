package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// testCommand is a programmable service.Command for handler tests.
type testCommand struct {
	name string
	msg  *model.Message
	err  error
	got  *service.CommandRequest
}

func (c *testCommand) Info() service.CommandInfo {
	return service.CommandInfo{Name: c.name, Description: "test command"}
}

func (c *testCommand) Run(_ context.Context, req service.CommandRequest) (*model.Message, error) {
	c.got = &req
	return c.msg, c.err
}

func commandRequest(t *testing.T, method, target, body string, authed bool) *http.Request {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	if authed {
		req = req.WithContext(middleware.ContextWithClaims(req.Context(), &model.TokenClaims{UserID: "u1"}))
	}
	return req
}

func TestCommandListRequiresAuth(t *testing.T) {
	h := NewCommandHandler(service.NewCommandService())
	rec := httptest.NewRecorder()
	h.List(rec, commandRequest(t, http.MethodGet, "/api/v1/commands", "", false))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestCommandList(t *testing.T) {
	svc := service.NewCommandService()
	svc.Register(&testCommand{name: "mstmeetings"})
	h := NewCommandHandler(svc)

	rec := httptest.NewRecorder()
	h.List(rec, commandRequest(t, http.MethodGet, "/api/v1/commands", "", true))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Commands []service.CommandInfo `json:"commands"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Commands) != 1 || body.Commands[0].Name != "mstmeetings" {
		t.Errorf("commands = %+v", body.Commands)
	}
}

func TestCommandListEmptyIsArray(t *testing.T) {
	h := NewCommandHandler(service.NewCommandService())
	rec := httptest.NewRecorder()
	h.List(rec, commandRequest(t, http.MethodGet, "/api/v1/commands", "", true))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"commands":[]`) {
		t.Fatalf("body = %q, want empty commands array", rec.Body.String())
	}
}

func TestCommandRunRequiresAuth(t *testing.T) {
	h := NewCommandHandler(service.NewCommandService())
	rec := httptest.NewRecorder()
	h.Run(rec, commandRequest(t, http.MethodPost, "/api/v1/commands/run", `{}`, false))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestCommandRunRejectsBadBody(t *testing.T) {
	h := NewCommandHandler(service.NewCommandService())
	for name, body := range map[string]string{
		"invalid JSON":   `{`,
		"unknown field":  `{"command":"x","parentType":"channel","parentID":"c1","extra":true}`,
		"missing fields": `{"command":"x"}`,
		"blank command":  `{"command":"  /  ","parentType":"channel","parentID":"c1"}`,
	} {
		rec := httptest.NewRecorder()
		h.Run(rec, commandRequest(t, http.MethodPost, "/api/v1/commands/run", body, true))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, rec.Code)
		}
	}
}

func TestCommandRunUnknownCommand(t *testing.T) {
	h := NewCommandHandler(service.NewCommandService())
	rec := httptest.NewRecorder()
	h.Run(rec, commandRequest(t, http.MethodPost, "/api/v1/commands/run",
		`{"command":"nope","parentType":"channel","parentID":"c1"}`, true))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestCommandRunForbidden(t *testing.T) {
	svc := service.NewCommandService()
	svc.Register(&testCommand{name: "mstmeetings", err: service.ErrForbidden})
	h := NewCommandHandler(svc)

	rec := httptest.NewRecorder()
	h.Run(rec, commandRequest(t, http.MethodPost, "/api/v1/commands/run",
		`{"command":"mstmeetings","parentType":"channel","parentID":"c1"}`, true))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestCommandRunInternalError(t *testing.T) {
	svc := service.NewCommandService()
	svc.Register(&testCommand{name: "mstmeetings", err: errors.New("graph down")})
	h := NewCommandHandler(svc)

	rec := httptest.NewRecorder()
	h.Run(rec, commandRequest(t, http.MethodPost, "/api/v1/commands/run",
		`{"command":"mstmeetings","parentType":"channel","parentID":"c1"}`, true))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "graph down") {
		t.Error("internal error details must not leak to the client")
	}
}

func TestCommandRunSuccess(t *testing.T) {
	cmd := &testCommand{name: "mstmeetings", msg: &model.Message{ID: "msg-1", Body: "join link"}}
	svc := service.NewCommandService()
	svc.Register(cmd)
	h := NewCommandHandler(svc)
	// A successful run clears the scope's server draft (the composer held
	// "/mstmeetings" as a draft until it ran) — same fold as message send.
	clearer := &fakeDraftClearer{done: make(chan struct{}, 1)}
	h.SetDraftClearer(clearer)

	rec := httptest.NewRecorder()
	// A leading slash (as typed in the composer) is accepted and trimmed.
	h.Run(rec, commandRequest(t, http.MethodPost, "/api/v1/commands/run",
		`{"command":"/mstmeetings","parentType":"conversation","parentID":"conv-1"}`, true))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Message *model.Message `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Message == nil || body.Message.ID != "msg-1" {
		t.Errorf("message = %+v", body.Message)
	}
	want := service.CommandRequest{UserID: "u1", ParentID: "conv-1", ParentType: "conversation"}
	if cmd.got == nil || *cmd.got != want {
		t.Errorf("command received %+v, want %+v", cmd.got, want)
	}

	// The scope's draft is cleared asynchronously after the run.
	clearer.waitForCall(t)
	clearer.mu.Lock()
	defer clearer.mu.Unlock()
	if len(clearer.calls) != 1 || clearer.calls[0] != (draftClearCall{"u1", "conv-1", "conversation", ""}) {
		t.Errorf("draft clear calls = %+v, want one for the run's scope", clearer.calls)
	}
}
