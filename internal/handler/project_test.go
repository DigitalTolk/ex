package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// ---------------------------------------------------------------- fakes

type hProjectStore struct {
	projects map[string]*model.CodingProject
	screens  map[string]*model.ProjectScreen
	failList bool
}

func newHProjectStore() *hProjectStore {
	return &hProjectStore{projects: map[string]*model.CodingProject{}, screens: map[string]*model.ProjectScreen{}}
}

func (s *hProjectStore) CreateProject(_ context.Context, p *model.CodingProject) error {
	if _, ok := s.projects[p.Key]; ok {
		return store.ErrAlreadyExists
	}
	s.projects[p.Key] = p
	return nil
}
func (s *hProjectStore) UpdateProject(_ context.Context, p *model.CodingProject) error {
	s.projects[p.Key] = p
	return nil
}
func (s *hProjectStore) GetProject(_ context.Context, key string) (*model.CodingProject, error) {
	if p, ok := s.projects[key]; ok {
		cp := *p
		return &cp, nil
	}
	return nil, store.ErrNotFound
}
func (s *hProjectStore) ListProjects(context.Context) ([]*model.CodingProject, error) {
	if s.failList {
		return nil, errors.New("dynamo down")
	}
	var out []*model.CodingProject
	for _, p := range s.projects {
		out = append(out, p)
	}
	return out, nil
}
func (s *hProjectStore) DeleteProject(_ context.Context, key string) error {
	delete(s.projects, key)
	return nil
}
func (s *hProjectStore) PutScreen(_ context.Context, sc *model.ProjectScreen) error {
	cp := *sc
	s.screens[sc.ID] = &cp
	return nil
}
func (s *hProjectStore) GetScreen(_ context.Context, key, id string) (*model.ProjectScreen, error) {
	if sc, ok := s.screens[id]; ok && sc.ProjectKey == key {
		cp := *sc
		return &cp, nil
	}
	return nil, store.ErrNotFound
}
func (s *hProjectStore) ListScreens(_ context.Context, key string) ([]*model.ProjectScreen, error) {
	var out []*model.ProjectScreen
	for _, sc := range s.screens {
		if sc.ProjectKey == key {
			out = append(out, sc)
		}
	}
	return out, nil
}
func (s *hProjectStore) DeleteScreen(_ context.Context, _, id string) error {
	delete(s.screens, id)
	return nil
}
func (s *hProjectStore) PutProjectTheme(context.Context, *model.ProjectTheme) error { return nil }
func (s *hProjectStore) GetProjectTheme(context.Context, string) (*model.ProjectTheme, error) {
	return nil, store.ErrNotFound
}
func (s *hProjectStore) DeleteProjectTheme(context.Context, string) error { return nil }

type hProjectAtts struct{ byID map[string]*model.Attachment }

func (a *hProjectAtts) Get(_ context.Context, id string) (*model.Attachment, error) {
	if x, ok := a.byID[id]; ok {
		return x, nil
	}
	return nil, store.ErrNotFound
}
func (a *hProjectAtts) ValidateForUse(context.Context, string) error { return nil }
func (a *hProjectAtts) AddRef(context.Context, string, string) error { return nil }
func (a *hProjectAtts) RemoveRef(context.Context, string, string) error {
	return nil
}
func (a *hProjectAtts) LoadForPreview(_ context.Context, ids []string) []*model.Attachment {
	var out []*model.Attachment
	for _, id := range ids {
		if x, ok := a.byID[id]; ok {
			out = append(out, x)
		}
	}
	return out
}

func projectHandlerFixture() (*ProjectHandler, *hProjectStore) {
	st := newHProjectStore()
	atts := &hProjectAtts{byID: map[string]*model.Attachment{
		"img": {ID: "img", CreatedBy: "u-alice", ContentType: "image/png", Size: 10, URL: "/m/img"},
	}}
	return NewProjectHandler(service.NewProjectService(st, atts)), st
}

