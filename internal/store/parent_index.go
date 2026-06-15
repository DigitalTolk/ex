package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ParentIndex covers two read-time indexes that previously required a
// full scan of the parent's messages: pinned messages and shared
// attachments. Both indexes live in the same partition as their parent
// (PK=parentPK, SK=PIN#<msgID> or FILE#<attID>) so a single Query
// returns just the rows of interest — no GSI needed.
//
// Lifetime:
//   - PinIndexRow is created on Pin and deleted on Unpin or message-
//     delete. ListPin returns rows in insertion-order (the SK encodes
//     the message ID, which is a ULID — already sortable).
//   - FileIndexRow is upserted on every message send/edit that
//     references the attachment, so the row's metadata always tracks
//     the most-recent share. It's deleted when the only message that
//     ever referenced it is deleted (caller's responsibility).
//
// Both row types are kept in addition to the existing per-message
// `Pinned` flag and `AttachmentIDs` list — those still drive the
// authoritative message renderer; the index just makes the
// "list pinned" / "list files" sidebar UIs O(pinned/file) instead of
// O(messages).

const (
	pinSKPrefix  = "PIN#"
	fileSKPrefix = "FILE#"
)

func pinSK(msgID string) string  { return pinSKPrefix + msgID }
func fileSK(attID string) string { return fileSKPrefix + attID }

// PinIndexRow captures the audit info for a pinned message. The
// MessageID always equals the trailing component of SK (PIN#<msgID>);
// it's stored as an attribute too so callers don't have to parse SK.
type PinIndexRow struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`

	ParentID  string    `dynamodbav:"parent_id"`
	MessageID string    `dynamodbav:"message_id"`
	PinnedBy  string    `dynamodbav:"pinned_by"`
	PinnedAt  time.Time `dynamodbav:"pinned_at"`
}

// FileIndexRow points to the latest message that shared the
// attachment in this parent. AttachmentID is the SHA-derived dedupe
// key used by AttachmentService — the same content always resolves to
// the same ID, so SK collisions across messages collapse to a single
// row per shared file (the desired ListFiles semantics).
type FileIndexRow struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`

	ParentID     string    `dynamodbav:"parent_id"`
	AttachmentID string    `dynamodbav:"attachment_id"`
	MessageID    string    `dynamodbav:"message_id"`
	AuthorID     string    `dynamodbav:"author_id"`
	CreatedAt    time.Time `dynamodbav:"created_at"`
}

type ParentIndexStore interface {
	SetPinIndex(ctx context.Context, parentID, msgID, pinnedBy string, pinnedAt time.Time) error
	DeletePinIndex(ctx context.Context, parentID, msgID string) error
	ListPinIndex(ctx context.Context, parentID string) ([]*PinIndexRow, error)

	SetFileIndex(ctx context.Context, parentID, attachmentID, msgID, authorID string, createdAt time.Time) error
	DeleteFileIndex(ctx context.Context, parentID, attachmentID string) error
	ListFileIndex(ctx context.Context, parentID string) ([]*FileIndexRow, error)
}

type ParentIndexStoreImpl struct {
	*DB
}

var _ ParentIndexStore = (*ParentIndexStoreImpl)(nil)

func NewParentIndexStore(db *DB) *ParentIndexStoreImpl {
	return &ParentIndexStoreImpl{DB: db}
}

func (s *ParentIndexStoreImpl) SetPinIndex(ctx context.Context, parentID, msgID, pinnedBy string, pinnedAt time.Time) error {
	row := PinIndexRow{
		PK:        parentPK(parentID),
		SK:        pinSK(msgID),
		ParentID:  parentID,
		MessageID: msgID,
		PinnedBy:  pinnedBy,
		PinnedAt:  pinnedAt,
	}
	av, err := attributevalue.MarshalMap(row)
	if err != nil { // coverage-ignore: PinIndexRow has only string/time fields; MarshalMap cannot fail
		return fmt.Errorf("store: marshal pin index: %w", err)
	}
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: set pin index: %w", err)
	}
	return nil
}

func (s *ParentIndexStoreImpl) DeletePinIndex(ctx context.Context, parentID, msgID string) error {
	if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(parentPK(parentID), pinSK(msgID)),
	}); err != nil {
		return fmt.Errorf("store: delete pin index: %w", err)
	}
	return nil
}

