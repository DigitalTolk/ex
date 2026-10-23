package agents

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// ---------------------------------------------------------------- fakes

type memProjectStore struct {
	projects  map[string]*model.CodingProject
	screens   map[string]map[string]*model.ProjectScreen
	themes    map[string]*model.ProjectTheme
	failList  bool
	failPut   bool
	failScr   bool
	failDel   bool
	failTheme bool
}

func (m *memProjectStore) PutProjectTheme(_ context.Context, t *model.ProjectTheme) error {
	if m.failTheme {
		return errMemProject
	}
	cp := *t
	m.themes[t.ProjectKey] = &cp
	return nil
}

func (m *memProjectStore) GetProjectTheme(_ context.Context, key string) (*model.ProjectTheme, error) {
	if m.failTheme {
		return nil, errMemProject
	}
	t, ok := m.themes[key]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *t
	return &cp, nil
}

func (m *memProjectStore) DeleteProjectTheme(_ context.Context, key string) error {
	if m.failTheme {
		return errMemProject
	}
	delete(m.themes, key)
	return nil
}

func newMemProjectStore() *memProjectStore {
	return &memProjectStore{projects: map[string]*model.CodingProject{}, screens: map[string]map[string]*model.ProjectScreen{}, themes: map[string]*model.ProjectTheme{}}
}

var errMemProject = errors.New("mem project store failure")

func (m *memProjectStore) CreateProject(_ context.Context, p *model.CodingProject) error {
	if m.failPut {
		return errMemProject
	}
	if _, ok := m.projects[p.Key]; ok {
		return store.ErrAlreadyExists
	}
	cp := *p
	m.projects[p.Key] = &cp
	return nil
}

func (m *memProjectStore) UpdateProject(_ context.Context, p *model.CodingProject) error {
	if m.failPut {
		return errMemProject
	}
	cp := *p
	m.projects[p.Key] = &cp
	return nil
}

func (m *memProjectStore) GetProject(_ context.Context, key string) (*model.CodingProject, error) {
	p, ok := m.projects[key]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *p
	return &cp, nil
}

func (m *memProjectStore) ListProjects(context.Context) ([]*model.CodingProject, error) {
	if m.failList {
		return nil, errMemProject
	}
	out := []*model.CodingProject{}
	for _, p := range m.projects {
		cp := *p
		out = append(out, &cp)
	}
	return out, nil
}

func (m *memProjectStore) DeleteProject(_ context.Context, key string) error {
	if m.failDel {
		return errMemProject
	}
	delete(m.projects, key)
	return nil
}

func (m *memProjectStore) PutScreen(_ context.Context, sc *model.ProjectScreen) error {
	if m.failPut {
		return errMemProject
	}
	if m.screens[sc.ProjectKey] == nil {
		m.screens[sc.ProjectKey] = map[string]*model.ProjectScreen{}
	}
	cp := *sc
	m.screens[sc.ProjectKey][sc.ID] = &cp
	return nil
}

