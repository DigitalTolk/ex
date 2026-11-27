package agents

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/cliffhub"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// CliffHubProjects makes CliffHub's systems ex's projects. CliffHub is the
// source of truth for a project's identity and references (name, repos, app
// link, description, design notes, UI library, links); ex keeps a cached copy
// in its own project rows so every reader (coding tasks, the design agent,
// the Projects page) keeps working off one store. Screens and the theme
// stylesheet stay in ex: they are ex attachments only its agents use.
//
// The cache is refreshed by polling (Sync): one list call whose ETag makes
// an unchanged catalogue cost a 304. Writes from ex (the Projects page, a
// coding task learning a project or a repo's default branch) go to CliffHub
// first, as the person making them, and then to the cache.
type CliffHubProjects struct {
	client systemsClient
	store  cliffhubProjectStore
	users  projectUserLookup
	images cliffhubImages
	// emailMap maps ex addresses to CliffHub ones (development only).
	emailMap map[string]string
	// fallbackActor acts for people CliffHub has no employee for.
	fallbackActor string
	gitHost       string
	webURL        string
	onChange      func(context.Context)
	now           func() time.Time

	// mu serialises syncs and guards the fields below.
	mu         sync.Mutex
	etag       string
	systems    []cliffhub.System
	lastSyncAt time.Time
	lastErr    string
	// pushErrs remembers the last failure to move each local-only project
	// into CliffHub, so a sync logs a failure once rather than every minute.
	pushErrs map[string]string
}

// systemsClient is the cliffhub.Client slice the projects use.
type systemsClient interface {
	Configured() bool
	ListSystems(ctx context.Context, etag string) ([]cliffhub.System, string, bool, error)
	CreateSystem(ctx context.Context, actorEmail string, in cliffhub.SystemInput) (*cliffhub.System, error)
	UpdateSystem(ctx context.Context, actorEmail, id string, in cliffhub.SystemInput) (*cliffhub.System, error)
	ScreenImage(ctx context.Context, systemID, screenID string) ([]byte, error)
	CreateScreen(ctx context.Context, actorEmail, systemID string, in cliffhub.ScreenInput, image []byte) (*cliffhub.Screen, error)
	UpdateScreen(ctx context.Context, actorEmail, systemID, screenID string, in cliffhub.ScreenInput, image []byte) (*cliffhub.Screen, error)
	DeleteScreen(ctx context.Context, actorEmail, systemID, screenID string) error
}

type cliffhubProjectStore interface {
	CreateProject(ctx context.Context, p *model.CodingProject) error
	UpdateProject(ctx context.Context, p *model.CodingProject) error
	ListProjects(ctx context.Context) ([]*model.CodingProject, error)
	PutScreen(ctx context.Context, sc *model.ProjectScreen) error
	ListScreens(ctx context.Context, projectKey string) ([]*model.ProjectScreen, error)
	DeleteScreen(ctx context.Context, projectKey, id string) error
	PutProjectTheme(ctx context.Context, t *model.ProjectTheme) error
	GetProjectTheme(ctx context.Context, projectKey string) (*model.ProjectTheme, error)
	DeleteProjectTheme(ctx context.Context, projectKey string) error
}

// cliffhubImages is the AttachmentService slice screens need: a CliffHub
// image becomes an ex attachment (agents read screens as attachments), and an
// ex upload is read back to send to CliffHub.
type cliffhubImages interface {
	ImportImage(ctx context.Context, p service.ImportImageParams) (*model.Attachment, error)
	OpenByID(ctx context.Context, id string) (io.ReadCloser, *model.Attachment, error)
	AddRef(ctx context.Context, attachmentID, messageID string) error
	RemoveRef(ctx context.Context, attachmentID, messageID string) error
}

type projectUserLookup interface {
	GetUser(ctx context.Context, id string) (*model.User, error)
}

// NewCliffHubProjects wires the CliffHub project source. gitHost turns a
// repo path back into a link when ex writes a repo CliffHub has never seen;
// webURL is CliffHub's web app, for links to a system.
func NewCliffHubProjects(client systemsClient, st cliffhubProjectStore, users projectUserLookup, images cliffhubImages, gitHost, webURL string) *CliffHubProjects {
	return &CliffHubProjects{
		client:   client,
		store:    st,
		users:    users,
		images:   images,
		gitHost:  strings.TrimSpace(gitHost),
		webURL:   strings.TrimRight(webURL, "/"),
		onChange: func(context.Context) {},
		now:      time.Now,
		pushErrs: map[string]string{},
	}
}

// SetOnChange is called after a sync changed any project.
func (s *CliffHubProjects) SetOnChange(f func(context.Context)) { s.onChange = f }

// Enabled reports whether projects come from CliffHub.
func (s *CliffHubProjects) Enabled() bool { return s != nil && s.client.Configured() }

// EditURL is where a person edits a linked project in CliffHub ("" when
// there is no web URL or the project is not linked).
func (s *CliffHubProjects) EditURL(p *model.CodingProject) string {
	if s.webURL == "" || p.SystemID == "" {
		return ""
	}
	return s.webURL + "/systems?system=" + url.QueryEscape(p.SystemID) + "&tab=project"
}

