package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// ChannelService manages channels and channel memberships.
type ChannelService struct {
	channels    ChannelStore
	memberships MembershipStore
	users       UserStore
	messages    MessageStore
	cache       Cache
	broker      Broker
	publisher   Publisher
}

// NewChannelService creates a ChannelService with the given dependencies.
// messages may be nil; when it is, system messages are not persisted.
func NewChannelService(channels ChannelStore, memberships MembershipStore, users UserStore, messages MessageStore, cache Cache, broker Broker, publisher Publisher) *ChannelService {
	return &ChannelService{
		channels:    channels,
		memberships: memberships,
		users:       users,
		messages:    messages,
		cache:       cache,
		broker:      broker,
		publisher:   publisher,
	}
}

// postSystemMessage persists a system message in the channel and publishes a
// message.new event so connected clients render it inline. Errors are
// swallowed: the user's underlying action (join/leave) has already succeeded,
// and we don't want the audit message to fail it.
func (s *ChannelService) postSystemMessage(ctx context.Context, channelID, body string) {
	if s.messages == nil {
		return
	}
	msg := &model.Message{
		ID:        store.NewID(),
		ParentID:  channelID,
		AuthorID:  "system",
		Body:      body,
		System:    true,
		CreatedAt: time.Now(),
	}
	if err := s.messages.CreateMessage(ctx, msg); err != nil {
		return
	}
	events.Publish(ctx, s.publisher, pubsub.ChannelName(channelID), events.EventMessageNew, msg)
}

// AutoJoinChannel adds a user to a channel without RBAC checks (used during
// signup/invite-accept flows where the caller has already authorized the
// action). Idempotent: a no-op (with no events) when the user is already a
// member.
func (s *ChannelService) AutoJoinChannel(ctx context.Context, userID, channelID string, role model.ChannelRole) error {
	if mem, err := s.memberships.GetMembership(ctx, channelID, userID); err == nil && mem != nil {
		return nil
	}
	ch, err := s.channels.GetChannel(ctx, channelID)
	if err != nil {
		return fmt.Errorf("channel: auto-join get channel: %w", err)
	}
	return s.addMemberWithEvents(ctx, ch, userID, role)
}

// addMemberWithEvents performs the dual-write add, broker subscribe, members
// changed broadcast, and system join message. Shared by Join (after public-
// channel + archived guards) and AutoJoinChannel (used by signup/invite flows).
func (s *ChannelService) addMemberWithEvents(ctx context.Context, ch *model.Channel, userID string, role model.ChannelRole) error {
	now := time.Now()
	displayName := s.resolveDisplayName(ctx, userID)
	membership := &model.ChannelMembership{
		ChannelID:   ch.ID,
		UserID:      userID,
		Role:        role,
		DisplayName: displayName,
		JoinedAt:    now,
	}
	uc := &model.UserChannel{
		UserID:      userID,
		ChannelID:   ch.ID,
		ChannelName: ch.Name,
		ChannelType: ch.Type,
		Role:        role,
		JoinedAt:    now,
	}
	if err := s.memberships.AddMember(ctx, membership, uc); err != nil {
		return fmt.Errorf("channel: add member: %w", err)
	}

	if s.broker != nil {
		s.broker.Subscribe(userID, pubsub.ChannelName(ch.ID))
	}

	events.Publish(ctx, s.publisher, pubsub.ChannelName(ch.ID), events.EventMembersChanged, map[string]any{
		"channelID":   ch.ID,
		"userID":      userID,
		"displayName": displayName,
		"action":      events.MemberActionJoined,
	})

	s.postSystemMessage(ctx, ch.ID, displayName+" joined the channel")
	return nil
}

// resolveDisplayName looks up a user's display name, falling back to "Unknown".
func (s *ChannelService) resolveDisplayName(ctx context.Context, userID string) string {
	if s.users != nil {
		u, err := s.users.GetUser(ctx, userID)
		if err == nil {
			return u.DisplayName
		}
	}
	return "Unknown"
}

