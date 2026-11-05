package service

import (
	"context"
	"errors"
	"fmt"
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
// a handle ("@oncall"). Mentioning a group alerts each member who can see the
// message exactly as if they had been @-mentioned by name (notification
// fan-out); this file owns the groups themselves and the lookups the mention
// paths make.

var userGroupHandlePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,29}$`)

// reservedUserGroupHandles are the broadcast mentions; a group can't take one.
var reservedUserGroupHandles = map[string]bool{"all": true, "channel": true, "here": true, "everyone": true}

// ErrUserGroupHandleTaken refuses a handle another group or a bot holds.
var ErrUserGroupHandleTaken = apperr.Reject(ErrAlreadyExists, "that handle is taken")

// userGroupWriteAttempts bounds the optimistic-concurrency retries of one
// group write.
const userGroupWriteAttempts = 3

// UserGroupStore persists user groups (store.UserGroupStoreImpl).
type UserGroupStore interface {
	CreateUserGroup(ctx context.Context, g *model.UserGroupDetail) error
	UpdateUserGroup(ctx context.Context, g *model.UserGroupDetail, previousHandle string, expectedVersion int64) error
	GetUserGroup(ctx context.Context, id string) (*model.UserGroupDetail, error)
	GetUserGroups(ctx context.Context, ids []string) ([]*model.UserGroupDetail, error)
	ListUserGroups(ctx context.Context) ([]*model.UserGroupDetail, error)
	UserGroupHandleOwner(ctx context.Context, handle string) (string, error)
}

// userGroupPeople is the cached batched user read (UserService.GetBatch).
type userGroupPeople interface {
	GetBatch(ctx context.Context, ids []string) ([]*model.User, error)
}

// userGroupSettings reads the workspace settings (SettingsService).
type userGroupSettings interface {
	Effective(ctx context.Context) *model.WorkspaceSettings
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

// UserGroupInput is what a manager writes when creating a group.
type UserGroupInput struct {
	Handle      string   `json:"handle"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	MemberIDs   []string `json:"memberIds"`
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
	settings  userGroupSettings
	bots      userGroupBotNames
	publisher Publisher
	now       func() time.Time
}

// NewUserGroupService wires the user-group service.
func NewUserGroupService(groups UserGroupStore, people userGroupPeople, settings userGroupSettings, bots userGroupBotNames, publisher Publisher) *UserGroupService {
	return &UserGroupService{groups: groups, people: people, settings: settings, bots: bots, publisher: publisher, now: time.Now}
}

// canView: everyone but guests sees groups.
func (a UserGroupActor) canView() error {
	if a.ID == "" || a.Role == model.SystemRoleGuest {
		return apperr.Forbidden("user group: guests can't use user groups")
	}
	return nil
}

// canManage: admins always; members when the workspace allows it.
func (s *UserGroupService) canManage(ctx context.Context, a UserGroupActor) error {
	if err := a.canView(); err != nil {
		return err
	}
	if a.Role == model.SystemRoleAdmin {
		return nil
	}
	if s.settings.Effective(ctx).UserGroupManagers == model.UserGroupManagersMembers {
		return nil
	}
	return apperr.Forbidden("user group: only admins manage user groups")
}

// CanManage reports whether actor may create and edit groups.
func (s *UserGroupService) CanManage(ctx context.Context, actor UserGroupActor) bool {
	return s.canManage(ctx, actor) == nil
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
	return s.group(ctx, id)
}

// GroupsForUser returns the enabled groups userID belongs to, by handle.
func (s *UserGroupService) GroupsForUser(ctx context.Context, actor UserGroupActor, userID string) ([]*model.UserGroup, error) {
	if err := actor.canView(); err != nil {
		return nil, err
	}
	all, err := s.groups.ListUserGroups(ctx)
	if err != nil {
		return nil, fmt.Errorf("user group: list: %w", err)
	}
	out := []*model.UserGroup{}
	for _, g := range all {
		if !g.Disabled && slices.Contains(g.MemberIDs, userID) {
			out = append(out, &g.UserGroup)
		}
	}
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

// Create makes a group.
func (s *UserGroupService) Create(ctx context.Context, actor UserGroupActor, in UserGroupInput) (*model.UserGroupDetail, error) {
	if err := s.canManage(ctx, actor); err != nil {
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
	members, err := s.validMembers(ctx, nil, in.MemberIDs)
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
			MemberCount: len(members),
			CreatedBy:   actor.ID,
			CreatedAt:   now,
			UpdatedAt:   now,
		},
		MemberIDs: members,
	}
	if err := s.groups.CreateUserGroup(ctx, g); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, ErrUserGroupHandleTaken
		}
		return nil, fmt.Errorf("user group: create: %w", err)
	}
	s.publishChanged(ctx, g.ID)
	return g, nil
}

