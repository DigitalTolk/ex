package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
)

type ChannelIndexer interface {
	IndexChannel(ctx context.Context, ch *model.Channel) error
	DeleteChannel(ctx context.Context, id string) error
}

// ChannelSearcher returns matching channel IDs; SearchPublic hydrates
// and applies guest-visibility rules so the UI never has to see
// archived or out-of-scope hits.
type ChannelSearcher interface {
	Channels(ctx context.Context, q string, limit int) ([]string, error)
}

// ChannelService manages channels and channel memberships.
type ChannelService struct {
	channels    ChannelStore
	memberships MembershipStore
	users       UserStore
	messages    MessageStore
	cache       Cache
	broker      Broker
	publisher   Publisher
	indexer     ChannelIndexer
	searcher    ChannelSearcher
	activity    ChannelActivityRecorder
	reminders   ChannelReminderSync
	threadState ChannelThreadStateSync
	conversions ConversationConverter
	// convertedDrafts moves a converted group's drafts to its channel.
	convertedDrafts ConversationDraftMover
	// audience is told about every membership/mute/preference write so the
	// notification audience cache on every instance reloads the channel.
	audience AudienceInvalidator
}

// SetAudienceInvalidator wires the notification audience cache's invalidation
// into every channel-audience write. Optional — unwired, nothing is cached
// against these writes to begin with.
func (s *ChannelService) SetAudienceInvalidator(a AudienceInvalidator) { s.audience = a }

// audienceWritten runs after a membership, role, mute or per-channel
// preference write on channelID (err is that write's result, passed through):
// it moves the channel's audience generation on, synchronously, so no
// instance alerts from a member list that predates the write. It runs even
// for a failed write, which may still have committed.
func (s *ChannelService) audienceWritten(ctx context.Context, channelID string, err error) error {
	if s.audience != nil {
		s.audience.ChannelAudienceChanged(ctx, channelID)
	}
	return err
}

// ChannelActivityRecorder keeps the Activity tab in step with channel
// membership and reads: "X added you to ~channel", dropping a channel's items
// when the user leaves it, and reading them when the user reads the channel.
// Implemented by ActivityService.
type ChannelActivityRecorder interface {
	RecordChannelAdded(ctx context.Context, actorID, userID string, ch *model.Channel)
	ParentLeft(ctx context.Context, userIDs []string, parentID string)
	ActivityReadTracker
}

// ChannelReminderSync is told when a user can no longer read a channel, so
// their pending reminders there (each a copy of a message's text) go too.
// Implemented by ReminderService.
type ChannelReminderSync interface {
	ParentLeft(ctx context.Context, userIDs []string, parentID string)
}

