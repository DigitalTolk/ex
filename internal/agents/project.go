package agents

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// ProjectService manages projects as the Projects page sees them
// (plan-projects-design.md): the product identity coding tasks already learn
// (key, name, repos) plus the design references the design agent copies
// from — app link, description, design notes, links and labelled
// screenshots of real pages.
//
// Permissions: every member reads and maintains references (screens, notes,
// links, description) — freshness depends on many hands, and screenshots are
// low risk. Renaming, deleting and editing repos drive coding tasks and MRs,
// so they stay with the project's creator and admins. Guests see nothing.
type ProjectService struct {
	store       projectStore
	attachments projectAttachments
	publisher   service.Publisher
	now         func() time.Time
	newID       func() string
}

type projectStore interface {
	CreateProject(ctx context.Context, p *model.CodingProject) error
	UpdateProject(ctx context.Context, p *model.CodingProject) error
	GetProject(ctx context.Context, key string) (*model.CodingProject, error)
	ListProjects(ctx context.Context) ([]*model.CodingProject, error)
	DeleteProject(ctx context.Context, key string) error
	PutScreen(ctx context.Context, sc *model.ProjectScreen) error
	GetScreen(ctx context.Context, projectKey, id string) (*model.ProjectScreen, error)
	ListScreens(ctx context.Context, projectKey string) ([]*model.ProjectScreen, error)
	DeleteScreen(ctx context.Context, projectKey, id string) error
	PutProjectTheme(ctx context.Context, t *model.ProjectTheme) error
	GetProjectTheme(ctx context.Context, projectKey string) (*model.ProjectTheme, error)
	DeleteProjectTheme(ctx context.Context, projectKey string) error
}

// projectAttachments is the AttachmentService slice screens need: the
// uploaded image row, the reference that keeps it alive, and URL resolution
// for the gallery.
type projectAttachments interface {
	Get(ctx context.Context, id string) (*model.Attachment, error)
	ValidateForUse(ctx context.Context, attachmentID string) error
	AddRef(ctx context.Context, attachmentID, messageID string) error
	RemoveRef(ctx context.Context, attachmentID, messageID string) error
	LoadForPreview(ctx context.Context, ids []string) []*model.Attachment
}

// NewProjectService wires the service.
func NewProjectService(s projectStore, a projectAttachments) *ProjectService {
	return &ProjectService{store: s, attachments: a, now: time.Now, newID: store.NewID}
}

// SetPublisher wires the real-time nudge: every change publishes
// project.changed so open Projects pages refetch. Optional (nil = silent).
func (s *ProjectService) SetPublisher(p service.Publisher) { s.publisher = p }

// changed tells every client a project or its references changed. Data-less
// on purpose: the global channel reaches guests too, who may not read
// projects — clients refetch through the gated API.
func (s *ProjectService) changed(ctx context.Context) {
	if s.publisher != nil {
		events.Publish(ctx, s.publisher, pubsub.GlobalChannelEvents(), events.EventProjectChanged, map[string]any{})
	}
}

// ProjectCaller is who is asking: the handler fills it from signed claims.
type ProjectCaller struct {
	ID   string
	Role model.SystemRole
}

func (c ProjectCaller) member() error {
	if c.ID == "" || c.Role == model.SystemRoleGuest {
		return apperr.Forbidden("projects are for workspace members")
	}
	return nil
}

// projectCallerOf is the caller a server-side path acts as — a coding task's
// requester, whose run is the one asking.
func projectCallerOf(u *model.User) ProjectCaller {
	return ProjectCaller{ID: u.ID, Role: u.SystemRole}
}

func (c ProjectCaller) canManage(p *model.CodingProject) bool {
	return c.Role == model.SystemRoleAdmin || (p.CreatedBy != "" && p.CreatedBy == c.ID)
}

// ProjectSummary is one row of the Projects list.
type ProjectSummary struct {
	*model.CodingProject
	ScreenCount int `json:"screenCount"`
	// OldestScreenAt drives the list's freshness hint; nil when no screens.
	OldestScreenAt *time.Time `json:"oldestScreenAt,omitempty"`
}