func (s *ParentIndexStoreImpl) ListPinIndex(ctx context.Context, parentID string) ([]*PinIndexRow, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(parentPK(parentID))),
		expression.Key("SK").BeginsWith(pinSKPrefix),
	)
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil { // coverage-ignore: static key-condition built from constants; Build cannot fail
		return nil, fmt.Errorf("store: build pin index expression: %w", err)
	}
	out := make([]*PinIndexRow, 0)
	var startKey map[string]types.AttributeValue
	for {
		page, err := s.Client.Query(ctx, &dynamodb.QueryInput{
			TableName:                 aws.String(s.Table),
			KeyConditionExpression:    expr.KeyCondition(),
			ExpressionAttributeNames:  expr.Names(),
			ExpressionAttributeValues: expr.Values(),
			ScanIndexForward:          aws.Bool(false), // newest msgIDs first (ULIDs sort lexicographically by time)
			ExclusiveStartKey:         startKey,
		})
		if err != nil {
			return nil, fmt.Errorf("store: list pin index: %w", err)
		}
		for _, raw := range page.Items {
			var row PinIndexRow
			if err := attributevalue.UnmarshalMap(raw, &row); err != nil { // coverage-ignore: round-trip of items this store wrote; cannot fail
				return nil, fmt.Errorf("store: unmarshal pin index: %w", err)
			}
			out = append(out, &row)
		}
		if len(page.LastEvaluatedKey) == 0 {
			break
		}
		startKey = page.LastEvaluatedKey
	}
	return out, nil
}

func (s *ParentIndexStoreImpl) SetFileIndex(ctx context.Context, parentID, attachmentID, msgID, authorID string, createdAt time.Time) error {
	if attachmentID == "" {
		return errors.New("store: set file index: empty attachmentID")
	}
	row := FileIndexRow{
		PK:           parentPK(parentID),
		SK:           fileSK(attachmentID),
		ParentID:     parentID,
		AttachmentID: attachmentID,
		MessageID:    msgID,
		AuthorID:     authorID,
		CreatedAt:    createdAt,
	}
	av, err := attributevalue.MarshalMap(row)
	if err != nil { // coverage-ignore: FileIndexRow has only string/time fields; MarshalMap cannot fail
		return fmt.Errorf("store: marshal file index: %w", err)
	}
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: set file index: %w", err)
	}
	return nil
}

func (s *ParentIndexStoreImpl) DeleteFileIndex(ctx context.Context, parentID, attachmentID string) error {
	if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(parentPK(parentID), fileSK(attachmentID)),
	}); err != nil {
		return fmt.Errorf("store: delete file index: %w", err)
	}
	return nil
}

func (s *ParentIndexStoreImpl) ListFileIndex(ctx context.Context, parentID string) ([]*FileIndexRow, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(parentPK(parentID))),
		expression.Key("SK").BeginsWith(fileSKPrefix),
	)
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil { // coverage-ignore: static key-condition built from constants; Build cannot fail
		return nil, fmt.Errorf("store: build file index expression: %w", err)
	}
	out := make([]*FileIndexRow, 0)
	var startKey map[string]types.AttributeValue
	for {
		page, err := s.Client.Query(ctx, &dynamodb.QueryInput{
			TableName:                 aws.String(s.Table),
			KeyConditionExpression:    expr.KeyCondition(),
			ExpressionAttributeNames:  expr.Names(),
			ExpressionAttributeValues: expr.Values(),
			ExclusiveStartKey:         startKey,
		})
		if err != nil {
			return nil, fmt.Errorf("store: list file index: %w", err)
		}
		for _, raw := range page.Items {
			var row FileIndexRow
			if err := attributevalue.UnmarshalMap(raw, &row); err != nil { // coverage-ignore: round-trip of items this store wrote; cannot fail
				return nil, fmt.Errorf("store: unmarshal file index: %w", err)
			}
			out = append(out, &row)
		}
		if len(page.LastEvaluatedKey) == 0 {
			break
		}
		startKey = page.LastEvaluatedKey
	}
	return out, nil
}