// ChannelThreadStateSync is told when users can no longer read a channel, so
// the unread markers of its threads (which light the sidebar's Threads dot)
// go with it. Implemented by UserStateService.
type ChannelThreadStateSync interface {
	ParentLeft(ctx context.Context, userIDs []string, parentID string)
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

func (s *ChannelService) SetIndexer(i ChannelIndexer) { s.indexer = i }

func (s *ChannelService) SetSearcher(sr ChannelSearcher) { s.searcher = sr }

// SetActivityRecorder wires the Activity tab. Optional — without it adding a
// member works the same but nothing lands in their activity stream.
func (s *ChannelService) SetActivityRecorder(a ChannelActivityRecorder) { s.activity = a }

// SetReminderSync wires reminder cleanup into losing access to a channel.
func (s *ChannelService) SetReminderSync(r ChannelReminderSync) { s.reminders = r }

// SetThreadStateSync wires unread-thread marker cleanup into losing access to
// a channel.
func (s *ChannelService) SetThreadStateSync(t ChannelThreadStateSync) { s.threadState = t }

// accessLost tells the activity stream and the reminders that these users can
// no longer read channelID — they left or were removed — so neither keeps
// showing its messages. Archiving is not a loss of access: members keep
// reading an archived channel.
func (s *ChannelService) accessLost(ctx context.Context, userIDs []string, channelID string) {
	if s.activity != nil {
		s.activity.ParentLeft(ctx, userIDs, channelID)
	}
	if s.reminders != nil {
		s.reminders.ParentLeft(ctx, userIDs, channelID)
	}
	if s.threadState != nil {
		s.threadState.ParentLeft(ctx, userIDs, channelID)
	}
}

func (s *ChannelService) indexChannel(ctx context.Context, ch *model.Channel) {
	if s.indexer == nil || ch == nil {
		return
	}
	if err := s.indexer.IndexChannel(ctx, ch); err != nil {
		slog.WarnContext(ctx, "search index channel failed", "id", ch.ID, "error", err)
	}
}

// postSystemMessage persists a system message in the channel and publishes a
// message.new event so connected clients render it inline. Errors are
// swallowed: the user's underlying action (join/leave) has already succeeded,
// and we don't want the audit message to fail it.
//
// An archived channel is frozen: membership changes there still update the
// member list and emit their events, but add no message to its history.
func (s *ChannelService) postSystemMessage(ctx context.Context, channelID, body string) {
	if s.messages == nil {
		return
	}
	if ch, err := s.channels.GetChannel(ctx, channelID); err == nil && ch.Archived {
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
		// Start caught up: a new member shouldn't see the channel's entire
		// pre-join history as unread.
		LastReadSeq: ch.MessageSeq,
	}
	if err := s.audienceWritten(ctx, membership.ChannelID, s.memberships.AddMember(ctx, membership, uc)); err != nil {
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
	return s.resolveMember(ctx, userID).displayName
}

// memberAccount is what adding a member needs to know about the account.
type memberAccount struct {
	displayName string
	machine     bool // a bot or agent
	deactivated bool
}

// resolveMember looks up a user's display name (falling back to "Unknown"),
// whether the account is a bot or agent, and whether it is deactivated.
func (s *ChannelService) resolveMember(ctx context.Context, userID string) memberAccount {
	if s.users != nil {
		u, err := s.users.GetUser(ctx, userID)
		if err == nil {
			return memberAccount{displayName: u.DisplayName, machine: u.IsBot || u.IsAgent(), deactivated: u.Status == "deactivated"}
		}
	}
	return memberAccount{displayName: "Unknown"}
}

// Create creates a new channel and adds the creator as the owner. Guests
// (invite-acceptance accounts) cannot create channels — they're scoped to
// the channels they're explicitly invited into plus #general.
func (s *ChannelService) Create(ctx context.Context, userID, name string, chanType model.ChannelType, description string) (*model.Channel, error) {
	return s.createChannel(ctx, userID, store.NewID(), name, chanType, description)
}

// CreateWithID is Create with a caller-chosen (derived) ID — for canonical
// channels that must have the same identity everywhere without coordination,
// e.g. a coding project's channel (DeriveID("codechan#"+projectPath)). The
// slug-uniqueness rules are unchanged.
func (s *ChannelService) CreateWithID(ctx context.Context, userID, id, name string, chanType model.ChannelType, description string) (*model.Channel, error) {
	if id == "" {
		return nil, fmt.Errorf("channel: id required: %w", ErrValidation)
	}
	return s.createChannel(ctx, userID, id, name, chanType, description)
}

func (s *ChannelService) createChannel(ctx context.Context, userID, id, name string, chanType model.ChannelType, description string) (*model.Channel, error) {
	if s.users != nil {
		if u, err := s.users.GetUser(ctx, userID); err == nil && u != nil {
			if u.SystemRole == model.SystemRoleGuest {
				return nil, apperr.Forbidden("channel: guests cannot create channels")
			}
		}
	}
	if err := ValidateChannelName(name); err != nil {
		return nil, err
	}
	if err := ValidateChannelDescription(description); err != nil {
		return nil, err
	}
	// Slugs are derived from names and used as URL keys; two
	// channels with the same name (case-insensitive collisions
	// included via slugify's lowercasing) would collide on
	// /channel/<slug>. The pre-check is the fast path for friendlier
	// errors; the actual race-safety lives in the store layer's
	// TransactWriteItems with a slug-lock item, which surfaces
	// ErrAlreadyExists if a concurrent create wins. We map both to
	// the same user-facing message.
	slug := Slugify(name)
	if taken, err := s.slugTaken(ctx, slug, ""); err == nil && taken {
		return nil, fmt.Errorf("channel: a channel with this name already exists: %w", ErrAlreadyExists)
	}
	now := time.Now()
	ch := &model.Channel{
		ID:          id,
		Name:        name,
		Slug:        slug,
		Description: description,
		Type:        chanType,
		CreatedBy:   userID,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := s.channels.CreateChannel(ctx, ch); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, fmt.Errorf("channel: a channel with this name already exists: %w", ErrAlreadyExists)
		}
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
	if err := s.audienceWritten(ctx, membership.ChannelID, s.memberships.AddMember(ctx, membership, uc)); err != nil {
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

	s.indexChannel(ctx, ch)

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

// GetVisibleByID returns a channel only if the actor has access to its chat
// surface. Public discovery uses BrowsePublic; direct /channel/:id rendering is
// scoped to joined channels. An archived channel stays readable for its
// members (it is read-only, not hidden); a non-member cannot join it.
func (s *ChannelService) GetVisibleByID(ctx context.Context, actorID, id string) (*model.Channel, error) {
	ch, err := s.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := s.grantVisibleAccess(ctx, actorID, ch); err != nil {
		return nil, err
	}
	return ch, nil
}

// Update modifies optional channel fields. The actor must be an owner, admin,
// or system admin. A new name renames the channel: its slug — the URL key —
// follows the name, and must be free (ErrAlreadyExists otherwise). Both
// fields are validated before either is written, and each write touches only
// its own fields.
func (s *ChannelService) Update(ctx context.Context, actorID, channelID string, name, description *string) (*model.Channel, error) {
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleAdmin); err != nil {
		return nil, err
	}

	ch, err := s.channels.GetChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("channel: get: %w", err)
	}
	if ch.Archived {
		return nil, ErrChannelArchived
	}

	renaming := name != nil && *name != ch.Name
	if renaming {
		if channelID == generalChannelID {
			return nil, apperr.Forbidden("channel: the general channel cannot be renamed")
		}
		if err := ValidateChannelName(*name); err != nil {
			return nil, err
		}
	}
	if description != nil {
		if err := ValidateChannelDescription(*description); err != nil {
			return nil, err
		}
	}

	now := time.Now()
	oldName := ch.Name
	if renaming {
		if err := s.rename(ctx, ch, *name, now); err != nil {
			return nil, err
		}
	}
	if description != nil {
		if err := s.channels.PatchChannel(ctx, channelID, store.ChannelPatch{Description: description, UpdatedAt: now}); err != nil {
			return nil, fmt.Errorf("channel: update: %w", err)
		}
		ch.Description, ch.UpdatedAt = *description, now
	}

	events.Publish(ctx, s.publisher, pubsub.ChannelName(channelID), events.EventChannelUpdated, map[string]any{
		"channelID":   channelID,
		"name":        ch.Name,
		"slug":        ch.Slug,
		"description": ch.Description,
	})
	s.indexChannel(ctx, ch)
	if renaming {
		s.postSystemMessage(ctx, channelID, s.resolveDisplayName(ctx, actorID)+" renamed the channel from ~"+oldName+" to ~"+ch.Name)
	}

	return ch, nil
}

// rename moves ch to name and its slug, refusing a slug another channel
// holds. The pre-check answers the common case; the store's transaction on
// the slug lock is what makes a race safe. The old slug stays an alias, so
// links made before the rename still open the channel.
func (s *ChannelService) rename(ctx context.Context, ch *model.Channel, name string, at time.Time) error {
	slug := Slugify(name)
	taken, err := s.slugTaken(ctx, slug, ch.ID)
	if err != nil {
		return err
	}
	if taken {
		return fmt.Errorf("channel: a channel with this name already exists: %w", ErrAlreadyExists)
	}
	if err := s.channels.RenameChannel(ctx, ch.ID, ch.Slug, name, slug, at); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return fmt.Errorf("channel: a channel with this name already exists: %w", ErrAlreadyExists)
		}
		return fmt.Errorf("channel: rename: %w", err)
	}
	ch.Name, ch.Slug, ch.UpdatedAt = name, slug, at
	s.syncMemberChannelNames(ctx, ch.ID, name)
	return nil
}

