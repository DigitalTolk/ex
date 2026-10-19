package importer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/limits"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// Channel is an existing ex channel as seen by the importer.
type Channel struct {
	ID       string `json:"id"`
	Slug     string `json:"slug"`
	Name     string `json:"name"`
	Type     string `json:"type"` // "public" | "private"
	Archived bool   `json:"archived"`
}

// Channels lists every ex channel — public and private, archived included.
func (im *Importer) Channels(ctx context.Context) ([]Channel, error) {
	chans, err := im.channels.ListAllChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("importer: list channels: %w", err)
	}
	out := make([]Channel, 0, len(chans))
	for _, c := range chans {
		out = append(out, Channel{ID: c.ID, Slug: c.Slug, Name: c.Name, Type: string(c.Type), Archived: c.Archived})
	}
	return out, nil
}

// ChannelSpec describes a channel to create.
type ChannelSpec struct {
	ID          string
	Slug        string
	Name        string // defaults to Slug
	Description string
	Type        string // "public" | "private"
	CreatedBy   string
	CreatedAt   time.Time
	// Archived creates the channel archived (its members are kept).
	Archived bool
}

// SlugTakenError reports that another channel already holds the slug.
type SlugTakenError struct {
	Slug       string
	ExistingID string
}

func (e *SlugTakenError) Error() string {
	return fmt.Sprintf("importer: slug %q already belongs to channel %s", e.Slug, e.ExistingID)
}

// ErrInvalidSpec wraps every input validation failure.
var ErrInvalidSpec = errors.New("importer: invalid spec")

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrInvalidSpec}, args...)...)
}

// EnsureChannel creates the channel with its historical creation time unless a
// channel with spec.ID already exists (then it is left as is). Name, slug and
// description go through ex's channel validators. Returns whether it was
// created; the stored channel is (re)indexed for search either way.
func (im *Importer) EnsureChannel(ctx context.Context, spec ChannelSpec) (bool, error) {
	if spec.Name == "" {
		spec.Name = spec.Slug
	}
	if spec.ID == "" {
		return false, invalid("channel ID is required")
	}
	if err := limits.ValidateChannelName(spec.Slug); err != nil {
		return false, invalid("slug %q: %v", spec.Slug, err)
	}
	if err := limits.ValidateChannelName(spec.Name); err != nil {
		return false, invalid("name %q: %v", spec.Name, err)
	}
	if err := limits.ValidateChannelDescription(spec.Description); err != nil {
		return false, invalid("description: %v", err)
	}
	typ := model.ChannelType(spec.Type)
	if typ != model.ChannelTypePublic && typ != model.ChannelTypePrivate {
		return false, invalid("channel type %q", spec.Type)
	}
	if existing, err := im.channels.GetChannel(ctx, spec.ID); err == nil {
		return false, im.indexChannel(ctx, existing)
	} else if !errors.Is(err, store.ErrNotFound) {
		return false, fmt.Errorf("importer: get channel: %w", err)
	}
	ch := &model.Channel{
		ID:          spec.ID,
		Name:        spec.Name,
		Slug:        spec.Slug,
		Description: strings.TrimSpace(spec.Description),
		Type:        typ,
		CreatedBy:   spec.CreatedBy,
		Archived:    spec.Archived,
		CreatedAt:   spec.CreatedAt,
		UpdatedAt:   spec.CreatedAt,
	}
	if err := im.channels.CreateChannel(ctx, ch); err != nil {
		if !errors.Is(err, store.ErrAlreadyExists) {
			return false, fmt.Errorf("importer: create channel: %w", err)
		}
		holder, gerr := im.channels.GetChannelBySlug(ctx, spec.Slug)
		if gerr != nil {
			return false, fmt.Errorf("importer: get channel by slug: %w", gerr)
		}
		if holder.ID != spec.ID {
			return false, &SlugTakenError{Slug: spec.Slug, ExistingID: holder.ID}
		}
		// A concurrent call created this very channel.
		return false, im.indexChannel(ctx, holder)
	}
	return true, im.indexChannel(ctx, ch)
}

func (im *Importer) indexChannel(ctx context.Context, ch *model.Channel) error {
	if err := im.indexer.IndexChannel(ctx, ch); err != nil {
		return fmt.Errorf("importer: index channel: %w", err)
	}
	return nil
}

// MemberSpec describes one channel member.
type MemberSpec struct {
	UserID   string
	Role     model.ChannelRole // 0 = member
	JoinedAt time.Time
	Muted    bool
	Favorite bool
}

