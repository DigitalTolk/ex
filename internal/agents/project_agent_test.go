package agents

import (
	"context"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func seedAgentProjects(t *testing.T) *projectFixture {
	t.Helper()
	f := newProjectFixture(t)
	ctx := context.Background()
	if _, err := f.svc.Create(ctx, f.alice, ProjectInput{
		Name: sp("Acme Portal"), AppURL: sp("https://acme.example.com"), Description: sp("Clients book things."),
		DesignNotes: sp("Font: Inter\nRadius: 8px"), Links: &[]model.ProjectLink{{Label: "Figma", URL: "https://figma.example.com/acme"}},
	}); err != nil {
		t.Fatal(err)
	}
	f.mustScreen(t, "acme-portal", "Booking detail", "img-b")
	f.atts.add("img-m", f.alice.ID, "image/png", 10)
	if _, err := f.svc.AddScreen(ctx, f.alice, "acme-portal", ScreenInput{
		Page: sp("Booking detail"), Description: sp("One booking,\n  on a phone"), Viewport: sp("mobile"),
		State: sp("empty"), SeenBy: sp("admin"), Route: sp("/bookings/:id"), AttachmentID: sp("img-m"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Update(ctx, f.alice, "acme-portal", ProjectInput{UILibrary: sp("shadcn/ui"), ThemeCSS: sp(sampleTheme), ThemeFilename: sp("globals.css")}); err != nil {
		t.Fatal(err)
	}
	f.mustCreate(t, "Acme Portal Admin")
	f.mustCreate(t, "Ox") // too short to name-match
	return f
}

func TestProjectByToken(t *testing.T) {
	f := seedAgentProjects(t)
	ctx := context.Background()
	if got := f.svc.ProjectByToken(ctx, nil); got != "" {
		t.Fatalf("no candidates: %q", got)
	}
	if got := f.svc.ProjectByToken(ctx, []string{"cliffhub", "acme-portal", "ox"}); got != "acme-portal" {
		t.Fatalf("first project token wins: %q", got)
	}
	if got := f.svc.ProjectByToken(ctx, []string{"nope"}); got != "" {
		t.Fatalf("unknown token: %q", got)
	}
	f.store.failList = true
	if got := f.svc.ProjectByToken(ctx, []string{"acme-portal"}); got != "" {
		t.Fatalf("list failure must attach nothing: %q", got)
	}
}

func TestProjectByName(t *testing.T) {
	f := seedAgentProjects(t)
	ctx := context.Background()
	cases := map[string]string{
		"":                                      "",
		"   ":                                   "",
		"mock the ACME portal booking page":     "acme-portal",
		"the acme portal admin users list":      "acme-portal-admin",
		"something in acme-portal-admin please": "acme-portal-admin",
		"acme portals are great":                "",
		"ox needs a new button":                 "",
		"nothing relevant here":                 "",
	}
	for text, want := range cases {
		if got := f.svc.ProjectByName(ctx, text); got != want {
			t.Errorf("ProjectByName(%q) = %q, want %q", text, got, want)
		}
	}
	f.store.failList = true
	if got := f.svc.ProjectByName(ctx, "acme portal"); got != "" {
		t.Fatalf("list failure: %q", got)
	}
}

func TestProjectScreenImage(t *testing.T) {
	f := seedAgentProjects(t)
	ctx := context.Background()
	if !f.svc.ScreenImage(ctx, "acme-portal", "img-m") {
		t.Fatal("project screen must be readable")
	}
	for _, tc := range [][2]string{{"", "img-m"}, {"acme-portal", ""}, {"acme-portal", "other"}, {"acme-portal-admin", "img-m"}} {
		if f.svc.ScreenImage(ctx, tc[0], tc[1]) {
			t.Fatalf("ScreenImage(%q,%q) must be false", tc[0], tc[1])
		}
	}
	f.store.failScr = true
	if f.svc.ScreenImage(ctx, "acme-portal", "img-m") {
		t.Fatal("list failure must deny")
	}
}

func TestDesignLayer_WithProject(t *testing.T) {
	f := seedAgentProjects(t)
	layer := f.svc.DesignLayer(context.Background(), "acme-portal")
	for _, want := range []string{
		"# Design references: Acme Portal (project key: acme-portal)",
		"App: https://acme.example.com",
		"## About the product\nClients book things.",
		"- Figma: https://figma.example.com/acme",
		"## Design notes (authoritative",
		"## UI library\nshadcn/ui\n",
		"## Theme tokens (from globals.css",
		"  --radius: 0.25rem",
		"Radius: 8px",
		"fetch_attachment(attachment_id)",
		"- att:img-b | Booking detail | desktop | default | - | - | Booking detail page",
		"- att:img-m | Booking detail | mobile | empty | admin | /bookings/:id | One booking, on a phone",
	} {
		if !strings.Contains(layer, want) {
			t.Errorf("layer missing %q:\n%s", want, layer)
		}
	}
	if strings.Index(layer, "att:img-b") > strings.Index(layer, "att:img-m") {
		t.Error("desktop screens list before mobile")
	}
}

func TestDesignLayer_SparseProject(t *testing.T) {
	f := seedAgentProjects(t)
	layer := f.svc.DesignLayer(context.Background(), "ox")
	for _, want := range []string{"# Design references: Ox (project key: ox)", "None written yet", "None uploaded yet"} {
		if !strings.Contains(layer, want) {
			t.Errorf("layer missing %q:\n%s", want, layer)
		}
	}
	for _, unwanted := range []string{"App:", "## About", "## Links", "fetch_attachment", "## UI library", "## Theme tokens"} {
		if strings.Contains(layer, unwanted) {
			t.Errorf("sparse layer should not carry %q", unwanted)
		}
	}
}

func TestDesignLayer_Failures(t *testing.T) {
	f := seedAgentProjects(t)
	ctx := context.Background()
	if got := f.svc.DesignLayer(ctx, "missing"); got != "" {
		t.Fatalf("missing project: %q", got)
	}
	f.store.failScr = true
	if got := f.svc.DesignLayer(ctx, "acme-portal"); got != "" {
		t.Fatalf("screens failure: %q", got)
	}
}

func TestDesignLayer_NoProject(t *testing.T) {
	f := seedAgentProjects(t)
	ctx := context.Background()
	layer := f.svc.DesignLayer(ctx, "")
	if !strings.Contains(layer, "Projects with references: Acme Portal.") || strings.Contains(layer, "Ox") {
		t.Fatalf("only projects with screens are offered:\n%s", layer)
	}

	empty := newProjectFixture(t)
	empty.mustCreate(t, "Bare")
	if layer := empty.svc.DesignLayer(ctx, ""); !strings.Contains(layer, "No project has reference screens yet") {
		t.Fatalf("no references anywhere:\n%s", layer)
	}

	f.store.failScr = true // a project whose screens can't be read is just not offered
	if layer := f.svc.DesignLayer(ctx, ""); !strings.Contains(layer, "No project has reference screens yet") {
		t.Fatalf("screens failure:\n%s", layer)
	}
	f.store.failList = true
	if got := f.svc.DesignLayer(ctx, ""); got != "" {
		t.Fatalf("list failure: %q", got)
	}
}

func TestIsDesignAgent(t *testing.T) {
	cases := []struct {
		u    *model.User
		want bool
	}{
		{nil, false},
		{&model.User{ID: "x"}, false},
		{&model.User{AgentConfig: &model.AgentConfig{TemplateSlug: AgentSlugGG}}, false},
		{&model.User{AgentConfig: &model.AgentConfig{TemplateSlug: AgentSlugDesign}}, true},
	}
	for i, tc := range cases {
		if got := IsDesignAgent(tc.u); got != tc.want {
			t.Errorf("case %d: got %v", i, got)
		}
	}
}

// The design agent follows its threads by default (tweaks are replies), and a
// user's own follow-up pref still wins.
func TestResolve_TemplateFollowUpDefault(t *testing.T) {
	ctx := context.Background()
	dir := newFakeAgentDir()
	users := &fakeUsers{users: map[string]*model.User{}}
	svc := NewAgentService(dir, users)
	if err := svc.SeedDefaults(ctx); err != nil {
		t.Fatal(err)
	}
	design := &model.User{ID: AgentUserID(AgentSlugDesign), Kind: model.UserKindAgent, AgentConfig: &model.AgentConfig{TemplateSlug: AgentSlugDesign}}
	gg := &model.User{ID: AgentUserID(AgentSlugGG), Kind: model.UserKindAgent, AgentConfig: &model.AgentConfig{TemplateSlug: AgentSlugGG}}
	if r, err := svc.Resolve(ctx, design, "u-alice"); err != nil || r.FollowUpMode != model.FollowUpAlways {
		t.Fatalf("design default: %+v %v", r, err)
	}
	if r, _ := svc.Resolve(ctx, gg, "u-alice"); r.FollowUpMode != model.FollowUpOff {
		t.Fatalf("gg default stays off: %q", r.FollowUpMode)
	}
	_ = dir.PutAgentPrefs(ctx, &model.UserAgentPrefs{UserID: "u-alice", Slug: AgentSlugDesign, FollowUpMode: model.FollowUpOff})
	if r, _ := svc.Resolve(ctx, design, "u-alice"); r.FollowUpMode != model.FollowUpOff {
		t.Fatalf("the user's pref wins: %q", r.FollowUpMode)
	}
}

// A theme that can't be read never blocks the rest of the layer.
func TestDesignLayer_ThemeUnreadable(t *testing.T) {
	f := seedAgentProjects(t)
	f.store.failTheme = true
	layer := f.svc.DesignLayer(context.Background(), "acme-portal")
	if !strings.Contains(layer, "## Reference screens") || strings.Contains(layer, "## Theme tokens") {
		t.Fatalf("layer without theme:\n%s", layer)
	}
}
