package service

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/text/unicode/norm"
)

// User groups follow the Microsoft 365 (Entra ID) department field: one group
// per department and one per squad (ParseDepartment). The directory status
// sweep, which already lists every account, hands each one's department to
// SyncDirectoryGroups; groups are created the first time their department or
// squad is seen and their members kept in step from then on.
//
// A group's members always follow what Microsoft 365 says. The one guard is
// tenant-wide: a sweep that reads far fewer departments than the one before
// (a Graph or permission glitch) is held once, and applied only if the next
// sweep agrees.

// DirectoryPerson is one enabled Microsoft 365 account as the sweep reads it:
// its department value and the ex user who is a group member for it, "" when
// nobody in ex is (no account yet, a guest or deactivated).
type DirectoryPerson struct {
	UserID     string
	Department string
}

const (
	// userGroupSyncStatusKey holds the last sweep's UserGroupSyncStatus.
	userGroupSyncStatusKey = "usergroups:sync"
	userGroupSyncStatusTTL = 7 * 24 * time.Hour
	// departmentDropFloor: the tenant-wide safeguard only judges a drop
	// from at least this many readable departments.
	departmentDropFloor = 20
	// maxAnomalyExamples bounds the example values the status reports.
	maxAnomalyExamples = 20
	// maxHandleAttempts bounds the -2, -3… suffixes tried for a new handle.
	maxHandleAttempts = 50
)

// groupSource is one department or squad as a sweep reads it.
type groupSource struct {
	kind      model.UserGroupSourceKind
	key       string
	spellings map[string]int
	// departments counts, for a squad, the departments its members list.
	departments map[string]int
	members     []string
	seen        map[string]bool
	skipped     int
}

func (g *groupSource) add(spelling, department, userID string) {
	g.spellings[spelling]++
	if department != "" {
		g.departments[department]++
	}
	switch {
	case userID == "":
		g.skipped++
	case !g.seen[userID]:
		g.seen[userID] = true
		g.members = append(g.members, userID)
	}
}

// mostCommon is the value most people have; ties go to the alphabetically
// first, so the result never depends on listing order.
func mostCommon(counts map[string]int) string {
	best, bestN := "", 0
	for _, v := range slices.Sorted(maps.Keys(counts)) {
		if counts[v] > bestN {
			best, bestN = v, counts[v]
		}
	}
	return best
}

func (g *groupSource) name() string { return mostCommon(g.spellings) }

func (g *groupSource) source() model.UserGroupSource {
	if g.kind == model.UserGroupSourceDepartment {
		return model.UserGroupSource{Kind: g.kind, Department: g.name(), Key: g.key}
	}
	return model.UserGroupSource{Kind: g.kind, Department: mostCommon(g.departments), Squad: g.name(), Key: g.key}
}

func (g *groupSource) description() string {
	src := g.source()
	if src.Kind == model.UserGroupSourceDepartment {
		return "Department " + src.Department
	}
	return "Squad " + src.Squad + " in " + src.Department
}

// collectDirectorySources parses every person's department into the
// department and squad groups it implies, counting the people with a
// readable department and summarising the values read only partly.
func collectDirectorySources(people []DirectoryPerson) (map[string]*groupSource, int, model.DepartmentAnomalyReport) {
	sources := map[string]*groupSource{}
	get := func(kind model.UserGroupSourceKind, prefix, name string) *groupSource {
		key := prefix + strings.ToLower(name)
		g := sources[key]
		if g == nil {
			g = &groupSource{kind: kind, key: key, spellings: map[string]int{}, departments: map[string]int{}, seen: map[string]bool{}}
			sources[key] = g
		}
		return g
	}
	readable := 0
	report := model.DepartmentAnomalyReport{Counts: map[string]int{}, Examples: []model.DepartmentAnomaly{}}
	examples := map[string]*model.DepartmentAnomaly{}
	for _, p := range people {
		parsed := ParseDepartment(p.Department)
		if len(parsed.Anomalies) > 0 {
			report.People++
			ex := examples[p.Department]
			if ex == nil {
				ex = &model.DepartmentAnomaly{Value: p.Department}
				for _, a := range parsed.Anomalies {
					ex.Kinds = append(ex.Kinds, string(a))
				}
				examples[p.Department] = ex
			}
			ex.People++
			for _, a := range parsed.Anomalies {
				report.Counts[string(a)]++
			}
		}
		if parsed.Department == "" {
			continue
		}
		readable++
		get(model.UserGroupSourceDepartment, "dept:", parsed.Department).add(parsed.Department, "", p.UserID)
		for _, squad := range parsed.Squads {
			get(model.UserGroupSourceSquad, "squad:", squad).add(squad, parsed.Department, p.UserID)
		}
	}
	for _, ex := range examples {
		report.Examples = append(report.Examples, *ex)
	}
	slices.SortFunc(report.Examples, func(a, b model.DepartmentAnomaly) int {
		return cmp.Or(cmp.Compare(b.People, a.People), cmp.Compare(a.Value, b.Value))
	})
	report.Examples = report.Examples[:min(len(report.Examples), maxAnomalyExamples)]
	return sources, readable, report
}

