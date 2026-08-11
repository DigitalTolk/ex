package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// The external-command admin API and the public response_url endpoint. The
// handler's job is the HTTP contract — admin gating, field aliases, and mapping
// service errors onto status codes; the behaviour behind it is covered in
// internal/service.

// memExtCommandStore is an in-memory store.ExternalCommandStore.
type memExtCommandStore struct {
	byID     map[string]*model.ExternalCommand
	triggers map[string]string
	failAll  bool
}

func newMemExtCommandStore() *memExtCommandStore {
	return &memExtCommandStore{
		byID:     map[string]*model.ExternalCommand{},
		triggers: map[string]string{},
	}
}

var errExtStore = &commandStoreError{}

type commandStoreError struct{}

func (*commandStoreError) Error() string { return "command store unavailable" }

func (m *memExtCommandStore) CreateCommand(_ context.Context, cmd *model.ExternalCommand) error {
	if m.failAll {
		return errExtStore
	}
	if _, taken := m.triggers[cmd.Trigger]; taken {
		return store.ErrAlreadyExists
	}
	copied := *cmd
	m.byID[cmd.ID] = &copied
	m.triggers[cmd.Trigger] = cmd.ID
	return nil
}

func (m *memExtCommandStore) UpdateCommand(_ context.Context, cmd *model.ExternalCommand) error {
	if m.failAll {
		return errExtStore
	}
	if _, ok := m.byID[cmd.ID]; !ok {
		return store.ErrNotFound
	}
	copied := *cmd
	m.byID[cmd.ID] = &copied
	return nil
}

func (m *memExtCommandStore) GetCommand(_ context.Context, id string) (*model.ExternalCommand, error) {
	if m.failAll {
		return nil, errExtStore
	}
	cmd, ok := m.byID[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	copied := *cmd
	return &copied, nil
}

func (m *memExtCommandStore) GetCommandByTrigger(ctx context.Context, trigger string) (*model.ExternalCommand, error) {
	id, ok := m.triggers[strings.ToLower(trigger)]
	if !ok {
		return nil, store.ErrNotFound
	}
	return m.GetCommand(ctx, id)
}

func (m *memExtCommandStore) ListCommands(_ context.Context) ([]*model.ExternalCommand, error) {
	if m.failAll {
		return nil, errExtStore
	}
	out := make([]*model.ExternalCommand, 0, len(m.byID))
	for _, c := range m.byID {
		copied := *c
		out = append(out, &copied)
	}
	return out, nil
}

func (m *memExtCommandStore) DeleteCommand(_ context.Context, id string) error {
	if m.failAll {
		return errExtStore
	}
	cmd, ok := m.byID[id]
	if !ok {
		return store.ErrNotFound
	}
	delete(m.triggers, cmd.Trigger)
	delete(m.byID, id)
	return nil
}

func setupExtCommandHandler(t *testing.T) (*ExternalCommandHandler, *auth.JWTManager, *memExtCommandStore) {
	t.Helper()
	cmdStore := newMemExtCommandStore()
	svc := service.NewExternalCommandService(service.ExternalCommandDeps{Store: cmdStore})
	jwtMgr := auth.NewJWTManager("test-secret-that-is-long-enough-for-hs256", time.Minute, time.Hour)
	return NewExternalCommandHandler(svc), jwtMgr, cmdStore
}

// callAsAdmin runs one request through the auth middleware as an admin.
func callAsAdmin(t *testing.T, jwtMgr *auth.JWTManager, h http.HandlerFunc, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	token := makeTokenForUser(jwtMgr, &model.User{ID: "u-adm", SystemRole: model.SystemRoleAdmin})
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(h).ServeHTTP(rec, req)
	return rec
}

func TestExternalCommandHandler_AdminOnly(t *testing.T) {
	h, jwtMgr, _ := setupExtCommandHandler(t)
	token := makeTokenForUser(jwtMgr, &model.User{ID: "u", SystemRole: model.SystemRoleMember})

	for name, handler := range map[string]http.HandlerFunc{
		"list":   h.List,
		"get":    h.Get,
		"create": h.Create,
		"update": h.Update,
		"delete": h.Delete,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/commands", strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		middleware.Auth(jwtMgr)(handler).ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s: status = %d, want 403 for a non-admin", name, rec.Code)
		}
	}
}

