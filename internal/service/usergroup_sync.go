package service

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/limits"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
)

// User groups come from a source (UserGroupSource): today the Entra security
// groups in one parent group. Each source group is one ex group, keyed by the
// source's stable ID, so a rename upstream renames the same group. The sync
// runs on a schedule and on an admin's Sync now, one run at a time across
// every server, and never invents anything: a handle comes from the source
// as is, and a source that can't be read changes nothing.

// UserGroupSource lists the groups ex should have, with their members.
type UserGroupSource interface {
	Fetch(ctx context.Context) (SourceSnapshot, error)
}

// SourceSnapshot is everything a source says in one read.
type SourceSnapshot struct {
	Groups []SourceGroup
}

// SourceGroup is one group as its source describes it.
type SourceGroup struct {
	// Key identifies the group across renames ("entra-group:<object id>").
	Key         string
	ID          string
	Name        string
	Description string
	// MemberRefs are the members' Entra object IDs.
	MemberRefs []string
	// MembersErr is set when the members couldn't be read: the group keeps
	// its current members this run.
	MembersErr error
}

// ErrUserGroupSourceEmpty is a source that lists no groups at all: treated
// as a failure (nothing changes), never as "every group is gone".
var ErrUserGroupSourceEmpty = errors.New("the parent group lists no groups")

// GraphGroupReader is the Microsoft Graph slice the Entra source reads
// (msgraph.Client).
type GraphGroupReader interface {
	ListMemberGroups(ctx context.Context, parentID string) ([]msgraph.Group, error)
	ListMemberUserIDs(ctx context.Context, groupID string) ([]string, error)
}

// EntraGroupsSource reads the security groups that are members of one
// parent group, and each one's direct user members.
type EntraGroupsSource struct {
	graph    GraphGroupReader
	parentID string
}

// NewEntraGroupsSource returns the source for the parent group parentID.
func NewEntraGroupsSource(graph GraphGroupReader, parentID string) *EntraGroupsSource {
	return &EntraGroupsSource{graph: graph, parentID: parentID}
}

// Fetch reads the parent's groups and their members.
func (s *EntraGroupsSource) Fetch(ctx context.Context) (SourceSnapshot, error) {
	groups, err := s.graph.ListMemberGroups(ctx, s.parentID)
	if errors.Is(err, msgraph.ErrNotFound) {
		return SourceSnapshot{}, errors.New("the parent group can't be found in Microsoft 365")
	}
	if err != nil {
		return SourceSnapshot{}, fmt.Errorf("reading the parent group failed: %w", err)
	}
	snap := SourceSnapshot{Groups: make([]SourceGroup, 0, len(groups))}
	for _, g := range groups {
		members, err := s.graph.ListMemberUserIDs(ctx, g.ID)
		snap.Groups = append(snap.Groups, SourceGroup{
			Key:         model.UserGroupSourceEntraGroup + ":" + g.ID,
			ID:          g.ID,
			Name:        g.DisplayName,
			Description: g.Description,
			MemberRefs:  members,
			MembersErr:  err,
		})
	}
	return snap, nil
}

// userGroupSyncUsers pages through ex's accounts (the user store).
type userGroupSyncUsers interface {
	ListUsers(ctx context.Context, limit int, cursor string) ([]*model.User, string, error)
}

// UserGroupSyncLocker is the cross-server run guard (RedisCache).
type UserGroupSyncLocker interface {
	AcquireLock(ctx context.Context, key, token string, ttl time.Duration) (bool, error)
	ReleaseLock(ctx context.Context, key, token string) error
}

const (
	// userGroupSyncStatusKey holds the last run's UserGroupSyncStatus.
	userGroupSyncStatusKey = "usergroups:sync"
	userGroupSyncStatusTTL = 7 * 24 * time.Hour
	// userGroupSyncRunningKey is held by the one running sync, on any server.
	userGroupSyncRunningKey = "usergroups:sync:running"
	// userGroupSyncBudget is the share of the interval one run may take; it
	// stops between groups after that, and the next run finishes the rest.
	userGroupSyncBudget = 0.8
	// userGroupSyncCooldown is how soon after a run Sync now may start
	// another.
	userGroupSyncCooldown = time.Minute
	userGroupSyncPageSize = 200

	userGroupSyncScheduled = "scheduled"
	userGroupSyncManual    = "manual"
)

// ErrUserGroupSyncCooldown refuses a Sync now right after a run.
var ErrUserGroupSyncCooldown = apperr.Conflict("a sync just finished; try again in a minute")