// ProjectSourceStatus describes where projects come from, for the Projects
// page.
type ProjectSourceStatus struct {
	Provider   string     `json:"provider"`
	NewURL     string     `json:"newURL,omitempty"`
	LastSyncAt *time.Time `json:"lastSyncAt,omitempty"`
	LastError  string     `json:"lastError,omitempty"`
}

// Status reports the last sync.
func (s *CliffHubProjects) Status() ProjectSourceStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := ProjectSourceStatus{Provider: "cliffhub", LastError: s.lastErr}
	if s.webURL != "" {
		st.NewURL = s.webURL + "/systems"
	}
	if !s.lastSyncAt.IsZero() {
		at := s.lastSyncAt
		st.LastSyncAt = &at
	}
	return st
}

// ProjectSyncResult is what one sync changed, by project key.
type ProjectSyncResult struct {
	Created   []string `json:"created"`
	Updated   []string `json:"updated"`
	Linked    []string `json:"linked"`
	Archived  []string `json:"archived"`
	Pushed    []string `json:"pushed"`
	Unchanged int      `json:"unchanged"`
	// NotModified: CliffHub answered 304 and the cache already matched.
	NotModified bool `json:"notModified"`
}

func (r *ProjectSyncResult) changed() bool {
	return len(r.Created)+len(r.Updated)+len(r.Linked)+len(r.Archived)+len(r.Pushed) > 0
}

// RunSync syncs at once, then every interval until ctx ends.
func (s *CliffHubProjects) RunSync(ctx context.Context, interval time.Duration) {
	s.syncOnce(ctx, true)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.syncOnce(ctx, false)
		}
	}
}

// syncOnce runs one bounded pass and logs its outcome.
func (s *CliffHubProjects) syncOnce(ctx context.Context, force bool) {
	defer safe.Recover()
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	res, err := s.Sync(ctx, force)
	switch {
	case err != nil:
		slog.WarnContext(ctx, "cliffhub project sync failed", "error", err)
	case res.changed():
		slog.InfoContext(ctx, "cliffhub project sync", "created", res.Created, "updated", res.Updated,
			"linked", res.Linked, "archived", res.Archived, "pushed", res.Pushed, "unchanged", res.Unchanged)
	}
}

