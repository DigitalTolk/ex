package app

import (
	"context"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/paginate"
	"github.com/DigitalTolk/ex/internal/search"
)

// attachmentGetter is the attachment store read the search indexer needs.
type attachmentGetter interface {
	GetByID(ctx context.Context, id string) (*model.Attachment, error)
}

// attachmentResolver looks up attachment metadata for the search indexer.
// Per-message attachment counts are capped well below 100, so a sequential
// loop over GetByID is fine; switching to a batched DDB BatchGetItem only
// matters at much larger volumes.
type attachmentResolver struct {
	s attachmentGetter
}

func newAttachmentResolver(s attachmentGetter) *attachmentResolver {
	return &attachmentResolver{s: s}
}

func (r *attachmentResolver) ResolveFilenames(ctx context.Context, ids []string) []string {
	atts := r.ResolveAttachments(ctx, ids)
	out := make([]string, 0, len(atts))
	for _, a := range atts {
		if a.Filename != "" {
			out = append(out, a.Filename)
		}
	}
	return out
}

func (r *attachmentResolver) ResolveAttachments(ctx context.Context, ids []string) []*model.Attachment {
	if len(ids) == 0 {
		return nil
	}
	out := make([]*model.Attachment, 0, len(ids))
	for _, id := range ids {
		a, err := r.s.GetByID(ctx, id)
		if err != nil || a == nil {
			continue
		}
		out = append(out, a)
	}
	return out
}

// The store reads the reindex sources page through.
type (
	userPager interface {
		ListUsers(ctx context.Context, limit int, cursor string) ([]*model.User, string, error)
	}
	channelLister interface {
		ListAllChannels(ctx context.Context) ([]*model.Channel, error)
	}
	conversationLister interface {
		ListAllConversations(ctx context.Context) ([]*model.Conversation, error)
	}
	messagePager interface {
		ListMessages(ctx context.Context, parentID, before string, limit int) ([]*model.Message, bool, error)
	}
)

// reindexSources adapts the stores to the slim source interface the search
// Reindexer expects. Each method pulls the entire population of one resource
// — workspaces are small enough that an in-memory list per resource is fine
// for an admin-triggered maintenance flow.
type reindexSources struct {
	users    userPager
	channels channelLister
	convs    conversationLister
	messages messagePager
}

func newReindexSources(users userPager, channels channelLister, convs conversationLister, messages messagePager) *reindexSources {
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
	// ListMessages uses (page, hasMore, err) instead of (page, next, err)
	// and the cursor is the last item's ID. Translate to the shape
	// paginate.All expects.
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

// idSearcher narrows search.Searcher's full-hit responses to the bare IDs the
// service-layer hooks consume. Two methods (Users/Channels) share one type
// since they only differ in which underlying call they dispatch to.
type idSearcher struct {
	s search.Searcher
}

func newIDSearcher(s search.Searcher) *idSearcher { return &idSearcher{s: s} }

func (a *idSearcher) Users(ctx context.Context, q string, limit int) ([]string, error) {
	res, err := a.s.Users(ctx, q, limit)
	if err != nil || res == nil {
		return nil, err
	}
	return hitIDs(res.Hits), nil
}

func (a *idSearcher) Channels(ctx context.Context, q string, limit int) ([]string, error) {
	// Service-layer name lookups resolve any channel, private included; the
	// callers apply their own access checks to what comes back.
	res, err := a.s.Channels(ctx, search.ChannelQuery{Q: q, Unscoped: true, Limit: limit})
	if err != nil || res == nil {
		return nil, err
	}
	return hitIDs(res.Hits), nil
}

func hitIDs(hits []search.SearchHit) []string {
	out := make([]string, len(hits))
	for i, h := range hits {
		out[i] = h.ID
	}
	return out
}
