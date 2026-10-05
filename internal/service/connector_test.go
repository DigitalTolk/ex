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
	"time"
)

// memConnectorStore is an in-memory connectorStore for tests.
type memConnectorStore struct {
	connectors map[string]*model.Connector
	files      map[string][]model.ConnectorFile
	installs   map[string]*model.ConnectorInstall // userID#slug
	// failListInstalls fails install listing (server-engine connector-load arm).
	failListInstalls error
	// failListConnectors fails registry listing (sync revision-map arm).
	failListConnectors error
	// failPutInstall fails install writes — the arms where recording an
	// expiry (or a successful re-verify) loses the race with the store.
	failPutInstall error
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
	if m.failListConnectors != nil {
		return nil, m.failListConnectors
	}
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
	if m.failPutInstall != nil {
		return m.failPutInstall
	}
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
	if m.failListInstalls != nil {
		return nil, m.failListInstalls
	}
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

// A connector whose credential is an API key (Metabase) verifies and later
// calls with THAT header — never Authorization: Bearer — and a template that
// could inject a second header is refused at ingest.
func TestConnector_InstallPasteCustomAuthHeader(t *testing.T) {
	verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("custom-header connector sent Authorization %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("X-Api-Key") != "mb_key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"common_name": "Analytics Bot", "email": "bot@example.com"})
	}))
	defer verify.Close()

	svc := NewConnectorService(newMemConnectorStore())
	if _, err := svc.Ingest(context.Background(), "u-admin", IngestInput{
		Slug: "metabase", Title: "Metabase", BaseURL: "https://mb.example.net/api",
		AuthKind: model.ConnectorAuthPaste, VerifyURL: verify.URL, AuthHeader: " X-Api-Key: {token} ",
		Files: []model.ConnectorFile{{Name: "index.yml", Content: "schema: 1"}},
	}); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	c, _ := svc.store.GetConnector(context.Background(), "metabase")
	if c.AuthHeader != "X-Api-Key: {token}" {
		t.Fatalf("authHeader not stored/trimmed: %q", c.AuthHeader)
	}
	inst, err := svc.Install(context.Background(), "u-alice", "metabase", InstallInput{Token: "mb_key"})
	if err != nil || inst.Status != model.ConnectorStatusConnected {
		t.Fatalf("install with API key: %v %+v", err, inst)
	}
	if _, err := svc.Install(context.Background(), "u-alice", "metabase", InstallInput{Token: "nope"}); !errors.Is(err, ErrTokenRejected) {
		t.Fatalf("wrong key must be rejected, got %v", err)
	}
	// The runner payload carries the template so connector_call matches.
	rows, err := svc.ForRunner(context.Background(), "u-alice", []string{"metabase"})
	if err != nil || len(rows) != 1 || rows[0].AuthHeader != "X-Api-Key: {token}" || rows[0].Token != "mb_key" {
		t.Fatalf("runner payload must carry authHeader: %v %+v", err, rows)
	}
	// Header injection is refused at ingest.
	if _, err := svc.Ingest(context.Background(), "u-admin", IngestInput{
		Slug: "evil", Title: "Evil", BaseURL: "https://e.example.net", AuthKind: model.ConnectorAuthPaste,
		AuthHeader: "X-Api-Key: {token}\r\nX-Admin: 1",
		Files:      []model.ConnectorFile{{Name: "index.yml", Content: "schema: 1"}},
	}); !errors.Is(err, ErrConnectorInvalid) {
		t.Fatalf("multi-line authHeader must be ErrConnectorInvalid, got %v", err)
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

	rows, err := svc.ForRunner(context.Background(), "u-alice", []string{"cliffhub", "core"})
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
	rows, err = svc.ForRunner(context.Background(), "u-bob", []string{"cliffhub"})
	if err != nil || len(rows) != 0 {
		t.Fatalf("bob rows = %v err = %v", rows, err)
	}
	// No picks → nothing fetched at all: the run may touch no service.
	rows, err = svc.ForRunner(context.Background(), "u-alice", nil)
	if err != nil || len(rows) != 0 {
		t.Fatalf("unpicked rows = %v err = %v", rows, err)
	}
	// An install the run did NOT pick is never bundled.
	rows, err = svc.ForRunner(context.Background(), "u-alice", []string{"core"})
	if err != nil || len(rows) != 0 {
		t.Fatalf("non-picked rows = %v err = %v", rows, err)
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

// The services: manifest at ingest: a stale entry (file gone) is rejected, but
// a shipped service file the manifest doesn't list is skipped (not rejected) —
// it just doesn't appear in the hierarchy, and the rest of the connector still
// ingests. A parsed manifest lands on the connector for hierarchy-first lookup.
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

	// A shipped file the manifest doesn't list must NOT fail ingest — the
	// connector still lands, work.yaml is simply absent from the hierarchy.
	unlisted := base
	unlisted.Files = []model.ConnectorFile{
		{Name: "index.yml", Content: manifest},
		{Name: "leave.yaml", Content: "service: leave"},
		{Name: "work.yaml", Content: "service: work"},
	}
	uc, err := svc.Ingest(context.Background(), "u-admin", unlisted)
	if err != nil {
		t.Fatalf("unlisted service file must not fail ingest: %v", err)
	}
	if len(uc.Services) != 1 || uc.Services[0].File != "leave.yaml" {
		t.Fatalf("only listed services should surface, got: %+v", uc.Services)
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
	// The provider is the canonical emitter and this fallback matches it
	// byte-for-byte: six columns, missing fields left EMPTY (no invented
	// defaults), keywords space-joined, rows sorted by id.
	first := strings.Split(lines[0], "\t")
	if len(first) != 6 || first[0] != "work.tasks.index" || first[1] != "GET api/work/tasks" {
		t.Fatalf("bad catalog row: %q", lines[0])
	}
	if strings.Contains(first[4], "\t") {
		t.Fatalf("summary not sanitized: %q", first[4])
	}
	if strings.Contains(first[5], ",") {
		t.Fatalf("keywords must be space-joined like the provider's: %q", first[5])
	}
	if lines[0] > lines[1] {
		t.Fatalf("catalog rows must be sorted by id: %q", catalog)
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

// sso_window connectors: startURL is required, SSRF-gated like every other
// stored URL, and the captured-token install rides the paste path unchanged.
func TestIngest_SSOWindow(t *testing.T) {
	svc := NewConnectorService(newMemConnectorStore())
	base := IngestInput{
		Slug: "hub", Title: "Hub", BaseURL: "https://hub.example.net",
		AuthKind: model.ConnectorAuthSSOWindow,
		Files:    []model.ConnectorFile{{Name: "index.yml", Content: "title: Hub"}},
	}

	if _, err := svc.Ingest(context.Background(), "admin", base); !errors.Is(err, ErrConnectorInvalid) || !strings.Contains(err.Error(), "startURL") {
		t.Fatalf("missing startURL: %v", err)
	}

	AllowPrivateConnectorTargets(false)
	bad := base
	bad.StartURL = "http://hub.example.net/api/auth/microsoft"
	_, err := svc.Ingest(context.Background(), "admin", bad)
	AllowPrivateConnectorTargets(true)
	if !errors.Is(err, ErrConnectorInvalid) || !strings.Contains(err.Error(), "startURL") {
		t.Fatalf("plain-http startURL must be refused: %v", err)
	}

	good := base
	good.StartURL = "https://hub.example.net/api/auth/microsoft"
	good.CapturePattern = "/callback?token={token}"
	c, err := svc.Ingest(context.Background(), "admin", good)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if c.StartURL != good.StartURL || c.CapturePattern != good.CapturePattern || c.AuthKind != model.ConnectorAuthSSOWindow {
		t.Fatalf("sso fields not stored: %+v", c)
	}
}

// The paste field's "where do I get this?" line comes WITH the registration,
// so each service words its own. It is rendered as a link the user is invited
// to click, which puts credentialURL on the same SSRF/phishing gate as every
// other stored URL, and the hint on a length bound — it is one line under a
// form field, not a second copy of the docs.
func TestIngest_CredentialHint(t *testing.T) {
	svc := NewConnectorService(newMemConnectorStore())
	base := IngestInput{
		Slug: "git", Title: "Git", BaseURL: "https://git.example.net/api/v4",
		AuthKind: model.ConnectorAuthPaste,
		Files:    []model.ConnectorFile{{Name: "index.yml", Content: "title: Git"}},
	}

	long := base
	long.CredentialHint = strings.Repeat("x", model.ConnectorCredentialHintMaxLen+1)
	if _, err := svc.Ingest(context.Background(), "admin", long); !errors.Is(err, ErrConnectorInvalid) ||
		!strings.Contains(err.Error(), "credentialHint") {
		t.Fatalf("overlong hint must be refused: %v", err)
	}

	AllowPrivateConnectorTargets(false)
	bad := base
	bad.CredentialURL = "http://git.example.net/-/user_settings/personal_access_tokens"
	_, err := svc.Ingest(context.Background(), "admin", bad)
	AllowPrivateConnectorTargets(true)
	if !errors.Is(err, ErrConnectorInvalid) || !strings.Contains(err.Error(), "credentialURL") {
		t.Fatalf("plain-http credentialURL must be refused: %v", err)
	}

	good := base
	good.CredentialHint = "  Preferences → Access tokens, with the read_api scope.  "
	good.CredentialURL = " https://git.example.net/-/user_settings/personal_access_tokens "
	c, err := svc.Ingest(context.Background(), "admin", good)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if c.CredentialHint != strings.TrimSpace(good.CredentialHint) || c.CredentialURL != strings.TrimSpace(good.CredentialURL) {
		t.Fatalf("credential hint not stored trimmed: %q / %q", c.CredentialHint, c.CredentialURL)
	}
}

// A service that finishes its Microsoft sign-in server-side hands back a
// SESSION, not a token: the shell lifts a named cookie out of the sign-in
// window. The name reaches Electron's cookie lookup, so it is validated as an
// HTTP token here rather than passed through.
func TestIngest_CaptureCookie(t *testing.T) {
	svc := NewConnectorService(newMemConnectorStore())
	base := IngestInput{
		Slug: "crm", Title: "CRM", BaseURL: "https://crm.example.net",
		AuthKind: model.ConnectorAuthSSOWindow,
		StartURL: "https://crm.example.net/api/auth/microsoft",
		Files:    []model.ConnectorFile{{Name: "index.yml", Content: "title: CRM"}},
	}

	bad := base
	bad.CaptureCookie = "connect.sid; HttpOnly"
	if _, err := svc.Ingest(context.Background(), "admin", bad); !errors.Is(err, ErrConnectorInvalid) ||
		!strings.Contains(err.Error(), "captureCookie") {
		t.Fatalf("a cookie name that is not a token must be refused: %v", err)
	}

	good := base
	good.CaptureCookie = "  connect.sid  "
	good.AuthHeader = "Cookie: connect.sid={token}"
	c, err := svc.Ingest(context.Background(), "admin", good)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if c.CaptureCookie != "connect.sid" {
		t.Fatalf("captureCookie not stored trimmed: %q", c.CaptureCookie)
	}
}

// displayName prefers a human label over a synthetic address: Metabase's API
// keys report common_name (the key's name) and an "@api-key.invalid" email.
func TestConnector_DisplayNameShapes(t *testing.T) {
	cases := map[string]string{
		`{"employee":{"name":"Alice A"}}`:                                                     "Alice A",
		`{"data":{"user":{"name":"Bob"}}}`:                                                    "Bob",
		`{"name":"Carol","email":"c@x.com"}`:                                                  "Carol",
		`{"common_name":"Test","first_name":"Test","email":"api-key-user-1@api-key.invalid"}`: "Test",
		`{"first_name":"Dana","last_name":"Diaz","email":"d@x.com"}`:                          "Dana Diaz",
		`{"first_name":"Solo","last_name":"","email":"s@x.com"}`:                              "Solo",
		`{"display_name":"  Eve  "}`:                                                          "Eve",
		`{"email":"only@x.com"}`:                                                              "only@x.com",
		`{"email":"api-key-user-9373@api-key.invalid"}`:                                       "API key",
		`{"first_name":"","last_name":"","email":"k@API-KEY.INVALID"}`:                        "API key",
		`{"email":"svc@bot.example"}`:                                                         "API key",
		`{"email":"nobody@localhost"}`:                                                        "API key",
		`{"email":"real@example.com"}`:                                                        "real@example.com",
		`{"name":""}`:                                                                         "",
		`[1,2]`:                                                                               "",
		`not json`:                                                                            "",
	}
	for raw, want := range cases {
		if got := displayName([]byte(raw)); got != want {
			t.Errorf("displayName(%s) = %q, want %q", raw, got, want)
		}
	}
}

// expiryPromptRecorder captures the reconnect prompts a dying credential raises.
type expiryPromptRecorder struct{ notes []Notification }

func (r *expiryPromptRecorder) NotifyDirect(_ context.Context, _ string, n Notification) {
	r.notes = append(r.notes, n)
}

// A credential the service starts refusing must stop reaching agents, say so
// in the row, and tell its owner ONCE — the three things that were missing
// when an expired session surfaced only as a bare "HTTP 401" mid-task.
func TestConnectorExpiry_WithheldRecordedAndAnnouncedOnce(t *testing.T) {
	st := newMemConnectorStore()
	svc := NewConnectorService(st)
	note := &expiryPromptRecorder{}
	svc.SetExpiryNotifier(note)

	live := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if live {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"name":"Alice"}`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	ctx := context.Background()
	st.connectors["crm"] = &model.Connector{
		Slug: "crm", Title: "CRM", BaseURL: srv.URL, VerifyURL: srv.URL + "/me",
		AuthKind: model.ConnectorAuthPaste, FileNames: []string{"a.yaml"},
	}
	st.files["crm"] = []model.ConnectorFile{{Slug: "crm", Name: "a.yaml", Content: "x"}}
	if _, err := svc.Install(ctx, "u-1", "crm", InstallInput{Token: "tok"}); err != nil {
		t.Fatalf("install: %v", err)
	}

	// While it is live the run gets the credential and no one is bothered.
	got, err := svc.ForRunner(ctx, "u-1", []string{"crm"})
	if err != nil || len(got) != 1 || got[0].Token != "tok" {
		t.Fatalf("live run should carry the credential: %v %+v", err, got)
	}
	if len(note.notes) != 0 {
		t.Fatalf("a live connector must not notify: %+v", note.notes)
	}

	// The session dies. The TTL is what makes a run re-prove it.
	live = false
	inst, _ := st.GetInstall(ctx, "u-1", "crm")
	inst.VerifiedAt = time.Now().Add(-2 * verifyTTL)
	if err := st.PutInstall(ctx, inst); err != nil {
		t.Fatalf("age the install: %v", err)
	}

	got, err = svc.ForRunner(ctx, "u-1", []string{"crm"})
	if err != nil {
		t.Fatalf("ForRunner: %v", err)
	}
	if len(got) != 0 {
		t.Fatal("a refused credential must not reach an agent")
	}
	after, _ := st.GetInstall(ctx, "u-1", "crm")
	if after.Status != model.ConnectorStatusExpired {
		t.Fatalf("status = %q, want expired", after.Status)
	}
	if titles := svc.ExpiredFor(ctx, "u-1", []string{"crm"}); len(titles) != 1 || titles[0] != "CRM" {
		t.Fatalf("ExpiredFor = %v, want [CRM]", titles)
	}
	if len(note.notes) != 1 || note.notes[0].Kind != NotificationKindConnectorExpired {
		t.Fatalf("one reconnect prompt expected, got %+v", note.notes)
	}

	// Still dead on the next run: withheld again, but NOT announced again.
	if _, err := svc.ForRunner(ctx, "u-1", []string{"crm"}); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if len(note.notes) != 1 {
		t.Fatalf("a connector that stays dead must not nag: %+v", note.notes)
	}

	// An agent asking on the user's behalf re-raises the prompt without
	// inventing a second state change.
	title, outcome, err := svc.AskReconnect(ctx, "u-1", "crm")
	if err != nil || title != "CRM" || outcome != ReconnectAsked {
		t.Fatalf("AskReconnect = %q, %q, %v", title, outcome, err)
	}
	if len(note.notes) != 2 {
		t.Fatalf("a deliberate ask should re-raise the prompt: %+v", note.notes)
	}
}

// An unreachable service is not a dead session: a network blip must leave a
// working credential alone rather than locking the user out of their own
// connector.
func TestConnectorExpiry_UnreachableKeepsTheCredential(t *testing.T) {
	st := newMemConnectorStore()
	svc := NewConnectorService(st)
	ctx := context.Background()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	st.connectors["crm"] = &model.Connector{
		Slug: "crm", Title: "CRM", BaseURL: srv.URL, VerifyURL: srv.URL + "/me",
		AuthKind: model.ConnectorAuthPaste, FileNames: []string{"a.yaml"},
	}
	st.files["crm"] = []model.ConnectorFile{{Slug: "crm", Name: "a.yaml", Content: "x"}}
	if _, err := svc.Install(ctx, "u-1", "crm", InstallInput{Token: "tok"}); err != nil {
		t.Fatalf("install: %v", err)
	}
	srv.Close() // the service is now unreachable, not refusing

	inst, _ := st.GetInstall(ctx, "u-1", "crm")
	inst.VerifiedAt = time.Now().Add(-2 * verifyTTL)
	_ = st.PutInstall(ctx, inst)

	got, err := svc.ForRunner(ctx, "u-1", []string{"crm"})
	if err != nil || len(got) != 1 || got[0].Token != "tok" {
		t.Fatalf("an unreachable service must not expire a credential: %v %+v", err, got)
	}
	after, _ := st.GetInstall(ctx, "u-1", "crm")
	if after.Status == model.ConnectorStatusExpired {
		t.Fatal("a dial failure must not be recorded as expiry")
	}
}

// The arms where the store, the registry or the caller is not in the happy
// path. Each one is a place a dead credential could otherwise take a live
// request down with it.
func TestConnectorExpiry_DegradedPaths(t *testing.T) {
	ctx := context.Background()
	newSvc := func(code int) (*ConnectorService, *memConnectorStore, *expiryPromptRecorder, func()) {
		st := newMemConnectorStore()
		svc := NewConnectorService(st)
		note := &expiryPromptRecorder{}
		svc.SetExpiryNotifier(note)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(code)
			_, _ = w.Write([]byte(`{"name":"Alice"}`))
		}))
		st.connectors["crm"] = &model.Connector{
			Slug: "crm", Title: "CRM", BaseURL: srv.URL, VerifyURL: srv.URL + "/me",
			AuthKind: model.ConnectorAuthPaste, FileNames: []string{"a.yaml"},
		}
		st.files["crm"] = []model.ConnectorFile{{Slug: "crm", Name: "a.yaml", Content: "x"}}
		st.installs["u-1#crm"] = &model.ConnectorInstall{
			UserID: "u-1", ConnectorSlug: "crm", Token: "tok",
			Status: model.ConnectorStatusConnected, VerifiedAt: time.Now().Add(-2 * verifyTTL),
		}
		return svc, st, note, srv.Close
	}

	t.Run("expiry that cannot be written is not announced", func(t *testing.T) {
		svc, st, note, done := newSvc(http.StatusUnauthorized)
		defer done()
		st.failPutInstall = errors.New("dynamo down")
		if got, _ := svc.ForRunner(ctx, "u-1", []string{"crm"}); len(got) != 0 {
			t.Fatal("a refused credential must still be withheld")
		}
		if len(note.notes) != 0 {
			t.Fatalf("an unrecorded expiry must not claim to be recorded: %+v", note.notes)
		}
	})

	t.Run("a live re-verify survives a failed write", func(t *testing.T) {
		svc, st, _, done := newSvc(http.StatusOK)
		defer done()
		st.failPutInstall = errors.New("dynamo down")
		got, err := svc.ForRunner(ctx, "u-1", []string{"crm"})
		if err != nil || len(got) != 1 || got[0].Token != "tok" {
			t.Fatalf("a store blip must not withhold a working credential: %v %+v", err, got)
		}
	})

	t.Run("re-verifying an already-expired install does not re-announce", func(t *testing.T) {
		svc, st, note, done := newSvc(http.StatusUnauthorized)
		defer done()
		st.installs["u-1#crm"].Status = model.ConnectorStatusExpired
		if _, err := svc.VerifyInstall(ctx, "u-1", "crm"); !errors.Is(err, ErrTokenRejected) {
			t.Fatalf("VerifyInstall = %v, want ErrTokenRejected", err)
		}
		if len(note.notes) != 0 {
			t.Fatalf("already-expired must not notify again: %+v", note.notes)
		}
	})

	t.Run("AskReconnect reports what it cannot find", func(t *testing.T) {
		svc, st, _, done := newSvc(http.StatusOK)
		defer done()
		if _, _, err := svc.AskReconnect(ctx, "u-1", "ghost"); err == nil {
			t.Fatal("unknown connector must error")
		}
		delete(st.installs, "u-1#crm")
		if _, _, err := svc.AskReconnect(ctx, "u-1", "crm"); err == nil {
			t.Fatal("connector the user never installed must error")
		}
	})

	t.Run("AskReconnect without a notifier still flags the row", func(t *testing.T) {
		svc, st, _, done := newSvc(http.StatusOK)
		defer done()
		svc.SetExpiryNotifier(nil)
		st.installs["u-1#crm"].Status = model.ConnectorStatusExpired
		if title, outcome, err := svc.AskReconnect(ctx, "u-1", "crm"); err != nil || title != "CRM" || outcome != ReconnectAsked {
			t.Fatalf("AskReconnect = %q, %q, %v", title, outcome, err)
		}
	})

	t.Run("ExpiredFor ignores what it was not asked about", func(t *testing.T) {
		svc, st, _, done := newSvc(http.StatusOK)
		defer done()
		if got := svc.ExpiredFor(ctx, "u-1", nil); got != nil {
			t.Fatalf("no slugs = nothing to report, got %v", got)
		}
		if got := svc.ExpiredFor(ctx, "u-1", []string{"crm", "ghost"}); len(got) != 0 {
			t.Fatalf("a live install is not expired: %v", got)
		}
		// A dangling install whose registry row is gone falls back to the slug.
		st.installs["u-1#orphan"] = &model.ConnectorInstall{
			UserID: "u-1", ConnectorSlug: "orphan", Status: model.ConnectorStatusExpired,
		}
		if got := svc.ExpiredFor(ctx, "u-1", []string{"orphan"}); len(got) != 1 || got[0] != "orphan" {
			t.Fatalf("ExpiredFor = %v, want [orphan]", got)
		}
	})
}

// Asking about a LIVE connector must not condemn it: the check runs first,
// and a working credential is reported working.
func TestConnectorExpiry_AskAboutALiveConnector(t *testing.T) {
	st := newMemConnectorStore()
	svc := NewConnectorService(st)
	note := &expiryPromptRecorder{}
	svc.SetExpiryNotifier(note)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	ctx := context.Background()
	st.connectors["crm"] = &model.Connector{Slug: "crm", Title: "CRM", BaseURL: srv.URL, VerifyURL: srv.URL + "/me"}
	st.installs["u-1#crm"] = &model.ConnectorInstall{
		UserID: "u-1", ConnectorSlug: "crm", Token: "tok", Status: model.ConnectorStatusConnected,
	}

	title, outcome, err := svc.AskReconnect(ctx, "u-1", "crm")
	if err != nil || title != "CRM" || outcome != ReconnectLive {
		t.Fatalf("AskReconnect = %q, %q, %v; want CRM/live", title, outcome, err)
	}
	if st.installs["u-1#crm"].Status == model.ConnectorStatusExpired {
		t.Fatal("a live credential must survive being asked about")
	}
	if len(note.notes) != 0 {
		t.Fatalf("no prompt should be raised for a working connector: %+v", note.notes)
	}

	// Unreachable: neither proven dead nor working, and left alone.
	srv.Close()
	if _, outcome, _ := svc.AskReconnect(ctx, "u-1", "crm"); outcome != ReconnectUnknown {
		t.Fatalf("unreachable outcome = %q, want unknown", outcome)
	}
	if st.installs["u-1#crm"].Status == model.ConnectorStatusExpired {
		t.Fatal("an unreachable service must not expire a credential")
	}

	// No verify endpoint = nothing to check against; taken at its word.
	st.connectors["crm"].VerifyURL = ""
	if _, outcome, _ := svc.AskReconnect(ctx, "u-1", "crm"); outcome != ReconnectLive {
		t.Fatalf("uncheckable outcome = %q, want live", outcome)
	}
}

// AskReconnect's remaining arms: a credential the service actively refuses,
// and a verify stamp the store will not take.
func TestConnectorExpiry_AskFindsItDead(t *testing.T) {
	ctx := context.Background()
	refuse := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer refuse.Close()

	st := newMemConnectorStore()
	svc := NewConnectorService(st)
	note := &expiryPromptRecorder{}
	svc.SetExpiryNotifier(note)
	st.connectors["crm"] = &model.Connector{Slug: "crm", Title: "CRM", BaseURL: refuse.URL, VerifyURL: refuse.URL + "/me"}
	st.installs["u-1#crm"] = &model.ConnectorInstall{
		UserID: "u-1", ConnectorSlug: "crm", Token: "tok", Status: model.ConnectorStatusConnected,
	}

	title, outcome, err := svc.AskReconnect(ctx, "u-1", "crm")
	if err != nil || title != "CRM" || outcome != ReconnectAsked {
		t.Fatalf("AskReconnect = %q, %q, %v; want CRM/asked", title, outcome, err)
	}
	if st.installs["u-1#crm"].Status != model.ConnectorStatusExpired {
		t.Fatal("a refused credential must be recorded expired")
	}
	if len(note.notes) != 1 {
		t.Fatalf("the owner should have been prompted once: %+v", note.notes)
	}

	// The live branch still answers "live" when the verify stamp cannot be
	// written — a store blip is not a reason to send someone to re-sign-in.
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer ok.Close()
	st2 := newMemConnectorStore()
	svc2 := NewConnectorService(st2)
	st2.connectors["crm"] = &model.Connector{Slug: "crm", Title: "CRM", BaseURL: ok.URL, VerifyURL: ok.URL + "/me"}
	st2.installs["u-1#crm"] = &model.ConnectorInstall{
		UserID: "u-1", ConnectorSlug: "crm", Token: "tok", Status: model.ConnectorStatusConnected,
	}
	st2.failPutInstall = errors.New("dynamo down")
	if _, outcome, err := svc2.AskReconnect(ctx, "u-1", "crm"); err != nil || outcome != ReconnectLive {
		t.Fatalf("AskReconnect with a failing store = %q, %v; want live", outcome, err)
	}
}

// IsInstalled is what stops an agent reporting a disconnect that never
// happened, so it is worth proving in both directions.
func TestConnectorService_IsInstalled(t *testing.T) {
	st := newMemConnectorStore()
	svc := NewConnectorService(st)
	st.installs["u-1#crm"] = &model.ConnectorInstall{UserID: "u-1", ConnectorSlug: "crm"}
	if !svc.IsInstalled(context.Background(), "u-1", "crm") {
		t.Fatal("an existing install must read as installed")
	}
	if svc.IsInstalled(context.Background(), "u-1", "ghost") {
		t.Fatal("a connector the user never installed must not")
	}
}