// Sync brings the cache in line with CliffHub. force skips the ETag, so the
// full list is fetched even when CliffHub saw it before.
func (s *CliffHubProjects) Sync(ctx context.Context, force bool) (*ProjectSyncResult, error) {
	if !s.Enabled() {
		return nil, cliffhub.ErrNotConfigured
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	etag := s.etag
	if force || s.systems == nil {
		etag = ""
	}
	systems, newETag, notModified, err := s.client.ListSystems(ctx, etag)
	if err != nil {
		s.lastErr = err.Error()
		return nil, err
	}
	if !notModified {
		s.systems, s.etag = systems, newETag
	}
	res, err := s.reconcile(ctx, s.systems, !notModified)
	if err != nil {
		s.lastErr = err.Error()
		return nil, err
	}
	res.NotModified = notModified && !res.changed()
	s.lastSyncAt, s.lastErr = s.now(), ""
	if res.changed() {
		s.onChange(ctx)
	}
	return res, nil
}

// reconcile applies systems to the cached project rows. Caller holds mu.
// fetched says the list is fresh from CliffHub: only then are screens and
// themes compared (a 304 means none of them changed).
func (s *CliffHubProjects) reconcile(ctx context.Context, systems []cliffhub.System, fetched bool) (*ProjectSyncResult, error) {
	res := &ProjectSyncResult{Created: []string{}, Updated: []string{}, Linked: []string{}, Archived: []string{}, Pushed: []string{}}
	projects, err := s.store.ListProjects(ctx)
	if err != nil {
		return nil, err
	}
	bySystem := map[string]*model.CodingProject{}
	unlinked := map[string]*model.CodingProject{} // by folded name
	taken := map[string]bool{}
	for _, p := range projects {
		taken[p.Key] = true
		if p.SystemID != "" {
			bySystem[p.SystemID] = p
		} else {
			unlinked[strings.ToLower(strings.TrimSpace(p.Name))] = p
		}
	}

	// refs is the screens and theme work, done once the rows are in place.
	type refsWork struct {
		p     *model.CodingProject
		sys   cliffhub.System
		fresh bool // just linked or moved: ex's own references go to CliffHub
	}
	var refs []refsWork
	seen := map[string]bool{}
	for _, sys := range systems {
		seen[sys.ID] = true
		p, linked := bySystem[sys.ID], false
		if p == nil {
			// A project ex had before CliffHub knew it, with the same name:
			// the same product. Link it rather than add a second one.
			if q := unlinked[strings.ToLower(strings.TrimSpace(sys.Name))]; q != nil {
				delete(unlinked, strings.ToLower(strings.TrimSpace(sys.Name)))
				p, linked = q, true
			}
		}
		// Only systems marked as projects (a project type) become ex
		// projects; the rest of the catalogue is not ex's business.
		if p == nil && sys.ProjectType == "" {
			continue
		}
		if p == nil {
			key := uniqueProjectKey(ProjectKey(sys.Name), sys.ID, taken)
			taken[key] = true
			next := &model.CodingProject{Key: key, Repos: []model.ProjectRepo{}, CreatedAt: s.now(), UpdatedAt: s.now()}
			applySystem(next, sys)
			if err := s.store.CreateProject(ctx, next); err != nil && !errors.Is(err, store.ErrAlreadyExists) {
				return nil, err
			}
			res.Created = append(res.Created, key)
			refs = append(refs, refsWork{next, sys, false})
			continue
		}
		next := *p
		if linked {
			// Link without losing anything: ex's notes, repos and links go to
			// the system where it has none (append only), and only then does
			// the row take the system's values. If CliffHub refuses, the
			// project stays unlinked and is retried on the next sync.
			next.SystemID = sys.ID
			if err := s.appendLocked(ctx, firstNonEmpty(p.CreatedBy, p.UpdatedBy), &next, sys); err != nil {
				if s.pushErrs[p.Key] != err.Error() {
					slog.WarnContext(ctx, "cliffhub: could not link project to its system", "project", p.Key, "system", sys.ID, "error", err)
					s.pushErrs[p.Key] = err.Error()
				}
				continue
			}
			delete(s.pushErrs, p.Key)
			sys = s.cached(sys.ID)
		} else {
			applySystem(&next, sys)
		}
		if fetched || linked {
			refs = append(refs, refsWork{&next, sys, linked})
		}
		if !linked && sameSyncedFields(p, &next) {
			res.Unchanged++
			continue
		}
		next.UpdatedAt = s.now()
		if err := s.store.UpdateProject(ctx, &next); err != nil {
			return nil, err
		}
		if linked {
			res.Linked = append(res.Linked, next.Key)
		} else {
			res.Updated = append(res.Updated, next.Key)
		}
	}

	// A linked project whose system is gone was deleted in CliffHub. Keep the
	// row (tasks and screens point at it) but retire it. An empty list is
	// never taken as "everything was deleted": that is far more likely a
	// CliffHub problem than a real wipe.
	if len(systems) > 0 {
		for _, p := range bySystem {
			if seen[p.SystemID] || p.Archived {
				continue
			}
			next := *p
			next.Archived, next.UpdatedAt = true, s.now()
			if err := s.store.UpdateProject(ctx, &next); err != nil {
				return nil, err
			}
			res.Archived = append(res.Archived, p.Key)
		}
	}

	// Projects ex has that CliffHub has no system for move into CliffHub,
	// created as the person who made them.
	for _, p := range unlinked {
		if p.Archived {
			continue
		}
		next := *p
		if err := s.createSystemLocked(ctx, firstNonEmpty(p.CreatedBy, p.UpdatedBy), &next); err != nil {
			if s.pushErrs[p.Key] != err.Error() {
				slog.WarnContext(ctx, "cliffhub: could not move project into CliffHub", "project", p.Key, "error", err)
				s.pushErrs[p.Key] = err.Error()
			}
			continue
		}
		delete(s.pushErrs, p.Key)
		next.UpdatedAt = s.now()
		if err := s.store.UpdateProject(ctx, &next); err != nil {
			return nil, err
		}
		res.Pushed = append(res.Pushed, p.Key)
		refs = append(refs, refsWork{&next, s.cached(next.SystemID), true})
	}

	// Screens and themes. A failure here is logged and retried on the next
	// full sync: the project rows above are already right.
	for _, w := range refs {
		changed, err := s.syncRefs(ctx, w.p, w.sys, w.fresh)
		if err != nil {
			slog.WarnContext(ctx, "cliffhub: screens or theme not synced", "project", w.p.Key, "error", err)
		}
		if changed && !contains(res.Created, w.p.Key) && !contains(res.Updated, w.p.Key) &&
			!contains(res.Linked, w.p.Key) && !contains(res.Pushed, w.p.Key) {
			res.Updated = append(res.Updated, w.p.Key)
			res.Unchanged--
		}
	}
	return res, nil
}

// cached is the system as CliffHub last showed it (zero when unknown).
// Caller holds mu.
func (s *CliffHubProjects) cached(id string) cliffhub.System {
	for _, sys := range s.systems {
		if sys.ID == id {
			return sys
		}
	}
	return cliffhub.System{ID: id}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// syncRefs brings a project's screens and theme in line with its system.
// fresh (a project just linked or moved into CliffHub) first sends ex's own
// theme to a system that has none. Screens ex has and CliffHub never had
// (no source hash) always go to CliffHub rather than being dropped.
func (s *CliffHubProjects) syncRefs(ctx context.Context, p *model.CodingProject, sys cliffhub.System, fresh bool) (bool, error) {
	changed, err := s.syncTheme(ctx, p, sys, fresh)
	if err != nil {
		return changed, err
	}
	sc, err := s.syncScreens(ctx, p, sys)
	return changed || sc, err
}

func (s *CliffHubProjects) syncTheme(ctx context.Context, p *model.CodingProject, sys cliffhub.System, fresh bool) (bool, error) {
	local, err := s.store.GetProjectTheme(ctx, p.Key)
	if errors.Is(err, store.ErrNotFound) {
		local, err = nil, nil
	}
	if err != nil {
		return false, err
	}
	switch {
	case fresh && local != nil && sys.ThemeCSS == "":
		in := cliffhub.SystemInput{ThemeCSS: &local.CSS, ThemeFilename: &local.Filename}
		var updated *cliffhub.System
		if err := s.asActor(ctx, firstNonEmpty(local.UpdatedBy, p.CreatedBy), func(email string) (err error) {
			updated, err = s.client.UpdateSystem(ctx, email, sys.ID, in)
			return err
		}); err != nil {
			return false, err
		}
		s.remember(*updated)
		return false, nil
	case sys.ThemeCSS == "" && local != nil:
		return true, s.store.DeleteProjectTheme(ctx, p.Key)
	case sys.ThemeCSS != "" && (local == nil || local.CSS != sys.ThemeCSS || local.Filename != firstNonEmpty(sys.ThemeFilename, "theme.css")):
		return true, s.store.PutProjectTheme(ctx, &model.ProjectTheme{
			ProjectKey: p.Key, Filename: firstNonEmpty(sys.ThemeFilename, "theme.css"), CSS: sys.ThemeCSS, UpdatedAt: s.now(),
		})
	}
	return false, nil
}

func (s *CliffHubProjects) syncScreens(ctx context.Context, p *model.CodingProject, sys cliffhub.System) (bool, error) {
	local, err := s.store.ListScreens(ctx, p.Key)
	if err != nil {
		return false, err
	}
	byID := map[string]*model.ProjectScreen{}
	for _, sc := range local {
		byID[sc.ID] = sc
	}
	changed := false
	for _, rs := range sys.Screens {
		ls := byID[rs.ID]
		delete(byID, rs.ID)
		next := screenFromSystem(p.Key, rs, s.now())
		if ls != nil {
			next.UploadedBy, next.AttachmentID, next.SourceSHA256 = ls.UploadedBy, ls.AttachmentID, ls.SourceSHA256
		}
		if ls != nil && ls.SourceSHA256 == rs.ImageSHA256 {
			if sameScreen(ls, next) {
				continue
			}
			if err := s.store.PutScreen(ctx, next); err != nil {
				return changed, err
			}
			changed = true
			continue
		}
		// New, or its image changed: copy the image into ex.
		data, err := s.client.ScreenImage(ctx, sys.ID, rs.ID)
		if err != nil {
			return changed, err
		}
		att, err := s.images.ImportImage(ctx, service.ImportImageParams{Name: screenFileName(rs), CreatedBy: next.UploadedBy, Data: data})
		if err != nil {
			return changed, err
		}
		if err := s.images.AddRef(ctx, att.ID, model.ScreenAttachmentRef(rs.ID)); err != nil {
			return changed, err
		}
		old := next.AttachmentID
		next.AttachmentID, next.SourceSHA256 = att.ID, rs.ImageSHA256
		if err := s.store.PutScreen(ctx, next); err != nil {
			_ = s.images.RemoveRef(ctx, att.ID, model.ScreenAttachmentRef(rs.ID))
			return changed, err
		}
		if old != "" {
			_ = s.images.RemoveRef(ctx, old, model.ScreenAttachmentRef(rs.ID))
		}
		changed = true
	}
	for _, ls := range byID {
		if ls.SourceSHA256 == "" {
			if err := s.pushScreen(ctx, p, sys.ID, ls); err != nil {
				return changed, err
			}
			changed = true
			continue
		}
		// Deleted in CliffHub.
		if err := s.store.DeleteScreen(ctx, p.Key, ls.ID); err != nil {
			return changed, err
		}
		_ = s.images.RemoveRef(ctx, ls.AttachmentID, model.ScreenAttachmentRef(ls.ID))
		changed = true
	}
	return changed, nil
}

// pushScreen moves a screen only ex has into CliffHub, as whoever uploaded
// it. CliffHub picks the screen's ID, so the row is re-keyed and its image
// reference moves with it.
func (s *CliffHubProjects) pushScreen(ctx context.Context, p *model.CodingProject, systemID string, ls *model.ProjectScreen) error {
	data, err := s.readImage(ctx, ls.AttachmentID)
	if err != nil {
		return err
	}
	var rs *cliffhub.Screen
	if err := s.asActor(ctx, firstNonEmpty(ls.UploadedBy, p.CreatedBy), func(email string) (err error) {
		rs, err = s.client.CreateScreen(ctx, email, systemID, screenInputOf(ls), data)
		return err
	}); err != nil {
		return err
	}
	next := *ls
	next.ID, next.SourceSHA256 = rs.ID, rs.ImageSHA256
	if err := s.images.AddRef(ctx, ls.AttachmentID, model.ScreenAttachmentRef(rs.ID)); err != nil {
		return err
	}
	if err := s.store.PutScreen(ctx, &next); err != nil {
		return err
	}
	if err := s.store.DeleteScreen(ctx, p.Key, ls.ID); err != nil {
		return err
	}
	_ = s.images.RemoveRef(ctx, ls.AttachmentID, model.ScreenAttachmentRef(ls.ID))
	return nil
}

// SaveScreen writes a screen of a linked project to CliffHub, as actorID:
// a new screen is created there and takes CliffHub's ID; an existing one is
// updated, with its image when imageChanged. A screen CliffHub never had is
// left for the sync to move.
func (s *CliffHubProjects) SaveScreen(ctx context.Context, actorID string, p *model.CodingProject, sc *model.ProjectScreen, isNew, imageChanged bool) error {
	if p.SystemID == "" || (!isNew && sc.SourceSHA256 == "") {
		return nil
	}
	var data []byte
	if isNew || imageChanged {
		var err error
		if data, err = s.readImage(ctx, sc.AttachmentID); err != nil {
			return err
		}
	}
	var rs *cliffhub.Screen
	if err := s.asActor(ctx, actorID, func(email string) (err error) {
		if isNew {
			rs, err = s.client.CreateScreen(ctx, email, p.SystemID, screenInputOf(sc), data)
		} else {
			rs, err = s.client.UpdateScreen(ctx, email, p.SystemID, sc.ID, screenInputOf(sc), data)
		}
		return err
	}); err != nil {
		return err
	}
	sc.ID, sc.SourceSHA256 = rs.ID, rs.ImageSHA256
	s.mu.Lock()
	s.etag = ""
	s.mu.Unlock()
	return nil
}

// DeleteScreenUpstream removes a linked project's screen from CliffHub.
func (s *CliffHubProjects) DeleteScreenUpstream(ctx context.Context, actorID string, p *model.CodingProject, sc *model.ProjectScreen) error {
	if p.SystemID == "" || sc.SourceSHA256 == "" {
		return nil
	}
	if err := s.asActor(ctx, actorID, func(email string) error {
		return s.client.DeleteScreen(ctx, email, p.SystemID, sc.ID)
	}); err != nil {
		return err
	}
	s.mu.Lock()
	s.etag = ""
	s.mu.Unlock()
	return nil
}

// SaveTheme writes a linked project's theme stylesheet to CliffHub ("" css
// removes it), as actorID.
func (s *CliffHubProjects) SaveTheme(ctx context.Context, actorID string, p *model.CodingProject, css, filename string) error {
	if p.SystemID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if css == "" {
		filename = ""
	}
	in := cliffhub.SystemInput{ThemeCSS: &css, ThemeFilename: &filename}
	var sys *cliffhub.System
	if err := s.asActor(ctx, actorID, func(email string) (err error) {
		sys, err = s.client.UpdateSystem(ctx, email, p.SystemID, in)
		return err
	}); err != nil {
		return err
	}
	s.remember(*sys)
	return nil
}

// readImage reads an ex attachment's bytes.
func (s *CliffHubProjects) readImage(ctx context.Context, attachmentID string) ([]byte, error) {
	rc, _, err := s.images.OpenByID(ctx, attachmentID)
	if err != nil {
		return nil, fmt.Errorf("cliffhub: read screen image: %w", err)
	}
	defer func() { _ = rc.Close() }()
	data, err := io.ReadAll(io.LimitReader(rc, model.ScreenImageMaxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("cliffhub: read screen image: %w", err)
	}
	return data, nil
}

func screenInputOf(sc *model.ProjectScreen) cliffhub.ScreenInput {
	return cliffhub.ScreenInput{Page: sc.Page, Description: sc.Description, Viewport: sc.Viewport,
		State: sc.State, SeenBy: sc.SeenBy, Route: sc.Route}
}

// screenFromSystem is a CliffHub screen as an ex screen row (no image yet).
func screenFromSystem(key string, rs cliffhub.Screen, now time.Time) *model.ProjectScreen {
	viewport := rs.Viewport
	if viewport != model.ScreenViewportMobile {
		viewport = model.ScreenViewportDesktop
	}
	state := rs.State
	if state == "default" {
		state = ""
	}
	return &model.ProjectScreen{
		ID: rs.ID, ProjectKey: key, Page: rs.Page, Description: rs.Description, Viewport: viewport,
		State: state, SeenBy: rs.SeenBy, Route: rs.Route,
		CreatedAt: parseTimeOr(rs.CreatedAt, now), UpdatedAt: parseTimeOr(rs.UpdatedAt, now),
	}
}

func sameScreen(a, b *model.ProjectScreen) bool {
	return a.Page == b.Page && a.Description == b.Description && a.Viewport == b.Viewport &&
		a.State == b.State && a.SeenBy == b.SeenBy && a.Route == b.Route &&
		a.CreatedAt.Equal(b.CreatedAt) && a.UpdatedAt.Equal(b.UpdatedAt)
}

// screenFileName names an imported image after its page ("booking-detail").
func screenFileName(rs cliffhub.Screen) string {
	if name := service.Slugify(rs.Page); name != "" {
		return name
	}
	return "screen"
}

func parseTimeOr(raw string, def time.Time) time.Time {
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t
	}
	return def
}

// Create registers p as a new CliffHub system, acting as actorID, and copies
// what CliffHub stored back onto p (SystemID included). The caller then
// writes p to the cache.
func (s *CliffHubProjects) Create(ctx context.Context, actorID string, p *model.CodingProject) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.createSystemLocked(ctx, actorID, p)
}

func (s *CliffHubProjects) createSystemLocked(ctx context.Context, actorID string, p *model.CodingProject) error {
	var sys *cliffhub.System
	if err := s.asActor(ctx, actorID, func(email string) (err error) {
		sys, err = s.client.CreateSystem(ctx, email, s.newSystemInput(p))
		return err
	}); err != nil {
		return err
	}
	s.remember(*sys)
	applySystem(p, *sys)
	return nil
}

// Save adds what p knows and its system lacks (new repos, a learned default
// branch, a missing description, …) to CliffHub, acting as actorID, and
// copies the result back onto p. It never removes or overwrites anything
// CliffHub holds: see appendOnlyPatch. A project not linked yet is created
// in CliffHub instead.
func (s *CliffHubProjects) Save(ctx context.Context, actorID string, p *model.CodingProject) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.SystemID == "" {
		return s.createSystemLocked(ctx, actorID, p)
	}
	current, err := s.current(ctx, p.SystemID)
	if err != nil {
		return err
	}
	return s.appendLocked(ctx, actorID, p, current)
}

