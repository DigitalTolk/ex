package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/searchaccess"
	"github.com/DigitalTolk/ex/internal/store"
)

// searchSystem is OpenSearch-backed search. client is nil when search is not
// configured: indexers and searchers then degrade to no-ops.
type searchSystem struct {
	client    *search.Client
	reindexer *search.Reindexer
	// mappingRebuilder is nil without a search client.
	mappingRebuilder *search.MappingRebuilder
	searcher         search.Searcher
	access           *searchaccess.Access
}

func (a *App) buildSearch(ctx context.Context) error {
	cfg, in, c, s := a.cfg, &a.infra, &a.chat, &a.search

	// NewClientFromConfig returns nil for an empty URL. Setting
	// OPENSEARCH_AWS_REGION switches to a SigV4-signing client backed by the
	// SDK's default credential chain — that's the IAM-role path on AWS-hosted
	// deployments (managed OpenSearch / Serverless). The same constructor
	// drives the migrate CLI so the wiring can't drift.
	client, err := search.NewClientFromConfig(ctx, search.ClientConfig{
		URL:        cfg.OpenSearchURL,
		AWSRegion:  cfg.OpenSearchAWSRegion,
		AWSService: cfg.OpenSearchAWSService,
	})
	if err != nil {
		return fmt.Errorf("failed to init OpenSearch client: %w", err)
	}
	s.client = client
	if client != nil {
		if err := client.EnsureIndices(ctx); err != nil {
			slog.Warn("search: ensure indices failed", "error", err)
		}
		sources := newReindexSources(in.users, in.channels, in.conversations, in.messages)
		// Reindex + mapping-rebuild progress is persisted durably in DynamoDB
		// (like workspace settings) so it survives the process that ran the
		// job and every instance's admin panel shows the same state. The
		// mapping rebuild keeps its Redis lock for single-runner election;
		// only the status blob lives in Dynamo.
		status := store.NewSearchStatusStore(in.db)
		// Both are non-nil with a client: every other argument is set here.
		s.reindexer = search.NewReindexer(client, sources, status)
		s.reindexer.SetAttachmentResolver(newAttachmentResolver(in.attachments))
		// The users/channels mapping rebuild (staging + alias-swap) is
		// coordinated through Redis: a distributed lock elects one runner so
		// N parallel containers can't double-run it, and the status lives in
		// Redis so the admin button is consistent cluster-wide. store.NewID
		// mints a unique lock token per run for the token-fenced release.
		s.mappingRebuilder = search.NewMappingRebuilder(client, sources, in.cache, status, store.NewID)

		// A non-nil client always yields the live indexer.
		idx := search.NewIndexer(client).(*search.LiveIndexer)
		idx.SetAttachmentResolver(newAttachmentResolver(in.attachments))
		c.messages.SetIndexer(idx)
		c.channels.SetIndexer(idx)
		c.users.SetIndexer(idx)
		c.auth.SetIndexer(idx)
		// Shared agent users are created through the agent store, which never
		// went through UserService — so without this they never reached the
		// index and could not be found in the DM composer.
		a.agents.svc.SetIndexer(idx)
	}
	s.searcher = search.NewService(client)
	s.access = searchaccess.New(in.memberships, in.conversations)
	if client != nil {
		ids := newIDSearcher(s.searcher)
		c.users.SetSearcher(ids)
		c.channels.SetSearcher(ids)
	}
	return nil
}

// staleRebuilder is the mapping rebuild's boot-time staleness check.
type staleRebuilder interface {
	StartIfStale(ctx context.Context, now func() int64) (bool, error)
}

// autoMappingRebuild auto-rolls the users/channels mapping rebuild if the live
// index generation is behind this binary's (a schema/analyzer bump, a fresh
// empty index, or a pre-versioning upgrade). Run detached so boot never
// blocks — search stays up on the old analyzer for the few seconds a rebuild
// takes. StartIfStale's Redis lock elects one runner, so all instances
// kicking this off at once converge without double-running the alias-swap.
func autoMappingRebuild(ctx context.Context, reb staleRebuilder) {
	defer safe.Recover()
	switch started, err := reb.StartIfStale(ctx, func() int64 { return time.Now().Unix() }); {
	case err != nil:
		slog.Warn("search: auto mapping-rebuild staleness check failed", "error", err)
	case started:
		slog.Info("search: users/channels index stale — auto mapping-rebuild started")
	}
}