// Create creates a new channel and adds the creator as the owner. Guests
// (invite-acceptance accounts) cannot create channels — they're scoped to
// the channels they're explicitly invited into plus #general.
func (s *ChannelService) Create(ctx context.Context, userID, name string, chanType model.ChannelType, description string) (*model.Channel, error) {
	if s.users != nil {
		if u, err := s.users.GetUser(ctx, userID); err == nil && u != nil {
			if u.SystemRole == model.SystemRoleGuest {
				return nil, errors.New("channel: guests cannot create channels")
			}
		}
	}
	if err := ValidateChannelName(name); err != nil {
		return nil, err
	}
	if err := ValidateChannelDescription(description); err != nil {
		return nil, err
	}
	now := time.Now()
	ch := &model.Channel{
		ID:          store.NewID(),
		Name:        name,
		Slug:        slugify(name),
		Description: description,
		Type:        chanType,
		CreatedBy:   userID,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := s.channels.CreateChannel(ctx, ch); err != nil {
		return nil, fmt.Errorf("channel: create: %w", err)
	}

	displayName := s.resolveDisplayName(ctx, userID)
	membership := &model.ChannelMembership{
		ChannelID:   ch.ID,
		UserID:      userID,
		Role:        model.ChannelRoleOwner,
		DisplayName: displayName,
		JoinedAt:    now,
	}
	uc := &model.UserChannel{
		UserID:      userID,
		ChannelID:   ch.ID,
		ChannelName: ch.Name,
		ChannelType: ch.Type,
		Role:        model.ChannelRoleOwner,
		JoinedAt:    now,
	}
	if err := s.memberships.AddMember(ctx, membership, uc); err != nil {
		return nil, fmt.Errorf("channel: add owner: %w", err)
	}

	if s.broker != nil {
		s.broker.Subscribe(userID, pubsub.ChannelName(ch.ID))
	}

	events.Publish(ctx, s.publisher, pubsub.GlobalChannelEvents(), events.EventChannelNew, map[string]any{
		"channelID": ch.ID,
		"name":      ch.Name,
		"slug":      ch.Slug,
		"type":      ch.Type,
	})

	return ch, nil
}

// GetByID returns a channel by its ID.
func (s *ChannelService) GetByID(ctx context.Context, id string) (*model.Channel, error) {
	ch, err := s.channels.GetChannel(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("channel: get: %w", err)
	}
	return ch, nil
}

// Update modifies optional channel fields. The actor must be an owner, admin,
// or system admin.
func (s *ChannelService) Update(ctx context.Context, actorID, channelID string, name, description *string) (*model.Channel, error) {
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleAdmin); err != nil {
		return nil, err
	}

	ch, err := s.channels.GetChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("channel: get: %w", err)
	}

	if name != nil {
		if err := ValidateChannelName(*name); err != nil {
			return nil, err
		}
		ch.Name = *name
	}
	if description != nil {
		if err := ValidateChannelDescription(*description); err != nil {
			return nil, err
		}
		ch.Description = *description
	}
	ch.UpdatedAt = time.Now()

	if err := s.channels.UpdateChannel(ctx, ch); err != nil {
		return nil, fmt.Errorf("channel: update: %w", err)
	}

	events.Publish(ctx, s.publisher, pubsub.ChannelName(channelID), events.EventChannelUpdated, map[string]any{
		"channelID":   channelID,
		"name":        ch.Name,
		"description": ch.Description,
	})

	return ch, nil
}