// appendLocked sends p's additions to current (if any) and applies the
// system CliffHub returns to p. Caller holds mu.
func (s *CliffHubProjects) appendLocked(ctx context.Context, actorID string, p *model.CodingProject, current cliffhub.System) error {
	in, changed := s.appendOnlyPatch(p, current)
	if !changed {
		applySystem(p, current)
		return nil
	}
	var sys *cliffhub.System
	if err := s.asActor(ctx, actorID, func(email string) (err error) {
		sys, err = s.client.UpdateSystem(ctx, email, p.SystemID, in)
		return err
	}); err != nil {
		return err
	}
	sys.Screens = current.Screens
	s.remember(*sys)
	applySystem(p, *sys)
	return nil
}

// current is the system as CliffHub holds it: from the cached list, or a
// fresh one when the cache does not have it. Caller holds mu.
func (s *CliffHubProjects) current(ctx context.Context, id string) (cliffhub.System, error) {
	for _, sys := range s.systems {
		if sys.ID == id {
			return sys, nil
		}
	}
	systems, etag, _, err := s.client.ListSystems(ctx, "")
	if err != nil {
		return cliffhub.System{}, err
	}
	s.systems, s.etag = systems, etag
	for _, sys := range systems {
		if sys.ID == id {
			return sys, nil
		}
	}
	return cliffhub.System{}, fmt.Errorf("cliffhub: system %s not found: %w", id, service.ErrValidation)
}

