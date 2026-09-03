package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// connCovErrStore wraps the in-memory store with per-method error injection so
// tests can reach the service's store-error arms.
type connCovErrStore struct {
	*memConnectorStore
	putConnectorErr   error
	putInstallErr     error
	listConnectorsErr error
	listInstallsErr   error
	getFilesErr       error
}

func newConnCovErrStore() *connCovErrStore {
	return &connCovErrStore{memConnectorStore: newMemConnectorStore()}
}

func (s *connCovErrStore) PutConnector(ctx context.Context, c *model.Connector, files []model.ConnectorFile) error {
	if s.putConnectorErr != nil {
		return s.putConnectorErr
	}
	return s.memConnectorStore.PutConnector(ctx, c, files)
}

func (s *connCovErrStore) PutInstall(ctx context.Context, in *model.ConnectorInstall) error {
	if s.putInstallErr != nil {
		return s.putInstallErr
	}
	return s.memConnectorStore.PutInstall(ctx, in)
}

func (s *connCovErrStore) ListConnectors(ctx context.Context) ([]*model.Connector, error) {
	if s.listConnectorsErr != nil {
		return nil, s.listConnectorsErr
	}
	return s.memConnectorStore.ListConnectors(ctx)
}

func (s *connCovErrStore) ListInstalls(ctx context.Context, userID string) ([]*model.ConnectorInstall, error) {
	if s.listInstallsErr != nil {
		return nil, s.listInstallsErr
	}
	return s.memConnectorStore.ListInstalls(ctx, userID)
}

func (s *connCovErrStore) GetConnectorFiles(ctx context.Context, slug string) ([]model.ConnectorFile, error) {
	if s.getFilesErr != nil {
		return nil, s.getFilesErr
	}
	return s.memConnectorStore.GetConnectorFiles(ctx, slug)
}

// connCovInput is a minimal valid IngestInput that individual cases mutate.
func connCovInput(slug string) IngestInput {
	return IngestInput{
		Slug: slug, Title: "T", BaseURL: "https://api.example.com",
		AuthKind: model.ConnectorAuthPaste,
		Files:    []model.ConnectorFile{{Name: "notes.md", Content: "hi"}},
	}
}

// Every ingest validation arm rejects with ErrConnectorInvalid.
func TestConnCovIngestValidationArms(t *testing.T) {
	tooMany := make([]model.ConnectorFile, 0, model.ConnectorMaxFiles+1)
	for i := 0; i <= model.ConnectorMaxFiles; i++ {
		tooMany = append(tooMany, model.ConnectorFile{Name: fmt.Sprintf("f%d.md", i), Content: "x"})
	}
	cases := []struct {
		name   string
		mutate func(*IngestInput)
	}{
		{"bad slug", func(in *IngestInput) { in.Slug = "Bad_Slug!" }},
		{"empty title", func(in *IngestInput) { in.Title = "" }},
		{"empty baseURL", func(in *IngestInput) { in.BaseURL = "" }},
		{"bad auth kind", func(in *IngestInput) { in.AuthKind = "oauth2" }},
		{"password needs tokenURL", func(in *IngestInput) {
			in.AuthKind = model.ConnectorAuthPassword
			in.TokenURL = ""
		}},
		{"no files", func(in *IngestInput) { in.Files = nil }},
		{"too many files", func(in *IngestInput) { in.Files = tooMany }},
		{"bad file name", func(in *IngestInput) {
			in.Files = []model.ConnectorFile{{Name: "a/b.md", Content: "x"}}
		}},
		{"file too large", func(in *IngestInput) {
			in.Files = []model.ConnectorFile{{Name: "big.md", Content: strings.Repeat("x", model.ConnectorFileMaxBytes+1)}}
		}},
		{"duplicate file", func(in *IngestInput) {
			in.Files = []model.ConnectorFile{{Name: "a.md", Content: "x"}, {Name: "a.md", Content: "y"}}
		}},
		{"index not yaml", func(in *IngestInput) {
			in.Files = []model.ConnectorFile{{Name: "index.yml", Content: "\t- not yaml"}}
		}},
		{"manifest entry missing file", func(in *IngestInput) {
			in.Files = []model.ConnectorFile{{Name: "index.yml", Content: "services:\n- service: x\n"}}
		}},
	}
	svc := NewConnectorService(newMemConnectorStore())
	for _, c := range cases {
		in := connCovInput("valid-slug")
		c.mutate(&in)
		if _, err := svc.Ingest(context.Background(), "u-admin", in); !errors.Is(err, ErrConnectorInvalid) {
			t.Errorf("%s: want ErrConnectorInvalid, got %v", c.name, err)
		}
	}
}