// errUserGroupSyncOff refuses a Sync now when no source is connected.
var errUserGroupSyncOff = apperr.Conflict("user groups aren't connected to Microsoft 365")

// userGroupSync is the sync's wiring (SetSync) and its background context
// (RunSync).
type userGroupSync struct {
	source   UserGroupSource
	users    userGroupSyncUsers
	lock     UserGroupSyncLocker
	interval time.Duration
	newToken func() string

	mu     sync.Mutex
	ctx    context.Context
	launch func(fn func())
}

// SetSync connects the groups to a source. Without it nothing syncs.
func (s *UserGroupService) SetSync(source UserGroupSource, users userGroupSyncUsers, lock UserGroupSyncLocker, interval time.Duration, newToken func() string) {
	s.sync = &userGroupSync{source: source, users: users, lock: lock, interval: interval, newToken: newToken}
}

// SyncConfigured reports whether a source is connected.
func (s *UserGroupService) SyncConfigured() bool { return s.sync != nil }

// RunSync syncs at once and then every interval until ctx ends. launch
// starts a Sync now in the background (on ctx, tracked by the app).
func (s *UserGroupService) RunSync(ctx context.Context, launch func(fn func())) {
	s.sync.mu.Lock()
	s.sync.ctx, s.sync.launch = ctx, launch
	s.sync.mu.Unlock()
	s.syncIsolated(ctx, userGroupSyncScheduled)
	ticker := time.NewTicker(s.sync.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.syncIsolated(ctx, userGroupSyncScheduled)
		}
	}
}

// syncIsolated runs one sync with its panics confined to it.
func (s *UserGroupService) syncIsolated(ctx context.Context, trigger string) {
	defer safe.Recover()
	s.runSync(ctx, trigger)
}

// SyncNow starts a sync for an admin. A sync already running anywhere is
// reported instead of starting a second; right after a run it answers
// ErrUserGroupSyncCooldown with the status.
func (s *UserGroupService) SyncNow(ctx context.Context, actor UserGroupActor) (*model.UserGroupSyncStatus, error) {
	if err := actor.canManage(); err != nil {
		return nil, err
	}
	status := s.syncStatus(ctx)
	if s.sync == nil {
		return status, errUserGroupSyncOff
	}
	s.sync.mu.Lock()
	runCtx, launch := s.sync.ctx, s.sync.launch
	s.sync.mu.Unlock()
	switch {
	case launch == nil:
		return status, errUserGroupSyncOff
	case status.Running:
		return status, nil
	case status.FinishedAt != nil && s.now().Sub(*status.FinishedAt) < userGroupSyncCooldown:
		return status, ErrUserGroupSyncCooldown
	}
	launch(func() { s.syncIsolated(runCtx, userGroupSyncManual) })
	now := s.now()
	status.Running, status.StartedAt, status.Trigger = true, &now, userGroupSyncManual
	return status, nil
}

// runSync is one sync, if no other runs anywhere.
func (s *UserGroupService) runSync(ctx context.Context, trigger string) {
	cfg := s.sync
	token := cfg.newToken()
	// The guard outlives the longest run (the budget) with margin.
	ok, err := cfg.lock.AcquireLock(ctx, userGroupSyncRunningKey, token, cfg.interval)
	if err != nil {
		slog.WarnContext(ctx, "user group sync: run guard unavailable; skipping this run", "error", err)
		return
	}
	if !ok {
		return
	}
	defer func() {
		if err := cfg.lock.ReleaseLock(context.WithoutCancel(ctx), userGroupSyncRunningKey, token); err != nil {
			slog.WarnContext(ctx, "user group sync: releasing the run guard failed; it expires on its own", "error", err)
		}
	}()

	started := s.now()
	status := s.loadSyncStatus(ctx)
	status.Running, status.StartedAt, status.Trigger = true, &started, trigger
	s.saveSyncStatus(ctx, status)
	s.publishSync(ctx)

	skipped, err := s.syncOnce(ctx, started.Add(time.Duration(float64(cfg.interval)*userGroupSyncBudget)))
	finished := s.now()
	status.Running, status.FinishedAt = false, &finished
	if err != nil {
		status.LastError = err.Error()
	} else {
		status.LastSyncedAt, status.LastError, status.Skipped = &finished, "", skipped
	}
	s.saveSyncStatus(ctx, status)
	s.publishSync(ctx)
}