// Archive marks a channel as archived AND removes every membership row,
// channel-side and user-side. Archive is destructive: the channel
// disappears from every sidebar (owner included) and its member list
// becomes empty. The Channel record itself is kept (with Archived=true)
// so historical messages continue to resolve their parent.
//
// Only the owner or a system admin may archive. The well-known #general
// channel cannot be archived.
func (s *ChannelService) Archive(ctx context.Context, actorID, channelID string) error {
	if channelID == generalChannelID {
		return errors.New("channel: cannot archive the general channel")
	}
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleOwner); err != nil {
		return err
	}

	ch, err := s.channels.GetChannel(ctx, channelID)
	if err != nil {
		return fmt.Errorf("channel: get: %w", err)
	}

	// Snapshot members before mutating anything so we can both remove their
	// rows and target their personal pubsub channels for the event.
	members, listErr := s.memberships.ListMembers(ctx, channelID)

	ch.Archived = true
	ch.UpdatedAt = time.Now()
	if err := s.channels.UpdateChannel(ctx, ch); err != nil {
		return fmt.Errorf("channel: archive: %w", err)
	}

	// Wipe memberships (both sides). Failures here are logged but do not
	// abort the archive — the channel is already flagged archived and the
	// membership store is dual-write so a partial failure can be retried by
	// re-archiving without violating any invariant.
	if listErr == nil {
		for _, m := range members {
			if rmErr := s.memberships.RemoveMember(ctx, channelID, m.UserID); rmErr != nil {
				slog.Warn("archive: remove member failed", "channelID", channelID, "userID", m.UserID, "error", rmErr)
			}
		}
	}

	if s.publisher == nil {
		return nil
	}
	if listErr != nil {
		events.Publish(ctx, s.publisher, pubsub.ChannelName(channelID), events.EventChannelArchived, map[string]any{
			"channelID": channelID,
		})
		return nil
	}
	channels := make([]string, 0, len(members)+1)
	channels = append(channels, pubsub.ChannelName(channelID))
	for _, m := range members {
		channels = append(channels, pubsub.UserChannel(m.UserID))
	}
	events.PublishMany(ctx, s.publisher, channels, events.EventChannelArchived, map[string]any{
		"channelID": channelID,
	})
	return nil
}

// Join adds a user to a public channel as a member. Guests are restricted
// to #general plus channels they were explicitly invited to — they cannot
// browse and self-join other public channels.
func (s *ChannelService) Join(ctx context.Context, userID, channelID string) error {
	ch, err := s.channels.GetChannel(ctx, channelID)
	if err != nil {
		return fmt.Errorf("channel: get: %w", err)
	}
	if ch.Type != model.ChannelTypePublic {
		return errors.New("channel: can only self-join public channels")
	}
	if ch.Archived {
		return errors.New("channel: channel is archived")
	}
	if s.users != nil {
		if u, err := s.users.GetUser(ctx, userID); err == nil && u != nil {
			if u.SystemRole == model.SystemRoleGuest && channelID != generalChannelID {
				return errors.New("channel: guests can only join channels they are invited to")
			}
		}
	}
	return s.addMemberWithEvents(ctx, ch, userID, model.ChannelRoleMember)
}

// Leave removes a user from a channel. The channel owner cannot leave, and
// nobody can leave the well-known #general channel — every active workspace
// member must remain a participant.
func (s *ChannelService) Leave(ctx context.Context, userID, channelID string) error {
	if channelID == generalChannelID {
		return errors.New("channel: cannot leave the general channel")
	}
	mem, err := s.memberships.GetMembership(ctx, channelID, userID)
	if err != nil {
		return fmt.Errorf("channel: get membership: %w", err)
	}
	if mem.Role == model.ChannelRoleOwner {
		return errors.New("channel: owner cannot leave the channel")
	}

	displayName := mem.DisplayName
	if displayName == "" {
		displayName = s.resolveDisplayName(ctx, userID)
	}

	if err := s.memberships.RemoveMember(ctx, channelID, userID); err != nil {
		return fmt.Errorf("channel: leave: %w", err)
	}

	if s.broker != nil {
		s.broker.Unsubscribe(userID, pubsub.ChannelName(channelID))
	}

	events.Publish(ctx, s.publisher, pubsub.ChannelName(channelID), events.EventMembersChanged, map[string]any{
		"channelID": channelID,
		"userID":    userID,
		"action":    events.MemberActionLeft,
	})
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventChannelRemoved, map[string]any{
		"channelID": channelID,
		"userID":    userID,
	})

	s.postSystemMessage(ctx, channelID, displayName+" left the channel")
	return nil
}