func projectReq(t *testing.T, h http.HandlerFunc, method, body string, role model.SystemRole, path map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "/x", rd)
	if role != "" {
		req = req.WithContext(middleware.ContextWithClaims(req.Context(), &model.TokenClaims{UserID: "u-alice", SystemRole: role}))
	}
	for k, v := range path {
		req.SetPathValue(k, v)
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func wantProjectStatus(t *testing.T, rec *httptest.ResponseRecorder, status int) map[string]any {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d: %s", rec.Code, status, rec.Body.String())
	}
	var m map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &m)
	return m
}

// The whole Projects page flow through the handlers: create → add screen →
// get → patch → edit screen → delete screen → delete project.
func TestProjectHandler_Lifecycle(t *testing.T) {
	h, st := projectHandlerFixture()
	member := model.SystemRoleMember
	key := map[string]string{"key": "acme"}

	m := wantProjectStatus(t, projectReq(t, h.Create, http.MethodPost, `{"name":"Acme","appURL":"https://acme.example.com"}`, member, nil), http.StatusCreated)
	if m["project"].(map[string]any)["key"] != "acme" {
		t.Fatalf("create: %v", m)
	}
	m = wantProjectStatus(t, projectReq(t, h.AddScreen, http.MethodPost, `{"page":"Home","description":"Landing","attachmentID":"img"}`, member, key), http.StatusCreated)
	screenID := m["screen"].(map[string]any)["id"].(string)

	m = wantProjectStatus(t, projectReq(t, h.Get, http.MethodGet, "", member, key), http.StatusOK)
	if m["canManage"] != true || len(m["screens"].([]any)) != 1 || m["screens"].([]any)[0].(map[string]any)["imageURL"] != "/m/img" {
		t.Fatalf("get: %v", m)
	}
	m = wantProjectStatus(t, projectReq(t, h.List, http.MethodGet, "", member, nil), http.StatusOK)
	if p := m["projects"].([]any)[0].(map[string]any); p["screenCount"] != float64(1) {
		t.Fatalf("list: %v", m)
	}
	m = wantProjectStatus(t, projectReq(t, h.Update, http.MethodPatch, `{"designNotes":"Font: Inter"}`, member, key), http.StatusOK)
	if m["project"].(map[string]any)["designNotes"] != "Font: Inter" {
		t.Fatalf("update: %v", m)
	}
	sk := map[string]string{"key": "acme", "id": screenID}
	m = wantProjectStatus(t, projectReq(t, h.UpdateScreen, http.MethodPatch, `{"viewport":"mobile"}`, member, sk), http.StatusOK)
	if m["screen"].(map[string]any)["viewport"] != "mobile" {
		t.Fatalf("update screen: %v", m)
	}
	wantProjectStatus(t, projectReq(t, h.DeleteScreen, http.MethodDelete, "", member, sk), http.StatusNoContent)
	if len(st.screens) != 0 {
		t.Fatal("screen not deleted")
	}
	wantProjectStatus(t, projectReq(t, h.Delete, http.MethodDelete, "", member, key), http.StatusNoContent)
	if len(st.projects) != 0 {
		t.Fatal("project not deleted")
	}
}

