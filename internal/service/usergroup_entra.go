package service

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/limits"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
)

// User groups linked to Microsoft 365. An admin links a group to a Microsoft
// Entra ID group; from then on its members come from Entra (nested groups
// included) and are read-only in ex. The directory status sweep resyncs every
// linked group each run; linking and "Sync now" sync at once.
//
// A sync never silently shrinks a group: a Graph failure keeps the last
// members, a vanished Entra group keeps them too (and says so), and a result
// that would remove most of the group — or all of it — waits for an admin.
// An empty @oncall is a pager that stopped paging.

// ErrEntraGroupNotFound reports a Microsoft 365 group that doesn't exist (or
// the app can no longer see).
var ErrEntraGroupNotFound = errors.New("user group: microsoft 365 group not found")

// ErrUserGroupSyncBusy refuses a sync of a group another sync is running for.
var ErrUserGroupSyncBusy = apperr.Conflict("this group is already being synced")

const (
	// userGroupSyncLockTTL bounds one group's sync; a crashed holder's lock
	// lapses after it.
	userGroupSyncLockTTL = 2 * time.Minute
	// userGroupSyncConcurrency bounds the Graph calls a sweep makes at once.
	userGroupSyncConcurrency = 4
	// userGroupSyncMinHeld: a sync removing more than max(this, half the
	// members) waits for an admin.
	userGroupSyncMinHeld = 5
	// entraSearchTTL keeps a picker search's answer, sparing Graph the
	// keystrokes.
	entraSearchTTL = time.Minute
)

// EntraGroupDirectory reads Microsoft 365 groups (MSGroupDirectory).
type EntraGroupDirectory interface {
	SearchGroups(ctx context.Context, query string) ([]model.EntraGroup, error)
	// GetGroup returns ErrEntraGroupNotFound for a group that is gone.
	GetGroup(ctx context.Context, id string) (*model.EntraGroup, error)
	// GroupUserIDs returns the object IDs of the group's users, nested groups
	// included; overLimit once it has more than limit. ErrEntraGroupNotFound
	// for a group that is gone.
	GroupUserIDs(ctx context.Context, id string, limit int) (ids []string, overLimit bool, err error)
}

// EntraUserIndex maps Entra object IDs to ex user IDs (cache.EntraUserIndex).
type EntraUserIndex interface {
	Lookup(ctx context.Context, objectIDs []string) (map[string]string, bool, error)
	Replace(ctx context.Context, m map[string]string, ttl time.Duration) error
	Add(ctx context.Context, objectID, userID string) error
}

// UserGroupSyncLocker is the per-group sync lock (RedisCache).
type UserGroupSyncLocker interface {
	AcquireLock(ctx context.Context, key, token string, ttl time.Duration) (bool, error)
	ReleaseLock(ctx context.Context, key, token string) error
}

// userAccountLister pages through every account (the user store).
type userAccountLister interface {
	ListUsers(ctx context.Context, limit int, cursor string) ([]*model.User, string, error)
}

// UserGroupMicrosoftDeps is what linking groups to Microsoft 365 needs.
type UserGroupMicrosoftDeps struct {
	Directory EntraGroupDirectory
	Index     EntraUserIndex
	Accounts  userAccountLister
	Locker    UserGroupSyncLocker
	// Cache keeps picker searches for a minute.
	Cache Cache
	// IndexTTL bounds the object-ID index between rebuilds (3 sweep
	// intervals).
	IndexTTL time.Duration
	NewToken func() string
}

type userGroupMicrosoft struct {
	UserGroupMicrosoftDeps
}

// defaultEntraIndexTTL bounds the object-ID index when no sweep interval was
// configured (3 × the status sweep's own 1h default).
const defaultEntraIndexTTL = 3 * time.Hour

// SetMicrosoft enables linking groups to Microsoft 365. Wired only when the
// integration is configured (MS_TENANT_ID).
func (s *UserGroupService) SetMicrosoft(deps UserGroupMicrosoftDeps) {
	if deps.IndexTTL <= 0 {
		deps.IndexTTL = defaultEntraIndexTTL
	}
	s.microsoft = &userGroupMicrosoft{deps}
}

// CanLinkMicrosoft reports whether actor may link groups: an admin, with the
// integration configured.
func (s *UserGroupService) CanLinkMicrosoft(actor UserGroupActor) bool {
	return s.microsoft != nil && actor.ID != "" && actor.Role == model.SystemRoleAdmin
}

