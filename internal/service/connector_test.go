package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// memConnectorStore is an in-memory connectorStore for tests.
type memConnectorStore struct {
	connectors map[string]*model.Connector
	files      map[string][]model.ConnectorFile
	installs   map[string]*model.ConnectorInstall // userID#slug
}

func newMemConnectorStore() *memConnectorStore {
	return &memConnectorStore{
		connectors: map[string]*model.Connector{},
		files:      map[string][]model.ConnectorFile{},
		installs:   map[string]*model.ConnectorInstall{},
	}
}

func (m *memConnectorStore) PutConnector(_ context.Context, c *model.Connector, files []model.ConnectorFile) error {
	cp := *c
	m.connectors[c.Slug] = &cp
	m.files[c.Slug] = files
	return nil
}

func (m *memConnectorStore) GetConnector(_ context.Context, slug string) (*model.Connector, error) {
	c, ok := m.connectors[slug]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *c
	return &cp, nil
}

func (m *memConnectorStore) ListConnectors(_ context.Context) ([]*model.Connector, error) {
	out := make([]*model.Connector, 0, len(m.connectors))
	for _, c := range m.connectors {
		cp := *c
		out = append(out, &cp)
	}
	return out, nil
}

func (m *memConnectorStore) GetConnectorFiles(_ context.Context, slug string) ([]model.ConnectorFile, error) {
	return m.files[slug], nil
}

func (m *memConnectorStore) PutInstall(_ context.Context, in *model.ConnectorInstall) error {
	cp := *in
	m.installs[in.UserID+"#"+in.ConnectorSlug] = &cp
	return nil
}

func (m *memConnectorStore) GetInstall(_ context.Context, userID, slug string) (*model.ConnectorInstall, error) {
	in, ok := m.installs[userID+"#"+slug]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *in
	return &cp, nil
}

func (m *memConnectorStore) ListInstalls(_ context.Context, userID string) ([]*model.ConnectorInstall, error) {
	out := []*model.ConnectorInstall{}
	for _, in := range m.installs {
		if in.UserID == userID {
			cp := *in
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (m *memConnectorStore) DeleteInstall(_ context.Context, userID, slug string) error {
	delete(m.installs, userID+"#"+slug)
	return nil
}

func seedConnector(t *testing.T, svc *ConnectorService, slug, authKind, tokenURL, verifyURL string) {
	t.Helper()
	_, err := svc.Ingest(context.Background(), "u-admin", IngestInput{
		Slug: slug, Title: slug, BaseURL: "https://api.example.com",
		AuthKind: authKind, TokenURL: tokenURL, ClientID: "client-1", VerifyURL: verifyURL,
		Files: []model.ConnectorFile{
			{Name: "index.yml", Content: "schema: 1"},
			{Name: "_catalog.tsv", Content: "a.b\tGET x\tread-only\tuser\tList\t"},
		},
	})
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
}

// Paste install verifies the token and records who it belongs to.
func TestConnector_InstallPasteVerified(t *testing.T) {
	verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok-1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"employee": map[string]any{"name": "Alice A"}})
	}))
	defer verify.Close()

	svc := NewConnectorService(newMemConnectorStore())
	seedConnector(t, svc, "cliffhub", model.ConnectorAuthPaste, "", verify.URL)

	inst, err := svc.Install(context.Background(), "u-alice", "cliffhub", InstallInput{Token: "tok-1"})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if inst.Status != model.ConnectorStatusConnected || inst.ConnectedAs != "Alice A" {
		t.Fatalf("got status=%s connectedAs=%q", inst.Status, inst.ConnectedAs)
	}

	// A definite 401 rejects the credential outright.
	if _, err := svc.Install(context.Background(), "u-alice", "cliffhub", InstallInput{Token: "wrong"}); !errors.Is(err, ErrTokenRejected) {
		t.Fatalf("want ErrTokenRejected, got %v", err)
	}
}