// Update edits a group's handle, name or description.
func (s *UserGroupService) Update(ctx context.Context, actor UserGroupActor, id string, patch UserGroupPatch) (*model.UserGroupDetail, error) {
	if err := s.canManage(ctx, actor); err != nil {
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

// AddMembers adds people to a group, up to limits.MaxUserGroupMembers.
func (s *UserGroupService) AddMembers(ctx context.Context, actor UserGroupActor, id string, userIDs []string) (*model.UserGroupDetail, error) {
	if err := s.canManage(ctx, actor); err != nil {
		return nil, err
	}
	return s.mutate(ctx, id, func(g *model.UserGroupDetail) error {
		members, err := s.validMembers(ctx, g.MemberIDs, userIDs)
		if err != nil {
			return err
		}
		g.MemberIDs = members
		return nil
	})
}

// RemoveMember takes one person out of a group.
func (s *UserGroupService) RemoveMember(ctx context.Context, actor UserGroupActor, id, userID string) (*model.UserGroupDetail, error) {
	if err := s.canManage(ctx, actor); err != nil {
		return nil, err
	}
	return s.mutate(ctx, id, func(g *model.UserGroupDetail) error {
		g.MemberIDs = slices.DeleteFunc(g.MemberIDs, func(m string) bool { return m == userID })
		return nil
	})
}

// SetEnabled disables or re-enables a group. A disabled group keeps its
// members and its handle; it just can't be mentioned.
func (s *UserGroupService) SetEnabled(ctx context.Context, actor UserGroupActor, id string, enabled bool) (*model.UserGroupDetail, error) {
	if err := s.canManage(ctx, actor); err != nil {
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
	all, err := s.groups.ListUserGroups(ctx)
	if err != nil {
		return fmt.Errorf("user group: list: %w", err)
	}
	for _, g := range all {
		if !slices.Contains(g.MemberIDs, userID) {
			continue
		}
		if _, err := s.mutate(ctx, g.ID, func(g *model.UserGroupDetail) error {
			g.MemberIDs = slices.DeleteFunc(g.MemberIDs, func(m string) bool { return m == userID })
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

// mutate applies change to the group's latest version and writes it,
// retrying when a concurrent write moved the group on in between.
func (s *UserGroupService) mutate(ctx context.Context, id string, change func(g *model.UserGroupDetail) error) (*model.UserGroupDetail, error) {
	for attempt := 1; ; attempt++ {
		g, err := s.group(ctx, id)
		if err != nil {
			return nil, err
		}
		version, previousHandle := g.Version, g.Handle
		if err := change(g); err != nil {
			return nil, err
		}
		g.MemberCount = len(g.MemberIDs)
		g.UpdatedAt = s.now()
		err = s.groups.UpdateUserGroup(ctx, g, previousHandle, version)
		switch {
		case err == nil:
			s.publishChanged(ctx, g.ID)
			return g, nil
		case errors.Is(err, store.ErrAlreadyExists):
			return nil, ErrUserGroupHandleTaken
		case errors.Is(err, store.ErrUserGroupChanged) && attempt < userGroupWriteAttempts:
			continue
		default:
			return nil, fmt.Errorf("user group: update: %w", err)
		}
	}
}

// group loads one group; NotFound when there is none.
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

// validMembers returns current plus the distinct people in add, refusing
// anyone who is not an active, human, non-guest account and a group past
// limits.MaxUserGroupMembers.
func (s *UserGroupService) validMembers(ctx context.Context, current, add []string) ([]string, error) {
	out := slices.Clone(current)
	var fresh []string
	for _, id := range add {
		id = strings.TrimSpace(id)
		if id != "" && !slices.Contains(out, id) && !slices.Contains(fresh, id) {
			fresh = append(fresh, id)
		}
	}
	if len(out)+len(fresh) > limits.MaxUserGroupMembers {
		return nil, apperr.Invalid("a user group holds at most %d members", limits.MaxUserGroupMembers)
	}
	if len(fresh) == 0 {
		return out, nil
	}
	users, err := s.people.GetBatch(ctx, fresh)
	if err != nil {
		return nil, fmt.Errorf("user group: get members: %w", err)
	}
	ok := make(map[string]bool, len(users))
	for _, u := range users {
		ok[u.ID] = !u.IsBot && u.SystemRole != model.SystemRoleGuest && u.Status != "deactivated"
	}
	for _, id := range fresh {
		if !ok[id] {
			return nil, apperr.Invalid("only active members can be in a user group (not guests or bots)")
		}
	}
	return append(out, fresh...), nil
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

// enabledGroups reads the groups with these IDs and keeps the enabled ones.
func (s *UserGroupService) enabledGroups(ctx context.Context, ids []string) ([]*model.UserGroupDetail, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	groups, err := s.groups.GetUserGroups(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("user group: get groups: %w", err)
	}
	return slices.DeleteFunc(groups, func(g *model.UserGroupDetail) bool { return g.Disabled }), nil
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
