package main

import (
	"context"

	"github.com/DigitalTolk/ex/internal/handler"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/paginate"
)

// reindexSources adapts the handler-level store adapters to the slim
// `search.reindexSources` interface the Reindexer expects. Each method
// pulls the entire population of one resource — workspaces are small
// enough that an in-memory list per resource is fine for an admin-
// triggered maintenance flow.
type reindexSources struct {
	users    *handler.UserStoreAdapter
	channels *handler.ChannelStoreAdapter
	convs    *handler.ConversationStoreAdapter
	messages *handler.MessageStoreAdapter
}

func newReindexSources(
	users *handler.UserStoreAdapter,
	channels *handler.ChannelStoreAdapter,
	convs *handler.ConversationStoreAdapter,
	messages *handler.MessageStoreAdapter,
) *reindexSources {
	return &reindexSources{users: users, channels: channels, convs: convs, messages: messages}
}

func (a *reindexSources) ListUsers(ctx context.Context) ([]*model.User, error) {
	return paginate.All(ctx, func(ctx context.Context, cursor string) ([]*model.User, string, error) {
		return a.users.ListUsers(ctx, 200, cursor)
	}, 0)
}

func (a *reindexSources) ListChannels(ctx context.Context) ([]*model.Channel, error) {
	return a.channels.ListAllChannels(ctx)
}

func (a *reindexSources) ListConversations(ctx context.Context) ([]*model.Conversation, error) {
	return a.convs.ListAllConversations(ctx)
}

func (a *reindexSources) ListMessages(ctx context.Context, parentID string) ([]*model.Message, error) {
	// ListMessages uses (page, hasMore, err) instead of (page, next,
	// err) and the cursor is the last item's ID. Translate to the
	// shape paginate.All expects.
	return paginate.All(ctx, func(ctx context.Context, cursor string) ([]*model.Message, string, error) {
		page, hasMore, err := a.messages.ListMessages(ctx, parentID, cursor, 200)
		if err != nil {
			return nil, "", err
		}
		if !hasMore || len(page) == 0 {
			return page, "", nil
		}
		return page, page[len(page)-1].ID, nil
	}, 0)
}