// slugTaken reports whether another channel than exceptID is called slug. A
// renamed channel's old slug (an alias) is free to take.
func (s *ChannelService) slugTaken(ctx context.Context, slug, exceptID string) (bool, error) {
	existing, err := s.channels.GetChannelBySlug(ctx, slug)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return false, nil
	case err != nil:
		return false, fmt.Errorf("channel: check name: %w", err)
	}
	return existing.Slug == slug && existing.ID != exceptID, nil
}

// NameAvailable reports whether a channel may be called name: a valid name no
// other channel holds. exceptChannelID is the channel being renamed — its own
// name counts as available to it.
func (s *ChannelService) NameAvailable(ctx context.Context, name, exceptChannelID string) (bool, error) {
	if err := ValidateChannelName(name); err != nil {
		return false, err
	}
	taken, err := s.slugTaken(ctx, Slugify(name), exceptChannelID)
	return !taken, err
}

// memberChannelNameSetter is the optional capability that rewrites the
// channel name copied onto a member's sidebar row (the DynamoDB membership
// store has it).
type memberChannelNameSetter interface {
	SetUserChannelName(ctx context.Context, channelID, userID, name string) error
}

// syncMemberChannelNames rewrites the name copied onto every member's sidebar
// row, off the request path. The sidebar list shows the channel's own name
// either way (ListUserChannels stamps it); the copies are what its ordering
// sorts by.
func (s *ChannelService) syncMemberChannelNames(ctx context.Context, channelID, name string) {
	setter, ok := s.memberships.(memberChannelNameSetter)
	if !ok {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		members, err := s.memberships.ListMembers(bg, channelID)
		if err != nil {
			slog.WarnContext(bg, "channel rename: list members failed; sidebar rows keep the old name until the next rename", "channelID", channelID, "error", err)
			return
		}
		for _, m := range members {
			if err := setter.SetUserChannelName(bg, channelID, m.UserID, name); err != nil && !errors.Is(err, store.ErrNotFound) {
				slog.WarnContext(bg, "channel rename: sidebar row name update failed", "channelID", channelID, "userID", m.UserID, "error", err)
			}
		}
	})
}

// MakePrivate turns a public channel private: its members keep it, nobody
// else can find, join or read it any more — it leaves the directory, the
// channel browser and channel search. One way, as in Slack. The owner or a
// system admin may do it; #general stays public, and an archived channel is
// read-only. An already private channel is left as it is.
func (s *ChannelService) MakePrivate(ctx context.Context, actorID, channelID string) (*model.Channel, error) {
	if channelID == generalChannelID {
		return nil, apperr.Forbidden("channel: the general channel stays public")
	}
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleOwner); err != nil {
		return nil, err
	}
	ch, err := s.channels.GetChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("channel: get: %w", err)
	}
	if ch.Archived {
		return nil, ErrChannelArchived
	}
	if ch.Type == model.ChannelTypePrivate {
		return ch, nil
	}
	now := time.Now()
	if err := s.channels.PatchChannel(ctx, channelID, store.ChannelPatch{MakePrivate: true, UpdatedAt: now}); err != nil {
		return nil, fmt.Errorf("channel: make private: %w", err)
	}
	ch.Type, ch.UpdatedAt = model.ChannelTypePrivate, now

	events.Publish(ctx, s.publisher, pubsub.ChannelName(channelID), events.EventChannelUpdated, map[string]any{
		"channelID":   channelID,
		"name":        ch.Name,
		"slug":        ch.Slug,
		"description": ch.Description,
		"type":        ch.Type,
	})
	s.indexChannel(ctx, ch)
	s.postSystemMessage(ctx, channelID, s.resolveDisplayName(ctx, actorID)+" made the channel private")
	return ch, nil
}

