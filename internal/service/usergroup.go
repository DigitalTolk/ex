package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/limits"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// User groups, Slack-style: a named set of people mentioned together through
// a handle ("@oncall"). Every group is linked to a Microsoft 365 group and
// takes its members from there (usergroup_entra.go); admins choose the group,
// its handle and its name. Mentioning a group alerts each member who can see
// the message exactly as if they had been @-mentioned by name (notification
// fan-out); this file owns the groups themselves and the lookups the mention
// paths make.

var userGroupHandlePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,29}$`)

// reservedUserGroupHandles are the broadcast mentions; a group can't take one.
var reservedUserGroupHandles = map[string]bool{"all": true, "channel": true, "here": true, "everyone": true}

// ErrUserGroupHandleTaken refuses a handle another group or a bot holds.
var ErrUserGroupHandleTaken = apperr.Reject(ErrAlreadyExists, "that handle is taken")

// ErrEntraGroupLinked refuses linking a Microsoft 365 group another user
// group is already linked to.
var ErrEntraGroupLinked = apperr.Reject(ErrAlreadyExists, "that Microsoft 365 group is already linked to another user group")

// userGroupWriteAttempts bounds the optimistic-concurrency retries of one
// group write.
const userGroupWriteAttempts = 3

// UserGroupStore persists user groups (store.UserGroupStoreImpl).
type UserGroupStore interface {
	CreateUserGroup(ctx context.Context, g *model.UserGroupDetail) error
	UpdateUserGroup(ctx context.Context, g, previous *model.UserGroupDetail) error
	GetUserGroup(ctx context.Context, id string) (*model.UserGroupDetail, error)
	GetUserGroups(ctx context.Context, ids []string) ([]*model.UserGroupDetail, error)
	ListUserGroups(ctx context.Context) ([]*model.UserGroupDetail, error)
	UserGroupHandleOwner(ctx context.Context, handle string) (string, error)
	ApplyUserGroupMembers(ctx context.Context, groupID string, add, remove []string) error
	UserGroupMemberIDs(ctx context.Context, groupID string) ([]string, error)
	UserGroupIDsForUser(ctx context.Context, userID string) ([]string, error)
}

// userGroupPeople is the cached batched user read (UserService.GetBatch).
type userGroupPeople interface {
	GetBatch(ctx context.Context, ids []string) ([]*model.User, error)
}

// userGroupBotNames says who holds a bot username (BotStore).
type userGroupBotNames interface {
	UsernameOwner(ctx context.Context, username string) (string, error)
}

// UserGroupActor is the caller, with the stored role the auth middleware put
// in the claims.
type UserGroupActor struct {
	ID   string
	Role model.SystemRole
}

// UserGroupInput is what an admin writes when creating a group: its details
// and the Microsoft 365 group its members come from.
type UserGroupInput struct {
	Handle       string `json:"handle"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	EntraGroupID string `json:"entraGroupId"`
}

