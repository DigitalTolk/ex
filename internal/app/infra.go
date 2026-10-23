package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/eventlog"
	"github.com/DigitalTolk/ex/internal/handler"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
)

// infra is what every subsystem builds on: the data stores, Redis, auth
// primitives, object storage and the real-time broker.
type infra struct {
	db     *store.DB
	cache  *cache.RedisCache
	pubsub *pubsub.RedisPubSub
	broker *pubsub.Broker
	inbox  *eventlog.Stream
	jwt    *auth.JWTManager
	oidc   service.OIDCProvider
	// s3 is nil when object storage is unavailable (uploads disabled).
	s3 *storage.S3Client

	users         *store.UserStoreImpl
	channels      *store.ChannelStoreImpl
	memberships   *store.MembershipStoreImpl
	conversations *store.ConversationStoreImpl
	messages      *store.MessageStoreImpl
	threadFollows *store.ThreadFollowStoreImpl
	parentIndex   *handler.ParentIndexAdapter
	userState     *store.UserStateStoreImpl
	invites       *store.InviteStoreImpl
	tokens        *store.TokenStoreImpl
	emojis        *store.EmojiStoreImpl
	attachments   *store.AttachmentStoreImpl
}

// Seams over the infrastructure constructors whose failure arms a test cannot
// otherwise reach (the pub/sub client dials the same Redis the cache just
// reached; S3 fails only on an AWS config load).
var (
	newRedisPubSub = pubsub.NewRedisPubSub
	newS3Client    = storage.NewS3Client
)

func (a *App) buildInfra(ctx context.Context) error {
	cfg := a.cfg
	in := &a.infra

	// ------------------------------------------------------------- DynamoDB
	db, err := store.New(ctx, store.DBConfig{
		Region:   cfg.AWSRegion,
		Endpoint: cfg.DynamoDBEndpoint,
		Table:    cfg.DynamoDBTable,
	})
	if err != nil {
		return fmt.Errorf("failed to init DynamoDB: %w", err)
	}
	if cfg.IsDev() {
		if err := db.EnsureTable(ctx); err != nil {
			return fmt.Errorf("failed to ensure DynamoDB table: %w", err)
		}
	}
	// Outside development the table is provisioned elsewhere, so TTL
	// enablement is an ASSUMPTION — assert it at boot rather than discovering
	// years of unexpired runner/claim/follow rows later.
	db.CheckTTL(ctx)
	in.db = db

	// ------------------------------------------------------------- Redis
	if in.cache, err = cache.NewRedisCache(cfg.RedisURL); err != nil {
		return fmt.Errorf("failed to init Redis cache: %w", err)
	}
	if in.pubsub, err = newRedisPubSub(cfg.RedisURL); err != nil {
		return fmt.Errorf("failed to init Redis pub/sub: %w", err)
	}

	// ------------------------------------------------------------- Stores
	// The impls satisfy the service interfaces directly.
	in.users = store.NewUserStore(db)
	in.channels = store.NewChannelStore(db)
	in.memberships = store.NewMembershipStore(db)
	in.conversations = store.NewConversationStore(db)
	in.messages = store.NewMessageStore(db)
	in.threadFollows = store.NewThreadFollowStore(db)
	in.parentIndex = handler.NewParentIndexAdapter(store.NewParentIndexStore(db))
	in.userState = store.NewUserStateStore(db)
	in.invites = store.NewInviteStore(db)
	in.tokens = store.NewTokenStore(db)
	// One-time background backfill of the per-user token partition (GSI1):
	// once the seeded marker lands, account deactivation revokes tokens with
	// a Query instead of a full-table Scan. Idempotent and concurrency-safe,
	// so every instance may attempt it; failures just retry on next boot.
	safe.Go(a.track(func() { backfillTokenIndex(in.tokens) }))
	in.emojis = store.NewEmojiStore(db)
	in.attachments = store.NewAttachmentStore(db)

	// ------------------------------------------------------------- Auth
	in.jwt = auth.NewJWTManager(cfg.JWTSecret, cfg.JWTAccessTTL, cfg.JWTRefreshTTL)
	if in.oidc, err = newOIDC(ctx, cfg); err != nil {
		return err
	}

	// ------------------------------------------------------------- S3
	in.s3 = newObjectStorage(ctx, cfg)

	// ------------------------------------------------------------- Durable event log
	// Per-user inbox streams for WS replay-on-reconnect: Redis Streams hold
	// each user's recent events with MAXLEN trimming; the WS handshake
	// replays anything newer than the client's cursor. AOF is optional — on
	// Redis loss every client just gets a replay.exhausted frame and falls
	// back to the existing refetch path.
	in.inbox = eventlog.NewStream(in.pubsub.Client(), 0)
	recipients := eventlog.NewResolver(
		handler.NewMembershipMemberLister(in.memberships.ListMembers),
		handler.NewConversationParticipantLister(in.conversations.GetConversation),
	)
	// Cache topic→recipient lists for a few seconds so the durable-inbox
	// fan-out doesn't re-query DynamoDB membership on every persistent event.
	// Bounded staleness; live delivery (broker subscription) stays correct on
	// join/leave.
	recipients.SetCacheTTL(10 * time.Second)
	in.pubsub.SetDurability(recipients, in.inbox)

	// ------------------------------------------------------------- Broker
	in.broker = pubsub.NewBroker(in.pubsub)
	a.onClose(func() { _ = in.broker.Close() })
	return nil
}