// syncOnce reads the source and applies it, stopping between groups at
// deadline. An error means nothing was applied.
func (s *UserGroupService) syncOnce(ctx context.Context, deadline time.Time) ([]model.UserGroupSyncSkip, error) {
	groups, err := s.groups.ListUserGroups(ctx)
	if err != nil {
		slog.WarnContext(ctx, "user group sync: listing groups failed; nothing changed", "error", err)
		return nil, errors.New("reading ex's groups failed")
	}
	fetchCtx, cancel := context.WithDeadline(ctx, deadline)
	snap, err := s.sync.source.Fetch(fetchCtx)
	cancel()
	if err == nil && len(snap.Groups) == 0 {
		err = ErrUserGroupSourceEmpty
	}
	if err != nil {
		// A broken parent must never read as "every group is gone".
		level := slog.LevelWarn
		if len(groups) > 0 {
			level = slog.LevelError
		}
		slog.Log(ctx, level, "user group sync: the source can't be used; nothing changed", "error", err, "groups", len(groups))
		return nil, err
	}
	people, err := s.syncPeople(ctx)
	if err != nil {
		slog.WarnContext(ctx, "user group sync: listing accounts failed; nothing changed", "error", err)
		return nil, errors.New("reading ex's accounts failed")
	}
	return s.applySnapshot(ctx, groups, snap, people, deadline), nil
}

// syncPeople maps the Entra object ID of every account that can be a group
// member (active, human, not a guest, signed in through SSO) to its user ID.
func (s *UserGroupService) syncPeople(ctx context.Context) (map[string]string, error) {
	people := map[string]string{}
	cursor := ""
	for {
		users, next, err := s.sync.users.ListUsers(ctx, userGroupSyncPageSize, cursor)
		if err != nil {
			return nil, err
		}
		for _, u := range users {
			if u.IsBot || u.AuthProvider != model.AuthProviderOIDC || u.MSObjectID == "" ||
				u.SystemRole == model.SystemRoleGuest || u.Status == "deactivated" {
				continue
			}
			people[u.MSObjectID] = u.ID
		}
		if next == "" {
			return people, nil
		}
		cursor = next
	}
}

// applySnapshot brings ex's groups in line with snap. Failures of one group
// are logged and never stop the others.
func (s *UserGroupService) applySnapshot(ctx context.Context, groups []*model.UserGroupDetail, snap SourceSnapshot, people map[string]string, deadline time.Time) []model.UserGroupSyncSkip {
	bySource := make(map[string]*model.UserGroupDetail, len(groups))
	for _, g := range groups {
		bySource[g.Source.Key] = g
	}
	sources := slices.Clone(snap.Groups)
	slices.SortFunc(sources, func(a, b SourceGroup) int { return cmp.Compare(a.Key, b.Key) })
	wanted := make(map[string]bool, len(sources))
	for _, src := range sources {
		wanted[src.Key] = true
	}
	skipped := []model.UserGroupSyncSkip{}
	for _, src := range sources {
		if s.now().After(deadline) {
			slog.WarnContext(ctx, "user group sync: out of time; the next run finishes the rest")
			return skipped
		}
		var skip *model.UserGroupSyncSkip
		var err error
		if g := bySource[src.Key]; g != nil {
			skip, err = s.syncFromSource(ctx, g, src, people)
		} else {
			skip, err = s.createFromSource(ctx, src, people)
		}
		if err != nil {
			slog.WarnContext(ctx, "user group sync: group not synced this run", "source", src.Key, "error", err)
		}
		if skip != nil {
			skipped = append(skipped, *skip)
		}
	}
	for _, g := range groups {
		if wanted[g.Source.Key] {
			continue
		}
		if s.now().After(deadline) {
			return skipped
		}
		if err := s.emptyGone(ctx, g); err != nil {
			slog.WarnContext(ctx, "user group sync: group not synced this run", "groupID", g.ID, "error", err)
		}
	}
	return skipped
}

// sourceMembers turns a source's member refs into ex user IDs, counting the
// refs no member account matches.
func sourceMembers(src SourceGroup, people map[string]string) (members []string, skipped int) {
	seen := map[string]bool{}
	for _, ref := range src.MemberRefs {
		id, ok := people[ref]
		switch {
		case !ok:
			skipped++
		case !seen[id]:
			seen[id] = true
			members = append(members, id)
		}
	}
	return members, skipped
}

// sourceDetails is the name and description a source gives a group, within
// ex's limits.
func sourceDetails(src SourceGroup) (name, description string) {
	return truncateRunes(strings.TrimSpace(src.Name), limits.MaxUserGroupNameChars),
		truncateRunes(strings.TrimSpace(src.Description), limits.MaxUserGroupDescriptionChars)
}