// SyncDirectoryGroups brings every department and squad group in line with
// the people the directory sweep read. Failures of one group are logged and
// never stop the others.
func (s *UserGroupService) SyncDirectoryGroups(ctx context.Context, people []DirectoryPerson) {
	sources, readable, report := collectDirectorySources(people)
	status := s.loadSyncStatus(ctx)
	if status.Readable >= departmentDropFloor && readable*2 < status.Readable && !status.Held {
		slog.ErrorContext(ctx, "user group sync: far fewer departments than the last sweep; holding this run — the next sweep applies if it agrees",
			"readable", readable, "previous", status.Readable)
		status.Held = true
		s.saveSyncStatus(ctx, status)
		return
	}
	groups, err := s.groups.ListUserGroups(ctx)
	if err != nil {
		slog.WarnContext(ctx, "user group sync: listing groups failed; skipping this run", "error", err)
		return
	}
	bySource := make(map[string]*model.UserGroupDetail, len(groups))
	for _, g := range groups {
		bySource[g.Source.Key] = g
	}
	// Departments first, then squads, each by key: deterministic, and a
	// department wins its bare handle over a squad of the same name.
	// The kind sorts "department" before "squad".
	keys := slices.SortedFunc(maps.Keys(sources), func(a, b string) int {
		return cmp.Or(cmp.Compare(sources[a].kind, sources[b].kind), cmp.Compare(a, b))
	})
	for _, key := range keys {
		var err error
		if g := bySource[key]; g != nil {
			err = s.syncSourceGroup(ctx, g, sources[key])
		} else {
			err = s.createSourceGroup(ctx, sources[key])
		}
		if err != nil {
			slog.WarnContext(ctx, "user group sync: group not synced this run", "source", key, "error", err)
		}
	}
	for _, g := range groups {
		if sources[g.Source.Key] == nil {
			if err := s.syncSourceGroup(ctx, g, nil); err != nil {
				slog.WarnContext(ctx, "user group sync: group not synced this run", "groupID", g.ID, "error", err)
			}
		}
	}
	if report.People > 0 {
		slog.WarnContext(ctx, "user group sync: some department values were read only partly", "people", report.People, "counts", report.Counts)
	}
	now := s.now()
	s.saveSyncStatus(ctx, &model.UserGroupSyncStatus{LastSyncedAt: &now, Readable: readable, Anomalies: report})
}

// createSourceGroup makes the group for a department or squad seen for the
// first time, under a free handle derived from its name.
func (s *UserGroupService) createSourceGroup(ctx context.Context, src *groupSource) error {
	handle, err := s.freeHandle(ctx, src.name())
	if err != nil {
		return err
	}
	now := s.now()
	g := &model.UserGroupDetail{UserGroup: model.UserGroup{
		ID:          model.UserGroupIDPrefix + store.NewID(),
		Handle:      handle,
		Name:        src.name(),
		Description: src.description(),
		MemberCount: len(src.members),
		CreatedAt:   now,
		UpdatedAt:   now,
		Source:      src.source(),
		SyncSkipped: src.skipped,
	}}
	if err := s.groups.CreateUserGroup(ctx, g); err != nil {
		return fmt.Errorf("create: %w", err)
	}
	defer s.publishChanged(ctx, g.ID)
	if err := s.groups.ApplyUserGroupMembers(ctx, g.ID, src.members, nil); err != nil {
		return fmt.Errorf("write members (the next sweep completes them): %w", err)
	}
	return nil
}

// syncSourceGroup applies a sweep's reading to an existing group; src is nil
// when nobody has its department or squad any more, which empties it. The row
// is only written when something on it changes.
func (s *UserGroupService) syncSourceGroup(ctx context.Context, g *model.UserGroupDetail, src *groupSource) error {
	current, err := s.memberIDs(ctx, g.ID)
	if err != nil {
		return err
	}
	var wanted []string
	skipped := 0
	state := model.UserGroupSyncSourceMissing
	if src != nil {
		wanted, skipped, state = src.members, src.skipped, ""
	}
	added, removed := diffMembers(current, wanted)
	membersChanged := len(added) > 0 || len(removed) > 0
	if membersChanged {
		if err := s.groups.ApplyUserGroupMembers(ctx, g.ID, added, removed); err != nil {
			return fmt.Errorf("write members: %w", err)
		}
	}
	count := len(current) + len(added) - len(removed)
	update := func(row *model.UserGroupDetail) {
		if src != nil {
			row.Source = src.source()
			if !row.AdminEdited {
				row.Name, row.Description = src.name(), src.description()
			}
		}
		row.MemberCount, row.SyncSkipped, row.SyncState = count, skipped, state
	}
	next := cloneUserGroup(g)
	update(next)
	if next.UserGroup == g.UserGroup {
		if membersChanged {
			s.forgetCopy(ctx, g.ID)
			s.publishChanged(ctx, g.ID)
		}
		return nil
	}
	_, err = s.mutate(ctx, g.ID, func(row *model.UserGroupDetail) error {
		update(row)
		return nil
	})
	return err
}