func TestProjectHandler_Errors(t *testing.T) {
	h, st := projectHandlerFixture()
	member, guest := model.SystemRoleMember, model.SystemRoleGuest
	key := map[string]string{"key": "acme"}
	sk := map[string]string{"key": "acme", "id": "nope"}
	wantProjectStatus(t, projectReq(t, h.Create, http.MethodPost, `{"name":"Acme"}`, member, nil), http.StatusCreated)

	cases := []struct {
		name   string
		h      http.HandlerFunc
		method string
		body   string
		role   model.SystemRole
		path   map[string]string
		status int
	}{
		{"list as guest", h.List, http.MethodGet, "", guest, nil, http.StatusForbidden},
		{"get missing", h.Get, http.MethodGet, "", member, map[string]string{"key": "nope"}, http.StatusNotFound},
		{"create bad json", h.Create, http.MethodPost, `{`, member, nil, http.StatusBadRequest},
		{"create unknown field", h.Create, http.MethodPost, `{"name":"X","bogus":1}`, member, nil, http.StatusBadRequest},
		{"create duplicate", h.Create, http.MethodPost, `{"name":"ACME"}`, member, nil, http.StatusConflict},
		{"create invalid", h.Create, http.MethodPost, `{"name":"X","appURL":"nope"}`, member, nil, http.StatusBadRequest},
		{"update bad json", h.Update, http.MethodPatch, `[`, member, key, http.StatusBadRequest},
		{"update missing", h.Update, http.MethodPatch, `{}`, member, map[string]string{"key": "nope"}, http.StatusNotFound},
		{"delete as guest", h.Delete, http.MethodDelete, "", guest, key, http.StatusForbidden},
		{"add screen bad json", h.AddScreen, http.MethodPost, `x`, member, key, http.StatusBadRequest},
		{"add screen invalid", h.AddScreen, http.MethodPost, `{"page":"P"}`, member, key, http.StatusBadRequest},
		{"update screen bad json", h.UpdateScreen, http.MethodPatch, `x`, member, sk, http.StatusBadRequest},
		{"update screen missing", h.UpdateScreen, http.MethodPatch, `{}`, member, sk, http.StatusNotFound},
		{"delete screen missing", h.DeleteScreen, http.MethodDelete, "", member, sk, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wantProjectStatus(t, projectReq(t, tc.h, tc.method, tc.body, tc.role, tc.path), tc.status)
		})
	}

	st.failList = true
	wantProjectStatus(t, projectReq(t, h.List, http.MethodGet, "", member, nil), http.StatusInternalServerError)
	// No claims at all: the service refuses the anonymous caller.
	wantProjectStatus(t, projectReq(t, h.List, http.MethodGet, "", "", nil), http.StatusForbidden)
}

// A run about a project may download that project's reference screenshots —
// files that live on the Projects page, not in any message the invoker sees.
// Other runs still get 404 for the same file.
func TestAgentAttachment_DownloadProjectScreen(t *testing.T) {
	var fx *hrunnerCovFix
	setup := func(t *testing.T, projectKey string) *httptest.ResponseRecorder {
		t.Helper()
		fx = hrunnerCovNewFix(t)
		_, st, signer := withAttachments(fx)
		pst := newHProjectStore()
		pst.projects["acme"] = &model.CodingProject{Key: "acme", Name: "Acme"}
		pst.screens["sc1"] = &model.ProjectScreen{ID: "sc1", ProjectKey: "acme", AttachmentID: "shot"}
		fx.orch.SetProjects(service.NewProjectService(pst, &hProjectAtts{}))
		fx.addRun(&model.Run{ProjectKey: projectKey})
		signer.objects["attachments/shot"] = []byte("png-bytes")
		st.byID["shot"] = &model.Attachment{ID: "shot", S3Key: "attachments/shot", CreatedBy: "someone-else",
			MessageIDs: []string{model.ScreenAttachmentRef("sc1")}, Filename: "home.png", ContentType: "image/png", Size: 9}
		return hrunnerCovDo(t, fx.toolH.DownloadAttachment, http.MethodGet, "", hrunnerCovToolClaims(hrunnerCovRunID), map[string]string{"id": "shot"})
	}
	rec := setup(t, "acme")
	hrunnerCovWantStatus(t, rec, http.StatusOK)
	if rec.Body.String() != "png-bytes" || rec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("screen download: %q %v", rec.Body.String(), rec.Header())
	}
	// The drawer learns what the agent looked at: one file_fetched event.
	var fetched []map[string]any
	for _, e := range fx.runs.events {
		if e.Type == "workspace.file_fetched" {
			fetched = append(fetched, e.Payload)
		}
	}
	if len(fetched) != 1 || fetched[0]["attachmentID"] != "shot" || fetched[0]["source"] != "project_screen" || fetched[0]["filename"] != "home.png" {
		t.Fatalf("fetch not recorded for the drawer: %+v", fetched)
	}
	hrunnerCovWantStatus(t, setup(t, ""), http.StatusNotFound)
	hrunnerCovWantStatus(t, setup(t, "other"), http.StatusNotFound)
}