// createFromSource makes the group for a source group seen for the first
// time; one whose name isn't a usable handle is skipped.
func (s *UserGroupService) createFromSource(ctx context.Context, src SourceGroup, people map[string]string) (*model.UserGroupSyncSkip, error) {
	handle, reason, err := s.usableHandle(ctx, src.Name, "")
	if err != nil {
		return nil, err
	}
	if reason != "" {
		return &model.UserGroupSyncSkip{Name: src.Name, Reason: reason}, nil
	}
	var members []string
	skipped := 0
	if src.MembersErr == nil {
		members, skipped = sourceMembers(src, people)
	}
	name, description := sourceDetails(src)
	now := s.now()
	g := &model.UserGroupDetail{UserGroup: model.UserGroup{
		ID:          model.UserGroupIDPrefix + store.NewID(),
		Handle:      handle,
		Name:        name,
		Description: description,
		MemberCount: len(members),
		CreatedAt:   now,
		UpdatedAt:   now,
		Source:      model.UserGroupSource{Kind: model.UserGroupSourceEntraGroup, ID: src.ID, Key: src.Key},
		SyncSkipped: skipped,
	}}
	if err := s.groups.CreateUserGroup(ctx, g); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			// Taken between the check and the write.
			return &model.UserGroupSyncSkip{Name: src.Name, Reason: "@" + handle + " is taken"}, nil
		}
		return nil, fmt.Errorf("create: %w", err)
	}
	defer s.publishChanged(ctx, g.ID)
	if err := s.groups.ApplyUserGroupMembers(ctx, g.ID, members, nil); err != nil {
		return nil, fmt.Errorf("write members (the next run completes them): %w", err)
	}
	return nil, nil
}

// syncFromSource applies a source group to its ex group: members (unless they
// couldn't be read), name, description and handle. A rename to a handle ex
// can't use keeps the old handle. The row is only written when something on
// it changes.
func (s *UserGroupService) syncFromSource(ctx context.Context, g *model.UserGroupDetail, src SourceGroup, people map[string]string) (*model.UserGroupSyncSkip, error) {
	count, skippedPeople := g.MemberCount, g.SyncSkipped
	membersChanged := false
	if src.MembersErr == nil {
		current, err := s.memberIDs(ctx, g.ID)
		if err != nil {
			return nil, err
		}
		var wanted []string
		wanted, skippedPeople = sourceMembers(src, people)
		added, removed := diffMembers(current, wanted)
		if membersChanged = len(added) > 0 || len(removed) > 0; membersChanged {
			if err := s.groups.ApplyUserGroupMembers(ctx, g.ID, added, removed); err != nil {
				return nil, fmt.Errorf("write members: %w", err)
			}
		}
		count = len(current) + len(added) - len(removed)
	} else {
		slog.WarnContext(ctx, "user group sync: members couldn't be read; keeping them this run", "groupID", g.ID, "error", src.MembersErr)
	}

	handle, state := g.Handle, model.UserGroupSyncState("")
	var skip *model.UserGroupSyncSkip
	if strings.ToLower(strings.TrimSpace(src.Name)) != g.Handle {
		usable, reason, err := s.usableHandle(ctx, src.Name, g.ID)
		if err != nil {
			return nil, err
		}
		if reason == "" {
			handle = usable
		} else {
			state = model.UserGroupSyncHandleConflict
			skip = &model.UserGroupSyncSkip{GroupID: g.ID, Name: src.Name, Reason: reason}
		}
	}
	name, description := sourceDetails(src)
	update := func(row *model.UserGroupDetail) error {
		row.Handle, row.Name, row.Description = handle, name, description
		row.MemberCount, row.SyncSkipped, row.SyncState = count, skippedPeople, state
		return nil
	}
	next := cloneUserGroup(g)
	_ = update(next)
	if next.UserGroup == g.UserGroup {
		if membersChanged {
			s.forgetCopy(ctx, g.ID)
			s.publishChanged(ctx, g.ID)
		}
		return skip, nil
	}
	_, err := s.mutate(ctx, g.ID, update)
	if errors.Is(err, ErrUserGroupHandleTaken) {
		// Taken between the check and the write: keep the old handle.
		handle, state = g.Handle, model.UserGroupSyncHandleConflict
		skip = &model.UserGroupSyncSkip{GroupID: g.ID, Name: src.Name, Reason: "@" + strings.ToLower(strings.TrimSpace(src.Name)) + " is taken"}
		_, err = s.mutate(ctx, g.ID, update)
	}
	return skip, err
}

