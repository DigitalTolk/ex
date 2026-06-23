package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/oklog/ulid/v2"
)

// Common errors returned by store operations.
var (
	ErrNotFound      = errors.New("store: item not found")
	ErrAlreadyExists = errors.New("store: item already exists")
)

// DBConfig holds the configuration for the DynamoDB connection.
type DBConfig struct {
	Region   string
	Endpoint string // optional, for local dev (e.g. http://localhost:8000)
	Table    string
}

// DynamoAPI is the subset of *dynamodb.Client used by the store package. The
// real client satisfies it directly; narrowing to an interface lets tests
// inject a fault-wrapping client to exercise the SDK-error branches that a live
// DynamoDB Local instance never returns on the happy path.
type DynamoAPI interface {
	BatchGetItem(ctx context.Context, params *dynamodb.BatchGetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error)
	BatchWriteItem(ctx context.Context, params *dynamodb.BatchWriteItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error)
	CreateTable(ctx context.Context, params *dynamodb.CreateTableInput, optFns ...func(*dynamodb.Options)) (*dynamodb.CreateTableOutput, error)
	DeleteItem(ctx context.Context, params *dynamodb.DeleteItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
	DescribeTable(ctx context.Context, params *dynamodb.DescribeTableInput, optFns ...func(*dynamodb.Options)) (*dynamodb.DescribeTableOutput, error)
	GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(ctx context.Context, params *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	Query(ctx context.Context, params *dynamodb.QueryInput, optFns ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
	Scan(ctx context.Context, params *dynamodb.ScanInput, optFns ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error)
	TransactWriteItems(ctx context.Context, params *dynamodb.TransactWriteItemsInput, optFns ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error)
	UpdateItem(ctx context.Context, params *dynamodb.UpdateItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
	UpdateTimeToLive(ctx context.Context, params *dynamodb.UpdateTimeToLiveInput, optFns ...func(*dynamodb.Options)) (*dynamodb.UpdateTimeToLiveOutput, error)
}

// DB is the base DynamoDB store that holds the client and table name.
type DB struct {
	Client DynamoAPI
	Table  string
}

// New creates a new DB instance from the given configuration.
func New(ctx context.Context, cfg DBConfig) (*DB, error) {
	opts := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(cfg.Region),
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil { // coverage-ignore: LoadDefaultConfig with only a region fails only on a malformed on-disk AWS config; not reachable in tests
		return nil, fmt.Errorf("store: load aws config: %w", err)
	}

	var clientOpts []func(*dynamodb.Options)
	if cfg.Endpoint != "" {
		clientOpts = append(clientOpts, func(o *dynamodb.Options) {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		})
	}

	client := dynamodb.NewFromConfig(awsCfg, clientOpts...)

	return &DB{
		Client: client,
		Table:  cfg.Table,
	}, nil
}

// EnsureTable creates the DynamoDB table with GSI1 if it does not already exist.
// This is intended for local development only.
func (db *DB) EnsureTable(ctx context.Context) error {
	_, err := db.Client.DescribeTable(ctx, &dynamodb.DescribeTableInput{
		TableName: aws.String(db.Table),
	})
	if err == nil {
		slog.Info("dynamodb table already exists", "table", db.Table)
		return nil
	}

	var notFound *types.ResourceNotFoundException
	if !errors.As(err, &notFound) {
		return fmt.Errorf("store: describe table: %w", err)
	}

	slog.Info("creating dynamodb table", "table", db.Table)

	_, err = db.Client.CreateTable(ctx, &dynamodb.CreateTableInput{
		TableName: aws.String(db.Table),
		KeySchema: []types.KeySchemaElement{
			{AttributeName: aws.String("PK"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("SK"), KeyType: types.KeyTypeRange},
		},
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("PK"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("SK"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("GSI1PK"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("GSI1SK"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("GSI2PK"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("GSI2SK"), AttributeType: types.ScalarAttributeTypeS},
		},
		GlobalSecondaryIndexes: []types.GlobalSecondaryIndex{
			{
				IndexName: aws.String("GSI1"),
				KeySchema: []types.KeySchemaElement{
					{AttributeName: aws.String("GSI1PK"), KeyType: types.KeyTypeHash},
					{AttributeName: aws.String("GSI1SK"), KeyType: types.KeyTypeRange},
				},
				Projection: &types.Projection{
					ProjectionType: types.ProjectionTypeAll,
				},
				ProvisionedThroughput: &types.ProvisionedThroughput{
					ReadCapacityUnits:  aws.Int64(5),
					WriteCapacityUnits: aws.Int64(5),
				},
			},
			{
				IndexName: aws.String("GSI2"),
				KeySchema: []types.KeySchemaElement{
					{AttributeName: aws.String("GSI2PK"), KeyType: types.KeyTypeHash},
					{AttributeName: aws.String("GSI2SK"), KeyType: types.KeyTypeRange},
				},
				Projection: &types.Projection{
					ProjectionType: types.ProjectionTypeAll,
				},
				ProvisionedThroughput: &types.ProvisionedThroughput{
					ReadCapacityUnits:  aws.Int64(5),
					WriteCapacityUnits: aws.Int64(5),
				},
			},
		},
		ProvisionedThroughput: &types.ProvisionedThroughput{
			ReadCapacityUnits:  aws.Int64(5),
			WriteCapacityUnits: aws.Int64(5),
		},
	})
	if err != nil {
		return fmt.Errorf("store: create table: %w", err)
	}

	// Wait for the table to become active.
	waiter := dynamodb.NewTableExistsWaiter(db.Client)
	if err := waiter.Wait(ctx, &dynamodb.DescribeTableInput{
		TableName: aws.String(db.Table),
	}, 2*time.Minute); err != nil { // coverage-ignore: dev-only table bootstrap; table-never-active is an infra timeout, not reachable against a healthy local instance
		return fmt.Errorf("store: wait for table: %w", err)
	}

	// Enable TTL on the table.
	_, err = db.Client.UpdateTimeToLive(ctx, &dynamodb.UpdateTimeToLiveInput{
		TableName: aws.String(db.Table),
		TimeToLiveSpecification: &types.TimeToLiveSpecification{
			AttributeName: aws.String("ttl"),
			Enabled:       aws.Bool(true),
		},
	})
	if err != nil {
		slog.Warn("failed to enable TTL (may not be supported locally)", "error", err)
	}

	slog.Info("dynamodb table created", "table", db.Table)
	return nil
}

// NewID generates a new ULID suitable for use as an entity identifier.
// ULIDs are time-ordered and lexicographically sortable.
func NewID() string {
	return ulid.MustNew(ulid.Timestamp(time.Now()), rand.Reader).String()
}

// DeriveID produces a deterministic ULID from a seed string by hashing it
// with SHA-256. Used for singleton or canonical entities (e.g. the #general
// channel, DM conversations) so all instances agree on the ID without
// coordination.
func DeriveID(seed string) string {
	h := sha256.Sum256([]byte(seed))
	var id ulid.ULID
	_ = id.SetTime(binary.BigEndian.Uint64(append([]byte{0, 0}, h[:6]...)) >> 16)
	_ = id.SetEntropy(h[6:16])
	return id.String()
}

// Key builder helpers.

func userPK(id string) string { return "USER#" + id }
func userEmailPK(email string) string {
	return "USEREMAIL#" + strings.ToLower(strings.TrimSpace(email))
}
func channelPK(id string) string   { return "CHAN#" + id }
func convPK(id string) string      { return "CONV#" + id }
func invitePK(token string) string { return "INVITE#" + token }
func rtokenPK(hash string) string  { return "RTOKEN#" + hash }

func profileSK() string              { return "PROFILE" }
func metaSK() string                 { return "META" }
func memberSK(userID string) string  { return "MEMBER#" + userID }
func msgSK(msgID string) string      { return "MSG#" + msgID }
func chanSK(channelID string) string { return "CHAN#" + channelID }
func convSK(convID string) string    { return "CONV#" + convID }

func chanNameGSI1PK(name string) string { return "CHANNAME#" + name }
func chanSlugGSI1PK(slug string) string { return "CHANSLUG#" + slug }
func chanGSI1SK(id string) string       { return "CHAN#" + id }

func publicChanGSI2PK() string { return "PUBLIC_CHANNELS" }
func allUsersGSI2PK() string   { return "ALL_USERS" }

// settingsPK is the singleton key for workspace-wide configuration.
// One record exists at (settingsPK, settingsSK) — written by admins via
// the admin endpoint and read on every upload to enforce limits.
func settingsPK() string { return "SETTINGS" }
func settingsSK() string { return "WORKSPACE" }

// User-defined sidebar categories: rows live under the user's PK so a
// single Query returns every category the user owns.
func categorySK(id string) string { return "CATEGORY#" + id }
func threadFollowSK(parentID, threadRootID string) string {
	return "THREAD#" + parentID + "#" + threadRootID
}
func threadFollowGSI1PK(parentID, threadRootID string) string {
	return "THREADFOLLOW#" + parentID + "#" + threadRootID
}

// threadGSI1PK indexes a thread's replies under GSI1 so the whole thread can be
// fetched with one Query instead of scanning the parent's message partition.
// threadRootID is a globally-unique message ULID, so it alone identifies the
// thread. Only reply rows (ParentMessageID != "") carry this key.
func threadGSI1PK(threadRootID string) string { return "THREAD#" + threadRootID }
func userStateSK(kind, targetID string) string { return "STATE#" + kind + "#" + targetID }
func webhookPK(id string) string               { return "WEBHOOK#" + id }
func webhookSK() string                        { return "META" }

func categoryNameSK(name string) string {
	return "CATEGORYNAME#" + strings.ToLower(strings.TrimSpace(name))
}
