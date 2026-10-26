package app

import (
	"context"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// wsOriginPatternsFromCORS converts the CORS allow-list (which holds
// scheme-qualified origins like "https://app.example.com" or
// "tauri://localhost") into host patterns suitable for
// websocket.AcceptOptions.OriginPatterns. The "*" sentinel is preserved so
// downstream callers can opt back into dev wildcard mode.
func wsOriginPatternsFromCORS(origins []string) []string {
	out := make([]string, 0, len(origins))
	for _, raw := range origins {
		if raw == "*" {
			return []string{"*"}
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			continue
		}
		out = append(out, u.Hostname())
	}
	return out
}

// uploadConnectSrcOrigins derives the CSP connect-src allow-list entry for
// browser-bound presigned uploads. The public endpoint wins (it is what the
// presigned URLs carry); only http origins are returned since the base CSP
// already permits https:.
func uploadConnectSrcOrigins(publicEndpoint, endpoint string) []string {
	raw := publicEndpoint
	if raw == "" {
		raw = endpoint
	}
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.Host == "" {
		return nil
	}
	return []string{u.Scheme + "://" + u.Host}
}

// channelIDLister and conversationIDLister are the ID-only membership lists
// the presence audience is built from.
type channelIDLister interface {
	ListUserChannelIDs(ctx context.Context, userID string) ([]string, error)
}

type conversationIDLister interface {
	ListUserConversationIDs(ctx context.Context, userID string) ([]string, error)
}

// presenceAudience resolves the pub/sub topics a user's presence change goes
// to: their channels and conversations. It uses a fresh context because a
// disconnect's request context is already cancelled.
//
// ID-only lists: topic names need no channel META, unread math or DM profile
// resolution — the full sidebar lists made every presence transition cost two
// enriched reads. The two lookups are independent, so they run concurrently;
// each stays best-effort (a failed side just contributes no topics), so the
// goroutines never return an error.
func presenceAudience(channels channelIDLister, convs conversationIDLister) func(context.Context, string) []string {
	return func(_ context.Context, userID string) []string {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var channelIDs, convIDs []string
		var g errgroup.Group
		g.Go(func() error {
			if ids, err := channels.ListUserChannelIDs(ctx, userID); err == nil {
				channelIDs = ids
			}
			return nil
		})
		g.Go(func() error {
			if ids, err := convs.ListUserConversationIDs(ctx, userID); err == nil {
				convIDs = ids
			}
			return nil
		})
		_ = g.Wait()
		topics := make([]string, 0, len(channelIDs)+len(convIDs))
		for _, id := range channelIDs {
			topics = append(topics, pubsub.ChannelName(id))
		}
		for _, id := range convIDs {
			topics = append(topics, pubsub.ConversationName(id))
		}
		return topics
	}
}

// agentLister lists the workspace's shared agents.
type agentLister interface {
	ListAgents(ctx context.Context) ([]*model.User, error)
}

// alwaysOnlineAgents is the presence roster's always-online set: shared
// agents are services, not sockets. A failed lookup adds nobody.
func alwaysOnlineAgents(agents agentLister) func(*http.Request) []string {
	return func(r *http.Request) []string {
		list, err := agents.ListAgents(r.Context())
		if err != nil {
			return nil
		}
		ids := make([]string, 0, len(list))
		for _, a := range list {
			ids = append(ids, a.ID)
		}
		return ids
	}
}
