package store

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// SearchStatusStore persists the durable state of a long-running search job
// (reindex, mapping-rebuild) as a singleton-per-job record, so the admin panel
// reflects the same progress on every instance and it survives the process that
// started the run — the same reason workspace settings live in DynamoDB rather
// than process memory or Redis. Keyed by an opaque `job` string; the caller owns
// the status shape (any struct with `dynamodbav` tags).
type SearchStatusStore interface {
	// GetSearchStatus loads the job's stored status into dest. `found` is false
	// (dest untouched) when no run has ever been recorded for that job.
	GetSearchStatus(ctx context.Context, job string, dest any) (found bool, err error)
	// PutSearchStatus overwrites the job's status record (single row per job).
	PutSearchStatus(ctx context.Context, job string, val any) error
}

// SearchStatusStoreImpl is the DynamoDB-backed implementation.
type SearchStatusStoreImpl struct {
	*DB
}

var _ SearchStatusStore = (*SearchStatusStoreImpl)(nil)

// NewSearchStatusStore returns a SearchStatusStoreImpl.
func NewSearchStatusStore(db *DB) *SearchStatusStoreImpl {
	return &SearchStatusStoreImpl{DB: db}
}

// searchStatusPK is the shared partition for all search-job status singletons;
// the job name is the sort key, so each job is one overwritten-in-place row.
func searchStatusPK() string { return "SEARCH_JOB" }

// GetSearchStatus reads the job's status row and unmarshals the status fields
// into dest. The PK/SK attributes have no matching dest fields and are ignored.
func (s *SearchStatusStoreImpl) GetSearchStatus(ctx context.Context, job string, dest any) (bool, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(searchStatusPK(), job),
	})
	if err != nil {
		return false, fmt.Errorf("store: get search status %q: %w", job, err)
	}
	if out.Item == nil {
		return false, nil
	}
	if err := attributevalue.UnmarshalMap(out.Item, dest); err != nil { // coverage-ignore: round-trip of an item this store wrote into a matching status struct; cannot fail.
		return false, fmt.Errorf("store: unmarshal search status %q: %w", job, err)
	}
	return true, nil
}

// PutSearchStatus marshals the status value, stamps the singleton key, and
// overwrites the row. A blind put (no condition): the run's own writes are
// serialized by its coordination (Redis lock for mapping-rebuild, in-process
// mutex for reindex), and the last write is the freshest.
func (s *SearchStatusStoreImpl) PutSearchStatus(ctx context.Context, job string, val any) error {
	av, err := attributevalue.MarshalMap(val)
	if err != nil { // coverage-ignore: the status values are flat scalar structs; MarshalMap cannot fail.
		return fmt.Errorf("store: marshal search status %q: %w", job, err)
	}
	av["PK"] = &types.AttributeValueMemberS{Value: searchStatusPK()}
	av["SK"] = &types.AttributeValueMemberS{Value: job}
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: put search status %q: %w", job, err)
	}
	return nil
}