// An unreachable verify endpoint must NOT block installing — the token is
// accepted as "unverified" (the staging VPN may simply be invisible to the
// server).
func TestConnector_InstallVerifyUnreachableIsLenient(t *testing.T) {
	svc := NewConnectorService(newMemConnectorStore())
	seedConnector(t, svc, "cliffhub", model.ConnectorAuthPaste, "", "http://127.0.0.1:1/nope")

	inst, err := svc.Install(context.Background(), "u-alice", "cliffhub", InstallInput{Token: "tok-x"})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if inst.Status != model.ConnectorStatusUnverified {
		t.Fatalf("want unverified, got %s", inst.Status)
	}
}

// Password-kind connectors exchange email/password for a token server-side
// (DT auth contract), then verify. A two_factor response surfaces as a
// challenge carrying the access code for the second round.
func TestConnector_InstallPasswordGrantAndTwoFactor(t *testing.T) {
	var gotGrant map[string]string
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotGrant = body
		switch body["grant_type"] {
		case "password":
			if body["username"] == "needs2fa@x.com" {
				_ = json.NewEncoder(w).Encode(map[string]any{"token_type": "two_factor", "access_code": "ac-99"})
				return
			}
			if body["password"] != "right" {
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{"message": "The user credentials were incorrect."})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"token_type": "Bearer", "access_token": "tok-pw", "expires_in": 3600})
		case "two_factor":
			if body["access_code"] == "ac-99" && body["code"] == "123456" {
				_ = json.NewEncoder(w).Encode(map[string]any{"token_type": "Bearer", "access_token": "tok-2fa"})
				return
			}
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"message": "bad code"})
		}
	}))
	defer auth.Close()
	verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"user": map[string]any{"name": "Core User"}}})
	}))
	defer verify.Close()

	svc := NewConnectorService(newMemConnectorStore())
	seedConnector(t, svc, "core", model.ConnectorAuthPassword, auth.URL, verify.URL)

	// Wrong password → legible login failure.
	if _, err := svc.Install(context.Background(), "u-a", "core", InstallInput{Email: "a@x.com", Password: "wrong"}); !errors.Is(err, ErrLoginFailed) {
		t.Fatalf("want ErrLoginFailed, got %v", err)
	}

	// Happy path.
	inst, err := svc.Install(context.Background(), "u-a", "core", InstallInput{Email: "a@x.com", Password: "right"})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if inst.Status != model.ConnectorStatusConnected || inst.ConnectedAs != "Core User" {
		t.Fatalf("got %+v", inst)
	}
	if gotGrant["client_id"] != "client-1" {
		t.Fatalf("client_id not sent: %v", gotGrant)
	}

	// 2FA: first call returns the challenge, second call with the code lands.
	_, err = svc.Install(context.Background(), "u-b", "core", InstallInput{Email: "needs2fa@x.com", Password: "right"})
	if !errors.Is(err, ErrTwoFactorRequired) {
		t.Fatalf("want ErrTwoFactorRequired, got %v", err)
	}
	access := TwoFactorAccessCode(err)
	if access != "ac-99" {
		t.Fatalf("access code = %q", access)
	}
	inst, err = svc.Install(context.Background(), "u-b", "core", InstallInput{TwoFactorCode: "123456", AccessCode: access})
	if err != nil {
		t.Fatalf("2fa install: %v", err)
	}
	if inst.Token != "tok-2fa" {
		t.Fatalf("token = %q", inst.Token)
	}
}

