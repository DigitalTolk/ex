package service

import (
	"context"

	"github.com/DigitalTolk/ex/internal/model"
)

// ChannelMemberCache is the shared copy of channels' member rows
// (internal/cache.MemberLists), valid only at the channel's current audience
// generation — which every membership write moves.
type ChannelMemberCache interface {
	// Member returns userID's row (nil when the copy doesn't hold one at the
	// current generation) and the current generation to store a fill under.
	Member(ctx context.Context, channelID, userID string) (*model.ChannelMembership, string, error)
	// Members returns the member rows when the copy is complete at the
	// current generation, and the current generation to store a fill under.
	Members(ctx context.Context, channelID string) ([]*model.ChannelMembership, string, bool, error)
	PutMember(ctx context.Context, channelID, gen string, row *model.ChannelMembership) error
	PutMembers(ctx context.Context, channelID, gen string, rows []*model.ChannelMembership) error
}

// consistentMembershipReader is the strongly consistent single-row read of the
// membership store (the DynamoDB impl has it). A fill of the copy must read
// consistently: an eventually consistent read right after a removal could
// still return the row, and the copy would keep the removed member in until
// the channel's next change.
type consistentMembershipReader interface {
	GetMembershipConsistent(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error)
}

// CachedMemberships serves channel member lists and membership checks — the
// access check behind nearly every request — from the shared copy, reading
// DynamoDB only to fill it. Everyone the copy doesn't hold is asked of the
// store, so a member whose join the copy missed is never locked out. Every
// other method is the store's own; writes move the channel's generation
// through the services (audienceWritten) and the importer.
type CachedMemberships struct {
	MembershipStore
	cache ChannelMemberCache
}

// NewCachedMemberships wraps store with the shared copy.
func NewCachedMemberships(store MembershipStore, cache ChannelMemberCache) *CachedMemberships {
	return &CachedMemberships{MembershipStore: store, cache: cache}
}

// GetMembership returns userID's membership of channelID: from the copy when
// it holds the row, else from a consistent store read that then joins the
// copy. ErrNotFound when they aren't a member.
func (c *CachedMemberships) GetMembership(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	row, gen, err := c.cache.Member(ctx, channelID, userID)
	if row != nil {
		return row, nil
	}
	reader, consistent := c.MembershipStore.(consistentMembershipReader)
	if err != nil || !consistent {
		return c.MembershipStore.GetMembership(ctx, channelID, userID)
	}
	row, err = reader.GetMembershipConsistent(ctx, channelID, userID)
	if err != nil {
		return nil, err
	}
	_ = c.cache.PutMember(ctx, channelID, gen, row)
	return row, nil
}

// ListMembers returns channelID's members: from the copy when it is complete,
// else from a consistent store read that then becomes the copy.
func (c *CachedMemberships) ListMembers(ctx context.Context, channelID string) ([]*model.ChannelMembership, error) {
	rows, gen, complete, err := c.cache.Members(ctx, channelID)
	if complete {
		return rows, nil
	}
	lister, consistent := c.MembershipStore.(consistentMemberLister)
	if err != nil || !consistent {
		return c.MembershipStore.ListMembers(ctx, channelID)
	}
	rows, err = lister.ListMembersConsistent(ctx, channelID)
	if err != nil {
		return nil, err
	}
	_ = c.cache.PutMembers(ctx, channelID, gen, rows)
	return rows, nil
}

// SetUserChannelName passes the channel service's sidebar-name rewrite on to
// the store when it has one.
func (c *CachedMemberships) SetUserChannelName(ctx context.Context, channelID, userID, name string) error {
	if setter, ok := c.MembershipStore.(memberChannelNameSetter); ok {
		return setter.SetUserChannelName(ctx, channelID, userID, name)
	}
	return nil
}