// A manifest entry without a service: name falls back to the file stem; a
// malformed service yaml degrades to "not in catalog" (not a failed ingest);
// endpoints missing id/method/path are skipped.
func TestConnCovIngestManifestAndCatalogEdges(t *testing.T) {
	ms := newMemConnectorStore()
	svc := NewConnectorService(ms)
	in := connCovInput("edges")
	in.Files = []model.ConnectorFile{
		{Name: "index.yml", Content: "services:\n- file: alpha.yaml\n- file: beta.yaml\n  service: beta_svc\n"},
		{Name: "alpha.yaml", Content: "\t bad yaml"},
		{Name: "beta.yaml", Content: "endpoints:\n- id: beta.list\n  method: GET\n  path: /v1/beta\n  summary: List\n- id: beta.broken\n  path: /v1/broken\n"},
	}
	c, err := svc.Ingest(context.Background(), "u-admin", in)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if len(c.Services) != 2 || c.Services[0].Name != "alpha" || c.Services[1].Name != "beta_svc" {
		t.Fatalf("services = %+v", c.Services)
	}
	files, err := ms.GetConnectorFiles(context.Background(), "edges")
	if err != nil {
		t.Fatalf("files: %v", err)
	}
	var catalog string
	for _, f := range files {
		if f.Name == "_catalog.tsv" {
			catalog = f.Content
		}
	}
	lines := strings.Split(strings.TrimSpace(catalog), "\n")
	if len(lines) != 1 || !strings.HasPrefix(lines[0], "beta.list\t") {
		t.Fatalf("catalog = %q", catalog)
	}
}

// Re-ingesting a slug keeps the original author/creation time; a failing
// PutConnector surfaces its error.
func TestConnCovIngestReingestAndPutError(t *testing.T) {
	ms := newMemConnectorStore()
	svc := NewConnectorService(ms)
	first, err := svc.Ingest(context.Background(), "admin-1", connCovInput("keeper"))
	if err != nil {
		t.Fatalf("first ingest: %v", err)
	}
	second, err := svc.Ingest(context.Background(), "admin-2", connCovInput("keeper"))
	if err != nil {
		t.Fatalf("re-ingest: %v", err)
	}
	if second.CreatedBy != "admin-1" || !second.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("re-ingest lost provenance: %+v", second)
	}

	es := newConnCovErrStore()
	es.putConnectorErr = errors.New("connCov: put failed")
	if _, err := NewConnectorService(es).Ingest(context.Background(), "admin", connCovInput("boom")); !errors.Is(err, es.putConnectorErr) {
		t.Fatalf("want put error, got %v", err)
	}
}

// ListForUser joins registry rows with the caller's installs; an install with
// no explicit agent-use policy reads back as "ask".
func TestConnCovListForUser(t *testing.T) {
	svc := NewConnectorService(newMemConnectorStore())
	seedConnector(t, svc, "one", model.ConnectorAuthPaste, "", "")
	seedConnector(t, svc, "two", model.ConnectorAuthPaste, "", "")
	if _, err := svc.Install(context.Background(), "u-a", "one", InstallInput{Token: "tok"}); err != nil {
		t.Fatalf("install: %v", err)
	}

	rows, err := svc.ListForUser(context.Background(), "u-a")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	byWSlug := map[string]ConnectorWithStatus{}
	for _, r := range rows {
		byWSlug[r.Slug] = r
	}
	one := byWSlug["one"]
	if !one.Installed || one.Status != model.ConnectorStatusUnverified || one.AgentUse != model.ConnectorAgentUseAsk {
		t.Fatalf("one = %+v", one)
	}
	if two := byWSlug["two"]; two.Installed || two.AgentUse != "" {
		t.Fatalf("two = %+v", two)
	}
}