// UserGroupPatch is a partial edit of a group's details.
type UserGroupPatch struct {
	Handle      *string `json:"handle"`
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

// UserGroupService manages user groups and answers the mention paths'
// lookups.
type UserGroupService struct {
	groups    UserGroupStore
	people    userGroupPeople
	bots      userGroupBotNames
	publisher Publisher
	now       func() time.Time
	// copies is the Redis copy of groups the mention paths read (SetCopies).
	copies UserGroupCopies
	// microsoft reads the Microsoft 365 groups members come from
	// (SetMicrosoft); nil when the integration isn't configured, and then no
	// group can be created.
	microsoft *userGroupMicrosoft
}

// UserGroupCopies is the shared copy of user groups (cache.UserGroupCopies):
// a copy of the store, never the source. Every committed change Forgets it.
type UserGroupCopies interface {
	Get(ctx context.Context, ids []string) (map[string]*model.UserGroupDetail, error)
	Put(ctx context.Context, g *model.UserGroupDetail) error
	Forget(ctx context.Context, id string) error
}

// SetCopies wires the shared copy the mention paths read groups through.
func (s *UserGroupService) SetCopies(c UserGroupCopies) { s.copies = c }

// NewUserGroupService wires the user-group service.
func NewUserGroupService(groups UserGroupStore, people userGroupPeople, bots userGroupBotNames, publisher Publisher) *UserGroupService {
	return &UserGroupService{groups: groups, people: people, bots: bots, publisher: publisher, now: time.Now}
}

// canView: everyone but guests sees groups.
func (a UserGroupActor) canView() error {
	if a.ID == "" || a.Role == model.SystemRoleGuest {
		return apperr.Forbidden("user group: guests can't use user groups")
	}
	return nil
}

// canManage: only admins edit, enable and disable groups.
func (a UserGroupActor) canManage() error {
	if a.ID == "" || a.Role != model.SystemRoleAdmin {
		return apperr.Forbidden("user group: only admins manage user groups")
	}
	return nil
}

// CanManage reports whether actor may edit groups.
func (s *UserGroupService) CanManage(actor UserGroupActor) bool {
	return actor.canManage() == nil
}

// normalizeUserGroupHandle lowercases and trims a handle (a leading "@" is
// dropped) and checks its shape.
func normalizeUserGroupHandle(handle string) (string, error) {
	handle = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(handle), "@"))
	if !userGroupHandlePattern.MatchString(handle) || reservedUserGroupHandles[handle] {
		return handle, apperr.Invalid("handle must be 2 to 30 lowercase letters, digits, '.', '-' or '_', starting with a letter or digit")
	}
	return handle, nil
}

func normalizeUserGroupName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > limits.MaxUserGroupNameChars {
		return name, apperr.Invalid("name must be 1 to %d characters", limits.MaxUserGroupNameChars)
	}
	return name, nil
}

func normalizeUserGroupDescription(desc string) (string, error) {
	desc = strings.TrimSpace(desc)
	if utf8.RuneCountInString(desc) > limits.MaxUserGroupDescriptionChars {
		return desc, apperr.Invalid("description must be at most %d characters", limits.MaxUserGroupDescriptionChars)
	}
	return desc, nil
}

// List returns the groups, by handle; disabled ones only when asked.
func (s *UserGroupService) List(ctx context.Context, actor UserGroupActor, includeDisabled bool) ([]*model.UserGroup, error) {
	if err := actor.canView(); err != nil {
		return nil, err
	}
	all, err := s.groups.ListUserGroups(ctx)
	if err != nil {
		return nil, fmt.Errorf("user group: list: %w", err)
	}
	out := make([]*model.UserGroup, 0, len(all))
	for _, g := range all {
		if g.Disabled && !includeDisabled {
			continue
		}
		out = append(out, &g.UserGroup)
	}
	return out, nil
}

// Get returns one group with its members.
func (s *UserGroupService) Get(ctx context.Context, actor UserGroupActor, id string) (*model.UserGroupDetail, error) {
	if err := actor.canView(); err != nil {
		return nil, err
	}
	g, err := s.group(ctx, id)
	if err != nil {
		return nil, err
	}
	if g.MemberIDs, err = s.memberIDs(ctx, id); err != nil {
		return nil, err
	}
	return g, nil
}

// GroupsForUser returns the enabled groups userID belongs to, by handle.
func (s *UserGroupService) GroupsForUser(ctx context.Context, actor UserGroupActor, userID string) ([]*model.UserGroup, error) {
	if err := actor.canView(); err != nil {
		return nil, err
	}
	ids, err := s.groups.UserGroupIDsForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("user group: list a user's groups: %w", err)
	}
	groups, err := s.groups.GetUserGroups(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("user group: get groups: %w", err)
	}
	out := []*model.UserGroup{}
	for _, g := range groups {
		if !g.Disabled {
			out = append(out, &g.UserGroup)
		}
	}
	slices.SortFunc(out, func(a, b *model.UserGroup) int { return strings.Compare(a.Handle, b.Handle) })
	return out, nil
}