// remember puts a system CliffHub just returned into the cached list and
// drops the ETag, so the next sync reads the list afresh. Caller holds mu.
func (s *CliffHubProjects) remember(sys cliffhub.System) {
	s.etag = ""
	for i := range s.systems {
		if s.systems[i].ID == sys.ID {
			// Write responses carry no screens; keep the ones the list had.
			if sys.Screens == nil {
				sys.Screens = s.systems[i].Screens
			}
			s.systems[i] = sys
			return
		}
	}
	s.systems = append(s.systems, sys)
}

// asActor runs call as actorID's CliffHub identity (their email). When the
// person has no email, or CliffHub has no employee with it, and a fallback
// person is configured, it runs as the fallback instead.
func (s *CliffHubProjects) asActor(ctx context.Context, actorID string, call func(email string) error) error {
	email, err := s.actorEmail(ctx, actorID)
	switch {
	case err != nil && s.fallbackActor != "" && errors.Is(err, service.ErrValidation):
		email = s.fallbackActor
	case err != nil:
		return err
	}
	err = call(email)
	if s.fallbackActor != "" && email != s.fallbackActor && cliffhub.UnknownActor(err) {
		err = call(s.fallbackActor)
	}
	return upstreamError(err)
}

// SetFallbackActor names the CliffHub employee ex acts as for people
// CliffHub does not know ("" refuses their changes).
func (s *CliffHubProjects) SetFallbackActor(email string) { s.fallbackActor = strings.TrimSpace(email) }