func (m *memProjectStore) GetScreen(_ context.Context, key, id string) (*model.ProjectScreen, error) {
	sc, ok := m.screens[key][id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *sc
	return &cp, nil
}

func (m *memProjectStore) ListScreens(_ context.Context, key string) ([]*model.ProjectScreen, error) {
	if m.failScr {
		return nil, errMemProject
	}
	out := []*model.ProjectScreen{}
	for _, sc := range m.screens[key] {
		cp := *sc
		out = append(out, &cp)
	}
	return out, nil
}

func (m *memProjectStore) DeleteScreen(_ context.Context, key, id string) error {
	if m.failDel {
		return errMemProject
	}
	delete(m.screens[key], id)
	return nil
}

type memProjectAttachments struct {
	byID        map[string]*model.Attachment
	refs        map[string]map[string]bool
	validateErr error
	addRefErr   error
}

func newMemProjectAttachments() *memProjectAttachments {
	return &memProjectAttachments{byID: map[string]*model.Attachment{}, refs: map[string]map[string]bool{}}
}

func (m *memProjectAttachments) add(id, owner, contentType string, size int64) {
	m.byID[id] = &model.Attachment{ID: id, CreatedBy: owner, ContentType: contentType, Size: size, Filename: id + ".png",
		URL: "/media/" + id, ThumbnailURL: "/thumb/" + id, Width: 1440, Height: 900}
}

func (m *memProjectAttachments) Get(_ context.Context, id string) (*model.Attachment, error) {
	a, ok := m.byID[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return a, nil
}

func (m *memProjectAttachments) ValidateForUse(context.Context, string) error { return m.validateErr }

func (m *memProjectAttachments) AddRef(_ context.Context, id, ref string) error {
	if m.addRefErr != nil {
		return m.addRefErr
	}
	if m.refs[id] == nil {
		m.refs[id] = map[string]bool{}
	}
	m.refs[id][ref] = true
	return nil
}

func (m *memProjectAttachments) RemoveRef(_ context.Context, id, ref string) error {
	delete(m.refs[id], ref)
	return nil
}

func (m *memProjectAttachments) LoadForPreview(_ context.Context, ids []string) []*model.Attachment {
	var out []*model.Attachment
	for _, id := range ids {
		if a, ok := m.byID[id]; ok {
			out = append(out, a)
		}
	}
	return out
}

type projectFixture struct {
	svc   *ProjectService
	store *memProjectStore
	atts  *memProjectAttachments
	pub   *recordingPublisher
	alice ProjectCaller
	bob   ProjectCaller
	admin ProjectCaller
	guest ProjectCaller
}

type recordingPublisher struct{ events []string }

func (r *recordingPublisher) Publish(_ context.Context, _ string, e *events.Event) error {
	r.events = append(r.events, e.Type)
	return nil
}

func newProjectFixture(t *testing.T) *projectFixture {
	t.Helper()
	st, atts := newMemProjectStore(), newMemProjectAttachments()
	svc := NewProjectService(st, atts)
	pub := &recordingPublisher{}
	svc.SetPublisher(pub)
	n := 0
	svc.newID = func() string { n++; return "sc" + string(rune('0'+n)) }
	svc.now = func() time.Time { return time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC) }
	return &projectFixture{
		svc: svc, store: st, atts: atts, pub: pub,
		alice: ProjectCaller{ID: "u-alice", Role: model.SystemRoleMember},
		bob:   ProjectCaller{ID: "u-bob", Role: model.SystemRoleMember},
		admin: ProjectCaller{ID: "u-admin", Role: model.SystemRoleAdmin},
		guest: ProjectCaller{ID: "u-guest", Role: model.SystemRoleGuest},
	}
}

func sp(s string) *string { return &s }

func (f *projectFixture) mustCreate(t *testing.T, name string) *model.CodingProject {
	t.Helper()
	p, err := f.svc.Create(context.Background(), f.alice, ProjectInput{Name: sp(name)})
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	return p
}

func (f *projectFixture) mustScreen(t *testing.T, key, page, att string) *model.ProjectScreen {
	t.Helper()
	f.atts.add(att, f.alice.ID, "image/png", 1000)
	sc, err := f.svc.AddScreen(context.Background(), f.alice, key, ScreenInput{Page: sp(page), Description: sp(page + " page"), AttachmentID: sp(att)})
	if err != nil {
		t.Fatalf("add screen: %v", err)
	}
	return sc
}

// ---------------------------------------------------------------- projects

func TestProject_CreateDerivesKeyAndPublishes(t *testing.T) {
	f := newProjectFixture(t)
	p, err := f.svc.Create(context.Background(), f.alice, ProjectInput{
		Name: sp(" Booking Portal "), AppURL: sp("https://booking.example.com"), Description: sp("Bookings for clients"),
		DesignNotes: sp("Font: Inter"), Links: &[]model.ProjectLink{{Label: "", URL: "https://figma.example.com/f"}, {URL: " "}},
		Repos: &[]model.ProjectRepo{{Path: "/grp/front/", Role: "frontend"}, {Path: "grp/front"}, {Path: "grp/api"}, {Path: ""}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if p.Key != "booking-portal" || p.Name != "Booking Portal" || p.CreatedBy != "u-alice" {
		t.Fatalf("project = %+v", p)
	}
	if len(p.Links) != 1 || p.Links[0].Label != "https://figma.example.com/f" {
		t.Fatalf("links = %+v", p.Links)
	}
	if len(p.Repos) != 2 || p.Repos[0].Path != "grp/front" || p.Repos[1].Role != model.RepoRoleOther {
		t.Fatalf("repos = %+v", p.Repos)
	}
	if len(f.pub.events) != 1 || f.pub.events[0] != events.EventProjectChanged {
		t.Fatalf("want one project.changed publish, got %d", len(f.pub.events))
	}
}

func TestProject_CreateRejections(t *testing.T) {
	f := newProjectFixture(t)
	ctx := context.Background()
	f.mustCreate(t, "Acme")
	long := strings.Repeat("x", 9000)
	cases := []struct {
		name   string
		caller ProjectCaller
		in     ProjectInput
		want   error
	}{
		{"guest", f.guest, ProjectInput{Name: sp("X")}, service.ErrForbidden},
		{"anonymous", ProjectCaller{}, ProjectInput{Name: sp("X")}, service.ErrForbidden},
		{"no name", f.alice, ProjectInput{}, service.ErrValidation},
		{"blank name", f.alice, ProjectInput{Name: sp("  ")}, service.ErrValidation},
		{"symbols only", f.alice, ProjectInput{Name: sp("!!!")}, service.ErrValidation},
		{"duplicate", f.bob, ProjectInput{Name: sp("ACME")}, service.ErrAlreadyExists},
		{"bad app url", f.alice, ProjectInput{Name: sp("Y"), AppURL: sp("javascript:alert(1)")}, service.ErrValidation},
		{"long description", f.alice, ProjectInput{Name: sp("Y"), Description: sp(long)}, service.ErrValidation},
		{"long notes", f.alice, ProjectInput{Name: sp("Y"), DesignNotes: sp(long)}, service.ErrValidation},
		{"too many links", f.alice, ProjectInput{Name: sp("Y"), Links: &[]model.ProjectLink{{URL: "https://a.example"}, {URL: "https://a.example"}, {URL: "https://a.example"}, {URL: "https://a.example"}, {URL: "https://a.example"}, {URL: "https://a.example"}, {URL: "https://a.example"}, {URL: "https://a.example"}, {URL: "https://a.example"}, {URL: "https://a.example"}, {URL: "https://a.example"}}}, service.ErrValidation},
		{"bad link", f.alice, ProjectInput{Name: sp("Y"), Links: &[]model.ProjectLink{{URL: "ftp://x"}}}, service.ErrValidation},
		{"long link label", f.alice, ProjectInput{Name: sp("Y"), Links: &[]model.ProjectLink{{Label: strings.Repeat("l", 200), URL: "https://a.example"}}}, service.ErrValidation},
		{"repo without group", f.alice, ProjectInput{Name: sp("Y"), Repos: &[]model.ProjectRepo{{Path: "solo"}}}, service.ErrValidation},
		{"repo flag-like", f.alice, ProjectInput{Name: sp("Y"), Repos: &[]model.ProjectRepo{{Path: "-x/y"}}}, service.ErrValidation},
		{"repo bad role", f.alice, ProjectInput{Name: sp("Y"), Repos: &[]model.ProjectRepo{{Path: "g/r", Role: "chef"}}}, service.ErrValidation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := f.svc.Create(ctx, tc.caller, tc.in); !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
		})
	}
	f.store.failPut = true
	if _, err := f.svc.Create(ctx, f.alice, ProjectInput{Name: sp("Fresh")}); !errors.Is(err, errMemProject) {
		t.Fatalf("store failure: want it surfaced, got %v", err)
	}
}

func TestProject_UpdatePermissions(t *testing.T) {
	f := newProjectFixture(t)
	ctx := context.Background()
	f.mustCreate(t, "Acme")

	// Any member maintains references.
	p, err := f.svc.Update(ctx, f.bob, "acme", ProjectInput{DesignNotes: sp("Radius 8"), AppURL: sp("")})
	if err != nil || p.DesignNotes != "Radius 8" || p.UpdatedBy != "u-bob" {
		t.Fatalf("member notes edit: %+v %v", p, err)
	}
	// Only creator/admin rename or change repos.
	if _, err := f.svc.Update(ctx, f.bob, "acme", ProjectInput{Name: sp("Hijack")}); !errors.Is(err, service.ErrForbidden) {
		t.Fatalf("member rename: want forbidden, got %v", err)
	}
	if _, err := f.svc.Update(ctx, f.bob, "acme", ProjectInput{Repos: &[]model.ProjectRepo{}}); !errors.Is(err, service.ErrForbidden) {
		t.Fatalf("member repos: want forbidden, got %v", err)
	}
	if p, err := f.svc.Update(ctx, f.admin, "acme", ProjectInput{Name: sp("Acme Two")}); err != nil || p.Name != "Acme Two" || p.Key != "acme" {
		t.Fatalf("admin rename keeps key: %+v %v", p, err)
	}
	if _, err := f.svc.Update(ctx, f.alice, "acme", ProjectInput{Name: sp("")}); !errors.Is(err, service.ErrValidation) {
		t.Fatalf("creator blank rename: want validation, got %v", err)
	}
	if _, err := f.svc.Update(ctx, f.guest, "acme", ProjectInput{}); !errors.Is(err, service.ErrForbidden) {
		t.Fatalf("guest: want forbidden, got %v", err)
	}
	if _, err := f.svc.Update(ctx, f.alice, "nope", ProjectInput{}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing: want not found, got %v", err)
	}
	f.store.failPut = true
	if _, err := f.svc.Update(ctx, f.alice, "acme", ProjectInput{}); !errors.Is(err, errMemProject) {
		t.Fatalf("store failure: got %v", err)
	}
}

func TestProject_ListAndGet(t *testing.T) {
	f := newProjectFixture(t)
	ctx := context.Background()
	f.mustCreate(t, "zeta")
	f.mustCreate(t, "Alpha")
	f.mustScreen(t, "alpha", "Settings", "a1")
	f.svc.now = func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	f.mustScreen(t, "alpha", "Bookings", "a2")

	list, err := f.svc.List(ctx, f.bob)
	if err != nil || len(list) != 2 || list[0].Key != "alpha" || list[0].ScreenCount != 2 {
		t.Fatalf("list: %+v %v", list, err)
	}
	if list[0].OldestScreenAt == nil || !list[0].OldestScreenAt.Equal(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)) || list[1].OldestScreenAt != nil {
		t.Fatalf("freshness: %+v / %+v", list[0].OldestScreenAt, list[1].OldestScreenAt)
	}

	d, err := f.svc.Get(ctx, f.bob, "alpha")
	if err != nil || d.CanManage || len(d.Screens) != 2 {
		t.Fatalf("get as bob: %+v %v", d, err)
	}
	if d.Screens[0].Page != "Bookings" || d.Screens[0].ImageURL != "/media/a2" || d.Screens[0].Width != 1440 {
		t.Fatalf("gallery order/urls: %+v", d.Screens[0])
	}
	delete(f.atts.byID, "a1") // an image gone from storage still lists, without URLs
	d, _ = f.svc.Get(ctx, f.alice, "alpha")
	if !d.CanManage || d.Screens[1].ImageURL != "" {
		t.Fatalf("get as alice: %+v", d.Screens[1])
	}

	if _, err := f.svc.List(ctx, f.guest); !errors.Is(err, service.ErrForbidden) {
		t.Fatalf("guest list: %v", err)
	}
	if _, err := f.svc.Get(ctx, f.guest, "alpha"); !errors.Is(err, service.ErrForbidden) {
		t.Fatalf("guest get: %v", err)
	}
	if _, err := f.svc.Get(ctx, f.bob, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("get missing: %v", err)
	}
	f.store.failScr = true
	if _, err := f.svc.List(ctx, f.bob); !errors.Is(err, errMemProject) {
		t.Fatalf("list screens failure: %v", err)
	}
	if _, err := f.svc.Get(ctx, f.bob, "alpha"); !errors.Is(err, errMemProject) {
		t.Fatalf("get screens failure: %v", err)
	}
	f.store.failList = true
	if _, err := f.svc.List(ctx, f.bob); !errors.Is(err, errMemProject) {
		t.Fatalf("list failure: %v", err)
	}
}

func TestProject_ScreensOrder(t *testing.T) {
	f := newProjectFixture(t)
	ctx := context.Background()
	f.mustCreate(t, "Acme")
	mobile := "mobile"
	for i, in := range []ScreenInput{
		{Page: sp("list"), Viewport: &mobile},
		{Page: sp("List"), State: sp("empty")},
		{Page: sp("List")},
		{Page: sp("list"), State: sp("default")},
	} {
		att := "o" + string(rune('0'+i))
		f.atts.add(att, f.alice.ID, "image/png", 10)
		in.Description, in.AttachmentID = sp("d"), sp(att)
		if _, err := f.svc.AddScreen(ctx, f.alice, "acme", in); err != nil {
			t.Fatalf("add %d: %v", i, err)
		}
	}
	screens, err := f.svc.Screens(ctx, "acme")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, sc := range screens {
		got = append(got, sc.Viewport+"/"+sc.State+"/"+sc.AttachmentID)
	}
	want := "desktop//o2,desktop//o3,desktop/empty/o1,mobile//o0"
	if strings.Join(got, ",") != want {
		t.Fatalf("order = %s, want %s", strings.Join(got, ","), want)
	}
}

func TestProject_DeleteReleasesScreens(t *testing.T) {
	f := newProjectFixture(t)
	ctx := context.Background()
	f.mustCreate(t, "Acme")
	f.mustScreen(t, "acme", "Home", "img1")
	if err := f.svc.Delete(ctx, f.bob, "acme"); !errors.Is(err, service.ErrForbidden) {
		t.Fatalf("member delete: want forbidden, got %v", err)
	}
	if err := f.svc.Delete(ctx, f.guest, "acme"); !errors.Is(err, service.ErrForbidden) {
		t.Fatalf("guest delete: %v", err)
	}
	if err := f.svc.Delete(ctx, f.alice, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete missing: %v", err)
	}
	f.store.failScr = true
	if err := f.svc.Delete(ctx, f.alice, "acme"); !errors.Is(err, errMemProject) {
		t.Fatalf("list screens failure: %v", err)
	}
	f.store.failScr, f.store.failDel = false, true
	if err := f.svc.Delete(ctx, f.alice, "acme"); !errors.Is(err, errMemProject) {
		t.Fatalf("screen delete failure: %v", err)
	}
	f.store.failDel = false
	if err := f.svc.Delete(ctx, f.admin, "acme"); err != nil {
		t.Fatalf("admin delete: %v", err)
	}
	if len(f.atts.refs["img1"]) != 0 {
		t.Fatalf("screen ref not released: %+v", f.atts.refs)
	}
	if _, ok := f.store.projects["acme"]; ok {
		t.Fatal("project row still there")
	}
}

func TestProject_DeleteProjectRowFailure(t *testing.T) {
	f := newProjectFixture(t)
	f.mustCreate(t, "Acme")
	f.store.failDel = true
	if err := f.svc.Delete(context.Background(), f.alice, "acme"); !errors.Is(err, errMemProject) {
		t.Fatalf("want row delete failure, got %v", err)
	}
}

// ---------------------------------------------------------------- screens

func TestScreen_AddTakesReference(t *testing.T) {
	f := newProjectFixture(t)
	f.mustCreate(t, "Acme")
	f.atts.add("img", f.bob.ID, "image/png", 2048)
	sc, err := f.svc.AddScreen(context.Background(), f.bob, "acme", ScreenInput{
		Page: sp(" Booking detail "), Description: sp("One booking"), Viewport: sp("mobile"),
		State: sp("default"), SeenBy: sp("admin"), Route: sp("/bookings/:id"), AttachmentID: sp("img"),
	})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if sc.Page != "Booking detail" || sc.Viewport != "mobile" || sc.State != "" || sc.UploadedBy != "u-bob" {
		t.Fatalf("screen = %+v", sc)
	}
	if !f.atts.refs["img"][model.ScreenAttachmentRef(sc.ID)] {
		t.Fatalf("screen must hold a reference on its image: %+v", f.atts.refs)
	}
}

func TestScreen_AddRejections(t *testing.T) {
	f := newProjectFixture(t)
	ctx := context.Background()
	f.mustCreate(t, "Acme")
	f.atts.add("mine", f.alice.ID, "image/png", 10)
	f.atts.add("theirs", f.bob.ID, "image/png", 10)
	f.atts.add("pdf", f.alice.ID, "application/pdf", 10)
	f.atts.add("huge", f.alice.ID, "image/png", model.ScreenImageMaxBytes+1)
	ok := ScreenInput{Page: sp("P"), Description: sp("D"), AttachmentID: sp("mine")}
	with := func(mut func(*ScreenInput)) ScreenInput { in := ok; mut(&in); return in }
	cases := []struct {
		name   string
		caller ProjectCaller
		key    string
		in     ScreenInput
		want   error
	}{
		{"guest", f.guest, "acme", ok, service.ErrForbidden},
		{"missing project", f.alice, "nope", ok, store.ErrNotFound},
		{"no page", f.alice, "acme", with(func(i *ScreenInput) { i.Page = nil }), service.ErrValidation},
		{"blank page", f.alice, "acme", with(func(i *ScreenInput) { i.Page = sp(" ") }), service.ErrValidation},
		{"long page", f.alice, "acme", with(func(i *ScreenInput) { i.Page = sp(strings.Repeat("p", 81)) }), service.ErrValidation},
		{"bad viewport", f.alice, "acme", with(func(i *ScreenInput) { i.Viewport = sp("tablet") }), service.ErrValidation},
		{"unknown image", f.alice, "acme", with(func(i *ScreenInput) { i.AttachmentID = sp("ghost") }), service.ErrValidation},
		{"someone else's image", f.alice, "acme", with(func(i *ScreenInput) { i.AttachmentID = sp("theirs") }), service.ErrForbidden},
		{"not an image", f.alice, "acme", with(func(i *ScreenInput) { i.AttachmentID = sp("pdf") }), service.ErrValidation},
		{"too large", f.alice, "acme", with(func(i *ScreenInput) { i.AttachmentID = sp("huge") }), service.ErrValidation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := f.svc.AddScreen(ctx, tc.caller, tc.key, tc.in); !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
		})
	}

	f.atts.validateErr = errors.New("still uploading")
	if _, err := f.svc.AddScreen(ctx, f.alice, "acme", ok); !errors.Is(err, service.ErrValidation) {
		t.Fatalf("unverified upload: %v", err)
	}
	f.atts.validateErr = nil
	f.atts.addRefErr = errMemProject
	if _, err := f.svc.AddScreen(ctx, f.alice, "acme", ok); !errors.Is(err, errMemProject) {
		t.Fatalf("addref failure: %v", err)
	}
	f.atts.addRefErr = nil
	f.store.failScr = true
	if _, err := f.svc.AddScreen(ctx, f.alice, "acme", ok); !errors.Is(err, errMemProject) {
		t.Fatalf("list failure: %v", err)
	}
	f.store.failScr = false
	f.store.failPut = true
	if _, err := f.svc.AddScreen(ctx, f.alice, "acme", ok); !errors.Is(err, errMemProject) {
		t.Fatalf("put failure: %v", err)
	}
	if len(f.atts.refs["mine"]) != 0 {
		t.Fatalf("failed put must release the reference: %+v", f.atts.refs["mine"])
	}
}

func TestScreen_AddLookupFailure(t *testing.T) {
	f := newProjectFixture(t)
	f.mustCreate(t, "Acme")
	failing := &failingGetAttachments{memProjectAttachments: f.atts}
	f.svc.attachments = failing
	if _, err := f.svc.AddScreen(context.Background(), f.alice, "acme", ScreenInput{Page: sp("P"), Description: sp("D"), AttachmentID: sp("x")}); !errors.Is(err, errMemProject) {
		t.Fatalf("attachment read failure must surface, got %v", err)
	}
}

type failingGetAttachments struct{ *memProjectAttachments }

func (failingGetAttachments) Get(context.Context, string) (*model.Attachment, error) {
	return nil, errMemProject
}

func TestScreen_Cap(t *testing.T) {
	f := newProjectFixture(t)
	f.mustCreate(t, "Acme")
	f.store.screens["acme"] = map[string]*model.ProjectScreen{}
	for i := 0; i < model.ProjectScreensMax; i++ {
		id := strings.Repeat("s", i+1)
		f.store.screens["acme"][id] = &model.ProjectScreen{ID: id, ProjectKey: "acme"}
	}
	f.atts.add("img", f.alice.ID, "image/png", 10)
	_, err := f.svc.AddScreen(context.Background(), f.alice, "acme", ScreenInput{Page: sp("P"), Description: sp("D"), AttachmentID: sp("img")})
	if !errors.Is(err, service.ErrValidation) {
		t.Fatalf("over cap: want validation, got %v", err)
	}
}

func TestScreen_UpdateAndReplaceImage(t *testing.T) {
	f := newProjectFixture(t)
	ctx := context.Background()
	f.mustCreate(t, "Acme")
	sc := f.mustScreen(t, "acme", "Home", "old")

	got, err := f.svc.UpdateScreen(ctx, f.bob, "acme", sc.ID, ScreenInput{Description: sp("Landing page")})
	if err != nil || got.Description != "Landing page" || got.UploadedBy != "u-alice" {
		t.Fatalf("label edit: %+v %v", got, err)
	}
	f.atts.add("new", f.bob.ID, "image/png", 10)
	got, err = f.svc.UpdateScreen(ctx, f.bob, "acme", sc.ID, ScreenInput{AttachmentID: sp("new")})
	if err != nil || got.AttachmentID != "new" || got.UploadedBy != "u-bob" {
		t.Fatalf("replace: %+v %v", got, err)
	}
	ref := model.ScreenAttachmentRef(sc.ID)
	if f.atts.refs["old"][ref] || !f.atts.refs["new"][ref] {
		t.Fatalf("refs after replace: %+v", f.atts.refs)
	}

	if _, err := f.svc.UpdateScreen(ctx, f.guest, "acme", sc.ID, ScreenInput{}); !errors.Is(err, service.ErrForbidden) {
		t.Fatalf("guest: %v", err)
	}
	if _, err := f.svc.UpdateScreen(ctx, f.bob, "acme", "ghost", ScreenInput{}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if _, err := f.svc.UpdateScreen(ctx, f.bob, "acme", sc.ID, ScreenInput{Description: sp("")}); !errors.Is(err, service.ErrValidation) {
		t.Fatalf("blank description: %v", err)
	}
	if _, err := f.svc.UpdateScreen(ctx, f.bob, "acme", sc.ID, ScreenInput{AttachmentID: sp("old")}); !errors.Is(err, service.ErrForbidden) {
		t.Fatalf("replacing with someone else's upload: want forbidden, got %v", err)
	}
	f.store.failPut = true
	if _, err := f.svc.UpdateScreen(ctx, f.bob, "acme", sc.ID, ScreenInput{Description: sp("x")}); !errors.Is(err, errMemProject) {
		t.Fatalf("put failure: %v", err)
	}
}

func TestScreen_Delete(t *testing.T) {
	f := newProjectFixture(t)
	ctx := context.Background()
	f.mustCreate(t, "Acme")
	sc := f.mustScreen(t, "acme", "Home", "img")
	if err := f.svc.DeleteScreen(ctx, f.guest, "acme", sc.ID); !errors.Is(err, service.ErrForbidden) {
		t.Fatalf("guest: %v", err)
	}
	if err := f.svc.DeleteScreen(ctx, f.bob, "acme", "ghost"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	f.store.failDel = true
	if err := f.svc.DeleteScreen(ctx, f.bob, "acme", sc.ID); !errors.Is(err, errMemProject) {
		t.Fatalf("store failure: %v", err)
	}
	f.store.failDel = false
	if err := f.svc.DeleteScreen(ctx, f.bob, "acme", sc.ID); err != nil {
		t.Fatalf("member delete: %v", err)
	}
	if len(f.atts.refs["img"]) != 0 || len(f.store.screens["acme"]) != 0 {
		t.Fatalf("not released: %+v %+v", f.atts.refs, f.store.screens)
	}
}

func TestProject_NoPublisherIsSilent(t *testing.T) {
	f := newProjectFixture(t)
	f.svc.publisher = nil
	f.mustCreate(t, "Quiet")
}

const sampleTheme = `@import "tailwindcss";
:root { --primary: oklch(0.13 0 0); --radius: 0.25rem; }
.dark { --primary: oklch(0.95 0 0); }`

// The UI library and the theme stylesheet: any member maintains them; the
// stylesheet lives in its own row, is shown condensed, and is refused when it
// defines no variables.
func TestProject_UILibraryAndTheme(t *testing.T) {
	f := newProjectFixture(t)
	ctx := context.Background()
	f.mustCreate(t, "Acme")

	p, err := f.svc.Update(ctx, f.bob, "acme", ProjectInput{UILibrary: sp("  shadcn/ui, Tailwind v4 "), ThemeCSS: sp(sampleTheme), ThemeFilename: sp("globals.css")})
	if err != nil || p.UILibrary != "shadcn/ui, Tailwind v4" {
		t.Fatalf("update: %+v %v", p, err)
	}
	d, _ := f.svc.Get(ctx, f.bob, "acme")
	if d.Theme == nil || d.Theme.Filename != "globals.css" || d.Theme.Variables != 3 || d.Theme.UpdatedBy != "u-bob" ||
		!strings.Contains(d.Theme.Summary, "Imports: tailwindcss") || d.Theme.Size != len(sampleTheme) {
		t.Fatalf("theme view: %+v", d.Theme)
	}
	if _, err := f.svc.Update(ctx, f.bob, "acme", ProjectInput{ThemeCSS: sp(sampleTheme), ThemeFilename: sp(" ")}); err != nil {
		t.Fatal(err)
	}
	if f.store.themes["acme"].Filename != "theme.css" {
		t.Fatalf("default file name: %q", f.store.themes["acme"].Filename)
	}
	if _, err := f.svc.Update(ctx, f.bob, "acme", ProjectInput{ThemeCSS: sp(sampleTheme)}); err != nil || f.store.themes["acme"].Filename != "theme.css" {
		t.Fatalf("no file name given: %v", err)
	}

	for name, in := range map[string]ProjectInput{
		"no variables":   {ThemeCSS: sp("body { color: red; }")},
		"too large":      {ThemeCSS: sp(strings.Repeat("a", model.ProjectThemeMaxBytes+1))},
		"long file name": {ThemeCSS: sp(sampleTheme), ThemeFilename: sp(strings.Repeat("n", 200))},
		"long library":   {UILibrary: sp(strings.Repeat("x", model.ProjectUILibraryMaxLen+1))},
	} {
		if _, err := f.svc.Update(ctx, f.bob, "acme", in); !errors.Is(err, service.ErrValidation) {
			t.Errorf("%s: want validation error, got %v", name, err)
		}
	}

	if _, err := f.svc.Update(ctx, f.bob, "acme", ProjectInput{ThemeCSS: sp("  ")}); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if d, _ := f.svc.Get(ctx, f.bob, "acme"); d.Theme != nil {
		t.Fatal("removed theme must be gone")
	}

	f.store.failTheme = true
	if _, err := f.svc.Get(ctx, f.bob, "acme"); !errors.Is(err, errMemProject) {
		t.Fatalf("theme read failure: %v", err)
	}
	if _, err := f.svc.Update(ctx, f.bob, "acme", ProjectInput{ThemeCSS: sp(sampleTheme)}); !errors.Is(err, errMemProject) {
		t.Fatalf("theme write failure: %v", err)
	}
	if err := f.svc.Delete(ctx, f.alice, "acme"); !errors.Is(err, errMemProject) {
		t.Fatalf("delete must fail when the theme can't be removed: %v", err)
	}
	f.store.failTheme = false
	if err := f.svc.Delete(ctx, f.alice, "acme"); err != nil {
		t.Fatal(err)
	}
}