// SetMute marks a channel as muted/unmuted for the calling user. Mute is a
// per-user preference: it suppresses notifications (sound + browser popup)
// but does not unsubscribe the user from real-time event delivery — they
// still see new messages, just without the alert.
func (s *ChannelService) SetMute(ctx context.Context, userID, channelID string, muted bool) error {
	if _, err := s.memberships.GetMembership(ctx, channelID, userID); err != nil {
		return fmt.Errorf("channel: get membership: %w", err)
	}
	if err := s.memberships.SetMute(ctx, channelID, userID, muted); err != nil {
		return fmt.Errorf("channel: set mute: %w", err)
	}
	// Notify only the user themselves — mute is not other-people's business.
	// The frontend uses this to update its sidebar indicator and any other
	// open client tabs the user has so the state stays in sync.
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventChannelMuted, map[string]any{
		"channelID": channelID,
		"userID":    userID,
		"muted":     muted,
	})
	return nil
}

// SetFavorite pins or unpins a channel in the user's sidebar. Per-user.
// The user must already be a member — pinning a channel you can't see
// would create an orphan row in the user-side index.
func (s *ChannelService) SetFavorite(ctx context.Context, userID, channelID string, favorite bool) error {
	if _, err := s.memberships.GetMembership(ctx, channelID, userID); err != nil {
		return fmt.Errorf("channel: get membership: %w", err)
	}
	if err := s.memberships.SetFavorite(ctx, channelID, userID, favorite); err != nil {
		return fmt.Errorf("channel: set favorite: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, map[string]any{
		"channelID": channelID,
		"userID":    userID,
		"favorite":  favorite,
	})
	return nil
}

// SetCategory assigns a channel to one of the user's sidebar categories
// (or clears the assignment when categoryID is empty). Same per-user
// semantics as SetFavorite. Validation that the categoryID actually
// belongs to this user is the caller's responsibility — handlers do
// that check before invoking.
func (s *ChannelService) SetCategory(ctx context.Context, userID, channelID, categoryID string) error {
	if _, err := s.memberships.GetMembership(ctx, channelID, userID); err != nil {
		return fmt.Errorf("channel: get membership: %w", err)
	}
	if err := s.memberships.SetCategory(ctx, channelID, userID, categoryID); err != nil {
		return fmt.Errorf("channel: set category: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, map[string]any{
		"channelID":  channelID,
		"userID":     userID,
		"categoryID": categoryID,
	})
	return nil
}

// AddMember adds a user to a channel with the specified role. The actor must
// be an admin or higher.
func (s *ChannelService) AddMember(ctx context.Context, actorID, channelID, userID string, role model.ChannelRole) error {
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleAdmin); err != nil {
		return err
	}

	ch, err := s.channels.GetChannel(ctx, channelID)
	if err != nil {
		return fmt.Errorf("channel: get: %w", err)
	}

	now := time.Now()
	displayName := s.resolveDisplayName(ctx, userID)
	membership := &model.ChannelMembership{
		ChannelID:   channelID,
		UserID:      userID,
		Role:        role,
		DisplayName: displayName,
		JoinedAt:    now,
	}
	uc := &model.UserChannel{
		UserID:      userID,
		ChannelID:   channelID,
		ChannelName: ch.Name,
		ChannelType: ch.Type,
		Role:        role,
		JoinedAt:    now,
	}
	if err := s.memberships.AddMember(ctx, membership, uc); err != nil {
		return fmt.Errorf("channel: add member: %w", err)
	}

	if s.broker != nil {
		s.broker.Subscribe(userID, pubsub.ChannelName(channelID))
	}

	events.Publish(ctx, s.publisher, pubsub.ChannelName(channelID), events.EventMembersChanged, map[string]any{
		"channelID":   channelID,
		"userID":      userID,
		"displayName": displayName,
		"action":      events.MemberActionAdded,
	})

	s.postSystemMessage(ctx, channelID, displayName+" was added to the channel")
	return nil
}

