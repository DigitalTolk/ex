package handler

// Coverage tests for connector.go (catalog/install/verify/sync endpoints),
// the remaining presence.go arms, and the agents/connectors route-registration
// block in router.go. All identifiers are prefixed hconnCov to stay out of the
// way of the other test files in this package.

import (
	"context"
	"errors"
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

// --- fakes -------------------------------------------------------------------

// hconnCovStore is an in-memory implementation of the service package's
// connector persistence seam, with per-method error toggles.
type hconnCovStore struct {
	connectors map[string]*model.Connector
	files      map[string][]model.ConnectorFile
	installs   map[string]*model.ConnectorInstall

	errPutConnector   error
	errListConnectors error
	errGetFiles       error
	errPutInstall     error
	errListInstalls   error
	errDeleteInstall  error
}

func hconnCovNewStore() *hconnCovStore {
	return &hconnCovStore{
		connectors: map[string]*model.Connector{},
		files:      map[string][]model.ConnectorFile{},
		installs:   map[string]*model.ConnectorInstall{},
	}
}

func hconnCovKey(userID, slug string) string { return userID + "|" + slug }

func (s *hconnCovStore) PutConnector(_ context.Context, c *model.Connector, files []model.ConnectorFile) error {
	if s.errPutConnector != nil {
		return s.errPutConnector
	}
	s.connectors[c.Slug] = c
	s.files[c.Slug] = files
	return nil
}

func (s *hconnCovStore) GetConnector(_ context.Context, slug string) (*model.Connector, error) {
	if c, ok := s.connectors[slug]; ok {
		return c, nil
	}
	return nil, store.ErrNotFound
}

func (s *hconnCovStore) ListConnectors(_ context.Context) ([]*model.Connector, error) {
	if s.errListConnectors != nil {
		return nil, s.errListConnectors
	}
	out := make([]*model.Connector, 0, len(s.connectors))
	for _, c := range s.connectors {
		out = append(out, c)
	}
	return out, nil
}

func (s *hconnCovStore) GetConnectorFiles(_ context.Context, slug string) ([]model.ConnectorFile, error) {
	if s.errGetFiles != nil {
		return nil, s.errGetFiles
	}
	return s.files[slug], nil
}

func (s *hconnCovStore) PutInstall(_ context.Context, in *model.ConnectorInstall) error {
	if s.errPutInstall != nil {
		return s.errPutInstall
	}
	s.installs[hconnCovKey(in.UserID, in.ConnectorSlug)] = in
	return nil
}

func (s *hconnCovStore) GetInstall(_ context.Context, userID, slug string) (*model.ConnectorInstall, error) {
	if in, ok := s.installs[hconnCovKey(userID, slug)]; ok {
		return in, nil
	}
	return nil, store.ErrNotFound
}

func (s *hconnCovStore) ListInstalls(_ context.Context, userID string) ([]*model.ConnectorInstall, error) {
	if s.errListInstalls != nil {
		return nil, s.errListInstalls
	}
	out := []*model.ConnectorInstall{}
	for _, in := range s.installs {
		if in.UserID == userID {
			out = append(out, in)
		}
	}
	return out, nil
}

func (s *hconnCovStore) DeleteInstall(_ context.Context, userID, slug string) error {
	if s.errDeleteInstall != nil {
		return s.errDeleteInstall
	}
	delete(s.installs, hconnCovKey(userID, slug))
	return nil
}

// hconnCovRuns fakes the liveRunGetter orchestrator slice.
type hconnCovRuns struct {
	run         *model.Run
	runErr      error
	attachErr   error
	attached    []string
	approval    *model.Approval
	approvalErr error
}

func (r *hconnCovRuns) GetLiveRun(_ context.Context, _ string) (*model.Run, error) {
	if r.runErr != nil {
		return nil, r.runErr
	}
	return r.run, nil
}

func (r *hconnCovRuns) AttachConnector(_ context.Context, _, slug, _ string) error {
	if r.attachErr != nil {
		return r.attachErr
	}
	r.attached = append(r.attached, slug)
	return nil
}

func (r *hconnCovRuns) ApprovalStatus(_ context.Context, _, _ string) (*model.Approval, error) {
	if r.approvalErr != nil {
		return nil, r.approvalErr
	}
	return r.approval, nil
}

// hconnCovPresenceStore drives PresenceService.OnlineUserIDs deterministically.
type hconnCovPresenceStore struct{ ids []string }

func (p *hconnCovPresenceStore) IncrementPresence(context.Context, string, string) (bool, error) {
	return false, nil
}
func (p *hconnCovPresenceStore) DecrementPresence(context.Context, string, string) (bool, error) {
	return false, nil
}
func (p *hconnCovPresenceStore) RefreshPresence(context.Context, string, string) error { return nil }
func (p *hconnCovPresenceStore) IsPresenceOnline(context.Context, string) (bool, error) {
	return false, nil
}
func (p *hconnCovPresenceStore) OnlinePresenceUserIDs(context.Context) ([]string, error) {
	return p.ids, nil
}

// --- helpers -----------------------------------------------------------------

func hconnCovHandler(st *hconnCovStore, runs *hconnCovRuns) *ConnectorHandler {
	return NewConnectorHandler(service.NewConnectorService(st), runs)
}

// hconnCovReq builds a request with claims injected and the {slug} path value
// set (both optional), the way the auth middleware and mux would.
func hconnCovReq(method, target, body string, claims *model.TokenClaims, slug string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if claims != nil {
		req = req.WithContext(middleware.ContextWithClaims(req.Context(), claims))
	}
	if slug != "" {
		req.SetPathValue("slug", slug)
	}
	return req
}

func hconnCovUserClaims() *model.TokenClaims {
	return &model.TokenClaims{UserID: "hconncov-user"}
}

func hconnCovRunClaims() *model.TokenClaims {
	return &model.TokenClaims{UserID: "hconncov-inv", RunID: "hconncov-run", Scope: model.TokenScopeRun}
}

func hconnCovPasteConnector(slug string) *model.Connector {
	return &model.Connector{Slug: slug, Title: "T " + slug, BaseURL: "http://x", AuthKind: model.ConnectorAuthPaste}
}

// --- connector.go: List --------------------------------------------------------

func TestHconnCovConnectorList(t *testing.T) {
	t.Run("ok", func(t *testing.T) {
		st := hconnCovNewStore()
		st.connectors["s1"] = hconnCovPasteConnector("s1")
		st.installs[hconnCovKey("hconncov-user", "s1")] = &model.ConnectorInstall{UserID: "hconncov-user", ConnectorSlug: "s1", Status: model.ConnectorStatusConnected}
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.List(rec, hconnCovReq(http.MethodGet, "/api/v1/connectors", "", hconnCovUserClaims(), ""))
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `"s1"`) {
			t.Fatalf("expected connector s1 in body, got %s", rec.Body.String())
		}
	})

	t.Run("store error is 500", func(t *testing.T) {
		st := hconnCovNewStore()
		st.errListConnectors = errors.New("boom")
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.List(rec, hconnCovReq(http.MethodGet, "/api/v1/connectors", "", hconnCovUserClaims(), ""))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status=%d, want 500", rec.Code)
		}
	})
}