// HandleAvailable reports whether handle is well-formed and held by no group
// and no bot.
func (s *UserGroupService) HandleAvailable(ctx context.Context, actor UserGroupActor, handle string) (bool, error) {
	if err := actor.canView(); err != nil {
		return false, err
	}
	handle, err := normalizeUserGroupHandle(handle)
	if err != nil {
		return false, nil
	}
	if err := s.handleFree(ctx, handle, ""); err != nil {
		if errors.Is(err, ErrUserGroupHandleTaken) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// Create makes a group from a Microsoft 365 group (admins only): its
// details, then its members.
func (s *UserGroupService) Create(ctx context.Context, actor UserGroupActor, in UserGroupInput) (*model.UserGroupDetail, error) {
	if err := s.canLink(actor); err != nil {
		return nil, err
	}
	handle, err := normalizeUserGroupHandle(in.Handle)
	if err != nil {
		return nil, err
	}
	name, err := normalizeUserGroupName(in.Name)
	if err != nil {
		return nil, err
	}
	desc, err := normalizeUserGroupDescription(in.Description)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.EntraGroupID) == "" {
		return nil, apperr.Invalid("choose the Microsoft 365 group the members come from")
	}
	snap, err := s.readEntraGroup(ctx, strings.TrimSpace(in.EntraGroupID), true)
	if err != nil {
		return nil, err
	}
	if err := s.handleFree(ctx, handle, ""); err != nil {
		return nil, err
	}
	now := s.now()
	g := &model.UserGroupDetail{
		UserGroup: model.UserGroup{
			ID:          model.UserGroupIDPrefix + store.NewID(),
			Handle:      handle,
			Name:        name,
			Description: desc,
			CreatedBy:   actor.ID,
			CreatedAt:   now,
			UpdatedAt:   now,
		},
	}
	snap.applyTo(g, now)
	if err := s.groups.CreateUserGroup(ctx, g); err != nil {
		return nil, s.writeError("create", err)
	}
	defer s.publishChanged(ctx, g.ID)
	if err := s.groups.ApplyUserGroupMembers(ctx, g.ID, snap.wanted, nil); err != nil {
		s.recordSyncFailure(ctx, g.ID)
		return nil, fmt.Errorf("user group: write members: %w", err)
	}
	g.MemberIDs = slices.Clone(snap.wanted)
	return g, nil
}

// Update edits a group's handle, name or description.
func (s *UserGroupService) Update(ctx context.Context, actor UserGroupActor, id string, patch UserGroupPatch) (*model.UserGroupDetail, error) {
	if err := actor.canManage(); err != nil {
		return nil, err
	}
	var handle, name, desc string
	var err error
	if patch.Handle != nil {
		if handle, err = normalizeUserGroupHandle(*patch.Handle); err != nil {
			return nil, err
		}
		if err := s.handleFree(ctx, handle, id); err != nil {
			return nil, err
		}
	}
	if patch.Name != nil {
		if name, err = normalizeUserGroupName(*patch.Name); err != nil {
			return nil, err
		}
	}
	if patch.Description != nil {
		if desc, err = normalizeUserGroupDescription(*patch.Description); err != nil {
			return nil, err
		}
	}
	return s.mutate(ctx, id, func(g *model.UserGroupDetail) error {
		if patch.Handle != nil {
			g.Handle = handle
		}
		if patch.Name != nil {
			g.Name = name
		}
		if patch.Description != nil {
			g.Description = desc
		}
		return nil
	})
}

// SetEnabled disables or re-enables a group. A disabled group keeps its
// members and its handle; it just can't be mentioned.
func (s *UserGroupService) SetEnabled(ctx context.Context, actor UserGroupActor, id string, enabled bool) (*model.UserGroupDetail, error) {
	if err := actor.canManage(); err != nil {
		return nil, err
	}
	return s.mutate(ctx, id, func(g *model.UserGroupDetail) error {
		g.Disabled = !enabled
		return nil
	})
}

// RemoveUserFromAllGroups takes userID out of every group (they became a
// guest, who can't be in one). Implements UserGroupMembershipRemover.
func (s *UserGroupService) RemoveUserFromAllGroups(ctx context.Context, userID string) error {
	ids, err := s.groups.UserGroupIDsForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("user group: list a user's groups: %w", err)
	}
	for _, id := range ids {
		if err := s.groups.ApplyUserGroupMembers(ctx, id, nil, []string{userID}); err != nil {
			return fmt.Errorf("user group: remove member: %w", err)
		}
		if _, err := s.mutate(ctx, id, func(g *model.UserGroupDetail) error {
			members, err := s.memberIDs(ctx, id)
			g.MemberCount = len(members)
			return err
		}); err != nil {
			return err
		}
	}
	return nil
}