// ScreenView is a screen with its image resolved for the gallery.
type ScreenView struct {
	*model.ProjectScreen
	ImageURL     string `json:"imageURL,omitempty"`
	ThumbnailURL string `json:"thumbnailURL,omitempty"`
	Width        int    `json:"width,omitempty"`
	Height       int    `json:"height,omitempty"`
}

// ProjectDetail is one project with its gallery.
type ProjectDetail struct {
	Project   *model.CodingProject `json:"project"`
	Screens   []*ScreenView        `json:"screens"`
	CanManage bool                 `json:"canManage"`
	// Theme is the uploaded stylesheet as the agent sees it (never the raw
	// file); nil when none was uploaded.
	Theme *ThemeView `json:"theme,omitempty"`
}

// ThemeView describes a project's theme stylesheet and its condensed form.
type ThemeView struct {
	Filename  string    `json:"filename"`
	Size      int       `json:"size"`
	Variables int       `json:"variables"`
	Summary   string    `json:"summary"`
	UpdatedBy string    `json:"updatedBy"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// List returns every project with gallery counts, by name.
func (s *ProjectService) List(ctx context.Context, caller ProjectCaller) ([]*ProjectSummary, error) {
	if err := caller.member(); err != nil {
		return nil, err
	}
	projects, err := s.store.ListProjects(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*ProjectSummary, 0, len(projects))
	for _, p := range projects {
		sum := &ProjectSummary{CodingProject: p}
		screens, err := s.store.ListScreens(ctx, p.Key)
		if err != nil {
			return nil, err
		}
		sum.ScreenCount = len(screens)
		for _, sc := range screens {
			if sum.OldestScreenAt == nil || sc.UpdatedAt.Before(*sum.OldestScreenAt) {
				at := sc.UpdatedAt
				sum.OldestScreenAt = &at
			}
		}
		out = append(out, sum)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

// Get returns one project and its gallery with image URLs resolved.
func (s *ProjectService) Get(ctx context.Context, caller ProjectCaller, key string) (*ProjectDetail, error) {
	if err := caller.member(); err != nil {
		return nil, err
	}
	p, err := s.store.GetProject(ctx, key)
	if err != nil {
		return nil, err
	}
	screens, err := s.Screens(ctx, key)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(screens))
	for _, sc := range screens {
		ids = append(ids, sc.AttachmentID)
	}
	byID := map[string]*model.Attachment{}
	for _, a := range s.attachments.LoadForPreview(ctx, ids) {
		byID[a.ID] = a
	}
	views := make([]*ScreenView, 0, len(screens))
	for _, sc := range screens {
		v := &ScreenView{ProjectScreen: sc}
		if a := byID[sc.AttachmentID]; a != nil {
			v.ImageURL, v.ThumbnailURL, v.Width, v.Height = a.URL, a.ThumbnailURL, a.Width, a.Height
		}
		views = append(views, v)
	}
	detail := &ProjectDetail{Project: p, Screens: views, CanManage: caller.canManage(p)}
	theme, err := s.store.GetProjectTheme(ctx, key)
	switch {
	case err == nil:
		summary, vars := CondenseThemeCSS(theme.CSS)
		detail.Theme = &ThemeView{Filename: theme.Filename, Size: len(theme.CSS), Variables: vars, Summary: summary,
			UpdatedBy: theme.UpdatedBy, UpdatedAt: theme.UpdatedAt}
	case !errors.Is(err, store.ErrNotFound):
		return nil, err
	}
	return detail, nil
}

// Screens returns a project's screens in gallery order: page, then desktop
// before mobile, then state.
func (s *ProjectService) Screens(ctx context.Context, key string) ([]*model.ProjectScreen, error) {
	screens, err := s.store.ListScreens(ctx, key)
	if err != nil {
		return nil, err
	}
	sort.Slice(screens, func(i, j int) bool {
		a, b := screens[i], screens[j]
		if pa, pb := strings.ToLower(a.Page), strings.ToLower(b.Page); pa != pb {
			return pa < pb
		}
		if a.Viewport != b.Viewport {
			return a.Viewport == model.ScreenViewportDesktop
		}
		if a.State != b.State {
			return a.State < b.State
		}
		return a.ID < b.ID
	})
	return screens, nil
}

// ProjectInput is a create or patch of a project. Nil fields are untouched
// on a patch.
type ProjectInput struct {
	Name        *string              `json:"name"`
	AppURL      *string              `json:"appURL"`
	Description *string              `json:"description"`
	DesignNotes *string              `json:"designNotes"`
	Links       *[]model.ProjectLink `json:"links"`
	Repos       *[]model.ProjectRepo `json:"repos"`
	UILibrary   *string              `json:"uiLibrary"`
	// ThemeCSS sets the project's main stylesheet ("" removes it);
	// ThemeFilename names it for display.
	ThemeCSS      *string `json:"themeCSS"`
	ThemeFilename *string `json:"themeFilename"`
}

// Create registers a new project. The key derives from the name, the same
// way coding tasks derive it, so a project created here and one learned by
// dev are the same product.
func (s *ProjectService) Create(ctx context.Context, caller ProjectCaller, in ProjectInput) (*model.CodingProject, error) {
	if err := caller.member(); err != nil {
		return nil, err
	}
	if in.Name == nil {
		return nil, fmt.Errorf("project: name required: %w", service.ErrValidation)
	}
	now := s.now()
	p := &model.CodingProject{Repos: []model.ProjectRepo{}, CreatedBy: caller.ID, UpdatedBy: caller.ID, CreatedAt: now, UpdatedAt: now}
	if err := applyProjectInput(p, in, true); err != nil {
		return nil, err
	}
	p.Key = ProjectKey(p.Name)
	if p.Key == "" {
		return nil, fmt.Errorf("project: name needs at least one letter or digit: %w", service.ErrValidation)
	}
	if err := s.store.CreateProject(ctx, p); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, fmt.Errorf("project %q already exists: %w", p.Key, service.ErrAlreadyExists)
		}
		return nil, err
	}
	s.changed(ctx)
	return p, nil
}

// Update patches a project. Name and repos need manage rights; references
// (app link, description, notes, links) any member may maintain.
func (s *ProjectService) Update(ctx context.Context, caller ProjectCaller, key string, in ProjectInput) (*model.CodingProject, error) {
	if err := caller.member(); err != nil {
		return nil, err
	}
	p, err := s.store.GetProject(ctx, key)
	if err != nil {
		return nil, err
	}
	if (in.Name != nil || in.Repos != nil) && !caller.canManage(p) {
		return nil, apperr.Forbidden("only the project's creator or an admin can rename it or change its repos")
	}
	if err := applyProjectInput(p, in, caller.canManage(p)); err != nil {
		return nil, err
	}
	if err := s.applyTheme(ctx, caller, key, in); err != nil {
		return nil, err
	}
	p.UpdatedBy, p.UpdatedAt = caller.ID, s.now()
	if err := s.store.UpdateProject(ctx, p); err != nil {
		return nil, err
	}
	s.changed(ctx)
	return p, nil
}

// Delete removes a project and its gallery (manage rights). Coding tasks
// keep their own copy of the project's name and repos, so history survives.
func (s *ProjectService) Delete(ctx context.Context, caller ProjectCaller, key string) error {
	if err := caller.member(); err != nil {
		return err
	}
	p, err := s.store.GetProject(ctx, key)
	if err != nil {
		return err
	}
	if !caller.canManage(p) {
		return apperr.Forbidden("only the project's creator or an admin can delete it")
	}
	screens, err := s.store.ListScreens(ctx, key)
	if err != nil {
		return err
	}
	for _, sc := range screens {
		if err := s.removeScreen(ctx, sc); err != nil {
			return err
		}
	}
	if err := s.store.DeleteProjectTheme(ctx, key); err != nil {
		return err
	}
	if err := s.store.DeleteProject(ctx, key); err != nil {
		return err
	}
	s.changed(ctx)
	return nil
}

// applyProjectInput validates and copies a patch onto p. Name is copied only
// when manage is true (callers already refused a name change without it).
func applyProjectInput(p *model.CodingProject, in ProjectInput, manage bool) error {
	if in.Name != nil && manage {
		name := strings.TrimSpace(*in.Name)
		if name == "" || len(name) > 80 {
			return fmt.Errorf("project: name must be 1–80 characters: %w", service.ErrValidation)
		}
		p.Name = name
	}
	if in.AppURL != nil {
		u := strings.TrimSpace(*in.AppURL)
		if u != "" && !httpURL(u) {
			return fmt.Errorf("project: app link must be an http(s) URL: %w", service.ErrValidation)
		}
		p.AppURL = u
	}
	if in.Description != nil {
		d := strings.TrimSpace(*in.Description)
		if len(d) > model.ProjectDescriptionMaxLen {
			return fmt.Errorf("project: description is limited to %d characters: %w", model.ProjectDescriptionMaxLen, service.ErrValidation)
		}
		p.Description = d
	}
	if in.DesignNotes != nil {
		n := strings.TrimSpace(*in.DesignNotes)
		if len(n) > model.ProjectDesignNotesMaxLen {
			return fmt.Errorf("project: design notes are limited to %d characters: %w", model.ProjectDesignNotesMaxLen, service.ErrValidation)
		}
		p.DesignNotes = n
	}
	if in.UILibrary != nil {
		lib := strings.TrimSpace(*in.UILibrary)
		if len(lib) > model.ProjectUILibraryMaxLen {
			return fmt.Errorf("project: UI library is limited to %d characters: %w", model.ProjectUILibraryMaxLen, service.ErrValidation)
		}
		p.UILibrary = lib
	}
	if in.Links != nil {
		links, err := cleanProjectLinks(*in.Links)
		if err != nil {
			return err
		}
		p.Links = links
	}
	if in.Repos != nil {
		repos, err := cleanProjectRepos(*in.Repos)
		if err != nil {
			return err
		}
		p.Repos = repos
	}
	return nil
}

// applyTheme saves or removes the project's theme stylesheet when the input
// carries one. A stylesheet that defines no CSS variables is refused — it
// would give the agent nothing (usually the wrong file was picked).
func (s *ProjectService) applyTheme(ctx context.Context, caller ProjectCaller, key string, in ProjectInput) error {
	if in.ThemeCSS == nil {
		return nil
	}
	css := *in.ThemeCSS
	if strings.TrimSpace(css) == "" {
		return s.store.DeleteProjectTheme(ctx, key)
	}
	if len(css) > model.ProjectThemeMaxBytes {
		return fmt.Errorf("project: theme stylesheets are limited to %d KB: %w", model.ProjectThemeMaxBytes>>10, service.ErrValidation)
	}
	if _, vars := CondenseThemeCSS(css); vars == 0 {
		return fmt.Errorf("project: no CSS variables found — upload the file that defines your theme (e.g. globals.css): %w", service.ErrValidation)
	}
	name := "theme.css"
	if in.ThemeFilename != nil && strings.TrimSpace(*in.ThemeFilename) != "" {
		name = strings.TrimSpace(*in.ThemeFilename)
	}
	if len(name) > model.ScreenFieldMaxLen {
		return fmt.Errorf("project: theme file name too long: %w", service.ErrValidation)
	}
	return s.store.PutProjectTheme(ctx, &model.ProjectTheme{ProjectKey: key, Filename: name, CSS: css, UpdatedBy: caller.ID, UpdatedAt: s.now()})
}

func cleanProjectLinks(in []model.ProjectLink) ([]model.ProjectLink, error) {
	if len(in) > model.ProjectLinksMax {
		return nil, fmt.Errorf("project: at most %d links: %w", model.ProjectLinksMax, service.ErrValidation)
	}
	out := make([]model.ProjectLink, 0, len(in))
	for _, l := range in {
		label, u := strings.TrimSpace(l.Label), strings.TrimSpace(l.URL)
		if u == "" {
			continue
		}
		if !httpURL(u) {
			return nil, fmt.Errorf("project: link %q must be an http(s) URL: %w", u, service.ErrValidation)
		}
		if len(label) > model.ScreenFieldMaxLen {
			return nil, fmt.Errorf("project: link label too long: %w", service.ErrValidation)
		}
		if label == "" {
			label = u
		}
		out = append(out, model.ProjectLink{Label: label, URL: u})
	}
	return out, nil
}

func cleanProjectRepos(in []model.ProjectRepo) ([]model.ProjectRepo, error) {
	out := make([]model.ProjectRepo, 0, len(in))
	seen := map[string]bool{}
	for _, r := range in {
		path := strings.Trim(strings.TrimSpace(r.Path), "/")
		if path == "" {
			continue
		}
		if !strings.Contains(path, "/") || strings.ContainsAny(path, " \t\n") || strings.HasPrefix(path, "-") {
			return nil, fmt.Errorf("project: repo %q must be a GitLab path like group/repo: %w", path, service.ErrValidation)
		}
		if seen[path] {
			continue
		}
		seen[path] = true
		role := strings.TrimSpace(r.Role)
		if !model.ValidRepoRole(role) {
			return nil, fmt.Errorf("project: unknown repo role %q: %w", role, service.ErrValidation)
		}
		if role == "" {
			role = model.RepoRoleOther
		}
		out = append(out, model.ProjectRepo{Path: path, Role: role, DefaultBranch: strings.TrimSpace(r.DefaultBranch)})
	}
	return out, nil
}

func httpURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// ScreenInput is a create or patch of one screen. Nil fields are untouched
// on a patch; AttachmentID replaces the image.
type ScreenInput struct {
	Page         *string `json:"page"`
	Description  *string `json:"description"`
	Viewport     *string `json:"viewport"`
	State        *string `json:"state"`
	SeenBy       *string `json:"seenBy"`
	Route        *string `json:"route"`
	AttachmentID *string `json:"attachmentID"`
}

// AddScreen adds a reference screenshot. The image is an attachment the
// caller uploaded through the normal upload flow; the screen takes a
// reference on it so it outlives the upload's draft state.
func (s *ProjectService) AddScreen(ctx context.Context, caller ProjectCaller, key string, in ScreenInput) (*model.ProjectScreen, error) {
	if err := caller.member(); err != nil {
		return nil, err
	}
	if _, err := s.store.GetProject(ctx, key); err != nil {
		return nil, err
	}
	if in.Page == nil || in.Description == nil || in.AttachmentID == nil {
		return nil, fmt.Errorf("screen: page, description and image are required: %w", service.ErrValidation)
	}
	existing, err := s.store.ListScreens(ctx, key)
	if err != nil {
		return nil, err
	}
	if len(existing) >= model.ProjectScreensMax {
		return nil, fmt.Errorf("screen: a project holds at most %d screens — replace or delete old ones: %w", model.ProjectScreensMax, service.ErrValidation)
	}
	now := s.now()
	sc := &model.ProjectScreen{ID: s.newID(), ProjectKey: key, Viewport: model.ScreenViewportDesktop, UploadedBy: caller.ID, CreatedAt: now, UpdatedAt: now}
	if err := applyScreenInput(sc, in); err != nil {
		return nil, err
	}
	if err := s.claimImage(ctx, caller, sc.ID, sc.AttachmentID); err != nil {
		return nil, err
	}
	if err := s.store.PutScreen(ctx, sc); err != nil {
		_ = s.attachments.RemoveRef(ctx, sc.AttachmentID, model.ScreenAttachmentRef(sc.ID))
		return nil, err
	}
	s.changed(ctx)
	return sc, nil
}

// UpdateScreen edits a screen's labels or replaces its image (any member).
// A new image counts as a fresh screenshot: the freshness date moves.
func (s *ProjectService) UpdateScreen(ctx context.Context, caller ProjectCaller, key, id string, in ScreenInput) (*model.ProjectScreen, error) {
	if err := caller.member(); err != nil {
		return nil, err
	}
	sc, err := s.store.GetScreen(ctx, key, id)
	if err != nil {
		return nil, err
	}
	oldImage := sc.AttachmentID
	if err := applyScreenInput(sc, in); err != nil {
		return nil, err
	}
	sc.UpdatedAt = s.now()
	replaced := sc.AttachmentID != oldImage
	if replaced {
		if err := s.claimImage(ctx, caller, sc.ID, sc.AttachmentID); err != nil {
			return nil, err
		}
		sc.UploadedBy = caller.ID
	}
	if err := s.store.PutScreen(ctx, sc); err != nil {
		return nil, err
	}
	if replaced {
		_ = s.attachments.RemoveRef(ctx, oldImage, model.ScreenAttachmentRef(sc.ID))
	}
	s.changed(ctx)
	return sc, nil
}

// DeleteScreen removes a screen and releases its image (any member).
func (s *ProjectService) DeleteScreen(ctx context.Context, caller ProjectCaller, key, id string) error {
	if err := caller.member(); err != nil {
		return err
	}
	sc, err := s.store.GetScreen(ctx, key, id)
	if err != nil {
		return err
	}
	if err := s.removeScreen(ctx, sc); err != nil {
		return err
	}
	s.changed(ctx)
	return nil
}

func (s *ProjectService) removeScreen(ctx context.Context, sc *model.ProjectScreen) error {
	if err := s.store.DeleteScreen(ctx, sc.ProjectKey, sc.ID); err != nil {
		return err
	}
	// Best effort: a failed release leaves an orphaned image, never a
	// screen pointing at a deleted one.
	_ = s.attachments.RemoveRef(ctx, sc.AttachmentID, model.ScreenAttachmentRef(sc.ID))
	return nil
}

// claimImage checks the upload is an image the caller uploaded and within
// bounds, then takes the screen's reference on it.
func (s *ProjectService) claimImage(ctx context.Context, caller ProjectCaller, screenID, attachmentID string) error {
	a, err := s.attachments.Get(ctx, attachmentID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("screen: image not found — upload it first: %w", service.ErrValidation)
		}
		return err
	}
	if a.CreatedBy != caller.ID {
		return apperr.Forbidden("screen: the image must be one you uploaded")
	}
	if !a.IsImage() {
		return fmt.Errorf("screen: %q is not an image: %w", a.Filename, service.ErrValidation)
	}
	if a.Size > model.ScreenImageMaxBytes {
		return fmt.Errorf("screen: images are limited to %d MB: %w", model.ScreenImageMaxBytes>>20, service.ErrValidation)
	}
	// Same gate as a message send: the bytes in storage must be the
	// finished, verified upload the row describes.
	if err := s.attachments.ValidateForUse(ctx, attachmentID); err != nil {
		return fmt.Errorf("screen: image upload is not finished: %w", service.ErrValidation)
	}
	return s.attachments.AddRef(ctx, attachmentID, model.ScreenAttachmentRef(screenID))
}

func applyScreenInput(sc *model.ProjectScreen, in ScreenInput) error {
	text := func(dst *string, v *string, max int, field string, required bool) error {
		if v == nil {
			return nil
		}
		t := strings.TrimSpace(*v)
		if required && t == "" {
			return fmt.Errorf("screen: %s is required: %w", field, service.ErrValidation)
		}
		if len(t) > max {
			return fmt.Errorf("screen: %s is limited to %d characters: %w", field, max, service.ErrValidation)
		}
		*dst = t
		return nil
	}
	for _, f := range []struct {
		dst      *string
		v        *string
		max      int
		name     string
		required bool
	}{
		{&sc.Page, in.Page, model.ScreenPageMaxLen, "page name", true},
		{&sc.Description, in.Description, model.ScreenDescriptionMaxLen, "description", true},
		{&sc.State, in.State, model.ScreenFieldMaxLen, "state", false},
		{&sc.SeenBy, in.SeenBy, model.ScreenFieldMaxLen, "seen by", false},
		{&sc.Route, in.Route, model.ScreenFieldMaxLen, "route", false},
		{&sc.AttachmentID, in.AttachmentID, model.ScreenFieldMaxLen, "image", true},
	} {
		if err := text(f.dst, f.v, f.max, f.name, f.required); err != nil {
			return err
		}
	}
	if in.Viewport != nil {
		switch v := strings.TrimSpace(*in.Viewport); v {
		case model.ScreenViewportDesktop, model.ScreenViewportMobile:
			sc.Viewport = v
		default:
			return fmt.Errorf("screen: viewport must be desktop or mobile: %w", service.ErrValidation)
		}
	}
	if sc.State == "default" {
		sc.State = ""
	}
	return nil
}