func (s *UserGroupService) canLink(actor UserGroupActor) error {
	if s.microsoft == nil {
		return apperr.Invalid("the Microsoft 365 integration isn't configured")
	}
	if !s.CanLinkMicrosoft(actor) {
		return apperr.Forbidden("user group: only admins link groups to Microsoft 365")
	}
	return nil
}

// SearchEntraGroups lists the Microsoft 365 groups whose name matches query,
// for the link picker. Answers are shared across instances for a minute.
func (s *UserGroupService) SearchEntraGroups(ctx context.Context, actor UserGroupActor, query string) ([]model.EntraGroup, error) {
	if err := s.canLink(actor); err != nil {
		return nil, err
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return []model.EntraGroup{}, nil
	}
	sum := sha256.Sum256([]byte(strings.ToLower(query)))
	key := "msgroups:search:" + hex.EncodeToString(sum[:])
	var cached []model.EntraGroup
	if s.microsoft.Cache.Get(ctx, key, &cached) == nil {
		return cached, nil
	}
	groups, err := s.microsoft.Directory.SearchGroups(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("user group: search microsoft 365 groups: %w", err)
	}
	if err := s.microsoft.Cache.Set(ctx, key, groups, entraSearchTTL); err != nil {
		slog.WarnContext(ctx, "user group: caching a microsoft 365 search failed", "error", err)
	}
	return groups, nil
}

// entraSnapshot is an Entra group's membership as ex reads it.
type entraSnapshot struct {
	group *model.EntraGroup
	// wanted are the ex users who become members: mapped, active, human,
	// non-guest accounts, in Entra's order.
	wanted    []string
	users     int // Entra users in the group, nested included
	overLimit bool
}

func (e *entraSnapshot) skipped() int { return e.users - len(e.wanted) }

// applyTo makes g a linked group holding e's members. The group's name is
// kept when e didn't read it (the sweep reads members only).
func (e *entraSnapshot) applyTo(g *model.UserGroupDetail, now time.Time) {
	g.EntraGroupID = e.group.ID
	if e.group.DisplayName != "" {
		g.EntraGroupName = e.group.DisplayName
	}
	g.MemberIDs = slices.Clone(e.wanted)
	g.SyncedAt, g.SyncSkipped, g.SyncState, g.PendingRemoval = &now, e.skipped(), "", 0
}

// entraSnapshot reads an Entra group for linking (admin action): its name
// and members. Refused over the member cap.
func (s *UserGroupService) entraSnapshot(ctx context.Context, actor UserGroupActor, entraID string) (*entraSnapshot, error) {
	if err := s.canLink(actor); err != nil {
		return nil, err
	}
	snap, err := s.readEntraGroup(ctx, entraID, true)
	if err != nil {
		return nil, err
	}
	if snap.overLimit {
		return nil, apperr.Invalid("this Microsoft 365 group has more than %d people", limits.MaxUserGroupMembers)
	}
	return snap, nil
}

// readEntraGroup reads an Entra group's members (and, withName, the group
// itself), mapping them to ex users. ErrEntraGroupNotFound for a gone group.
func (s *UserGroupService) readEntraGroup(ctx context.Context, entraID string, withName bool) (*entraSnapshot, error) {
	snap := &entraSnapshot{group: &model.EntraGroup{ID: entraID}}
	if withName {
		g, err := s.microsoft.Directory.GetGroup(ctx, entraID)
		if errors.Is(err, ErrEntraGroupNotFound) {
			return nil, apperr.NotFound("that Microsoft 365 group doesn't exist")
		}
		if err != nil {
			return nil, fmt.Errorf("user group: read microsoft 365 group: %w", err)
		}
		snap.group = g
	}
	ids, overLimit, err := s.microsoft.Directory.GroupUserIDs(ctx, entraID, limits.MaxUserGroupMembers)
	if err != nil {
		return nil, err
	}
	if overLimit {
		snap.overLimit = true
		return snap, nil
	}
	snap.users = len(ids)
	if snap.wanted, err = s.membersFor(ctx, ids); err != nil {
		return nil, err
	}
	return snap, nil
}

// membersFor maps Entra object IDs to the ex users who can be group members.
func (s *UserGroupService) membersFor(ctx context.Context, objectIDs []string) ([]string, error) {
	byObject, err := s.entraUsers(ctx, objectIDs)
	if err != nil {
		return nil, err
	}
	var userIDs []string
	for _, oid := range objectIDs {
		if uid, ok := byObject[oid]; ok && !slices.Contains(userIDs, uid) {
			userIDs = append(userIDs, uid)
		}
	}
	if len(userIDs) == 0 {
		return []string{}, nil
	}
	users, err := s.people.GetBatch(ctx, userIDs)
	if err != nil {
		return nil, fmt.Errorf("user group: get members: %w", err)
	}
	ok := make(map[string]bool, len(users))
	for _, u := range users {
		ok[u.ID] = eligibleGroupMember(u)
	}
	return slices.DeleteFunc(userIDs, func(id string) bool { return !ok[id] }), nil
}