// AddChannelMembers adds members to a channel (both the channel-side and the
// user-side rows). Existing memberships are left untouched; no system message
// is posted. New members start caught up on the channel's current messages.
// Returns how many memberships were added.
func (im *Importer) AddChannelMembers(ctx context.Context, channelID string, members []MemberSpec) (int, error) {
	ch, err := im.channels.GetChannel(ctx, channelID)
	if err != nil {
		return 0, fmt.Errorf("importer: get channel: %w", err)
	}
	ids := make([]string, 0, len(members))
	for _, m := range members {
		ids = append(ids, m.UserID)
	}
	names, err := im.displayNames(ctx, ids)
	if err != nil {
		return 0, err
	}
	added := 0
	for _, m := range members {
		role := m.Role
		if role == 0 {
			role = model.ChannelRoleMember
		}
		membership := &model.ChannelMembership{ChannelID: ch.ID, UserID: m.UserID, Role: role, DisplayName: names[m.UserID], JoinedAt: m.JoinedAt}
		uc := &model.UserChannel{
			UserID:      m.UserID,
			ChannelID:   ch.ID,
			ChannelName: ch.Name,
			ChannelType: ch.Type,
			Role:        role,
			JoinedAt:    m.JoinedAt,
			LastReadSeq: ch.MessageSeq,
			Muted:       m.Muted,
			Favorite:    m.Favorite,
		}
		if err := im.memberships.AddChannelMember(ctx, ch, membership, uc); err != nil {
			if errors.Is(err, store.ErrAlreadyExists) {
				continue
			}
			return added, fmt.Errorf("importer: add member %s: %w", m.UserID, err)
		}
		added++
	}
	return added, nil
}

// displayNames resolves user IDs to display names (unknown IDs map to "").
func (im *Importer) displayNames(ctx context.Context, ids []string) (map[string]string, error) {
	users, err := im.users.GetUsersByIDs(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("importer: get users: %w", err)
	}
	out := make(map[string]string, len(users))
	for _, u := range users {
		out[u.ID] = u.DisplayName
	}
	return out, nil
}

// ConversationSpec describes a direct (two people, or one for a self-DM) or
// group conversation.
type ConversationSpec struct {
	Type           string // "dm" | "group"
	ParticipantIDs []string
	Name           string // group name (optional)
	CreatedBy      string
	CreatedAt      time.Time
}

// maxGroupParticipants: creating a group writes 1+2N items in one transaction.
const maxGroupParticipants = 49

// EnsureConversation creates the conversation (already activated, so every
// participant sees it) unless it exists. Its ID is derived from the
// participants exactly as ex derives it, so an existing conversation between
// the same people is reused. Returns the ID and whether it was created.
func (im *Importer) EnsureConversation(ctx context.Context, spec ConversationSpec) (string, bool, error) {
	participants := dedupe(spec.ParticipantIDs)
	var id string
	switch model.ConversationType(spec.Type) {
	case model.ConversationTypeDM:
		if len(participants) < 1 || len(participants) > 2 {
			return "", false, invalid("a direct conversation has one or two participants, got %d", len(participants))
		}
		a, b := participants[0], participants[len(participants)-1]
		id = store.DeriveDMConversationID(a, b)
	case model.ConversationTypeGroup:
		if len(participants) < 2 || len(participants) > maxGroupParticipants {
			return "", false, invalid("a group has 2..%d participants, got %d", maxGroupParticipants, len(participants))
		}
		id = store.DeriveGroupConversationID(participants)
	default:
		return "", false, invalid("conversation type %q", spec.Type)
	}
	createdBy := spec.CreatedBy
	if createdBy == "" {
		createdBy = participants[0]
	}
	existing, err := im.conversations.GetConversation(ctx, id)
	if err == nil {
		if !existing.Activated {
			if err := im.conversations.ActivateConversation(ctx, id, existing.ParticipantIDs); err != nil {
				return "", false, fmt.Errorf("importer: activate conversation: %w", err)
			}
		}
		return id, false, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return "", false, fmt.Errorf("importer: get conversation: %w", err)
	}
	names, err := im.displayNames(ctx, participants)
	if err != nil {
		return "", false, err
	}
	conv := &model.Conversation{
		ID:             id,
		Type:           model.ConversationType(spec.Type),
		Name:           spec.Name,
		ParticipantIDs: participants,
		CreatedBy:      createdBy,
		Activated:      true,
		CreatedAt:      spec.CreatedAt,
		UpdatedAt:      spec.CreatedAt,
	}
	members := make([]*model.UserConversation, 0, len(participants))
	for _, uid := range participants {
		members = append(members, &model.UserConversation{
			UserID:         uid,
			ConversationID: id,
			Type:           conv.Type,
			DisplayName:    conversationTitle(conv, uid, names),
			ParticipantIDs: participants,
			CreatedBy:      createdBy,
			Activated:      true,
			JoinedAt:       spec.CreatedAt,
			UpdatedAt:      spec.CreatedAt,
		})
	}
	if err := im.conversations.CreateConversation(ctx, conv, members); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return id, false, nil
		}
		return "", false, fmt.Errorf("importer: create conversation: %w", err)
	}
	return id, true, nil
}

// conversationTitle mirrors how ex names a conversation for each participant:
// the other person for a DM (yourself for a self-DM), the group name, or the
// other members' names for an unnamed group.
func conversationTitle(conv *model.Conversation, viewer string, names map[string]string) string {
	if conv.Type == model.ConversationTypeGroup && conv.Name != "" {
		return conv.Name
	}
	others := make([]string, 0, len(conv.ParticipantIDs))
	for _, id := range conv.ParticipantIDs {
		if id != viewer && names[id] != "" {
			others = append(others, names[id])
		}
	}
	if len(others) == 0 {
		return names[viewer]
	}
	return strings.Join(others, ", ")
}

func dedupe(ids []string) []string {
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
