package main

import (
	"context"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/paginate"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/store"

	"log/slog"
)

// runSearchReindex rebuilds the ex_users and ex_channels OpenSearch
// indices with the CURRENT mapping (the n-gram `autocomplete` analyzer)
// from DynamoDB, with zero downtime: each index is bulk-built as a fresh
// staging index and atomically alias-swapped live, then a repair pass
// re-lists the canonical store so writes that raced the rebuild are
// captured (see search.RecreateUsersChannels). This is how a
// mapping/analyzer change rolls onto an EXISTING cluster — EnsureIndices
// only creates absent indices. Rebuilding from scratch also drops
// orphaned ghost docs (users/channels deleted directly from DynamoDB and
// never de-indexed).
//
// Idempotent: re-running produces the same end state. Defaults to
// --dry-run (reports the counts it WOULD reindex without touching
// OpenSearch); pass --apply to rebuild + swap.
func runSearchReindex(ctx context.Context, db *store.DB, args []string) int {
	dryRun, _, mode := migrateFlags("search-reindex", args, nil)

	cfg, err := config.Load()
	if err != nil {
		fatal("config load failed", err)
	}
	client, err := search.NewClientFromConfig(ctx, search.ClientConfig{
		URL:        cfg.OpenSearchURL,
		AWSRegion:  cfg.OpenSearchAWSRegion,
		AWSService: cfg.OpenSearchAWSService,
	})
	if err != nil {
		fatal("opensearch client init failed", err)
	}
	if client == nil {
		slog.Error("search-reindex: OPENSEARCH_URL is not set — nothing to do")
		return 1
	}

	src := &usersChannelsSource{
		users:    store.NewUserStore(db),
		channels: store.NewChannelStore(db),
	}

	slog.Info("search-reindex starting", "mode", mode, "indices", []string{search.IndexUsers, search.IndexChannels})
	return searchReindex(ctx, client, src, dryRun)
}

// searchReindex is the flag- and env-free core of the subcommand,
// extracted so tests can pin the dry-run/apply contract with a spy
// rebuilder: dry-run reports counts from the SAME src listing the apply
// path reindexes from and performs zero rebuilder calls; apply delegates
// to search.RecreateUsersChannels.
func searchReindex(ctx context.Context, rc search.IndexRebuilder, src search.UsersChannelsSource, dryRun bool) int {
	if dryRun {
		users, err := src.ListUsers(ctx)
		if err != nil {
			slog.Error("search-reindex: list users", "error", err)
			return 1
		}
		channels, err := src.ListChannels(ctx)
		if err != nil {
			slog.Error("search-reindex: list channels", "error", err)
			return 1
		}
		slog.Info("search-reindex dry-run: would rebuild + swap",
			"users", len(users), "channels", len(channels))
		return 0
	}

	users, channels, err := search.RecreateUsersChannels(ctx, rc, src)
	if err != nil {
		slog.Error("search reindex failed — the live indices keep serving (a staging index may linger)", "error", err)
		return 1
	}
	slog.Info("search-reindex complete", "users", users, "channels", channels)
	return 0
}

// usersChannelsSource adapts the DynamoDB stores to
// search.UsersChannelsSource for the reindex.
type usersChannelsSource struct {
	users    *store.UserStoreImpl
	channels *store.ChannelStoreImpl
}

func (s *usersChannelsSource) ListUsers(ctx context.Context) ([]*model.User, error) {
	return paginate.All(ctx, func(ctx context.Context, cursor string) ([]*model.User, string, error) {
		return s.users.List(ctx, 200, cursor)
	}, 0)
}

func (s *usersChannelsSource) ListChannels(ctx context.Context) ([]*model.Channel, error) {
	return s.channels.ListAll(ctx)
}