// RemoveMember removes a user from a channel. The actor must be admin or
// higher. Owners can only be removed by a system admin. Members cannot be
// removed from the well-known #general channel — it must contain every
// active user.
func (s *ChannelService) RemoveMember(ctx context.Context, actorID, channelID, targetID string) error {
	if channelID == generalChannelID {
		return errors.New("channel: cannot remove members from the general channel")
	}
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleAdmin); err != nil {
		return err
	}

	target, err := s.memberships.GetMembership(ctx, channelID, targetID)
	if err != nil {
		return fmt.Errorf("channel: get target membership: %w", err)
	}

	if target.Role == model.ChannelRoleOwner {
		claims := middleware.ClaimsFromContext(ctx)
		if claims == nil || claims.SystemRole != model.SystemRoleAdmin {
			return errors.New("channel: only system admins can remove channel owners")
		}
	}

	displayName := target.DisplayName
	if displayName == "" {
		displayName = s.resolveDisplayName(ctx, targetID)
	}

	if err := s.memberships.RemoveMember(ctx, channelID, targetID); err != nil {
		return fmt.Errorf("channel: remove member: %w", err)
	}

	if s.broker != nil {
		s.broker.Unsubscribe(targetID, pubsub.ChannelName(channelID))
	}

	events.Publish(ctx, s.publisher, pubsub.ChannelName(channelID), events.EventMembersChanged, map[string]any{
		"channelID": channelID,
		"userID":    targetID,
		"action":    events.MemberActionRemoved,
	})
	events.Publish(ctx, s.publisher, pubsub.UserChannel(targetID), events.EventChannelRemoved, map[string]any{
		"channelID": channelID,
		"userID":    targetID,
	})

	s.postSystemMessage(ctx, channelID, displayName+" was removed from the channel")
	return nil
}

// UpdateMemberRole changes a member's role within a channel.
func (s *ChannelService) UpdateMemberRole(ctx context.Context, actorID, channelID, targetID string, newRole model.ChannelRole) error {
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleAdmin); err != nil {
		return err
	}

	if newRole == model.ChannelRoleOwner {
		actor, err := s.memberships.GetMembership(ctx, channelID, actorID)
		if err != nil && !isSystemAdmin(ctx) {
			return fmt.Errorf("channel: get actor membership: %w", err)
		}
		if actor != nil && actor.Role != model.ChannelRoleOwner && !isSystemAdmin(ctx) {
			return errors.New("channel: only owners can promote to owner")
		}
	}

	if err := s.memberships.UpdateMemberRole(ctx, channelID, targetID, newRole); err != nil {
		return fmt.Errorf("channel: update role: %w", err)
	}
	return nil
}

// ListMembers returns all memberships for a channel.
func (s *ChannelService) ListMembers(ctx context.Context, channelID string) ([]*model.ChannelMembership, error) {
	members, err := s.memberships.ListMembers(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("channel: list members: %w", err)
	}
	return members, nil
}

// ListUserChannels returns all non-archived channels a user belongs to,
// plus any archived channels where the user is the owner. The per-channel
// archive flag isn't denormalized onto UserChannel, so we fan out the lookups
// concurrently — this runs on every WebSocket connect.
func (s *ChannelService) ListUserChannels(ctx context.Context, userID string) ([]*model.UserChannel, error) {
	channels, err := s.memberships.ListUserChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("channel: list user channels: %w", err)
	}
	if len(channels) == 0 {
		return channels, nil
	}

	keep := make([]bool, len(channels))
	var wg sync.WaitGroup
	wg.Add(len(channels))
	for i, uc := range channels {
		go func(i int, uc *model.UserChannel) {
			defer wg.Done()
			ch, err := s.channels.GetChannel(ctx, uc.ChannelID)
			if err != nil || ch == nil {
				return
			}
			if !ch.Archived || uc.Role == model.ChannelRoleOwner {
				keep[i] = true
			}
		}(i, uc)
	}
	wg.Wait()

	filtered := make([]*model.UserChannel, 0, len(channels))
	for i, uc := range channels {
		if keep[i] {
			filtered = append(filtered, uc)
		}
	}
	return filtered, nil
}