// Archive makes a channel read-only. Members keep their memberships and can
// still read its history, search it and leave it, but nobody can post, react,
// edit, rename it or add members until it is unarchived. Directory, browse and
// channel search stop listing it.
//
// Only the owner or a system admin may archive. The well-known #general
// channel cannot be archived.
func (s *ChannelService) Archive(ctx context.Context, actorID, channelID string) error {
	if channelID == generalChannelID {
		return apperr.Forbidden("channel: cannot archive the general channel")
	}
	return s.setArchived(ctx, actorID, channelID, true, events.EventChannelArchived)
}

// Unarchive makes an archived channel writable again. Owner or system admin.
func (s *ChannelService) Unarchive(ctx context.Context, actorID, channelID string) error {
	return s.setArchived(ctx, actorID, channelID, false, events.EventChannelUnarchived)
}

// setArchived flips the archived flag, reindexes the channel (search filters
// archived channels) and tells the channel topic plus every member's user
// topic, so open views and sidebars switch between writable and read-only live.
func (s *ChannelService) setArchived(ctx context.Context, actorID, channelID string, archived bool, event string) error {
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleOwner); err != nil {
		return err
	}
	ch, err := s.channels.GetChannel(ctx, channelID)
	if err != nil {
		return fmt.Errorf("channel: get: %w", err)
	}
	if ch.Archived == archived {
		return nil
	}
	ch.Archived = archived
	ch.UpdatedAt = time.Now()
	if err := s.channels.PatchChannel(ctx, channelID, store.ChannelPatch{Archived: &archived, UpdatedAt: ch.UpdatedAt}); err != nil {
		return fmt.Errorf("channel: set archived: %w", err)
	}
	s.indexChannel(ctx, ch)

	payload := map[string]any{"channelID": channelID}
	topics := []string{pubsub.ChannelName(channelID)}
	members, err := s.memberships.ListMembers(ctx, channelID)
	if err != nil {
		// The flag is already stored; open views still hear it on the channel
		// topic, and every sidebar re-reads it on its next refetch.
		slog.WarnContext(ctx, "channel archive: list members failed", "channelID", channelID, "error", err)
	}
	for _, m := range members {
		topics = append(topics, pubsub.UserChannel(m.UserID))
	}
	events.PublishMany(ctx, s.publisher, topics, event, payload)
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
		return apperr.Forbidden("channel: can only self-join public channels")
	}
	if ch.Archived {
		return ErrChannelArchived
	}
	if s.users != nil {
		if u, err := s.users.GetUser(ctx, userID); err == nil && u != nil {
			if u.SystemRole == model.SystemRoleGuest && channelID != generalChannelID {
				return apperr.Forbidden("channel: guests can only join channels they are invited to")
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
		return apperr.Forbidden("channel: cannot leave the general channel")
	}
	mem, err := s.callerMembership(ctx, channelID, userID)
	if err != nil {
		return err
	}
	if mem.Role == model.ChannelRoleOwner {
		return apperr.Forbidden("channel: owner cannot leave the channel")
	}

	displayName := mem.DisplayName
	if displayName == "" {
		displayName = s.resolveDisplayName(ctx, userID)
	}

	if err := s.audienceWritten(ctx, channelID, s.memberships.RemoveMember(ctx, channelID, userID)); err != nil {
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
	s.accessLost(ctx, []string{userID}, channelID)

	s.postSystemMessage(ctx, channelID, displayName+" left the channel")
	return nil
}

// SetMute marks a channel as muted/unmuted for the calling user. Mute is a
// per-user preference: it suppresses notifications (sound + browser popup)
// but does not unsubscribe the user from real-time event delivery — they
// still see new messages, just without the alert.
func (s *ChannelService) SetMute(ctx context.Context, userID, channelID string, muted bool) error {
	if _, err := s.callerMembership(ctx, channelID, userID); err != nil {
		return err
	}
	if err := s.audienceWritten(ctx, channelID, s.memberships.SetMute(ctx, channelID, userID, muted)); err != nil {
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

// SetNotificationPrefs persists the caller's per-channel notification
// overrides. Each field is "use my account default" when nil, or an explicit
// override otherwise. Like mute it's a per-user preference, so only the user's
// own clients are notified (via userchannel.updated) to keep tabs in sync.
func (s *ChannelService) SetNotificationPrefs(ctx context.Context, userID, channelID string, override model.ChannelNotificationOverride) error {
	if override.DesktopLevel != nil && !override.DesktopLevel.Valid() {
		return apperr.Invalid("channel: invalid desktop notification level")
	}
	if override.MobileLevel != nil && !override.MobileLevel.Valid() {
		return apperr.Invalid("channel: invalid mobile notification level")
	}
	if _, err := s.callerMembership(ctx, channelID, userID); err != nil {
		return err
	}
	if err := s.audienceWritten(ctx, channelID, s.memberships.SetNotifPrefs(ctx, channelID, userID, override)); err != nil {
		return fmt.Errorf("channel: set notification prefs: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, map[string]any{
		"channelID":         channelID,
		"userID":            userID,
		"notificationPrefs": override,
	})
	return nil
}

// SetFavorite pins or unpins a channel in the user's sidebar. Per-user.
// The user must already be a member — pinning a channel you can't see
// would create an orphan row in the user-side index.
func (s *ChannelService) SetFavorite(ctx context.Context, userID, channelID string, favorite bool) error {
	if _, err := s.callerMembership(ctx, channelID, userID); err != nil {
		return err
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
func (s *ChannelService) SetCategory(ctx context.Context, userID, channelID, categoryID string, sidebarPosition *int) error {
	if _, err := s.callerMembership(ctx, channelID, userID); err != nil {
		return err
	}
	if err := s.memberships.SetCategory(ctx, channelID, userID, categoryID, sidebarPosition); err != nil {
		return fmt.Errorf("channel: set category: %w", err)
	}
	payload := map[string]any{
		"channelID":  channelID,
		"userID":     userID,
		"categoryID": categoryID,
	}
	if sidebarPosition != nil {
		payload["sidebarPosition"] = *sidebarPosition
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, payload)
	return nil
}

// AddMember adds a user to a channel with the specified role. The actor must
// be an admin or higher.
func (s *ChannelService) AddMember(ctx context.Context, actorID, channelID, userID string, role model.ChannelRole) error {
	// Any member can invite someone into a channel they belong to (Slack /
	// Mattermost default). Removing members and changing roles still require
	// admin — see RemoveMember / UpdateMemberRole.
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleMember); err != nil {
		return err
	}
	// Only admins may grant an elevated role; a plain member's invite always
	// lands the newcomer as a regular member, never admin/owner. Owner is
	// granted only by an owner or a system admin — the same rule
	// UpdateMemberRole enforces — so an admin's owner grant lands as admin.
	if role > model.ChannelRoleMember {
		if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleAdmin); err != nil {
			role = model.ChannelRoleMember
		} else if role > model.ChannelRoleAdmin {
			if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleOwner); err != nil {
				role = model.ChannelRoleAdmin
			}
		}
	}

	// An archived channel still takes new members: it is read-only for its
	// content, but people (e.g. admins, who cannot join on their own) must be
	// able to get at its history. postSystemMessage leaves its history alone.
	ch, err := s.channels.GetChannel(ctx, channelID)
	if err != nil {
		return fmt.Errorf("channel: get: %w", err)
	}

	account := s.resolveMember(ctx, userID)
	if account.deactivated {
		return ErrMemberDeactivated
	}
	now := time.Now()
	displayName, machine := account.displayName, account.machine
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
		// Start caught up: an invited member shouldn't inherit the channel's
		// pre-join backlog as unread.
		LastReadSeq: ch.MessageSeq,
	}
	if err := s.audienceWritten(ctx, membership.ChannelID, s.memberships.AddMember(ctx, membership, uc)); err != nil {
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
	// A bot or agent has nobody to read its activity stream.
	if s.activity != nil && !machine {
		s.activity.RecordChannelAdded(ctx, actorID, userID, ch)
	}
	return nil
}

// RemoveMember removes a user from a channel. The actor must be admin or
// higher. Owners can only be removed by a system admin. Members cannot be
// removed from the well-known #general channel — it must contain every
// active user.
func (s *ChannelService) RemoveMember(ctx context.Context, actorID, channelID, targetID string) error {
	if channelID == generalChannelID {
		return apperr.Forbidden("channel: cannot remove members from the general channel")
	}
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleAdmin); err != nil {
		return err
	}

	target, err := s.memberships.GetMembership(ctx, channelID, targetID)
	if err != nil {
		return fmt.Errorf("channel: get target membership: %w", err)
	}

	if target.Role == model.ChannelRoleOwner {
		if !s.isSystemAdmin(ctx, actorID) {
			return apperr.Forbidden("channel: only system admins can remove channel owners")
		}
	}

	displayName := target.DisplayName
	if displayName == "" {
		displayName = s.resolveDisplayName(ctx, targetID)
	}

	if err := s.audienceWritten(ctx, channelID, s.memberships.RemoveMember(ctx, channelID, targetID)); err != nil {
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
	s.accessLost(ctx, []string{targetID}, channelID)

	s.postSystemMessage(ctx, channelID, displayName+" was removed from the channel")
	return nil
}

// UpdateMemberRole changes a member's role within a channel. Channel admins
// move members between member and admin; only an owner or a system admin
// makes someone an owner or changes an owner's role, so a system admin can
// hand a channel to a new owner.
func (s *ChannelService) UpdateMemberRole(ctx context.Context, actorID, channelID, targetID string, newRole model.ChannelRole) error {
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleAdmin); err != nil {
		return err
	}

	if newRole == model.ChannelRoleOwner {
		actor, err := s.memberships.GetMembership(ctx, channelID, actorID)
		if err != nil && !s.isSystemAdmin(ctx, actorID) {
			return fmt.Errorf("channel: get actor membership: %w", err)
		}
		if actor != nil && actor.Role != model.ChannelRoleOwner && !s.isSystemAdmin(ctx, actorID) {
			return apperr.Forbidden("channel: only owners can promote to owner")
		}
	}

	// Demoting an existing OWNER requires owner/sysadmin authority. Without this,
	// a mere channel admin could strip the owner (the only role that can archive
	// the channel) and then remove them — escalating from a lower role. Mirrors
	// the owner protection in RemoveMember.
	if newRole != model.ChannelRoleOwner {
		target, err := s.memberships.GetMembership(ctx, channelID, targetID)
		if err != nil && !s.isSystemAdmin(ctx, actorID) {
			return fmt.Errorf("channel: get target membership: %w", err)
		}
		if target != nil && target.Role == model.ChannelRoleOwner && !s.isSystemAdmin(ctx, actorID) {
			actor, err := s.memberships.GetMembership(ctx, channelID, actorID)
			if err != nil {
				return fmt.Errorf("channel: get actor membership: %w", err)
			}
			if actor == nil || actor.Role != model.ChannelRoleOwner {
				return apperr.Forbidden("channel: only an owner can change another owner's role")
			}
		}
	}

	if err := s.audienceWritten(ctx, channelID, s.memberships.UpdateMemberRole(ctx, channelID, targetID, newRole)); err != nil {
		return fmt.Errorf("channel: update role: %w", err)
	}

	// Every member's list shows the new badge, and the member themselves
	// gains or loses what the role allows (rename, archive, …).
	events.Publish(ctx, s.publisher, pubsub.ChannelName(channelID), events.EventMembersChanged, map[string]any{
		"channelID": channelID,
		"userID":    targetID,
		"role":      newRole.String(),
		"action":    events.MemberActionRoleChanged,
	})
	return nil
}

// ListMembers returns the memberships of a channel the actor can access,
// leaving out deactivated accounts: they keep their membership underneath (a
// reactivated account is back in its channels) but no longer count as
// members. A failed status read lists everyone rather than nobody.
func (s *ChannelService) ListMembers(ctx context.Context, actorID, channelID string) ([]*model.ChannelMembership, error) {
	if err := s.checkPermission(ctx, actorID, channelID, model.ChannelRoleMember); err != nil {
		return nil, err
	}
	members, err := s.memberships.ListMembers(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("channel: list members: %w", err)
	}
	if s.users == nil {
		return members, nil
	}
	ids := make([]string, len(members))
	for i, m := range members {
		ids[i] = m.UserID
	}
	deactivated, err := s.users.DeactivatedAmong(ctx, ids)
	if err != nil {
		slog.WarnContext(ctx, "channel: member status read failed; listing every member", "channelID", channelID, "error", err)
		return members, nil
	}
	return slices.DeleteFunc(members, func(m *model.ChannelMembership) bool { return deactivated[m.UserID] }), nil
}

// clampNotifyCount bounds the alerted-unread badge by the plain unread count
// at read time. The two counters are written by different detached paths
// (seq bump vs. notifier), so a narrow race can leave a badge value with no
// unread messages behind it — the next read must never SHOW a numeric badge
// on a caught-up channel. The persisted value still resets on mark-read.
func clampNotifyCount(notify *int64, unread int) {
	if *notify > int64(unread) {
		*notify = int64(unread)
	}
}

// batchChannelStore is the optional batched-META-read capability of the
// channel store (the DynamoDB impl has it). Asserted with a per-channel
// fallback so plain test stores keep working.
type batchChannelStore interface {
	GetChannelsByIDs(ctx context.Context, ids []string) ([]*model.Channel, error)
}

// ListUserChannelIDs returns just the channel IDs of the user's memberships:
// one membership Query, no META BatchGet, no unread math. The WebSocket
// connect path and the presence audience resolver only need topic names, and
// paying the full sidebar enrichment there doubled every connect's DynamoDB
// cost. Unlike ListUserChannels this does NOT filter archived channels — a
// subscription to an archived channel's topic is harmless (nothing posts
// there) and delivers the unarchive event live.
func (s *ChannelService) ListUserChannelIDs(ctx context.Context, userID string) ([]string, error) {
	channels, err := s.memberships.ListUserChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("channel: list user channel ids: %w", err)
	}
	ids := make([]string, 0, len(channels))
	for _, uc := range channels {
		ids = append(ids, uc.ChannelID)
	}
	return ids, nil
}

// ListUserChannels returns every channel a user belongs to, archived ones
// included (they are read-only, not hidden; the sidebar groups them apart).
// The archive flag isn't denormalized onto UserChannel, so the META rows are
// batch-read (one BatchGetItem) — this runs on the sidebar list — and the
// flag is stamped onto each row at read time.
func (s *ChannelService) ListUserChannels(ctx context.Context, userID string) ([]*model.UserChannel, error) {
	channels, err := s.memberships.ListUserChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("channel: list user channels: %w", err)
	}
	if len(channels) == 0 {
		return channels, nil
	}

	// Batched path: ONE BatchGetItem for every channel META row — the old
	// per-channel GetChannel fan-out cost a DynamoDB read per membership,
	// on the sidebar list AND on every WebSocket connect (reconnect storms
	// multiplied it).
	if bs, ok := s.channels.(batchChannelStore); ok {
		ids := make([]string, len(channels))
		for i, uc := range channels {
			ids[i] = uc.ChannelID
		}
		if fetched, err := bs.GetChannelsByIDs(ctx, ids); err == nil {
			byID := make(map[string]*model.Channel, len(fetched))
			for _, ch := range fetched {
				byID[ch.ID] = ch
			}
			out := make([]*model.UserChannel, 0, len(channels))
			for _, uc := range channels {
				ch := byID[uc.ChannelID]
				if ch == nil {
					continue // channel row missing: drop like the fan-out did
				}
				uc.Archived = ch.Archived
				uc.ChannelName, uc.ChannelType = ch.Name, ch.Type
				uc.LastMessageAt = ch.LastMessageAt
				// Exact unread: messages added since this user last read.
				// O(1) from the seq pair; survives reload and reconnect.
				if n := ch.MessageSeq - uc.LastReadSeq; n > 0 {
					uc.UnreadCount = int(n)
					uc.Unread = true
				}
				clampNotifyCount(&uc.UnreadNotifyCount, uc.UnreadCount)
				out = append(out, uc)
			}
			return out, nil
		}
		// Batch failed → the per-channel fallback below still serves the list.
	}

	keep := make([]bool, len(channels))
	var wg sync.WaitGroup
	wg.Add(len(channels))
	for i, uc := range channels {
		go func(i int, uc *model.UserChannel) {
			defer wg.Done()
			defer safe.Recover()
			ch, err := s.channels.GetChannel(ctx, uc.ChannelID)
			if err != nil || ch == nil {
				return
			}
			keep[i] = true
			uc.Archived = ch.Archived
			uc.ChannelName, uc.ChannelType = ch.Name, ch.Type
			uc.LastMessageAt = ch.LastMessageAt
			// Exact unread: messages added since this user last read. O(1) from
			// the seq pair — no per-channel count query. Survives reload and
			// reconnect because both numbers are persisted.
			if n := ch.MessageSeq - uc.LastReadSeq; n > 0 {
				uc.UnreadCount = int(n)
				uc.Unread = true
			}
			clampNotifyCount(&uc.UnreadNotifyCount, uc.UnreadCount)
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

// MarkChannelRead catches the user up to the channel's current MessageSeq, so
// the sidebar unread badge clears and stays cleared across reloads. Publishes a
// user.channel.updated to the caller's own topic so other tabs/devices refetch
// and drop the badge too. Returns ErrNotFound when the caller isn't a member.
func (s *ChannelService) MarkChannelRead(ctx context.Context, userID, channelID string) error {
	ch, err := s.channels.GetChannel(ctx, channelID)
	if err != nil {
		return fmt.Errorf("channel: get: %w", err)
	}
	if err := s.memberships.SetChannelLastRead(ctx, channelID, userID, ch.MessageSeq); err != nil {
		return err
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, map[string]any{
		"channelID": channelID,
	})
	if s.activity != nil {
		s.activity.MarkParentRead(ctx, userID, channelID, "", time.Now())
	}
	return nil
}

// SearchPublic returns matched public channels visible to the caller
// via OpenSearch. Returns (nil, nil) when no searcher is configured so
// the handler can fall back to BrowsePublic.
func (s *ChannelService) SearchPublic(ctx context.Context, userID, q string, limit int) ([]*model.Channel, error) {
	if s.searcher == nil {
		return nil, nil
	}
	ids, err := s.searcher.Channels(ctx, q, limit)
	if err != nil {
		return nil, err
	}
	guestOnly := s.isGuest(ctx, userID)
	// Guests are scoped to channels they belong to — ONE membership list
	// instead of a GetMembership read per search hit.
	var guestChannels map[string]bool
	if guestOnly {
		mine, err := s.memberships.ListUserChannels(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("channel: search guest scope: %w", err)
		}
		guestChannels = make(map[string]bool, len(mine))
		for _, uc := range mine {
			guestChannels[uc.ChannelID] = true
		}
	}
	// Resolve every hit in one BatchGetItem instead of a GetChannel per hit;
	// on batch failure (or a store without the capability) fall back to the
	// per-ID loop to keep search best-effort.
	byID := s.channelsByID(ctx, ids)
	out := make([]*model.Channel, 0, len(ids))
	for _, id := range ids {
		ch := byID[id]
		if ch == nil || ch.Archived || ch.Type != model.ChannelTypePublic {
			continue
		}
		if guestOnly && !guestChannels[ch.ID] {
			continue
		}
		out = append(out, ch)
	}
	return out, nil
}

// channelsByID resolves many channels preferring the batched store read, with
// a per-ID fallback. Unresolvable IDs are simply absent (stale search hits,
// deleted channels).
func (s *ChannelService) channelsByID(ctx context.Context, ids []string) map[string]*model.Channel {
	byID := make(map[string]*model.Channel, len(ids))
	if bs, ok := s.channels.(batchChannelStore); ok {
		if chans, err := bs.GetChannelsByIDs(ctx, ids); err == nil {
			for _, ch := range chans {
				byID[ch.ID] = ch
			}
			return byID
		}
	}
	for _, id := range ids {
		if ch, err := s.channels.GetChannel(ctx, id); err == nil && ch != nil {
			byID[id] = ch
		}
	}
	return byID
}

func (s *ChannelService) isGuest(ctx context.Context, userID string) bool {
	if s.users == nil || userID == "" {
		return false
	}
	u, err := s.users.GetUser(ctx, userID)
	if err != nil || u == nil {
		return false
	}
	return u.SystemRole == model.SystemRoleGuest
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

// guestBrowse fetches the channel records for every live public channel the
// guest belongs to, in a stable order: archived ones are left out, as
// ListPublicChannels leaves them out for everyone else. No cursor — guests
// never have enough channels to need pagination.
func (s *ChannelService) guestBrowse(ctx context.Context, userID string) ([]*model.Channel, string, error) {
	mine, err := s.memberships.ListUserChannels(ctx, userID)
	if err != nil {
		return nil, "", fmt.Errorf("channel: browse public guest: %w", err)
	}
	// One batched read for all the guest's channels (per-ID fallback inside);
	// iteration order follows the membership list so the result stays stable.
	ids := make([]string, 0, len(mine))
	for _, uc := range mine {
		ids = append(ids, uc.ChannelID)
	}
	byID := s.channelsByID(ctx, ids)
	out := make([]*model.Channel, 0, len(mine))
	for _, uc := range mine {
		ch := byID[uc.ChannelID]
		if ch == nil || ch.Type != model.ChannelTypePublic || ch.Archived {
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

// callerMembership reads the caller's own membership for a per-member
// setting (mute, favorite, …) or leaving: none is a refusal — the caller is
// not a member — while a store failure stays internal.
func (s *ChannelService) callerMembership(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	mem, err := s.memberships.GetMembership(ctx, channelID, userID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.Forbidden("channel: not a member")
	}
	if err != nil {
		return nil, fmt.Errorf("channel: get membership: %w", err)
	}
	return mem, nil
}

// checkPermission verifies that the actor has at least minRole in the channel,
// or is a system admin (which bypasses channel-level checks).
func (s *ChannelService) checkPermission(ctx context.Context, actorID, channelID string, minRole model.ChannelRole) error {
	// Membership first: it's the common case and keeps the hot path at one
	// read. The (rarer) system-admin bypass is only consulted on a shortfall.
	mem, err := s.memberships.GetMembership(ctx, channelID, actorID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			if s.isSystemAdmin(ctx, actorID) {
				return nil
			}
			return apperr.Forbidden("channel: not a member")
		}
		return fmt.Errorf("channel: check permission: %w", err)
	}

	if mem.Role < minRole {
		if s.isSystemAdmin(ctx, actorID) {
			return nil
		}
		return apperr.Forbidden("channel: insufficient permissions (need %s, have %s)", minRole, mem.Role)
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

// GetVisibleBySlug is the slug variant of GetVisibleByID.
func (s *ChannelService) GetVisibleBySlug(ctx context.Context, actorID, slug string) (*model.Channel, error) {
	ch, err := s.GetBySlug(ctx, slug)
	if err != nil {
		return nil, err
	}
	if err := s.grantVisibleAccess(ctx, actorID, ch); err != nil {
		return nil, err
	}
	return ch, nil
}

// grantVisibleAccess authorises actor to open ch's chat. For a public channel
// the actor hasn't joined yet, it self-joins them (Slack-style "open a public
// channel to join") rather than denying access — clicking a public
// channel/message/thread link should just let you in. Private channels and
// anyone the Join rules reject (e.g. guests) stay forbidden.
func (s *ChannelService) grantVisibleAccess(ctx context.Context, actorID string, ch *model.Channel) error {
	// No system-admin bypass here: admins get the same treatment as anyone —
	// a public channel auto-joins them, but a private channel they don't
	// belong to stays forbidden. Admin channel management lives on dedicated
	// endpoints with their own RBAC checks.
	if _, err := s.memberships.GetMembership(ctx, ch.ID, actorID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			if ch.Type == model.ChannelTypePublic {
				// Join re-validates public/archived/guest rules and writes the
				// membership (with the member-joined event + WS subscription).
				if joinErr := s.Join(ctx, actorID, ch.ID); joinErr != nil {
					return ErrForbidden
				}
				return nil
			}
			return ErrForbidden
		}
		return fmt.Errorf("channel: check access: %w", err)
	}
	return nil
}

// isSystemAdmin reports whether userID is a system admin according to the
// user store — the single source of RBAC truth. Deliberately NOT read from
// request claims: a stale JWT must not confer admin after a demotion, and
// the service layer stays free of HTTP-middleware context plumbing.
func (s *ChannelService) isSystemAdmin(ctx context.Context, userID string) bool {
	if s.users == nil || userID == "" {
		return false
	}
	u, err := s.users.GetUser(ctx, userID)
	return err == nil && u != nil && u.SystemRole == model.SystemRoleAdmin
}

// Slugify converts a name into a URL-friendly slug.
func Slugify(name string) string {
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