// mutate applies change to the group's latest version, writes it and tells
// every client, retrying when a concurrent write moved the group on.
func (s *UserGroupService) mutate(ctx context.Context, id string, change func(g *model.UserGroupDetail) error) (*model.UserGroupDetail, error) {
	return s.write(ctx, id, true, change)
}

// write is mutate with the usergroup.changed event optional: a sync that
// only moved its bookkeeping (when it last ran) tells no one. It writes the
// group's row; members are written with ApplyUserGroupMembers.
func (s *UserGroupService) write(ctx context.Context, id string, publish bool, change func(g *model.UserGroupDetail) error) (*model.UserGroupDetail, error) {
	for attempt := 1; ; attempt++ {
		previous, err := s.group(ctx, id)
		if err != nil {
			return nil, err
		}
		g := cloneUserGroup(previous)
		if err := change(g); err != nil {
			return nil, err
		}
		g.UpdatedAt = s.now()
		err = s.groups.UpdateUserGroup(ctx, g, previous)
		switch {
		case err == nil:
			s.forgetCopy(ctx, g.ID)
			if publish {
				s.publishChanged(ctx, g.ID)
			}
			return g, nil
		case errors.Is(err, store.ErrUserGroupChanged) && attempt < userGroupWriteAttempts:
			continue
		default:
			return nil, s.writeError("update", err)
		}
	}
}

// writeError maps a failed group write to what the caller is told.
func (s *UserGroupService) writeError(what string, err error) error {
	switch {
	case errors.Is(err, store.ErrAlreadyExists):
		return ErrUserGroupHandleTaken
	case errors.Is(err, store.ErrEntraGroupLinked):
		return ErrEntraGroupLinked
	}
	return fmt.Errorf("user group: %s: %w", what, err)
}

func cloneUserGroup(g *model.UserGroupDetail) *model.UserGroupDetail {
	c := *g
	c.MemberIDs = slices.Clone(g.MemberIDs)
	return &c
}

// forgetCopy deletes the group's shared copy after a committed change (row
// or members), so the next reader reads the store.
func (s *UserGroupService) forgetCopy(ctx context.Context, id string) {
	if s.copies == nil {
		return
	}
	if err := s.copies.Forget(context.WithoutCancel(ctx), id); err != nil {
		slog.ErrorContext(ctx, "user group: deleting the shared copy failed — mentions may use the previous members until it expires", "groupID", id, "error", err)
	}
}

// memberIDs lists a group's members.
func (s *UserGroupService) memberIDs(ctx context.Context, id string) ([]string, error) {
	members, err := s.groups.UserGroupMemberIDs(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("user group: list members: %w", err)
	}
	return members, nil
}

// group loads one group's row (no members); NotFound when there is none.
func (s *UserGroupService) group(ctx context.Context, id string) (*model.UserGroupDetail, error) {
	g, err := s.groups.GetUserGroup(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.NotFound("user group: no such group")
	}
	if err != nil {
		return nil, fmt.Errorf("user group: get: %w", err)
	}
	return g, nil
}

// handleFree refuses a handle held by a bot, or by another group than self.
func (s *UserGroupService) handleFree(ctx context.Context, handle, self string) error {
	owner, err := s.groups.UserGroupHandleOwner(ctx, handle)
	switch {
	case err == nil && owner != self:
		return ErrUserGroupHandleTaken
	case err != nil && !errors.Is(err, store.ErrNotFound):
		return fmt.Errorf("user group: check handle: %w", err)
	}
	_, err = s.bots.UsernameOwner(ctx, handle)
	switch {
	case err == nil:
		return ErrUserGroupHandleTaken
	case !errors.Is(err, store.ErrNotFound):
		return fmt.Errorf("user group: check bot username: %w", err)
	}
	return nil
}