func TestExternalCommandHandler_CreateAndList(t *testing.T) {
	h, jwtMgr, _ := setupExtCommandHandler(t)

	// display_name and trigger_word are Mattermost's spellings; both are accepted.
	body := `{"trigger_word":"/Deploy","display_name":"Deploy","request_url":"https://hooks.example.com/run"}`
	rec := callAsAdmin(t, jwtMgr, h.Create, httptest.NewRequest(http.MethodPost, "/api/v1/admin/commands", strings.NewReader(body)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var created map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created["trigger"] != "deploy" {
		t.Errorf("trigger = %v, want it normalized to \"deploy\"", created["trigger"])
	}
	if created["title"] != "Deploy" {
		t.Errorf("title = %v, want the display_name alias applied", created["title"])
	}
	// The token is revealed exactly once, here.
	tokenValue, _ := created["token"].(string)
	if !strings.HasPrefix(tokenValue, "excmd_") {
		t.Fatalf("token = %q, want an excmd_ credential", tokenValue)
	}
	id, _ := created["id"].(string)

	// …and never again by the read APIs.
	rec = callAsAdmin(t, jwtMgr, h.List, httptest.NewRequest(http.MethodGet, "/api/v1/admin/commands", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), tokenValue) {
		t.Error("the list response leaks the command's token")
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/admin/commands/"+id, nil)
	getReq.SetPathValue("id", id)
	rec = callAsAdmin(t, jwtMgr, h.Get, getReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), tokenValue) {
		t.Error("the get response leaks the command's token")
	}
}

func TestExternalCommandHandler_UpdateAndDelete(t *testing.T) {
	h, jwtMgr, cmdStore := setupExtCommandHandler(t)
	cmd := &model.ExternalCommand{
		ID: "c1", Trigger: "deploy", RequestURL: "https://hooks.example.com/run", Token: "excmd_x",
	}
	if err := cmdStore.CreateCommand(nil, cmd); err != nil { //nolint:staticcheck // the mem store ignores ctx
		t.Fatalf("seed: %v", err)
	}

	updReq := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/commands/c1",
		strings.NewReader(`{"request_url":"https://hooks.example.com/v2","description":"newer"}`))
	updReq.SetPathValue("id", "c1")
	rec := callAsAdmin(t, jwtMgr, h.Update, updReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", rec.Code, rec.Body.String())
	}

	delReq := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/commands/c1", nil)
	delReq.SetPathValue("id", "c1")
	rec = callAsAdmin(t, jwtMgr, h.Delete, delReq)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestExternalCommandHandler_ErrorStatuses(t *testing.T) {
	h, jwtMgr, cmdStore := setupExtCommandHandler(t)

	tests := []struct {
		name    string
		handler http.HandlerFunc
		method  string
		id      string
		body    string
		want    int
	}{
		{name: "malformed body", handler: h.Create, method: http.MethodPost, body: `{`, want: http.StatusBadRequest},
		{
			name: "invalid trigger", handler: h.Create, method: http.MethodPost,
			body: `{"trigger":"two words","request_url":"https://hooks.example.com/run"}`, want: http.StatusBadRequest,
		},
		{
			name: "unsafe request URL", handler: h.Create, method: http.MethodPost,
			body: `{"trigger":"x","request_url":"http://127.0.0.1/run"}`, want: http.StatusBadRequest,
		},
		{name: "unknown command", handler: h.Get, method: http.MethodGet, id: "nope", want: http.StatusNotFound},
		{name: "delete unknown", handler: h.Delete, method: http.MethodDelete, id: "nope", want: http.StatusNotFound},
		{
			name: "update malformed body", handler: h.Update, method: http.MethodPatch, id: "c1",
			body: `{`, want: http.StatusBadRequest,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/api/v1/admin/commands", strings.NewReader(tc.body))
			if tc.id != "" {
				req.SetPathValue("id", tc.id)
			}
			rec := callAsAdmin(t, jwtMgr, tc.handler, req)
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
		})
	}

	t.Run("duplicate trigger is a conflict", func(t *testing.T) {
		body := `{"trigger":"dupe","request_url":"https://hooks.example.com/run"}`
		if rec := callAsAdmin(t, jwtMgr, h.Create,
			httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))); rec.Code != http.StatusCreated {
			t.Fatalf("first create status = %d", rec.Code)
		}
		rec := callAsAdmin(t, jwtMgr, h.Create, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
		if rec.Code != http.StatusConflict {
			t.Errorf("status = %d, want 409", rec.Code)
		}
	})

	t.Run("a store failure is a server error", func(t *testing.T) {
		cmdStore.failAll = true
		rec := callAsAdmin(t, jwtMgr, h.List, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("status = %d, want 500", rec.Code)
		}
		cmdStore.failAll = false
	})
}

// A reserved (built-in) trigger is a conflict, not a validation error: the request
// is well-formed, the name is simply taken.
func TestExternalCommandHandler_ReservedTriggerIsConflict(t *testing.T) {
	cmdStore := newMemExtCommandStore()
	svc := service.NewExternalCommandService(service.ExternalCommandDeps{
		Store:    cmdStore,
		Reserved: func() map[string]bool { return map[string]bool{"mstmeetings": true} },
	})
	h := NewExternalCommandHandler(svc)
	jwtMgr := auth.NewJWTManager("test-secret-that-is-long-enough-for-hs256", time.Minute, time.Hour)

	body := `{"trigger":"mstmeetings","request_url":"https://hooks.example.com/run"}`
	rec := callAsAdmin(t, jwtMgr, h.Create, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
	if rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409", rec.Code)
	}
}

