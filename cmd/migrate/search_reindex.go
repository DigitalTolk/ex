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

// runSearchReindex drops and recreates the ex_users and ex_channels
// OpenSearch indices with the CURRENT mapping (the edge-ngram
// `autocomplete` analyzer) and bulk-reindexes them from DynamoDB. This is
// how a mapping/analyzer change rolls onto an EXISTING cluster —
// EnsureIndices only creates an absent index, so an analyzer change needs
// a fresh mapping. Recreating from scratch also drops orphaned ghost docs
// (users/channels deleted directly from DynamoDB and never de-indexed).
//
// Idempotent: re-running produces the same end state. Defaults to
// --dry-run (reports the counts it WOULD reindex without touching
// OpenSearch); pass --apply to recreate + write.
func runSearchReindex(ctx context.Context, db *store.DB, args []string) int {
	dryRun, _, mode := migrateFlags("search-reindex", args, nil)

	cfg, err := config.Load()
	if err != nil {
		fatal("config load failed", err)
	}
	client, err := buildSearchClient(ctx, cfg)
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

	if dryRun {
		users, uerr := src.ListUsers(ctx)
		if uerr != nil {
			fatal("list users", uerr)
		}
		channels, cerr := src.ListChannels(ctx)
		if cerr != nil {
			fatal("list channels", cerr)
		}
		slog.Info("search-reindex dry-run: would recreate + reindex",
			"users", len(users), "channels", len(channels))
		return 0
	}

	users, channels, err := search.RecreateUsersChannels(ctx, client, src)
	if err != nil {
		fatal("search reindex", err)
	}
	slog.Info("search-reindex complete", "users", users, "channels", channels)
	return 0
}

// buildSearchClient mirrors the server's OpenSearch wiring: SigV4-signed
// client when an AWS region is configured, plain client otherwise, nil
// when no URL is set.
func buildSearchClient(ctx context.Context, cfg *config.Config) (*search.Client, error) {
	if cfg.OpenSearchAWSRegion != "" {
		return search.NewAWSClient(ctx, cfg.OpenSearchURL, search.AWSSigning{
			Region:  cfg.OpenSearchAWSRegion,
			Service: cfg.OpenSearchAWSService,
		})
	}
	return search.NewClient(cfg.OpenSearchURL), nil
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