// --- connector.go: Ingest ------------------------------------------------------

func TestHconnCovConnectorIngest(t *testing.T) {
	valid := `{"slug":"s1","title":"T","baseURL":"http://x","authKind":"paste","files":[{"name":"readme.md","content":"hi"}]}`

	t.Run("bad body is 400", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), nil)
		rec := httptest.NewRecorder()
		h.Ingest(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors", `{`, hconnCovUserClaims(), ""))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status=%d, want 400", rec.Code)
		}
	})

	t.Run("invalid connector is 400", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), nil)
		rec := httptest.NewRecorder()
		h.Ingest(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors", `{"slug":"NOT VALID"}`, hconnCovUserClaims(), ""))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status=%d, want 400", rec.Code)
		}
	})

	t.Run("store failure is 500", func(t *testing.T) {
		st := hconnCovNewStore()
		st.errPutConnector = errors.New("boom")
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.Ingest(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors", valid, hconnCovUserClaims(), ""))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status=%d, want 500", rec.Code)
		}
	})

	t.Run("success is 201", func(t *testing.T) {
		st := hconnCovNewStore()
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.Ingest(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors", valid, hconnCovUserClaims(), ""))
		if rec.Code != http.StatusCreated {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		if st.connectors["s1"] == nil {
			t.Fatal("connector s1 not stored")
		}
	})
}

// --- connector.go: Sync --------------------------------------------------------

func TestHconnCovConnectorSync(t *testing.T) {
	t.Run("no provider is 503", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), nil) // no SetProvider → ErrConnectorInvalid
		rec := httptest.NewRecorder()
		h.Sync(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/sync", "", hconnCovUserClaims(), ""))
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status=%d, want 503", rec.Code)
		}
	})

	t.Run("provider failure is 502", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer ts.Close()
		svc := service.NewConnectorService(hconnCovNewStore())
		svc.SetProvider(ts.URL, "key")
		h := NewConnectorHandler(svc, nil)
		rec := httptest.NewRecorder()
		h.Sync(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/sync", "", hconnCovUserClaims(), ""))
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("status=%d, want 502", rec.Code)
		}
	})

	t.Run("success is 200", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"connectors":[{"slug":"a","revision":""}]}`))
		}))
		defer ts.Close()
		svc := service.NewConnectorService(hconnCovNewStore())
		svc.SetProvider(ts.URL, "key")
		h := NewConnectorHandler(svc, nil)
		rec := httptest.NewRecorder()
		h.Sync(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/sync", "", hconnCovUserClaims(), ""))
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "skipped") {
			t.Fatalf("expected skipped report, got %s", rec.Body.String())
		}
	})
}

// --- connector.go: Install -----------------------------------------------------

func TestHconnCovConnectorInstall(t *testing.T) {
	t.Run("bad body is 400", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), nil)
		rec := httptest.NewRecorder()
		h.Install(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s1/install", `{`, hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status=%d, want 400", rec.Code)
		}
	})

	t.Run("unknown connector is 404", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), nil)
		rec := httptest.NewRecorder()
		h.Install(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/nope/install", `{}`, hconnCovUserClaims(), "nope"))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status=%d, want 404", rec.Code)
		}
	})

	t.Run("missing token on paste connector is 400", func(t *testing.T) {
		st := hconnCovNewStore()
		st.connectors["s1"] = hconnCovPasteConnector("s1")
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.Install(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s1/install", `{}`, hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status=%d, want 400", rec.Code)
		}
	})

	t.Run("verify 401 rejects the token", func(t *testing.T) {
		verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
		}))
		defer verify.Close()
		st := hconnCovNewStore()
		c := hconnCovPasteConnector("s1")
		c.VerifyURL = verify.URL
		st.connectors["s1"] = c
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.Install(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s1/install", `{"token":"Bearer abc"}`, hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d, want 401", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "token_rejected") {
			t.Fatalf("expected token_rejected, got %s", rec.Body.String())
		}
	})

	t.Run("two-factor challenge is 409 with accessCode", func(t *testing.T) {
		authTS := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"token_type":"two_factor","access_code":"AC42"}`))
		}))
		defer authTS.Close()
		st := hconnCovNewStore()
		st.connectors["s2"] = &model.Connector{Slug: "s2", Title: "S2", BaseURL: "http://x", AuthKind: model.ConnectorAuthPassword, TokenURL: authTS.URL}
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.Install(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s2/install", `{"email":"e@x","password":"p"}`, hconnCovUserClaims(), "s2"))
		if rec.Code != http.StatusConflict {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "AC42") {
			t.Fatalf("expected accessCode AC42, got %s", rec.Body.String())
		}
	})

	t.Run("login failure is 401", func(t *testing.T) {
		authTS := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"bad creds"}`))
		}))
		defer authTS.Close()
		st := hconnCovNewStore()
		st.connectors["s2"] = &model.Connector{Slug: "s2", Title: "S2", BaseURL: "http://x", AuthKind: model.ConnectorAuthPassword, TokenURL: authTS.URL}
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.Install(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s2/install", `{"email":"e@x","password":"p"}`, hconnCovUserClaims(), "s2"))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "login_failed") {
			t.Fatalf("expected login_failed, got %s", rec.Body.String())
		}
	})

	t.Run("store failure is 500", func(t *testing.T) {
		st := hconnCovNewStore()
		st.connectors["s1"] = hconnCovPasteConnector("s1")
		st.errPutInstall = errors.New("boom")
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.Install(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s1/install", `{"token":"tok"}`, hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status=%d, want 500", rec.Code)
		}
	})

	t.Run("success is 200", func(t *testing.T) {
		st := hconnCovNewStore()
		st.connectors["s1"] = hconnCovPasteConnector("s1")
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.Install(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s1/install", `{"token":"tok"}`, hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "install") {
			t.Fatalf("expected install payload, got %s", rec.Body.String())
		}
	})
}

// --- connector.go: Uninstall ---------------------------------------------------

func TestHconnCovConnectorUninstall(t *testing.T) {
	t.Run("store failure is 500", func(t *testing.T) {
		st := hconnCovNewStore()
		st.errDeleteInstall = errors.New("boom")
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.Uninstall(rec, hconnCovReq(http.MethodDelete, "/api/v1/connectors/s1/install", "", hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status=%d, want 500", rec.Code)
		}
	})

	t.Run("success is 204", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), nil)
		rec := httptest.NewRecorder()
		h.Uninstall(rec, hconnCovReq(http.MethodDelete, "/api/v1/connectors/s1/install", "", hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status=%d, want 204", rec.Code)
		}
	})
}

// --- connector.go: UpdateInstall -----------------------------------------------

func TestHconnCovConnectorUpdateInstall(t *testing.T) {
	install := func(st *hconnCovStore) {
		st.installs[hconnCovKey("hconncov-user", "s1")] = &model.ConnectorInstall{UserID: "hconncov-user", ConnectorSlug: "s1"}
	}

	t.Run("bad body is 400", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), nil)
		rec := httptest.NewRecorder()
		h.UpdateInstall(rec, hconnCovReq(http.MethodPatch, "/api/v1/connectors/s1/install", `{`, hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status=%d, want 400", rec.Code)
		}
	})

	t.Run("invalid mode is 400", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), nil)
		rec := httptest.NewRecorder()
		h.UpdateInstall(rec, hconnCovReq(http.MethodPatch, "/api/v1/connectors/s1/install", `{"agentUse":"sometimes"}`, hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status=%d, want 400", rec.Code)
		}
	})

	t.Run("not installed is 404", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), nil)
		rec := httptest.NewRecorder()
		h.UpdateInstall(rec, hconnCovReq(http.MethodPatch, "/api/v1/connectors/s1/install", `{"agentUse":"always"}`, hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status=%d, want 404", rec.Code)
		}
	})

	t.Run("store failure is 500", func(t *testing.T) {
		st := hconnCovNewStore()
		install(st)
		st.errPutInstall = errors.New("boom")
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.UpdateInstall(rec, hconnCovReq(http.MethodPatch, "/api/v1/connectors/s1/install", `{"agentUse":"never"}`, hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status=%d, want 500", rec.Code)
		}
	})

	t.Run("success is 204", func(t *testing.T) {
		st := hconnCovNewStore()
		install(st)
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.UpdateInstall(rec, hconnCovReq(http.MethodPatch, "/api/v1/connectors/s1/install", `{"agentUse":"always"}`, hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status=%d, want 204", rec.Code)
		}
		if got := st.installs[hconnCovKey("hconncov-user", "s1")].AgentUse; got != "always" {
			t.Fatalf("agentUse=%q, want always", got)
		}
	})
}

// --- connector.go: VerifyInstall -----------------------------------------------

func TestHconnCovConnectorVerifyInstall(t *testing.T) {
	seed := func(st *hconnCovStore, verifyURL string) {
		c := hconnCovPasteConnector("s1")
		c.VerifyURL = verifyURL
		st.connectors["s1"] = c
		st.installs[hconnCovKey("hconncov-user", "s1")] = &model.ConnectorInstall{UserID: "hconncov-user", ConnectorSlug: "s1", Token: "tok", Status: model.ConnectorStatusUnverified}
	}

	t.Run("unknown connector is 404", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), nil)
		rec := httptest.NewRecorder()
		h.VerifyInstall(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s1/verify", "", hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status=%d, want 404", rec.Code)
		}
	})

	t.Run("service 403 is 401 token_rejected", func(t *testing.T) {
		verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))
		defer verify.Close()
		st := hconnCovNewStore()
		seed(st, verify.URL)
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.VerifyInstall(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s1/verify", "", hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d, want 401", rec.Code)
		}
	})

	t.Run("unreachable service is 502", func(t *testing.T) {
		verify := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		deadURL := verify.URL
		verify.Close() // keep the URL, kill the listener → connection refused
		st := hconnCovNewStore()
		seed(st, deadURL)
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.VerifyInstall(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s1/verify", "", hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("status=%d, want 502", rec.Code)
		}
	})

	t.Run("store failure after verify is 500", func(t *testing.T) {
		verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"name":"Bob"}`))
		}))
		defer verify.Close()
		st := hconnCovNewStore()
		seed(st, verify.URL)
		st.errPutInstall = errors.New("boom")
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.VerifyInstall(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s1/verify", "", hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status=%d, want 500", rec.Code)
		}
	})

	t.Run("no verify URL returns the install", func(t *testing.T) {
		st := hconnCovNewStore()
		seed(st, "")
		h := hconnCovHandler(st, nil)
		rec := httptest.NewRecorder()
		h.VerifyInstall(rec, hconnCovReq(http.MethodPost, "/api/v1/connectors/s1/verify", "", hconnCovUserClaims(), "s1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	})
}

// --- connector.go: UseConnector -------------------------------------------------

func TestHconnCovConnectorUse(t *testing.T) {
	// seed returns a store where the invoker has s1 installed with the given
	// agent-use policy, plus the registered connector (for the title lookup).
	seed := func(policy string) *hconnCovStore {
		st := hconnCovNewStore()
		st.connectors["s1"] = hconnCovPasteConnector("s1")
		st.installs[hconnCovKey("hconncov-inv", "s1")] = &model.ConnectorInstall{UserID: "hconncov-inv", ConnectorSlug: "s1", AgentUse: policy}
		return st
	}
	liveRun := func() *hconnCovRuns {
		return &hconnCovRuns{run: &model.Run{ID: "hconncov-run", InvokerID: "hconncov-inv"}}
	}

	t.Run("missing connector is 400", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), liveRun())
		rec := httptest.NewRecorder()
		h.UseConnector(rec, hconnCovReq(http.MethodPost, "/api/v1/agent/run/use-connector", `{}`, hconnCovRunClaims(), ""))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status=%d, want 400", rec.Code)
		}
	})

	t.Run("closed run is 409", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), &hconnCovRuns{runErr: errors.New("gone")})
		rec := httptest.NewRecorder()
		h.UseConnector(rec, hconnCovReq(http.MethodPost, "/api/v1/agent/run/use-connector", `{"connector":"s1"}`, hconnCovRunClaims(), ""))
		if rec.Code != http.StatusConflict {
			t.Fatalf("status=%d, want 409", rec.Code)
		}
	})

	t.Run("not installed is denied", func(t *testing.T) {
		h := hconnCovHandler(hconnCovNewStore(), liveRun())
		rec := httptest.NewRecorder()
		h.UseConnector(rec, hconnCovReq(http.MethodPost, "/api/v1/agent/run/use-connector", `{"connector":"s1"}`, hconnCovRunClaims(), ""))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "denied") {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("policy never is denied", func(t *testing.T) {
		h := hconnCovHandler(seed(model.ConnectorAgentUseNever), liveRun())
		rec := httptest.NewRecorder()
		h.UseConnector(rec, hconnCovReq(http.MethodPost, "/api/v1/agent/run/use-connector", `{"connector":"s1"}`, hconnCovRunClaims(), ""))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "denied") {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("policy always attaches", func(t *testing.T) {
		runs := liveRun()
		h := hconnCovHandler(seed(model.ConnectorAgentUseAlways), runs)
		rec := httptest.NewRecorder()
		h.UseConnector(rec, hconnCovReq(http.MethodPost, "/api/v1/agent/run/use-connector", `{"connector":"s1","reason":"docs"}`, hconnCovRunClaims(), ""))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "attached") {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		if len(runs.attached) != 1 || runs.attached[0] != "s1" {
			t.Fatalf("attached=%v, want [s1]", runs.attached)
		}
	})

	t.Run("attach failure is 500", func(t *testing.T) {
		runs := liveRun()
		runs.attachErr = errors.New("boom")
		h := hconnCovHandler(seed(model.ConnectorAgentUseAlways), runs)
		rec := httptest.NewRecorder()
		h.UseConnector(rec, hconnCovReq(http.MethodPost, "/api/v1/agent/run/use-connector", `{"connector":"s1"}`, hconnCovRunClaims(), ""))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status=%d, want 500", rec.Code)
		}
	})

	t.Run("policy ask without approval returns ask", func(t *testing.T) {
		h := hconnCovHandler(seed(""), liveRun()) // empty policy defaults to ask
		rec := httptest.NewRecorder()
		h.UseConnector(rec, hconnCovReq(http.MethodPost, "/api/v1/agent/run/use-connector", `{"connector":"s1"}`, hconnCovRunClaims(), ""))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ask"`) {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("unverifiable approval is denied", func(t *testing.T) {
		runs := liveRun()
		runs.approvalErr = errors.New("no such approval")
		h := hconnCovHandler(seed(model.ConnectorAgentUseAsk), runs)
		rec := httptest.NewRecorder()
		h.UseConnector(rec, hconnCovReq(http.MethodPost, "/api/v1/agent/run/use-connector", `{"connector":"s1","approvalID":"ap1"}`, hconnCovRunClaims(), ""))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "denied") {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("approved approval attaches", func(t *testing.T) {
		runs := liveRun()
		runs.approval = &model.Approval{ID: "ap1", State: model.ApprovalApproved, Summary: "Attach connector s1 to this run"}
		h := hconnCovHandler(seed(model.ConnectorAgentUseAsk), runs)
		rec := httptest.NewRecorder()
		h.UseConnector(rec, hconnCovReq(http.MethodPost, "/api/v1/agent/run/use-connector", `{"connector":"s1","approvalID":"ap1"}`, hconnCovRunClaims(), ""))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "attached") {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		if len(runs.attached) != 1 || runs.attached[0] != "s1" {
			t.Fatalf("attached=%v, want [s1]", runs.attached)
		}
	})
}

// --- connector.go: RunnerConnectors ---------------------------------------------

func TestHconnCovConnectorRunner(t *testing.T) {
	t.Run("service failure is 500", func(t *testing.T) {
		st := hconnCovNewStore()
		st.errListInstalls = errors.New("boom")
		h := hconnCovHandler(st, &hconnCovRuns{})
		rec := httptest.NewRecorder()
		h.RunnerConnectors(rec, hconnCovReq(http.MethodGet, "/api/v1/agent/run/connectors", "", hconnCovRunClaims(), ""))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status=%d, want 500", rec.Code)
		}
	})

	t.Run("only the run's picks ship", func(t *testing.T) {
		st := hconnCovNewStore()
		st.connectors["s1"] = hconnCovPasteConnector("s1")
		st.connectors["s2"] = hconnCovPasteConnector("s2")
		st.installs[hconnCovKey("hconncov-inv", "s1")] = &model.ConnectorInstall{UserID: "hconncov-inv", ConnectorSlug: "s1", Token: "t1"}
		st.installs[hconnCovKey("hconncov-inv", "s2")] = &model.ConnectorInstall{UserID: "hconncov-inv", ConnectorSlug: "s2", Token: "t2"}
		runs := &hconnCovRuns{run: &model.Run{ID: "hconncov-run", InvokerID: "hconncov-inv", ConnectorSlugs: []string{"s1"}}}
		h := hconnCovHandler(st, runs)
		rec := httptest.NewRecorder()
		h.RunnerConnectors(rec, hconnCovReq(http.MethodGet, "/api/v1/agent/run/connectors", "", hconnCovRunClaims(), ""))
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		body := rec.Body.String()
		if !strings.Contains(body, `"slug":"s1"`) {
			t.Fatalf("expected picked connector s1 in payload, got %s", body)
		}
		if strings.Contains(body, `"slug":"s2"`) {
			t.Fatalf("unpicked connector s2 must not ship, got %s", body)
		}
	})
}

// --- presence.go: always-online merge -------------------------------------------

func TestHconnCovPresenceAlwaysOnline(t *testing.T) {
	svc := service.NewPresenceService(&hconnCovPresenceStore{ids: []string{"hconncov-u1"}}, nil)
	h := NewPresenceHandler(svc)
	h.SetAlwaysOnline(func(*http.Request) []string { return []string{"hconncov-u1", "hconncov-agent"} })

	rec := httptest.NewRecorder()
	h.List(rec, httptest.NewRequest(http.MethodGet, "/api/v1/presence", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "hconncov-agent") {
		t.Fatalf("always-online agent missing from %s", body)
	}
	if strings.Count(body, `"hconncov-u1"`) != 1 {
		t.Fatalf("already-online user must not be duplicated: %s", body)
	}
}

// --- router.go: agents/connectors registration block ----------------------------

// TestHconnCovRouterAgentRoutes builds the router with the agent, runner,
// run-tool (workspace included), connector, coding-task, and context handlers
// all wired, which executes the corresponding mux.Handle registration blocks,
// then probes one route per block (non-404 proves registration; 401 from the
// auth middlewares is expected).
func TestHconnCovRouterAgentRoutes(t *testing.T) {
	jwtMgr := auth.NewJWTManager("hconncov-router-secret", 15*time.Minute, 24*time.Hour)
	runTool := &AgentRunToolHandler{workspace: &AgentWorkspaceDeps{}}
	router := NewRouter(&Deps{
		Auth:         &AuthHandler{},
		User:         &UserHandler{},
		Channel:      &ChannelHandler{},
		Conversation: &ConversationHandler{},
		WS:           &WSHandler{},
		Agent:        &AgentHandler{},
		AgentRunner:  &AgentRunnerHandler{},
		AgentRunTool: runTool,
		Connector:    &ConnectorHandler{},
		CodingTask:   &CodingTaskHandler{},
		Context:      &ContextHandler{},
		JWT:          jwtMgr,
		AppVersion:   "hconncov",
		AllowOrigins: []string{"*"},
	})
	if router == nil {
		t.Fatal("expected non-nil router")
	}

	routes := []struct{ method, path string }{
		// Agent SPA surface.
		{http.MethodGet, "/api/v1/agents"},
		{http.MethodPost, "/api/v1/agents"},
		{http.MethodPost, "/api/v1/agents/runner-token"},
		{http.MethodGet, "/api/v1/runs/thread"},
		{http.MethodGet, "/api/v1/runs/r1"},
		{http.MethodPost, "/api/v1/runs/r1/stop"},
		{http.MethodGet, "/api/v1/skills"},
		{http.MethodGet, "/api/v1/agents/gg/subscriptions"},
		{http.MethodGet, "/api/v1/channels/c1/watchers"},
		// Desktop-runner API.
		{http.MethodPost, "/api/v1/agent/runner/register"},
		{http.MethodPost, "/api/v1/agent/runner/claim"},
		{http.MethodPost, "/api/v1/agent/runner/runs/r1/events"},
		// Connector registry + per-user installs.
		{http.MethodGet, "/api/v1/connectors"},
		{http.MethodPost, "/api/v1/connectors"},
		{http.MethodPost, "/api/v1/connectors/sync"},
		{http.MethodPost, "/api/v1/connectors/s1/install"},
		{http.MethodPatch, "/api/v1/connectors/s1/install"},
		{http.MethodPost, "/api/v1/connectors/s1/verify"},
		{http.MethodDelete, "/api/v1/connectors/s1/install"},
		// Run-scoped tool API (incl. the connector run routes).
		{http.MethodGet, "/api/v1/agent/run/connectors"},
		{http.MethodPost, "/api/v1/agent/run/use-connector"},
		{http.MethodPost, "/api/v1/agent/run/messages"},
		{http.MethodGet, "/api/v1/agent/run/thread"},
		{http.MethodPost, "/api/v1/agent/run/approvals"},
		{http.MethodGet, "/api/v1/agent/run/skills"},
		// Coding tasks: run tools + human surface.
		{http.MethodPost, "/api/v1/agent/run/coding-task"},
		{http.MethodPost, "/api/v1/agent/run/coding-task/report"},
		{http.MethodGet, "/api/v1/coding-tasks/t1"},
		{http.MethodPost, "/api/v1/coding-tasks/t1/signoff"},
		{http.MethodGet, "/api/v1/channels/c1/coding-tasks"},
		{http.MethodGet, "/api/v1/coding-projects"},
		// Ex-wide workspace tools (registered because workspace is set).
		{http.MethodGet, "/api/v1/agent/run/channels"},
		{http.MethodPost, "/api/v1/agent/run/channels/c1/join"},
		{http.MethodGet, "/api/v1/agent/run/search"},
		{http.MethodPost, "/api/v1/agent/run/dm"},
		{http.MethodPost, "/api/v1/agent/run/notify"},
		// Shared context surface.
		{http.MethodGet, "/api/v1/context/channel/c1"},
		{http.MethodPost, "/api/v1/context/channel/c1"},
		{http.MethodPatch, "/api/v1/context/channel/c1/i1"},
		{http.MethodDelete, "/api/v1/context/channel/c1/i1"},
	}
	for _, rt := range routes {
		req := httptest.NewRequest(rt.method, rt.path, strings.NewReader("{}"))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code == http.StatusNotFound {
			t.Errorf("%s %s returned 404 — route not registered", rt.method, rt.path)
		}
	}
}