// entraUsers resolves object IDs through the index; an incomplete or
// unreadable index is rebuilt from the accounts first.
func (s *UserGroupService) entraUsers(ctx context.Context, objectIDs []string) (map[string]string, error) {
	found, complete, err := s.microsoft.Index.Lookup(ctx, objectIDs)
	if err == nil && complete {
		return found, nil
	}
	if err != nil {
		slog.WarnContext(ctx, "user group: entra user index unavailable; rebuilding it from the accounts", "error", err)
	}
	all, err := s.scanEntraUsers(ctx)
	if err != nil {
		return nil, err
	}
	s.ReplaceEntraIndex(ctx, all)
	return all, nil
}

// scanEntraUsers reads every account's Entra object ID.
func (s *UserGroupService) scanEntraUsers(ctx context.Context) (map[string]string, error) {
	out := map[string]string{}
	cursor := ""
	for {
		users, next, err := s.microsoft.Accounts.ListUsers(ctx, directorySyncPageSize, cursor)
		if err != nil {
			return nil, fmt.Errorf("user group: list accounts: %w", err)
		}
		for _, u := range users {
			if u.MSObjectID != "" {
				out[u.MSObjectID] = u.ID
			}
		}
		if next == "" {
			return out, nil
		}
		cursor = next
	}
}

// ReplaceEntraIndex stores a complete object-ID index (the status sweep
// rebuilds it from the accounts it reads anyway).
func (s *UserGroupService) ReplaceEntraIndex(ctx context.Context, byObject map[string]string) {
	if err := s.microsoft.Index.Replace(ctx, byObject, s.microsoft.IndexTTL); err != nil {
		slog.WarnContext(ctx, "user group: storing the entra user index failed; the next sync rebuilds it", "error", err)
	}
}

// NoteEntraUser records a signed-in user's object ID, so a linked group picks
// them up at its next sync instead of after the next index rebuild.
func (s *UserGroupService) NoteEntraUser(ctx context.Context, objectID, userID string) {
	if s.microsoft == nil || objectID == "" {
		return
	}
	if err := s.microsoft.Index.Add(ctx, objectID, userID); err != nil {
		slog.WarnContext(ctx, "user group: recording a sign-in in the entra user index failed", "error", err)
	}
}

// PreviewLink says what linking group groupID (empty: a new group) to an
// Entra group would do.
func (s *UserGroupService) PreviewLink(ctx context.Context, actor UserGroupActor, entraID, groupID string) (*model.UserGroupLinkPreview, error) {
	if err := s.canLink(actor); err != nil {
		return nil, err
	}
	snap, err := s.readEntraGroup(ctx, entraID, false)
	if errors.Is(err, ErrEntraGroupNotFound) {
		return nil, apperr.NotFound("that Microsoft 365 group doesn't exist")
	}
	if err != nil {
		return nil, fmt.Errorf("user group: read microsoft 365 group: %w", err)
	}
	if snap.overLimit {
		return &model.UserGroupLinkPreview{OverLimit: true}, nil
	}
	var current []string
	if groupID != "" {
		g, err := s.group(ctx, groupID)
		if err != nil {
			return nil, err
		}
		current = g.MemberIDs
	}
	added, removed := diffMembers(current, snap.wanted)
	return &model.UserGroupLinkPreview{Users: snap.users, ToAdd: len(added), ToRemove: len(removed), Skipped: snap.skipped()}, nil
}

// Link links group id to an Entra group and replaces its members with the
// Entra group's (the admin confirmed the preview).
func (s *UserGroupService) Link(ctx context.Context, actor UserGroupActor, id, entraID string) (*model.UserGroupDetail, error) {
	snap, err := s.entraSnapshot(ctx, actor, entraID)
	if err != nil {
		return nil, err
	}
	return s.mutate(ctx, id, func(g *model.UserGroupDetail) error {
		snap.applyTo(g, s.now())
		return nil
	})
}