// actorEmail is the address CliffHub knows the acting person by.
func (s *CliffHubProjects) actorEmail(ctx context.Context, actorID string) (string, error) {
	if actorID == "" {
		return "", fmt.Errorf("cliffhub: no one to act as: %w", service.ErrValidation)
	}
	u, err := s.users.GetUser(ctx, actorID)
	if err != nil {
		return "", fmt.Errorf("cliffhub: actor lookup: %w", err)
	}
	email := s.cliffhubEmail(u)
	if email == "" {
		return "", fmt.Errorf("cliffhub: %s has no email address to act as in CliffHub: %w", u.DisplayName, service.ErrValidation)
	}
	return email, nil
}

// cliffhubEmail is the address CliffHub knows u by: their own, unless the
// email map says otherwise (development seed users standing in for real
// employees). Lowercased.
func (s *CliffHubProjects) cliffhubEmail(u *model.User) string {
	email := strings.ToLower(strings.TrimSpace(u.Email))
	if mapped, ok := s.emailMap[email]; ok {
		return mapped
	}
	return email
}

// SetEmailMap maps ex addresses to the CliffHub employees they stand for,
// from "ex@a=cliffhub@b,ex2@a=cliffhub2@b" (CLIFFHUB_EMAIL_MAP). For
// development only: production addresses match on their own.
func (s *CliffHubProjects) SetEmailMap(spec string) {
	s.emailMap = map[string]string{}
	for _, pair := range strings.Split(spec, ",") {
		from, to, ok := strings.Cut(pair, "=")
		from, to = strings.ToLower(strings.TrimSpace(from)), strings.ToLower(strings.TrimSpace(to))
		if ok && from != "" && to != "" {
			s.emailMap[from] = to
		}
	}
}

// upstreamError turns a CliffHub refusal into something the caller can show:
// a 4xx is the request's fault (a name already taken, someone CliffHub does
// not know) and reads as a validation error.
func upstreamError(err error) error {
	var ce *cliffhub.Error
	if errors.As(err, &ce) && ce.Status >= 400 && ce.Status < 500 && ce.Status != http.StatusUnauthorized {
		return fmt.Errorf("CliffHub: %s: %w", ce.Message, service.ErrValidation)
	}
	return err
}