// ForRunner ships only what the invoker installed, with the env prefix and
// docs bundle; paste-only connectors without a token can't exist (install
// requires one).
func TestConnector_ForRunnerShipsInstalledBundles(t *testing.T) {
	svc := NewConnectorService(newMemConnectorStore())
	seedConnector(t, svc, "cliffhub", model.ConnectorAuthPaste, "", "")
	seedConnector(t, svc, "core", model.ConnectorAuthPaste, "", "")

	if _, err := svc.Install(context.Background(), "u-alice", "cliffhub", InstallInput{Token: "tok-ch"}); err != nil {
		t.Fatalf("install: %v", err)
	}

	rows, err := svc.ForRunner(context.Background(), "u-alice")
	if err != nil {
		t.Fatalf("forRunner: %v", err)
	}
	if len(rows) != 1 || rows[0].Slug != "cliffhub" {
		t.Fatalf("rows = %+v", rows)
	}
	// 2 bundle files + the server-generated _USAGE.md (injected when the
	// bundle doesn't ship its own).
	if rows[0].EnvPrefix != "CLIFFHUB" || rows[0].Token != "tok-ch" || len(rows[0].Files) != 3 {
		t.Fatalf("row = %+v", rows[0])
	}
	last := rows[0].Files[len(rows[0].Files)-1]
	if last.Name != "_USAGE.md" || !strings.Contains(last.Content, "connector_call") {
		t.Fatalf("expected generated _USAGE.md, got %s", last.Name)
	}

	// Nothing installed → nothing shipped.
	rows, err = svc.ForRunner(context.Background(), "u-bob")
	if err != nil || len(rows) != 0 {
		t.Fatalf("bob rows = %v err = %v", rows, err)
	}
}

// Picked tokens are rewritten to bare names in the prompt (a leading "/slug"
// would read as a harness slash command); unpicked slashes stay untouched.
func TestStripConnectorTokens(t *testing.T) {
	cases := []struct {
		body  string
		slugs []string
		want  string
	}{
		{"/cliffhub find me details about habib", []string{"cliffhub"}, "cliffhub find me details about habib"},
		{"@gg /core bookings today and /cliffhub tasks", []string{"core", "cliffhub"}, "@gg core bookings today and cliffhub tasks"},
		{"check /tmp/foo and 1/2", []string{"cliffhub"}, "check /tmp/foo and 1/2"},
		{"/unknown stays as typed", nil, "/unknown stays as typed"},
	}
	for _, c := range cases {
		if got := stripConnectorTokens(c.body, c.slugs); got != c.want {
			t.Errorf("strip(%q, %v) = %q, want %q", c.body, c.slugs, got, c.want)
		}
	}
}

// The composer's /connector picks parse from the message body; word-internal
// slashes (URLs, paths) never match.
func TestParseConnectorTokens(t *testing.T) {
	cases := []struct {
		body string
		want []string
	}{
		{"@gg /cliffhub how many open tasks?", []string{"cliffhub"}},
		{"/core list today's bookings /cliffhub too", []string{"core", "cliffhub"}},
		{"see https://example.com/path and a/b — no picks", nil},
		{"ratio 1/2 looks fine", nil},
		{"/cliffhub /cliffhub dedupe", []string{"cliffhub"}},
		{"plain message", nil},
	}
	for _, c := range cases {
		got := parseConnectorTokens(c.body)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("parse(%q) = %v, want %v", c.body, got, c.want)
		}
	}
}

// The services: manifest is validated both directions at ingest — a stale
// entry (file gone) and an unlisted service file are both rejected; a parsed
// manifest lands on the connector for hierarchy-first lookup.
func TestConnector_IngestServicesManifest(t *testing.T) {
	svc := NewConnectorService(newMemConnectorStore())
	base := IngestInput{
		Slug: "hub", Title: "Hub", BaseURL: "https://api.example.com",
		AuthKind: model.ConnectorAuthPaste,
	}

	manifest := "schema: 1\nservices:\n- file: leave.yaml\n  service: leave\n  endpoints: 2\n  description: Leave management\n"

	good := base
	good.Files = []model.ConnectorFile{
		{Name: "index.yml", Content: manifest},
		{Name: "leave.yaml", Content: "service: leave"},
		{Name: "_enums.yaml", Content: "x: 1"},
	}
	c, err := svc.Ingest(context.Background(), "u-admin", good)
	if err != nil {
		t.Fatalf("good bundle rejected: %v", err)
	}
	if len(c.Services) != 1 || c.Services[0].Name != "leave" || c.Services[0].File != "leave.yaml" {
		t.Fatalf("services not parsed: %+v", c.Services)
	}

	stale := base
	stale.Files = []model.ConnectorFile{{Name: "index.yml", Content: manifest}}
	if _, err := svc.Ingest(context.Background(), "u-admin", stale); err == nil {
		t.Fatal("stale manifest entry (leave.yaml missing) not rejected")
	}

	unlisted := base
	unlisted.Files = []model.ConnectorFile{
		{Name: "index.yml", Content: manifest},
		{Name: "leave.yaml", Content: "service: leave"},
		{Name: "work.yaml", Content: "service: work"},
	}
	if _, err := svc.Ingest(context.Background(), "u-admin", unlisted); err == nil {
		t.Fatal("unlisted service file (work.yaml) not rejected")
	}

	// No manifest at all stays legal (tiny hand-rolled bundles).
	bare := base
	bare.Files = []model.ConnectorFile{{Name: "notes.md", Content: "hi"}}
	if c, err := svc.Ingest(context.Background(), "u-admin", bare); err != nil || len(c.Services) != 0 {
		t.Fatalf("bare bundle: err=%v services=%+v", err, c.Services)
	}
}