// Unlink makes a linked group an ordinary one, keeping its members.
func (s *UserGroupService) Unlink(ctx context.Context, actor UserGroupActor, id string) (*model.UserGroupDetail, error) {
	if err := s.canLink(actor); err != nil {
		return nil, err
	}
	return s.mutate(ctx, id, func(g *model.UserGroupDetail) error {
		g.EntraGroupID, g.EntraGroupName, g.SyncedAt, g.SyncSkipped, g.SyncState, g.PendingRemoval = "", "", nil, 0, "", 0
		return nil
	})
}

// SyncNow syncs a linked group at once. applyRemovals applies a sync that
// was held for removing most of the group.
func (s *UserGroupService) SyncNow(ctx context.Context, actor UserGroupActor, id string, applyRemovals bool) (*model.UserGroupDetail, error) {
	if err := s.canLink(actor); err != nil {
		return nil, err
	}
	g, err := s.group(ctx, id)
	if err != nil {
		return nil, err
	}
	if !g.Linked() {
		return nil, apperr.Invalid("this group isn't linked to Microsoft 365")
	}
	return s.syncGroup(ctx, id, applyRemovals, true)
}

// SyncLinkedGroups resyncs every linked group, least recently synced first,
// a few at a time, until the deadline (the status sweep's budget). Failures
// are recorded on their group and logged; they never stop the others.
func (s *UserGroupService) SyncLinkedGroups(ctx context.Context, deadline time.Time) {
	if s.microsoft == nil {
		return
	}
	all, err := s.groups.ListUserGroups(ctx)
	if err != nil {
		slog.WarnContext(ctx, "user group sync: listing groups failed; skipping this run", "error", err)
		return
	}
	linked := slices.DeleteFunc(all, func(g *model.UserGroupDetail) bool { return !g.Linked() })
	slices.SortStableFunc(linked, func(a, b *model.UserGroupDetail) int { return cmp.Compare(syncedUnix(a), syncedUnix(b)) })

	work := make(chan string)
	var wg sync.WaitGroup
	for range userGroupSyncConcurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range work {
				if _, err := s.syncGroup(ctx, id, false, false); err != nil && !errors.Is(err, ErrUserGroupSyncBusy) {
					slog.WarnContext(ctx, "user group sync: group not synced this run", "groupID", id, "error", err)
				}
			}
		}()
	}
	for i, g := range linked {
		if !s.now().Before(deadline) {
			slog.WarnContext(ctx, "user group sync: out of time; the rest go first next run", "left", len(linked)-i)
			break
		}
		work <- g.ID
	}
	close(work)
	wg.Wait()
}

func syncedUnix(g *model.UserGroupDetail) int64 {
	if g.SyncedAt == nil {
		return 0
	}
	return g.SyncedAt.UnixNano()
}

// syncGroup brings one linked group in line with its Entra group, under the
// group's sync lock. withName also refreshes the Entra group's name (an
// admin's Sync now; the sweep reads members only).
func (s *UserGroupService) syncGroup(ctx context.Context, id string, applyRemovals, withName bool) (*model.UserGroupDetail, error) {
	key, token := "ugsync:"+id, s.microsoft.NewToken()
	ok, err := s.microsoft.Locker.AcquireLock(ctx, key, token, userGroupSyncLockTTL)
	if err != nil {
		return nil, fmt.Errorf("user group sync: lock: %w", err)
	}
	if !ok {
		return nil, ErrUserGroupSyncBusy
	}
	defer func() {
		if err := s.microsoft.Locker.ReleaseLock(context.WithoutCancel(ctx), key, token); err != nil {
			slog.WarnContext(ctx, "user group sync: releasing the lock failed; it lapses on its own", "groupID", id, "error", err)
		}
	}()

	g, err := s.group(ctx, id)
	if err != nil {
		return nil, err
	}
	if !g.Linked() {
		return g, nil // unlinked meanwhile
	}
	snap, err := s.readEntraGroup(ctx, g.EntraGroupID, withName)
	switch {
	case errors.Is(err, ErrEntraGroupNotFound), errors.Is(err, ErrNotFound):
		return s.syncState(ctx, id, model.UserGroupSyncSourceMissing, 0)
	case err != nil:
		if _, serr := s.syncState(ctx, id, model.UserGroupSyncError, 0); serr != nil {
			slog.WarnContext(ctx, "user group sync: recording the failure failed", "groupID", id, "error", serr)
		}
		return nil, fmt.Errorf("user group sync: read microsoft 365 group: %w", err)
	case snap.overLimit:
		return s.syncState(ctx, id, model.UserGroupSyncOversize, 0)
	}
	_, removed := diffMembers(g.MemberIDs, snap.wanted)
	held := (len(snap.wanted) == 0 && len(g.MemberIDs) > 0) || len(removed) > max(userGroupSyncMinHeld, len(g.MemberIDs)/2)
	if held && !applyRemovals {
		return s.syncState(ctx, id, model.UserGroupSyncHeld, len(removed))
	}
	return s.applySync(ctx, id, snap)
}

