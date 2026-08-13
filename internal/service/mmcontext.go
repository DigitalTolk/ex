package service

import (
	"context"

	"github.com/DigitalTolk/ex/internal/model"
)

// mmChannelReader reads a channel row for its name, slug, and visibility.
type mmChannelReader interface {
	GetChannel(ctx context.Context, id string) (*model.Channel, error)
}

// mmUserReader reads a user row for the fields a username is derived from.
type mmUserReader interface {
	GetUser(ctx context.Context, id string) (*model.User, error)
}

// MMContextResolver implements BotContextResolver over the channel and user
// stores. It supplies the cosmetic naming fields MM-shaped integration payloads
// carry (channel_name, user_name, channel_type).
//
// Every lookup is best-effort by contract: a miss yields empty strings rather
// than an error, because those fields are labels — an integration acts on the
// ids, which are always present. See BotContextResolver.
type MMContextResolver struct {
	channels mmChannelReader
	users    mmUserReader
}

func NewMMContextResolver(channels mmChannelReader, users mmUserReader) *MMContextResolver {
	return &MMContextResolver{channels: channels, users: users}
}

var _ BotContextResolver = (*MMContextResolver)(nil)

// ChannelContext returns a channel's display name, slug, and MM type letter.
//
// A conversation (DM or group DM) reports only the type: ex conversations have no
// name or slug of their own — they are identified by their participants — and
// inventing one would put participant names into an integration payload that MM's
// contract does not promise.
func (r *MMContextResolver) ChannelContext(ctx context.Context, parentID, parentType string) (string, string, string) {
	if parentType == ParentConversation {
		return "", "", mmChannelTypeDirect
	}
	if r.channels == nil {
		return "", "", MMChannelTypeFor(parentType)
	}
	ch, err := r.channels.GetChannel(ctx, parentID)
	if err != nil || ch == nil {
		return "", "", MMChannelTypeFor(parentType)
	}
	return ch.Name, ch.Slug, MMChannelTypeForVisibility(ch.Type)
}

// UserContext returns the MM-style username and display name for a user.
func (r *MMContextResolver) UserContext(ctx context.Context, userID string) (string, string) {
	if r.users == nil || userID == "" {
		return "", ""
	}
	u, err := r.users.GetUser(ctx, userID)
	if err != nil || u == nil {
		return "", ""
	}
	return MMUsername(u.Email, u.DisplayName, u.ID), u.DisplayName
}