// The catalog is derived at ingest when the bundle doesn't ship one, and each
// service records the route_id prefixes its endpoints actually use.
func TestConnector_IngestGeneratesCatalog(t *testing.T) {
	svc := NewConnectorService(newMemConnectorStore())
	leaveYaml := `service: tasks
endpoints:
- id: work.tasks.index
  method: GET
  path: api/work/tasks
  summary: "List and filter	tasks"
  keywords: [todo, assigned]
- id: work.tasks.store
  method: POST
  path: api/work/tasks
  side_effects: creates
  summary: Create a task
`
	c, err := svc.Ingest(context.Background(), "u-admin", IngestInput{
		Slug: "hub2", Title: "Hub2", BaseURL: "https://api.example.com",
		AuthKind: model.ConnectorAuthPaste,
		Files: []model.ConnectorFile{
			{Name: "index.yml", Content: "services:\n- file: tasks-and-stories.yaml\n  service: tasks_and_stories\n"},
			{Name: "tasks-and-stories.yaml", Content: leaveYaml},
		},
	})
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if len(c.Services) != 1 || len(c.Services[0].RoutePrefixes) != 1 || c.Services[0].RoutePrefixes[0] != "work" {
		t.Fatalf("route prefixes not derived: %+v", c.Services)
	}
	files, err := svc.store.GetConnectorFiles(context.Background(), "hub2")
	if err != nil {
		t.Fatalf("files: %v", err)
	}
	var catalog string
	for _, f := range files {
		if f.Name == "_catalog.tsv" {
			catalog = f.Content
		}
	}
	if catalog == "" {
		t.Fatal("catalog not generated")
	}
	lines := strings.Split(strings.TrimSpace(catalog), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 catalog rows, got %d: %q", len(lines), catalog)
	}
	first := strings.Split(lines[0], "\t")
	if len(first) != 6 || first[0] != "work.tasks.index" || first[1] != "GET api/work/tasks" || first[2] != "read-only" || first[3] != "user" {
		t.Fatalf("bad catalog row: %q", lines[0])
	}
	if strings.Contains(first[4], "\t") {
		t.Fatalf("summary not sanitized: %q", first[4])
	}
}

// Anonymous (auth kind "none") connectors install with no credential: verify
// runs unauthenticated, no identity is captured, empty token is legal.
func TestConnector_InstallAnonymous(t *testing.T) {
	verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("anonymous verify sent Authorization %q", r.Header.Get("Authorization"))
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{{"repoName": "gitlab/x"}})
	}))
	defer verify.Close()

	svc := NewConnectorService(newMemConnectorStore())
	_, err := svc.Ingest(context.Background(), "u-admin", IngestInput{
		Slug: "anon", Title: "Anon", BaseURL: "https://api.example.com",
		AuthKind: model.ConnectorAuthNone, VerifyURL: verify.URL,
		Files: []model.ConnectorFile{{Name: "index.yml", Content: "schema: 1"}},
	})
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	inst, err := svc.Install(context.Background(), "u-1", "anon", InstallInput{})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if inst.Status != model.ConnectorStatusConnected {
		t.Fatalf("status = %q, want connected", inst.Status)
	}
	if inst.Identity != "" {
		t.Fatalf("anonymous install captured identity: %q", inst.Identity)
	}
}
