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
	// Filename is a copy of the attachment's name so the Files panel can
	// filter without reading every attachment. Rows are written without it;
	// the first search in the parent fills it in (SetFileIndexName).
	Filename string `dynamodbav:"filename,omitempty"`
}

type ParentIndexStore interface {
	SetPinIndex(ctx context.Context, parentID, msgID, pinnedBy string, pinnedAt time.Time) error
	DeletePinIndex(ctx context.Context, parentID, msgID string) error
	ListPinIndex(ctx context.Context, parentID string) ([]*PinIndexRow, error)

	SetFileIndex(ctx context.Context, parentID, attachmentID, msgID, authorID string, createdAt time.Time) error
	DeleteFileIndex(ctx context.Context, parentID, attachmentID string) error
	ListFileIndex(ctx context.Context, parentID string) ([]*FileIndexRow, error)
	SetFileIndexName(ctx context.Context, parentID, attachmentID, filename string) error
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
	av := mustAttrs(attributevalue.MarshalMap(row))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: set pin index: %w", err)
	}
	return nil
}

// PinIndexEntry and FileIndexEntry describe one pin / file index row for
// SetIndexRows.
type PinIndexEntry struct {
	ParentID, MessageID, PinnedBy string
	PinnedAt                      time.Time
}

type FileIndexEntry struct {
	ParentID, AttachmentID, MessageID, AuthorID string
	CreatedAt                                   time.Time
}

// SetIndexRows writes many pin and file index rows in BatchWriteItem calls.
// Rows are overwritten like SetPinIndex/SetFileIndex; when the same file
// appears more than once, the last entry wins (as sequential SetFileIndex
// calls would).
func (s *ParentIndexStoreImpl) SetIndexRows(ctx context.Context, pins []PinIndexEntry, files []FileIndexEntry) error {
	var items []map[string]types.AttributeValue
	for _, p := range pins {
		items = append(items, mustAttrs(attributevalue.MarshalMap(PinIndexRow{
			PK: parentPK(p.ParentID), SK: pinSK(p.MessageID), ParentID: p.ParentID, MessageID: p.MessageID,
			PinnedBy: p.PinnedBy, PinnedAt: p.PinnedAt,
		})))
	}
	pos := map[string]int{} // PK|SK → index in items (BatchWriteItem rejects duplicate keys)
	for _, f := range files {
		if f.AttachmentID == "" {
			return errors.New("store: set index rows: empty attachmentID")
		}
		row := mustAttrs(attributevalue.MarshalMap(FileIndexRow{
			PK: parentPK(f.ParentID), SK: fileSK(f.AttachmentID), ParentID: f.ParentID, AttachmentID: f.AttachmentID,
			MessageID: f.MessageID, AuthorID: f.AuthorID, CreatedAt: f.CreatedAt,
		}))
		key := parentPK(f.ParentID) + "|" + fileSK(f.AttachmentID)
		if i, ok := pos[key]; ok {
			items[i] = row
			continue
		}
		pos[key] = len(items)
		items = append(items, row)
	}
	if err := s.putAll(ctx, items); err != nil {
		return fmt.Errorf("store: set index rows: %w", err)
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
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
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
			if err := attributevalue.UnmarshalMap(raw, &row); err != nil {
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
	av := mustAttrs(attributevalue.MarshalMap(row))
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

// SetFileIndexName records the attachment's name on its existing index row.
// Only the name is written, so a re-share landing meanwhile keeps its
// message; a row deleted meanwhile stays deleted.
func (s *ParentIndexStoreImpl) SetFileIndexName(ctx context.Context, parentID, attachmentID, filename string) error {
	update := expression.Set(expression.Name("filename"), expression.Value(filename))
	cond := expression.AttributeExists(expression.Name("PK"))
	expr := mustExpr(expression.NewBuilder().WithUpdate(update).WithCondition(cond).Build())
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(parentPK(parentID), fileSK(attachmentID)),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	var gone *types.ConditionalCheckFailedException
	if err != nil && !errors.As(err, &gone) {
		return fmt.Errorf("store: set file index name: %w", err)
	}
	return nil
}

func (s *ParentIndexStoreImpl) ListFileIndex(ctx context.Context, parentID string) ([]*FileIndexRow, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(parentPK(parentID))),
		expression.Key("SK").BeginsWith(fileSKPrefix),
	)
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
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
			if err := attributevalue.UnmarshalMap(raw, &row); err != nil {
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