// applySync writes the synced members. Only a membership or state change
// tells clients; a run that changed nothing just moves "last synced".
func (s *UserGroupService) applySync(ctx context.Context, id string, snap *entraSnapshot) (*model.UserGroupDetail, error) {
	var changed bool
	g, err := s.write(ctx, id, false, func(g *model.UserGroupDetail) error {
		added, removed := diffMembers(g.MemberIDs, snap.wanted)
		changed = len(added) > 0 || len(removed) > 0 || g.SyncState != "" || g.SyncSkipped != snap.skipped() ||
			(snap.group.DisplayName != "" && snap.group.DisplayName != g.EntraGroupName)
		snap.applyTo(g, s.now())
		return nil
	})
	if err == nil && changed {
		s.publishChanged(ctx, id)
	}
	return g, err
}

// syncState records why a sync didn't apply, leaving the members as they
// are. A source-missing group stays enabled: its last members keep getting
// paged (a duplicate beats silence) while admins see why.
func (s *UserGroupService) syncState(ctx context.Context, id string, state model.UserGroupSyncState, pending int) (*model.UserGroupDetail, error) {
	var changed bool
	g, err := s.write(ctx, id, false, func(g *model.UserGroupDetail) error {
		changed = g.SyncState != state || g.PendingRemoval != pending
		g.SyncState, g.PendingRemoval = state, pending
		return nil
	})
	if err == nil && changed {
		s.publishChanged(ctx, id)
	}
	return g, err
}

// diffMembers lists who to add to current and who to remove, to reach wanted.
func diffMembers(current, wanted []string) (added, removed []string) {
	for _, id := range wanted {
		if !slices.Contains(current, id) {
			added = append(added, id)
		}
	}
	for _, id := range current {
		if !slices.Contains(wanted, id) {
			removed = append(removed, id)
		}
	}
	return added, removed
}

// eligibleGroupMember: only active, human, non-guest accounts are members.
func eligibleGroupMember(u *model.User) bool {
	return !u.IsBot && u.SystemRole != model.SystemRoleGuest && u.Status != "deactivated"
}

// MSGroupDirectory reads Microsoft 365 groups through Microsoft Graph.
type MSGroupDirectory struct {
	graph GraphGroups
}

// GraphGroups is the slice of the Graph client group linking uses.
type GraphGroups interface {
	SearchGroups(ctx context.Context, query string) ([]msgraph.Group, error)
	GetGroup(ctx context.Context, id string) (*msgraph.Group, error)
	GroupUserIDs(ctx context.Context, id string, limit int) ([]string, bool, error)
}

// NewMSGroupDirectory builds the Graph-backed group directory.
func NewMSGroupDirectory(graph GraphGroups) *MSGroupDirectory {
	return &MSGroupDirectory{graph: graph}
}

func entraGroup(g *msgraph.Group) model.EntraGroup {
	return model.EntraGroup{ID: g.ID, DisplayName: g.DisplayName, Mail: g.Mail, Kind: g.Kind()}
}

// SearchGroups lists the groups whose name matches query.
func (d *MSGroupDirectory) SearchGroups(ctx context.Context, query string) ([]model.EntraGroup, error) {
	groups, err := d.graph.SearchGroups(ctx, query)
	if err != nil {
		return nil, err
	}
	out := make([]model.EntraGroup, len(groups))
	for i := range groups {
		out[i] = entraGroup(&groups[i])
	}
	return out, nil
}

// GetGroup reads one group.
func (d *MSGroupDirectory) GetGroup(ctx context.Context, id string) (*model.EntraGroup, error) {
	g, err := d.graph.GetGroup(ctx, id)
	if errors.Is(err, msgraph.ErrNotFound) {
		return nil, ErrEntraGroupNotFound
	}
	if err != nil {
		return nil, err
	}
	out := entraGroup(g)
	return &out, nil
}

// GroupUserIDs reads the group's users, nested groups included.
func (d *MSGroupDirectory) GroupUserIDs(ctx context.Context, id string, limit int) ([]string, bool, error) {
	ids, over, err := d.graph.GroupUserIDs(ctx, id, limit)
	if errors.Is(err, msgraph.ErrNotFound) {
		return nil, false, ErrEntraGroupNotFound
	}
	return ids, over, err
}