// SyncStatus reports the last sweep's group sync: when it ran, whether it was
// held, and the department values it read only partly. Admins only.
func (s *UserGroupService) SyncStatus(ctx context.Context, actor UserGroupActor) (*model.UserGroupSyncStatus, error) {
	if err := actor.canManage(); err != nil {
		return nil, err
	}
	return s.loadSyncStatus(ctx), nil
}

// loadSyncStatus reads the last sweep's status; an empty one when there is
// none (no sweep yet, or the cache lost it).
func (s *UserGroupService) loadSyncStatus(ctx context.Context) *model.UserGroupSyncStatus {
	status := &model.UserGroupSyncStatus{}
	if s.statusCache == nil {
		return status
	}
	if err := s.statusCache.Get(ctx, userGroupSyncStatusKey, status); err != nil {
		if !errors.Is(err, cache.ErrCacheMiss) {
			slog.WarnContext(ctx, "user group sync: reading the last status failed", "error", err)
		}
		return &model.UserGroupSyncStatus{}
	}
	return status
}

func (s *UserGroupService) saveSyncStatus(ctx context.Context, status *model.UserGroupSyncStatus) {
	if s.statusCache == nil {
		return
	}
	if err := s.statusCache.Set(ctx, userGroupSyncStatusKey, status, userGroupSyncStatusTTL); err != nil {
		slog.WarnContext(ctx, "user group sync: storing the status failed", "error", err)
	}
}

// freeHandle returns the first free handle for a new group named name: its
// slug, then slug-2, slug-3… A handle is free when it's well formed, not a
// broadcast word, and held by no group and no bot.
func (s *UserGroupService) freeHandle(ctx context.Context, name string) (string, error) {
	base := userGroupHandleBase(name)
	for n := 1; n <= maxHandleAttempts; n++ {
		candidate := base
		if n > 1 {
			suffix := fmt.Sprintf("-%d", n)
			candidate = strings.TrimRight(base[:min(len(base), 30-len(suffix))], "-") + suffix
		}
		if _, err := normalizeUserGroupHandle(candidate); err != nil {
			continue
		}
		err := s.handleFree(ctx, candidate, "")
		switch {
		case err == nil:
			return candidate, nil
		case !errors.Is(err, ErrUserGroupHandleTaken):
			return "", err
		}
	}
	return "", fmt.Errorf("no free handle for %q", name)
}

// handleLetters fold letters NFD doesn't decompose into ASCII.
var handleLetters = map[rune]string{'æ': "ae", 'ø': "o", 'œ': "oe", 'ß': "ss", 'đ': "d", 'ł': "l", 'þ': "th", 'ð': "d"}

// userGroupHandleBase turns a department or squad name into a handle: lower
// case, accents folded (å→a, ö→o, æ→ae), "&" as "and", any other run of
// characters as "-", at most 30 characters (cut at a "-" where possible).
// "group" when nothing usable is left.
func userGroupHandleBase(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range norm.NFD.String(strings.ToLower(strings.ReplaceAll(name, "&", " and "))) {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		if s, ok := handleLetters[r]; ok {
			b.WriteString(s)
			dash = false
			continue
		}
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.TrimRight(b.String(), "-")
	if len(out) > 30 {
		out = out[:30]
		if i := strings.LastIndexByte(out, '-'); i >= 2 {
			out = out[:i]
		}
		out = strings.TrimRight(out, "-")
	}
	if out == "" {
		return "group"
	}
	return out
}

// diffMembers lists who to add to current and who to remove, to reach wanted,
// in their listed order. Linear in the two lists: groups have no size limit.
func diffMembers(current, wanted []string) (added, removed []string) {
	have := make(map[string]bool, len(current))
	for _, id := range current {
		have[id] = true
	}
	want := make(map[string]bool, len(wanted))
	for _, id := range wanted {
		want[id] = true
		if !have[id] {
			added = append(added, id)
		}
	}
	for _, id := range current {
		if !want[id] {
			removed = append(removed, id)
		}
	}
	return added, removed
}