// publishChanged tells every client the group changed; they refetch it.
func (s *UserGroupService) publishChanged(ctx context.Context, id string) {
	events.Publish(ctx, s.publisher, pubsub.UserEvents(), events.EventUserGroupChanged, map[string]any{"groupId": id})
}

// --- lookups for the mention paths ---

// enabledGroups reads the groups with these IDs, members included, and
// keeps the enabled ones: from the shared copy first, the rest strongly
// consistent from the store (and copied for the next reader). A failed copy
// read reads everything from the store — the copy can make a mention slower,
// never miss someone.
func (s *UserGroupService) enabledGroups(ctx context.Context, ids []string) ([]*model.UserGroupDetail, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	found := map[string]*model.UserGroupDetail{}
	if s.copies != nil {
		copies, err := s.copies.Get(ctx, ids)
		if err != nil {
			slog.WarnContext(ctx, "user group: shared copy unavailable; reading the store", "error", err)
		} else {
			found = copies
		}
	}
	var missing []string
	for _, id := range ids {
		if found[id] == nil {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		groups, err := s.groups.GetUserGroups(ctx, missing)
		if err != nil {
			return nil, fmt.Errorf("user group: get groups: %w", err)
		}
		for _, g := range groups {
			if !g.Disabled {
				if g.MemberIDs, err = s.memberIDs(ctx, g.ID); err != nil {
					return nil, err
				}
			}
			found[g.ID] = g
			if s.copies != nil {
				if err := s.copies.Put(ctx, g); err != nil {
					slog.WarnContext(ctx, "user group: storing the shared copy failed", "groupID", g.ID, "error", err)
				}
			}
		}
	}
	out := make([]*model.UserGroupDetail, 0, len(found))
	for _, id := range ids {
		if g := found[id]; g != nil && !g.Disabled {
			out = append(out, g)
			delete(found, id)
		}
	}
	return out, nil
}

// EnabledHandles returns the current handle of every enabled group in ids
// (mention pills, alert text).
func (s *UserGroupService) EnabledHandles(ctx context.Context, ids []string) (map[string]string, error) {
	groups, err := s.enabledGroups(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(groups))
	for _, g := range groups {
		out[g.ID] = g.Handle
	}
	return out, nil
}

// MentionedMembers resolves the groups a message by authorID mentions to
// their members, read strongly consistent at send time. Disabled and unknown
// groups resolve to nothing, and so does every group a guest mentions: guests
// can't mention groups.
func (s *UserGroupService) MentionedMembers(ctx context.Context, authorID string, ids []string) (map[string][]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	guest, err := s.isGuest(ctx, authorID)
	if err != nil || guest {
		return nil, err
	}
	groups, err := s.enabledGroups(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[string][]string, len(groups))
	for _, g := range groups {
		out[g.ID] = g.MemberIDs
	}
	return out, nil
}

// isGuest reports whether userID is a guest account. An unknown author (an
// incoming webhook's sentinel) is not.
func (s *UserGroupService) isGuest(ctx context.Context, userID string) (bool, error) {
	users, err := s.people.GetBatch(ctx, []string{userID})
	if err != nil {
		return false, fmt.Errorf("user group: get author: %w", err)
	}
	return len(users) == 1 && users[0].SystemRole == model.SystemRoleGuest, nil
}

// handleGroups resolves typed handles (lowercase) to the enabled group
// holding each one; unknown and disabled handles are absent.
func (s *UserGroupService) handleGroups(ctx context.Context, handles []string) (map[string]*model.UserGroupDetail, error) {
	ids := make([]string, 0, len(handles))
	for _, h := range handles {
		id, err := s.groups.UserGroupHandleOwner(ctx, h)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("user group: resolve handle: %w", err)
		}
		ids = append(ids, id)
	}
	groups, err := s.enabledGroups(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[string]*model.UserGroupDetail, len(groups))
	for _, g := range groups {
		out[g.Handle] = g
	}
	return out, nil
}