func TestConnCovListForUserStoreErrors(t *testing.T) {
	es := newConnCovErrStore()
	svc := NewConnectorService(es)

	es.listConnectorsErr = errors.New("connCov: list connectors failed")
	if _, err := svc.ListForUser(context.Background(), "u"); !errors.Is(err, es.listConnectorsErr) {
		t.Fatalf("want listConnectors error, got %v", err)
	}
	es.listConnectorsErr = nil
	es.listInstallsErr = errors.New("connCov: list installs failed")
	if _, err := svc.ListForUser(context.Background(), "u"); !errors.Is(err, es.listInstallsErr) {
		t.Fatalf("want listInstalls error, got %v", err)
	}
}

// An error with no colon carries no access code.
func TestConnCovTwoFactorAccessCodeNoColon(t *testing.T) {
	if got := TwoFactorAccessCode(errors.New("plain")); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

// Install edge arms: unknown connector, pasted "Bearer <tok>" scheme strip,
// empty paste token, oversize token, reinstall keeping InstalledAt, and a
// failing PutInstall.
func TestConnCovInstallEdges(t *testing.T) {
	ctx := context.Background()

	ms := newMemConnectorStore()
	svc := NewConnectorService(ms)
	seedConnector(t, svc, "plain", model.ConnectorAuthPaste, "", "")

	if _, err := svc.Install(ctx, "u", "ghost", InstallInput{Token: "t"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown connector: want ErrNotFound, got %v", err)
	}

	inst, err := svc.Install(ctx, "u", "plain", InstallInput{Token: "Bearer tok-b"})
	if err != nil {
		t.Fatalf("bearer install: %v", err)
	}
	if inst.Token != "tok-b" {
		t.Fatalf("scheme not stripped: %q", inst.Token)
	}

	if _, err := svc.Install(ctx, "u", "plain", InstallInput{}); !errors.Is(err, ErrConnectorInvalid) {
		t.Fatalf("empty paste token: want ErrConnectorInvalid, got %v", err)
	}
	if _, err := svc.Install(ctx, "u", "plain", InstallInput{Token: strings.Repeat("a", model.ConnectorTokenMaxLen+1)}); !errors.Is(err, ErrConnectorInvalid) {
		t.Fatalf("oversize token: want ErrConnectorInvalid, got %v", err)
	}

	// Reinstall keeps the original InstalledAt.
	past := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	old, err := ms.GetInstall(ctx, "u", "plain")
	if err != nil {
		t.Fatalf("get install: %v", err)
	}
	old.InstalledAt = past
	if err := ms.PutInstall(ctx, old); err != nil {
		t.Fatalf("put install: %v", err)
	}
	inst, err = svc.Install(ctx, "u", "plain", InstallInput{Token: "tok-2"})
	if err != nil {
		t.Fatalf("reinstall: %v", err)
	}
	if !inst.InstalledAt.Equal(past) {
		t.Fatalf("InstalledAt not preserved: %v", inst.InstalledAt)
	}

	es := newConnCovErrStore()
	esvc := NewConnectorService(es)
	seedConnector(t, esvc, "plain", model.ConnectorAuthPaste, "", "")
	es.putInstallErr = errors.New("connCov: put install failed")
	if _, err := esvc.Install(ctx, "u", "plain", InstallInput{Token: "t"}); !errors.Is(err, es.putInstallErr) {
		t.Fatalf("want put install error, got %v", err)
	}
}

func TestConnCovUninstall(t *testing.T) {
	ctx := context.Background()
	ms := newMemConnectorStore()
	svc := NewConnectorService(ms)
	seedConnector(t, svc, "gone", model.ConnectorAuthPaste, "", "")
	if _, err := svc.Install(ctx, "u", "gone", InstallInput{Token: "t"}); err != nil {
		t.Fatalf("install: %v", err)
	}
	if err := svc.Uninstall(ctx, "u", "gone"); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if _, err := ms.GetInstall(ctx, "u", "gone"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("install not deleted: %v", err)
	}
}

// VerifyInstall: unknown connector, missing install, no verify URL, network
// failure (stays unverified with a legible error), 2xx upgrade to connected
// (capturing name + identity), and a definite 401 reporting the token.
func TestConnCovVerifyInstall(t *testing.T) {
	ctx := context.Background()
	var mode atomic.Int32 // 0 = 503, 1 = 200 JSON, 2 = 401
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		switch mode.Load() {
		case 0:
			w.WriteHeader(http.StatusServiceUnavailable)
		case 1:
			_, _ = w.Write([]byte(`{"user":{"name":"Zed"},"id":7}`))
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer srv.Close()

	svc := NewConnectorService(newMemConnectorStore())
	seedConnector(t, svc, "flaky", model.ConnectorAuthPaste, "", srv.URL)
	seedConnector(t, svc, "noverify", model.ConnectorAuthPaste, "", "")

	if _, err := svc.VerifyInstall(ctx, "u", "ghost"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown connector: want ErrNotFound, got %v", err)
	}
	if _, err := svc.VerifyInstall(ctx, "u", "flaky"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("no install yet: want ErrNotFound, got %v", err)
	}

	// Service down at install time → unverified.
	inst, err := svc.Install(ctx, "u", "flaky", InstallInput{Token: "tok"})
	if err != nil || inst.Status != model.ConnectorStatusUnverified {
		t.Fatalf("install: %+v err=%v", inst, err)
	}
	// Still down at verify time → kept unverified, legible error.
	inst, err = svc.VerifyInstall(ctx, "u", "flaky")
	if !errors.Is(err, ErrLoginFailed) || inst == nil || inst.Status != model.ConnectorStatusUnverified {
		t.Fatalf("unreachable verify: inst=%+v err=%v", inst, err)
	}

	// Service back → upgraded to connected with name + identity.
	mode.Store(1)
	inst, err = svc.VerifyInstall(ctx, "u", "flaky")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if inst.Status != model.ConnectorStatusConnected || inst.ConnectedAs != "Zed" || inst.Identity == "" {
		t.Fatalf("upgraded install = %+v", inst)
	}

	// Token now rejected outright.
	mode.Store(2)
	if _, err := svc.VerifyInstall(ctx, "u", "flaky"); !errors.Is(err, ErrTokenRejected) {
		t.Fatalf("want ErrTokenRejected, got %v", err)
	}

	// No verify URL configured → install returned untouched.
	if _, err := svc.Install(ctx, "u", "noverify", InstallInput{Token: "tok"}); err != nil {
		t.Fatalf("install noverify: %v", err)
	}
	inst, err = svc.VerifyInstall(ctx, "u", "noverify")
	if err != nil || inst.Status != model.ConnectorStatusUnverified {
		t.Fatalf("noverify: inst=%+v err=%v", inst, err)
	}
}

func TestConnCovVerifyInstallPutError(t *testing.T) {
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"name":"Ok"}`))
	}))
	defer srv.Close()

	es := newConnCovErrStore()
	svc := NewConnectorService(es)
	seedConnector(t, svc, "upg", model.ConnectorAuthPaste, "", srv.URL)
	if _, err := svc.Install(ctx, "u", "upg", InstallInput{Token: "t"}); err != nil {
		t.Fatalf("install: %v", err)
	}
	es.putInstallErr = errors.New("connCov: verify put failed")
	if _, err := svc.VerifyInstall(ctx, "u", "upg"); !errors.Is(err, es.putInstallErr) {
		t.Fatalf("want put error, got %v", err)
	}
}

// InstalledIndex lists installs (defaulting agent-use to ask), skips dangling
// installs, and surfaces store errors.
func TestConnCovInstalledIndex(t *testing.T) {
	ctx := context.Background()
	es := newConnCovErrStore()
	svc := NewConnectorService(es)
	seedConnector(t, svc, "one", model.ConnectorAuthPaste, "", "")
	seedConnector(t, svc, "two", model.ConnectorAuthPaste, "", "")
	if _, err := svc.Install(ctx, "u", "one", InstallInput{Token: "t"}); err != nil {
		t.Fatalf("install: %v", err)
	}
	if err := es.PutInstall(ctx, &model.ConnectorInstall{UserID: "u", ConnectorSlug: "two", Token: "t", AgentUse: model.ConnectorAgentUseNever}); err != nil {
		t.Fatalf("put install: %v", err)
	}
	if err := es.PutInstall(ctx, &model.ConnectorInstall{UserID: "u", ConnectorSlug: "ghost", Token: "t"}); err != nil {
		t.Fatalf("put dangling install: %v", err)
	}

	entries, err := svc.InstalledIndex(ctx, "u")
	if err != nil {
		t.Fatalf("index: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("want 2 entries (dangling skipped), got %+v", entries)
	}
	byEntry := map[string]ConnectorIndexEntry{}
	for _, e := range entries {
		byEntry[e.Slug] = e
	}
	if byEntry["one"].AgentUse != model.ConnectorAgentUseAsk || byEntry["two"].AgentUse != model.ConnectorAgentUseNever {
		t.Fatalf("entries = %+v", entries)
	}

	es.listInstallsErr = errors.New("connCov: list installs failed")
	if _, err := svc.InstalledIndex(ctx, "u"); !errors.Is(err, es.listInstallsErr) {
		t.Fatalf("want list error, got %v", err)
	}
}

// AgentUsePolicy: not installed → never+error; dangling registry entry →
// never+error; installed with no explicit mode → ask (with the title).
func TestConnCovAgentUsePolicy(t *testing.T) {
	ctx := context.Background()
	ms := newMemConnectorStore()
	svc := NewConnectorService(ms)
	seedConnector(t, svc, "one", model.ConnectorAuthPaste, "", "")

	policy, _, err := svc.AgentUsePolicy(ctx, "u", "one")
	if !errors.Is(err, store.ErrNotFound) || policy != model.ConnectorAgentUseNever {
		t.Fatalf("not installed: policy=%q err=%v", policy, err)
	}

	if err := ms.PutInstall(ctx, &model.ConnectorInstall{UserID: "u", ConnectorSlug: "ghost", Token: "t"}); err != nil {
		t.Fatalf("put install: %v", err)
	}
	policy, _, err = svc.AgentUsePolicy(ctx, "u", "ghost")
	if !errors.Is(err, store.ErrNotFound) || policy != model.ConnectorAgentUseNever {
		t.Fatalf("dangling: policy=%q err=%v", policy, err)
	}

	if _, err := svc.Install(ctx, "u", "one", InstallInput{Token: "t"}); err != nil {
		t.Fatalf("install: %v", err)
	}
	policy, title, err := svc.AgentUsePolicy(ctx, "u", "one")
	if err != nil || policy != model.ConnectorAgentUseAsk || title != "one" {
		t.Fatalf("default policy: %q title=%q err=%v", policy, title, err)
	}

	if err := svc.SetAgentUse(ctx, "u", "one", model.ConnectorAgentUseAlways); err != nil {
		t.Fatalf("set: %v", err)
	}
	policy, _, err = svc.AgentUsePolicy(ctx, "u", "one")
	if err != nil || policy != model.ConnectorAgentUseAlways {
		t.Fatalf("explicit policy: %q err=%v", policy, err)
	}
}

func TestConnCovSetAgentUse(t *testing.T) {
	ctx := context.Background()
	ms := newMemConnectorStore()
	svc := NewConnectorService(ms)
	seedConnector(t, svc, "one", model.ConnectorAuthPaste, "", "")

	if err := svc.SetAgentUse(ctx, "u", "one", "bogus"); !errors.Is(err, ErrConnectorInvalid) {
		t.Fatalf("bad mode: want ErrConnectorInvalid, got %v", err)
	}
	if err := svc.SetAgentUse(ctx, "u", "one", model.ConnectorAgentUseNever); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("not installed: want ErrNotFound, got %v", err)
	}

	if _, err := svc.Install(ctx, "u", "one", InstallInput{Token: "t"}); err != nil {
		t.Fatalf("install: %v", err)
	}
	if err := svc.SetAgentUse(ctx, "u", "one", model.ConnectorAgentUseNever); err != nil {
		t.Fatalf("set: %v", err)
	}
	in, err := ms.GetInstall(ctx, "u", "one")
	if err != nil || in.AgentUse != model.ConnectorAgentUseNever {
		t.Fatalf("install = %+v err=%v", in, err)
	}
}

func TestConnCovKnownSlugs(t *testing.T) {
	ctx := context.Background()
	es := newConnCovErrStore()
	svc := NewConnectorService(es)
	seedConnector(t, svc, "one", model.ConnectorAuthPaste, "", "")
	seedConnector(t, svc, "two", model.ConnectorAuthPaste, "", "")

	slugs, err := svc.KnownSlugs(ctx)
	if err != nil || len(slugs) != 2 || !slugs["one"] || !slugs["two"] {
		t.Fatalf("slugs = %v err=%v", slugs, err)
	}

	es.listConnectorsErr = errors.New("connCov: list failed")
	if _, err := svc.KnownSlugs(ctx); !errors.Is(err, es.listConnectorsErr) {
		t.Fatalf("want list error, got %v", err)
	}
}

// usageDoc renders the services hierarchy: route prefixes, description
// truncation, and the scoped-grep example built from real prefixes.
func TestConnCovUsageDocServices(t *testing.T) {
	c := &model.Connector{
		Slug: "svc", Title: "Svc", Description: "docs",
		Services: []model.ConnectorServiceInfo{
			{Name: "work", File: "work.yaml", Description: strings.Repeat("d", 120), RoutePrefixes: []string{"work", "hr"}},
			{Name: "leave", File: "leave.yaml", Description: "short", RoutePrefixes: []string{"leave"}},
			{Name: "misc", File: "misc.yaml", Description: "no routes"},
		},
	}
	doc := usageDoc(c)
	if !strings.Contains(doc, "## Services — pick the OWNER first") {
		t.Fatalf("services section missing:\n%s", doc)
	}
	if !strings.Contains(doc, "[routes: work.*, hr.*]") {
		t.Fatalf("route prefixes not rendered:\n%s", doc)
	}
	if !strings.Contains(doc, strings.Repeat("d", 110)+"…") {
		t.Fatalf("long description not truncated:\n%s", doc)
	}
	if !strings.Contains(doc, "^(work|leave)\\.") {
		t.Fatalf("scoped-grep example not built from real prefixes:\n%s", doc)
	}
	if !strings.Contains(doc, "- misc (misc.yaml) — no routes") {
		t.Fatalf("prefix-less service rendered wrong:\n%s", doc)
	}
}

// ForRunner edge arms: store errors, dangling installs, a bundle shipping its
// own _USAGE.md, and the _identity.json injection.
func TestConnCovForRunnerEdges(t *testing.T) {
	ctx := context.Background()

	es := newConnCovErrStore()
	svc := NewConnectorService(es)
	es.listInstallsErr = errors.New("connCov: list installs failed")
	if _, err := svc.ForRunner(ctx, "u"); !errors.Is(err, es.listInstallsErr) {
		t.Fatalf("want list error, got %v", err)
	}
	es.listInstallsErr = nil

	// Dangling install (registry entry removed) is skipped, not fatal.
	if err := es.PutInstall(ctx, &model.ConnectorInstall{UserID: "u", ConnectorSlug: "ghost", Token: "t"}); err != nil {
		t.Fatalf("put install: %v", err)
	}
	rows, err := svc.ForRunner(ctx, "u")
	if err != nil || len(rows) != 0 {
		t.Fatalf("dangling: rows=%+v err=%v", rows, err)
	}

	// A real install whose file fetch fails surfaces the error.
	in := connCovInput("own-usage")
	in.Files = []model.ConnectorFile{
		{Name: "index.yml", Content: "schema: 1"},
		{Name: "_USAGE.md", Content: "custom usage doc"},
	}
	if _, err := svc.Ingest(ctx, "admin", in); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if err := es.PutInstall(ctx, &model.ConnectorInstall{UserID: "u2", ConnectorSlug: "own-usage", Token: "tok", Identity: `{"id":"u2"}`}); err != nil {
		t.Fatalf("put install: %v", err)
	}
	es.getFilesErr = errors.New("connCov: files failed")
	if _, err := svc.ForRunner(ctx, "u2"); !errors.Is(err, es.getFilesErr) {
		t.Fatalf("want files error, got %v", err)
	}
	es.getFilesErr = nil

	// Bundle ships its own _USAGE.md → not overridden; identity is injected.
	rows, err = svc.ForRunner(ctx, "u2")
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
	usageCount, identity := 0, ""
	for _, f := range rows[0].Files {
		switch f.Name {
		case "_USAGE.md":
			usageCount++
			if f.Content != "custom usage doc" {
				t.Fatalf("bundle _USAGE.md overridden: %q", f.Content)
			}
		case "_identity.json":
			identity = f.Content
		}
	}
	if usageCount != 1 || identity != `{"id":"u2"}` {
		t.Fatalf("files = %+v", rows[0].Files)
	}
}

// passwordGrant edge arms: missing credentials, an unparseable token URL, an
// unreachable auth service, and a failure response with no message.
func TestConnCovPasswordGrantEdges(t *testing.T) {
	ctx := context.Background()
	svc := NewConnectorService(newMemConnectorStore())

	seedConnector(t, svc, "pw-nocred", model.ConnectorAuthPassword, "http://127.0.0.1:1/t", "")
	if _, err := svc.Install(ctx, "u", "pw-nocred", InstallInput{}); !errors.Is(err, ErrConnectorInvalid) {
		t.Fatalf("missing creds: want ErrConnectorInvalid, got %v", err)
	}

	seedConnector(t, svc, "pw-badurl", model.ConnectorAuthPassword, "://nope", "")
	if _, err := svc.Install(ctx, "u", "pw-badurl", InstallInput{Email: "a@x.com", Password: "p"}); err == nil {
		t.Fatal("bad token URL: want request-build error, got nil")
	}

	seedConnector(t, svc, "pw-unreach", model.ConnectorAuthPassword, "http://127.0.0.1:1/x", "")
	if _, err := svc.Install(ctx, "u", "pw-unreach", InstallInput{Email: "a@x.com", Password: "p"}); !errors.Is(err, ErrLoginFailed) || !strings.Contains(err.Error(), "unreachable") {
		t.Fatalf("unreachable auth: want ErrLoginFailed unreachable, got %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	seedConnector(t, svc, "pw-500", model.ConnectorAuthPassword, srv.URL, "")
	if _, err := svc.Install(ctx, "u", "pw-500", InstallInput{Email: "a@x.com", Password: "p"}); !errors.Is(err, ErrLoginFailed) || !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("500 with no message: got %v", err)
	}
}

// A verify URL that can't even build a request degrades to "unverified".
func TestConnCovAuthedGetBadVerifyURL(t *testing.T) {
	svc := NewConnectorService(newMemConnectorStore())
	seedConnector(t, svc, "badverify", model.ConnectorAuthPaste, "", "://bad")
	inst, err := svc.Install(context.Background(), "u", "badverify", InstallInput{Token: "t"})
	if err != nil || inst.Status != model.ConnectorStatusUnverified {
		t.Fatalf("inst=%+v err=%v", inst, err)
	}
}

// clipIdentity compacts JSON (deep maps clipped, fat entries and long arrays
// summarized, long strings truncated, scalars kept) and hard-clips non-JSON.
func TestConnCovClipIdentity(t *testing.T) {
	if got := clipIdentity([]byte("plain text")); got != "plain text" {
		t.Fatalf("small non-JSON changed: %q", got)
	}
	if got := clipIdentity([]byte(strings.Repeat("x", 5000))); len(got) != 2048 {
		t.Fatalf("large non-JSON not clipped to 2048: %d", len(got))
	}

	fat := map[string]any{}
	for i := 0; i < 400; i++ {
		fat[fmt.Sprintf("k%03d", i)] = "vvvvvvvvvv"
	}
	payload := map[string]any{
		"n":   42,
		"s":   strings.Repeat("s", 250),
		"big": []any{1, 2, 3, 4, 5},
		"few": []any{"a", 2},
		"l1":  map[string]any{"l2": map[string]any{"l3": map[string]any{"l4": map[string]any{"gone": "deep"}}}},
		"fat": fat,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(clipIdentity(raw)), &out); err != nil {
		t.Fatalf("compacted output not JSON: %v", err)
	}
	if out["n"] != float64(42) {
		t.Fatalf("scalar dropped: %v", out["n"])
	}
	if s, _ := out["s"].(string); s != strings.Repeat("s", 200)+"…" {
		t.Fatalf("long string not truncated: %q", s)
	}
	if out["big"] != "[5 items omitted]" {
		t.Fatalf("long array not summarized: %v", out["big"])
	}
	few, _ := out["few"].([]any)
	if len(few) != 2 || few[0] != "a" || few[1] != float64(2) {
		t.Fatalf("short array mangled: %v", out["few"])
	}
	fatOut, _ := out["fat"].(string)
	if !strings.HasPrefix(fatOut, "[large value omitted") {
		t.Fatalf("fat entry not omitted: %.80v", out["fat"])
	}
	l4 := out["l1"].(map[string]any)["l2"].(map[string]any)["l3"].(map[string]any)["l4"]
	if m, ok := l4.(map[string]any); !ok || len(m) != 0 {
		t.Fatalf("depth cap not applied: %v", l4)
	}
}

func TestConnCovDisplayNameBadJSON(t *testing.T) {
	if got := displayName([]byte("not json")); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}
