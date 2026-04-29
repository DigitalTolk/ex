package main

import (
	"context"

	"github.com/DigitalTolk/ex/internal/handler"
	"github.com/DigitalTolk/ex/internal/model"
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
	out := make([]*model.User, 0)
	cursor := ""
	for {
		page, next, err := a.users.ListUsers(ctx, 200, cursor)
		if err != nil {
			return nil, err
		}
		out = append(out, page...)
		if next == "" {
			break
		}
		cursor = next
	}
	return out, nil
}

func (a *reindexSources) ListChannels(ctx context.Context) ([]*model.Channel, error) {
	return a.channels.ListAllChannels(ctx)
}

func (a *reindexSources) ListConversations(ctx context.Context) ([]*model.Conversation, error) {
	return a.convs.ListAllConversations(ctx)
}

func (a *reindexSources) ListMessages(ctx context.Context, parentID string) ([]*model.Message, error) {
	out := make([]*model.Message, 0)
	before := ""
	for {
		page, hasMore, err := a.messages.ListMessages(ctx, parentID, before, 200)
		if err != nil {
			return nil, err
		}
		out = append(out, page...)
		if !hasMore || len(page) == 0 {
			break
		}
		before = page[len(page)-1].ID
	}
	return out, nil
}
