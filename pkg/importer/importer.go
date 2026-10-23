// Package importer writes conversation history from another chat system —
// users, channels, direct and group conversations, memberships, messages,
// threads, reactions, pins and file attachments — straight into ex's store.
//
// Contract: the importer is built only on the storage layers (internal/store,
// internal/storage, internal/search, internal/cache), never on internal/service.
// Nothing it does publishes WebSocket events, sends notifications or mobile
// pushes, bumps alerted-unread badges, records activity, or starts agent runs:
// imported history arrives silently and already read. Callers supply
// deterministic IDs (message IDs are ULIDs whose time is the message's original
// creation time, so imported messages interleave correctly with existing ones),
// which makes every write idempotent — re-running any call after a crash is
// safe and never duplicates data.
//
// Ordering: users before anything that references them; channels and
// conversations before their members and messages; attachments before the
// messages that carry them; messages of a parent before FinalizeParent and
// IndexParent for that parent. Calls for different parents are independent
// and may run concurrently; calls for the same parent must be serialized
// (PutMessages writes message rows in batches, unconditionally, right after
// its existence check).
package importer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
)

// Options are the connection settings Open uses. DynamoDBTable and S3Bucket
// are required; everything else is optional (empty endpoints mean AWS
// defaults, empty search/Redis settings disable those integrations).
type Options struct {
	AWSRegion        string
	DynamoDBTable    string
	DynamoDBEndpoint string

	S3Bucket    string
	S3Region    string
	S3Endpoint  string
	S3AccessKey string
	S3SecretKey string

	OpenSearchURL       string
	OpenSearchAWSRegion string // set to sign requests with SigV4 (AWS-managed domains)

	RedisURL string

	// TempDir holds attachment bodies while they are hashed before upload
	// (empty = the OS temp dir).
	TempDir string
}

// ObjectStore is the object storage holding attachment bodies: uploads,
// existence checks (validation) and deletes (rollback).
type ObjectStore interface {
	PutChecksummedObject(ctx context.Context, key, contentType string, body io.ReadSeeker, size int64, sha256Hex string) (string, error)
	HeadObject(ctx context.Context, key string) (bool, error)
	DeleteObject(ctx context.Context, key string) error
}

// SearchIndex is the search integration: per-document upserts for users and
// channels, bulk writes for a parent's messages and files, and deletes for
// tombstoned messages.
type SearchIndex interface {
	search.BulkWriter
	DeleteDoc(ctx context.Context, index, id string) error
}

// UserCache drops cached user records after users are written.
type UserCache interface {
	DeleteUsers(ctx context.Context, userIDs []string) error
}

// AudienceInvalidator moves the notification audience generations of the
// channels whose memberships an import changed (cache.RedisCache is one), so
// every running ex instance alerts the new audience from its very next message
// instead of a member list it cached before the import.
type AudienceInvalidator interface {
	ChannelAudiencesChanged(ctx context.Context, channelIDs ...string) error
}

// Deps are the importer's collaborators. DB is required; Objects is required
// for PutAttachment; Search, Indexer, Cache and Audiences are optional.
// Without Audiences, running ex instances may keep alerting a channel's
// pre-import members for as long as they cache an audience (two minutes).
type Deps struct {
	DB        *store.DB
	Objects   ObjectStore
	Search    SearchIndex
	Indexer   search.Indexer
	Cache     UserCache
	Audiences AudienceInvalidator
	TempDir   string
	// closer releases connections opened by Open.
	closer func() error
}

// Importer writes history into ex. Safe for concurrent use.
type Importer struct {
	users         *store.UserStoreImpl
	channels      *store.ChannelStoreImpl
	memberships   *store.MembershipStoreImpl
	conversations *store.ConversationStoreImpl
	messages      *store.MessageStoreImpl
	attachments   *store.AttachmentStoreImpl
	parentIndex   *store.ParentIndexStoreImpl
	follows       *store.ThreadFollowStoreImpl

	objects   ObjectStore
	search    SearchIndex
	indexer   search.Indexer
	cache     UserCache
	audiences AudienceInvalidator
	tempDir   string
	closer    func() error
}

// ErrNoObjectStore is returned by PutAttachment when no object store is set.
var ErrNoObjectStore = errors.New("importer: no object store configured")

// New builds an importer from explicit collaborators (tests, custom wiring).
func New(d Deps) (*Importer, error) {
	if d.DB == nil {
		return nil, errors.New("importer: DB is required")
	}
	indexer := d.Indexer
	if indexer == nil {
		indexer = search.NoopIndexer{}
	}
	return &Importer{
		users:         store.NewUserStore(d.DB),
		channels:      store.NewChannelStore(d.DB),
		memberships:   store.NewMembershipStore(d.DB),
		conversations: store.NewConversationStore(d.DB),
		messages:      store.NewMessageStore(d.DB),
		attachments:   store.NewAttachmentStore(d.DB),
		parentIndex:   store.NewParentIndexStore(d.DB),
		follows:       store.NewThreadFollowStore(d.DB),
		objects:       d.Objects,
		search:        d.Search,
		indexer:       indexer,
		cache:         d.Cache,
		audiences:     d.Audiences,
		tempDir:       d.TempDir,
		closer:        d.closer,
	}, nil
}

// Constructor seams, swapped in tests to reach the connection-error arms.
var (
	newDB     = store.New
	newS3     = storage.NewS3Client
	newSearch = search.NewClientFromConfig
	newCache  = cache.NewRedisCache
)

// Open connects to ex's storage with the given settings.
func Open(ctx context.Context, o Options) (*Importer, error) {
	if o.DynamoDBTable == "" || o.S3Bucket == "" {
		return nil, errors.New("importer: DynamoDBTable and S3Bucket are required")
	}
	db, err := newDB(ctx, store.DBConfig{Region: o.AWSRegion, Endpoint: o.DynamoDBEndpoint, Table: o.DynamoDBTable})
	if err != nil {
		return nil, fmt.Errorf("importer: dynamodb: %w", err)
	}
	s3Region := o.S3Region
	if s3Region == "" {
		s3Region = o.AWSRegion
	}
	objects, err := newS3(ctx, storage.S3Config{Endpoint: o.S3Endpoint, Bucket: o.S3Bucket, AccessKey: o.S3AccessKey, SecretKey: o.S3SecretKey, Region: s3Region})
	if err != nil {
		return nil, fmt.Errorf("importer: s3: %w", err)
	}
	d := Deps{DB: db, Objects: objects, TempDir: o.TempDir}
	if o.OpenSearchURL != "" {
		client, err := newSearch(ctx, search.ClientConfig{URL: o.OpenSearchURL, AWSRegion: o.OpenSearchAWSRegion})
		if err != nil {
			return nil, fmt.Errorf("importer: opensearch: %w", err)
		}
		d.Search = client
		d.Indexer = search.NewIndexer(client)
	}
	if o.RedisURL != "" {
		c, err := newCache(o.RedisURL)
		if err != nil {
			return nil, fmt.Errorf("importer: redis: %w", err)
		}
		d.Cache = c
		d.Audiences = c
		d.closer = c.Client().Close
	}
	return New(d)
}

// Close releases connections opened by Open.
func (im *Importer) Close() error {
	if im.closer == nil {
		return nil
	}
	return im.closer()
}

// tempFile is a seam over os.CreateTemp.
var tempFile = os.CreateTemp