// applySystem copies a system's fields onto a cached project row.
func applySystem(p *model.CodingProject, sys cliffhub.System) {
	p.SystemID = sys.ID
	if name := strings.TrimSpace(sys.Name); name != "" {
		p.Name = name
	}
	p.Description = strings.TrimSpace(sys.Description)
	p.AppURL = appURLOf(sys.URLs)
	p.DesignNotes = strings.TrimSpace(sys.DesignNotes)
	p.UILibrary = strings.TrimSpace(sys.UILibrary)
	p.Instructions = strings.TrimSpace(sys.Instructions)
	p.AgentEmails = agentEmailsOf(sys)
	// Archived in CliffHub, or no longer marked as a project there.
	p.Archived = !sys.IsActive || sys.ProjectType == ""
	p.Links = []model.ProjectLink{}
	for _, l := range sys.DesignLinks {
		if u := strings.TrimSpace(l.URL); httpURL(u) {
			p.Links = append(p.Links, model.ProjectLink{Label: firstNonEmpty(strings.TrimSpace(l.Label), u), URL: u})
		}
	}
	p.Repos = []model.ProjectRepo{}
	seen := map[string]bool{}
	for _, l := range sys.RepoLinks {
		path := repoPathOf(l.URL)
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		role := strings.TrimSpace(l.Role)
		if role == "" || !model.ValidRepoRole(role) {
			role = model.RepoRoleOther
		}
		p.Repos = append(p.Repos, model.ProjectRepo{
			Path: path, Role: role, DefaultBranch: strings.TrimSpace(l.DefaultBranch),
			URL: strings.TrimSpace(l.URL), Label: strings.TrimSpace(l.Label),
		})
	}
}

// agentEmailsOf is who may use dev agents on a system, lowercased: the list
// the sync reads, or the people a write response names.
func agentEmailsOf(sys cliffhub.System) []string {
	out := []string{}
	add := func(e string) {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" && !slices.Contains(out, e) {
			out = append(out, e)
		}
	}
	for _, e := range sys.AgentEmails {
		add(e)
	}
	if len(sys.AgentEmails) == 0 {
		for _, a := range sys.AgentEmployees {
			add(a.Email)
		}
	}
	return out
}

// ErrNoDevAccess refuses dev-agent work on a project for someone not on its
// list of people allowed to use dev agents.
var ErrNoDevAccess = errors.New("no dev agent access, do not retry")

// CheckDevAccess refuses when u may not have dev agents work on the project:
// a project linked to CliffHub lists who may (empty: nobody); one ex holds
// alone has no list and is open as before.
func (s *CliffHubProjects) CheckDevAccess(p *model.CodingProject, u *model.User) error {
	if !s.Enabled() || p == nil || p.SystemID == "" || u == nil {
		return nil
	}
	if slices.Contains(p.AgentEmails, s.cliffhubEmail(u)) {
		return nil
	}
	ask := "Ask whoever manages the project to add you."
	if link := s.EditURL(p); link != "" {
		ask = "Ask whoever manages the project to add you: " + link
	}
	return fmt.Errorf("%w: %s, you're not on this project's access list, so the dev agent can't work on it for you. %s",
		ErrNoDevAccess, u.DisplayName, ask)
}

// appURLOf picks a system's app link: staging first (what agents should
// look at and test against), then prod, then any.
func appURLOf(urls []cliffhub.URL) string {
	for _, want := range []string{"staging", "prod", ""} {
		for _, u := range urls {
			if (want == "" || u.TypeKey == want) && httpURL(strings.TrimSpace(u.URL)) {
				return strings.TrimSpace(u.URL)
			}
		}
	}
	return ""
}

// repoPathOf turns a repo link into the "group/sub/repo" path agents clone:
// the URL's path without ".git" or a GitLab "/-/…" suffix, or the text as
// given when it is already a path. A link with no group ("https://host")
// is not a repo.
func repoPathOf(raw string) string {
	raw = strings.TrimSpace(raw)
	path := raw
	if u, err := url.Parse(raw); err == nil && u.Host != "" {
		path = u.Path
	}
	if i := strings.Index(path, "/-/"); i >= 0 {
		path = path[:i]
	}
	path = strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	if !strings.Contains(path, "/") || strings.ContainsAny(path, " \t\n") {
		return ""
	}
	return path
}

// newSystemInput is a new system for p: everything ex knows about it.
func (s *CliffHubProjects) newSystemInput(p *model.CodingProject) cliffhub.SystemInput {
	in, _ := s.appendOnlyPatch(p, cliffhub.System{})
	name := p.Name
	in.Name = &name
	return in
}