// DeliverResponse is unauthenticated by design — the path token is the credential.
func TestExternalCommandHandler_DeliverResponse(t *testing.T) {
	h, _, _ := setupExtCommandHandler(t)

	t.Run("an empty token is a 404", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/hooks/commands/", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		h.DeliverResponse(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("an unknown token is a 404, undifferentiated from expired", func(t *testing.T) {
		// A client probing tokens must learn nothing about which ones existed.
		req := httptest.NewRequest(http.MethodPost, "/hooks/commands/xyz", strings.NewReader(`{}`))
		req.SetPathValue("token", "xyz")
		rec := httptest.NewRecorder()
		h.DeliverResponse(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
	})
}

// memResponseStore is an in-memory service.CommandResponseStore.
type memResponseStore struct {
	pending map[string]*store.PendingCommandResponse
	getErr  error
}

func newMemResponseStore() *memResponseStore {
	return &memResponseStore{pending: map[string]*store.PendingCommandResponse{}}
}

func (m *memResponseStore) Put(_ context.Context, token string, p *store.PendingCommandResponse) error {
	copied := *p
	m.pending[token] = &copied
	return nil
}

func (m *memResponseStore) Get(_ context.Context, token string) (*store.PendingCommandResponse, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	p, ok := m.pending[token]
	if !ok {
		return nil, nil
	}
	copied := *p
	return &copied, nil
}

func (m *memResponseStore) Delete(_ context.Context, token string) { delete(m.pending, token) }

// The response_url endpoint's remaining status mappings. It is unauthenticated by
// design — the path token is the whole credential.
func TestExternalCommandHandler_DeliverResponseStatuses(t *testing.T) {
	responses := newMemResponseStore()
	svc := service.NewExternalCommandService(service.ExternalCommandDeps{
		Store:     newMemExtCommandStore(),
		Messages:  nil, // never reached: every case below fails before posting
		Responses: responses,
	})
	h := NewExternalCommandHandler(svc)

	t.Run("a malformed body is a server error", func(t *testing.T) {
		responses.pending["tok-bad"] = &store.PendingCommandResponse{
			UserID: "u1", ParentID: "ch1", ParentType: service.ParentChannel,
		}
		req := httptest.NewRequest(http.MethodPost, "/hooks/commands/tok-bad", strings.NewReader(`not json`))
		req.SetPathValue("token", "tok-bad")
		rec := httptest.NewRecorder()
		h.DeliverResponse(rec, req)
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("status = %d, want 500", rec.Code)
		}
	})

	t.Run("a store failure is a server error", func(t *testing.T) {
		responses.getErr = errExtStore
		defer func() { responses.getErr = nil }()
		req := httptest.NewRequest(http.MethodPost, "/hooks/commands/tok", strings.NewReader(`{}`))
		req.SetPathValue("token", "tok")
		rec := httptest.NewRecorder()
		h.DeliverResponse(rec, req)
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("status = %d, want 500", rec.Code)
		}
	})

	t.Run("an empty response is accepted and posts nothing", func(t *testing.T) {
		responses.pending["tok-empty"] = &store.PendingCommandResponse{
			UserID: "u1", ParentID: "ch1", ParentType: service.ParentChannel,
		}
		req := httptest.NewRequest(http.MethodPost, "/hooks/commands/tok-empty", strings.NewReader(`{}`))
		req.SetPathValue("token", "tok-empty")
		rec := httptest.NewRecorder()
		h.DeliverResponse(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
		}
	})
}

// The invoking user losing access while the integration worked is a 403, not a
// server error — nothing is broken, the post is simply no longer allowed.
func TestExternalCommandHandler_DeliverResponseForbidden(t *testing.T) {
	responses := newMemResponseStore()
	responses.pending["tok"] = &store.PendingCommandResponse{
		// No requester → PostBotCard refuses with ErrForbidden.
		UserID: "", ParentID: "ch1", ParentType: service.ParentChannel,
	}
	svc := service.NewExternalCommandService(service.ExternalCommandDeps{
		Store:     newMemExtCommandStore(),
		Messages:  service.NewMessageService(newDataMessageStore(), newDataMembershipStore(), nil, nil, &mockBrokerForHandler{}),
		Responses: responses,
	})
	h := NewExternalCommandHandler(svc)

	req := httptest.NewRequest(http.MethodPost, "/hooks/commands/tok",
		strings.NewReader(`{"response_type":"in_channel","text":"late"}`))
	req.SetPathValue("token", "tok")
	rec := httptest.NewRecorder()
	h.DeliverResponse(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", rec.Code, rec.Body.String())
	}
}

// A service error on update surfaces as a 500 rather than a misleading 404.
func TestExternalCommandHandler_UpdateStoreFailure(t *testing.T) {
	h, jwtMgr, cmdStore := setupExtCommandHandler(t)
	if err := cmdStore.CreateCommand(context.Background(), &model.ExternalCommand{
		ID: "c9", Trigger: "deploy", RequestURL: "https://hooks.example.com/run", Token: "excmd_x",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cmdStore.failAll = true
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/commands/c9",
		strings.NewReader(`{"request_url":"https://hooks.example.com/v2"}`))
	req.SetPathValue("id", "c9")
	rec := callAsAdmin(t, jwtMgr, h.Update, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500 (body %s)", rec.Code, rec.Body.String())
	}
}