// tokenIndexer is the token store's one-time per-user index backfill.
type tokenIndexer interface {
	EnsureUserTokenIndex(ctx context.Context) error
}

// backfillTokenIndex runs the per-user token index backfill, bounded; a
// failure only leaves deactivation on its scan path until the next boot.
func backfillTokenIndex(tokens tokenIndexer) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := tokens.EnsureUserTokenIndex(ctx); err != nil {
		slog.Warn("token index backfill failed (deactivation falls back to the scan path)", "error", err)
	}
}

// newOIDC connects the SSO provider when OIDC_ISSUER is set (nil otherwise:
// guest login only). A configured issuer that cannot be discovered fails the
// boot.
func newOIDC(ctx context.Context, cfg *config.Config) (service.OIDCProvider, error) {
	if cfg.OIDCIssuer == "" {
		return nil, nil
	}
	p, err := auth.NewOIDCProvider(ctx, cfg.OIDCIssuer, cfg.OIDCClientID, cfg.OIDCClientSecret, cfg.OIDCRedirectURL())
	if err != nil {
		return nil, fmt.Errorf("failed to init OIDC provider: %w", err)
	}
	return handler.NewOIDCAdapter(p), nil
}

// newObjectStorage connects S3 when ANY S3 setting is in play: a custom
// endpoint (minio in dev), an explicit access key (CI / static creds), or just
// a bucket name (the AWS-prod path with role-based credentials, where neither
// endpoint nor static keys are set). Unavailable storage is not fatal: it
// returns nil and uploads are disabled.
func newObjectStorage(ctx context.Context, cfg *config.Config) *storage.S3Client {
	if cfg.S3Endpoint == "" && cfg.S3AccessKey == "" && cfg.S3Bucket == "" {
		return nil
	}
	c, err := newS3Client(ctx, storage.S3Config{
		Endpoint:       cfg.S3Endpoint,
		PublicEndpoint: cfg.S3PublicEndpoint,
		Bucket:         cfg.S3Bucket,
		AccessKey:      cfg.S3AccessKey,
		SecretKey:      cfg.S3SecretKey,
		Region:         cfg.S3Region,
	})
	if err != nil {
		slog.Warn("S3 not available, avatar uploads disabled", "error", err)
		return nil
	}
	return c
}