// appendOnlyPatch is the update that adds what p has and sys lacks, and
// nothing else. CliffHub is the source of truth and holds data ex never
// sees (links ex cannot parse, environments it does not use), so ex only
// ever appends:
//
//   - text fields (description, design notes, UI library, project type) are
//     set only when the system's is empty;
//   - the app link is added as a staging URL only when the system has no
//     app link at all;
//   - repo links are matched by repo path: existing links are kept as they
//     are, only gaining a role or default branch they lack, and repos the
//     system does not have are appended;
//   - design links whose URL the system lacks are appended.
//
// Lists are sent whole (CliffHub replaces a list), built from the system's
// own list so every existing entry goes back unchanged. changed is false
// when there is nothing to add.
func (s *CliffHubProjects) appendOnlyPatch(p *model.CodingProject, sys cliffhub.System) (cliffhub.SystemInput, bool) {
	var in cliffhub.SystemInput
	changed := false
	fill := func(dst **string, have, want string) {
		if strings.TrimSpace(have) == "" && strings.TrimSpace(want) != "" {
			v := strings.TrimSpace(want)
			*dst, changed = &v, true
		}
	}
	fill(&in.Description, sys.Description, p.Description)
	fill(&in.DesignNotes, sys.DesignNotes, p.DesignNotes)
	fill(&in.UILibrary, sys.UILibrary, p.UILibrary)
	fill(&in.Instructions, sys.Instructions, p.Instructions)
	fill(&in.ProjectType, sys.ProjectType, guessProjectType(p))

	if app := strings.TrimSpace(p.AppURL); app != "" && appURLOf(sys.URLs) == "" {
		urls := append(append([]cliffhub.URL{}, sys.URLs...), cliffhub.URL{TypeKey: "staging", URL: app})
		in.URLs, changed = &urls, true
	}

	links := append([]cliffhub.RepoLink{}, sys.RepoLinks...)
	byPath := map[string]int{}
	for i, l := range links {
		if path := repoPathOf(l.URL); path != "" {
			if _, dup := byPath[path]; !dup {
				byPath[path] = i
			}
		}
	}
	reposChanged := false
	for _, r := range p.Repos {
		i, ok := byPath[r.Path]
		if !ok {
			link := r.URL
			if repoPathOf(link) != r.Path {
				link = s.repoLink(r.Path)
			}
			links = append(links, cliffhub.RepoLink{Label: firstNonEmpty(r.Label, r.Path), URL: link,
				Role: r.Role, DefaultBranch: r.DefaultBranch})
			byPath[r.Path] = len(links) - 1
			reposChanged = true
			continue
		}
		if links[i].Role == "" && r.Role != "" && r.Role != model.RepoRoleOther {
			links[i].Role, reposChanged = r.Role, true
		}
		if links[i].DefaultBranch == "" && r.DefaultBranch != "" {
			links[i].DefaultBranch, reposChanged = r.DefaultBranch, true
		}
	}
	if reposChanged {
		in.RepoLinks, changed = &links, true
	}

	design := append([]cliffhub.Link{}, sys.DesignLinks...)
	haveURL := map[string]bool{}
	for _, l := range design {
		haveURL[strings.TrimSpace(l.URL)] = true
	}
	designChanged := false
	for _, l := range p.Links {
		if u := strings.TrimSpace(l.URL); u != "" && !haveURL[u] {
			design = append(design, cliffhub.Link{Label: firstNonEmpty(strings.TrimSpace(l.Label), u), URL: u})
			haveURL[u], designChanged = true, true
		}
	}
	if designChanged {
		in.DesignLinks, changed = &design, true
	}
	return in, changed
}

// guessProjectType is the project type a project ex made most likely has,
// from its repo roles and whether it carries design references.
func guessProjectType(p *model.CodingProject) string {
	roles := map[string]bool{}
	for _, r := range p.Repos {
		roles[r.Role] = true
	}
	visual := p.DesignNotes != "" || p.UILibrary != "" || len(p.Links) > 0
	switch {
	case roles[model.RepoRoleFrontend] && roles[model.RepoRoleBackend]:
		return "fullstack"
	case roles[model.RepoRoleFrontend]:
		return "frontend"
	case roles[model.RepoRoleMobile]:
		return "mobile"
	case visual:
		return "frontend"
	case roles[model.RepoRoleBackend]:
		return "backend"
	case roles[model.RepoRoleInfra]:
		return "infra"
	}
	return "other"
}

// repoLink is the web link of a repo path on the team's git host.
func (s *CliffHubProjects) repoLink(path string) string {
	if s.gitHost == "" {
		return path
	}
	host := s.gitHost
	if !strings.Contains(host, "://") {
		host = "https://" + host
	}
	return strings.TrimRight(host, "/") + "/" + path
}

// sameSyncedFields reports whether two rows agree on every field CliffHub
// owns.
func sameSyncedFields(a, b *model.CodingProject) bool {
	type synced struct {
		SystemID, Name, Description, AppURL, DesignNotes, UILibrary, Instructions string
		Archived                                                                  bool
		AgentEmails                                                               []string
		Links                                                                     []model.ProjectLink
		Repos                                                                     []model.ProjectRepo
	}
	pick := func(p *model.CodingProject) synced {
		links, repos := p.Links, p.Repos
		if len(links) == 0 {
			links = nil
		}
		if len(repos) == 0 {
			repos = nil
		}
		emails := p.AgentEmails
		if len(emails) == 0 {
			emails = nil
		}
		return synced{p.SystemID, p.Name, p.Description, p.AppURL, p.DesignNotes, p.UILibrary, p.Instructions, p.Archived, emails, links, repos}
	}
	return reflect.DeepEqual(pick(a), pick(b))
}

// uniqueProjectKey is base, or base with a number, that no project uses yet.
// A name with no letters or digits falls back to the system's ID.
func uniqueProjectKey(base, systemID string, taken map[string]bool) string {
	if base == "" {
		base = ProjectKey("system-" + systemID)
	}
	key := base
	for n := 2; taken[key]; n++ {
		key = fmt.Sprintf("%s-%d", base, n)
	}
	return key
}