// emptyGone empties a group whose source group left the parent (or was
// deleted) and flags it; an admin decides whether to disable it.
func (s *UserGroupService) emptyGone(ctx context.Context, g *model.UserGroupDetail) error {
	current, err := s.memberIDs(ctx, g.ID)
	if err != nil {
		return err
	}
	if len(current) > 0 {
		if err := s.groups.ApplyUserGroupMembers(ctx, g.ID, nil, current); err != nil {
			return fmt.Errorf("write members: %w", err)
		}
	}
	if g.MemberCount == 0 && g.SyncSkipped == 0 && g.SyncState == model.UserGroupSyncSourceMissing {
		if len(current) > 0 {
			s.forgetCopy(ctx, g.ID)
			s.publishChanged(ctx, g.ID)
		}
		return nil
	}
	_, err = s.mutate(ctx, g.ID, func(row *model.UserGroupDetail) error {
		row.MemberCount, row.SyncSkipped, row.SyncState = 0, 0, model.UserGroupSyncSourceMissing
		return nil
	})
	return err
}

// usableHandle checks a source group's name as a handle for the group self
// ("" for a new one): well formed, not a broadcast word, held by no other
// group and no bot. reason says why not ("" when usable).
func (s *UserGroupService) usableHandle(ctx context.Context, name, self string) (handle, reason string, err error) {
	handle = strings.ToLower(strings.TrimSpace(name))
	switch {
	case reservedUserGroupHandles[handle]:
		return handle, "@" + handle + " is reserved", nil
	case !userGroupHandlePattern.MatchString(handle):
		return handle, "not a valid handle (2 to 50 lowercase letters, digits, '.', '-' or '_')", nil
	}
	owner, err := s.groups.UserGroupHandleOwner(ctx, handle)
	switch {
	case err == nil && owner != self:
		return handle, "@" + handle + " is taken by another group", nil
	case err != nil && !errors.Is(err, store.ErrNotFound):
		return handle, "", fmt.Errorf("check handle: %w", err)
	}
	_, err = s.bots.UsernameOwner(ctx, handle)
	switch {
	case err == nil:
		return handle, "@" + handle + " is taken by a bot", nil
	case !errors.Is(err, store.ErrNotFound):
		return handle, "", fmt.Errorf("check bot username: %w", err)
	}
	return handle, "", nil
}

// SyncStatus reports how the sync went. Admins only.
func (s *UserGroupService) SyncStatus(ctx context.Context, actor UserGroupActor) (*model.UserGroupSyncStatus, error) {
	if err := actor.canManage(); err != nil {
		return nil, err
	}
	return s.syncStatus(ctx), nil
}

// syncStatus is the stored status with what's known from the wiring. A run
// that claims to be running past the guard's lifetime (a crashed server) is
// not.
func (s *UserGroupService) syncStatus(ctx context.Context) *model.UserGroupSyncStatus {
	status := s.loadSyncStatus(ctx)
	if s.sync == nil {
		status.Configured, status.Running = false, false
		return status
	}
	status.Configured = true
	status.IntervalMinutes = int(s.sync.interval / time.Minute)
	if status.Running && (status.StartedAt == nil || s.now().Sub(*status.StartedAt) > s.sync.interval) {
		status.Running = false
	}
	return status
}

// loadSyncStatus reads the last run's status; an empty one when there is
// none (no run yet, or the cache lost it).
func (s *UserGroupService) loadSyncStatus(ctx context.Context) *model.UserGroupSyncStatus {
	status := &model.UserGroupSyncStatus{}
	if err := s.statusCache.Get(ctx, userGroupSyncStatusKey, status); err != nil {
		if !errors.Is(err, cache.ErrCacheMiss) {
			slog.WarnContext(ctx, "user group sync: reading the last status failed", "error", err)
		}
		status = &model.UserGroupSyncStatus{}
	}
	if status.Skipped == nil {
		status.Skipped = []model.UserGroupSyncSkip{}
	}
	return status
}

func (s *UserGroupService) saveSyncStatus(ctx context.Context, status *model.UserGroupSyncStatus) {
	if err := s.statusCache.Set(ctx, userGroupSyncStatusKey, status, userGroupSyncStatusTTL); err != nil {
		slog.WarnContext(ctx, "user group sync: storing the status failed", "error", err)
	}
}

// publishSync tells clients a sync started or ended; admins refetch the
// status.
func (s *UserGroupService) publishSync(ctx context.Context) {
	events.Publish(ctx, s.publisher, pubsub.UserEvents(), events.EventUserGroupSync, nil)
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