// BrowsePublic returns a paginated list of public channels visible to the
// caller. Members and admins see every public channel; guests are scoped
// to their joined channels (invite list + #general).
func (s *ChannelService) BrowsePublic(ctx context.Context, userID string, limit int, cursor string) ([]*model.Channel, string, error) {
	if s.users != nil && userID != "" {
		if u, err := s.users.GetUser(ctx, userID); err == nil && u != nil && u.SystemRole == model.SystemRoleGuest {
			// Skip the public-channel scan entirely — paginating through it
			// would silently drop everything not in the user's set, leaving
			// the client with empty pages but a valid cursor.
			return s.guestBrowse(ctx, userID)
		}
	}
	channels, nextCursor, err := s.channels.ListPublicChannels(ctx, limit, cursor)
	if err != nil {
		return nil, "", fmt.Errorf("channel: browse public: %w", err)
	}
	return channels, nextCursor, nil
}

// guestBrowse fetches the channel records for every channel the guest
// belongs to, in a stable order. No cursor — guests never have enough
// channels to need pagination.
func (s *ChannelService) guestBrowse(ctx context.Context, userID string) ([]*model.Channel, string, error) {
	mine, err := s.memberships.ListUserChannels(ctx, userID)
	if err != nil {
		return nil, "", fmt.Errorf("channel: browse public guest: %w", err)
	}
	out := make([]*model.Channel, 0, len(mine))
	for _, uc := range mine {
		ch, err := s.channels.GetChannel(ctx, uc.ChannelID)
		if err != nil || ch == nil || ch.Type != model.ChannelTypePublic {
			continue
		}
		out = append(out, ch)
	}
	return out, "", nil
}

// IsMember reports whether the user has a membership row in the channel.
// Used by the WebSocket handler to gate inbound ephemeral events (typing
// indicator) — the same membership check that any persistent action has
// to pass on the write path.
func (s *ChannelService) IsMember(ctx context.Context, userID, channelID string) bool {
	if userID == "" || channelID == "" {
		return false
	}
	_, err := s.memberships.GetMembership(ctx, channelID, userID)
	return err == nil
}

// checkPermission verifies that the actor has at least minRole in the channel,
// or is a system admin (which bypasses channel-level checks).
func (s *ChannelService) checkPermission(ctx context.Context, actorID, channelID string, minRole model.ChannelRole) error {
	if isSystemAdmin(ctx) {
		return nil
	}

	mem, err := s.memberships.GetMembership(ctx, channelID, actorID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return errors.New("channel: not a member")
		}
		return fmt.Errorf("channel: check permission: %w", err)
	}

	if mem.Role < minRole {
		return fmt.Errorf("channel: insufficient permissions (need %s, have %s)", minRole, mem.Role)
	}
	return nil
}

// GetBySlug returns a channel by its slug.
func (s *ChannelService) GetBySlug(ctx context.Context, slug string) (*model.Channel, error) {
	ch, err := s.channels.GetChannelBySlug(ctx, slug)
	if err != nil {
		return nil, fmt.Errorf("channel: get by slug: %w", err)
	}
	return ch, nil
}

// isSystemAdmin checks whether the authenticated user in context is a system admin.
func isSystemAdmin(ctx context.Context) bool {
	claims := middleware.ClaimsFromContext(ctx)
	return claims != nil && claims.SystemRole == model.SystemRoleAdmin
}

// slugify converts a name into a URL-friendly slug.
func slugify(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	prev := false
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			prev = false
		} else if !prev {
			b.WriteByte('-')
			prev = true
		}
	}
	return strings.Trim(b.String(), "-")
}
