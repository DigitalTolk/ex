package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/oklog/ulid/v2"
)

// ReadWatermarkID returns a ULID that sorts after every message ID minted at
// or before t (max entropy for t's millisecond). A "mark everything read"
// request doesn't know the newest message's ID, so it stamps this as the
// LastReadMsgID instead — the client places its "New" divider by comparing
// message IDs against it, and IDs compare in the same order the list is
// sorted in.
func ReadWatermarkID(t time.Time) string {
	var id ulid.ULID
	_ = id.SetTime(ulid.Timestamp(t))
	for i := 6; i < len(id); i++ {
		id[i] = 0xFF
	}
	return id.String()
}

// ErrStaleReadPoint reports that a read-point write was a no-op because the
// stored point is already at or past it (a stale tab, a reordered detached
// write). Callers treat it as success but must not announce the read — the
// announced numbers would describe a point that was never stored.
var ErrStaleReadPoint = errors.New("store: read point already past")

// readPointAttempt is one conditional write of setReadPoint.
type readPointAttempt struct {
	upd  expression.UpdateBuilder
	cond expression.ConditionBuilder
}

// setReadPoint is the forward-only last-read write shared by the channel
// (membership store) and conversation user-side rows. It stamps lastReadSeq
// (+ lastReadMsgID when given) and clears the alerted-message badge, never
// moving either field backwards.
//
// The SEQ is the order that counts (unread = MessageSeq - lastReadSeq): a
// higher seq always wins. Message IDs are not ordered with seqs (ULID entropy
// is random within a millisecond, concurrent sends claim seqs out of ID order,
// and the read-everything watermark covers its whole millisecond), so a
// higher seq can arrive with a LOWER ID. DynamoDB can't take a max in an
// update, so that case is a second, rarer conditional write:
//
//  1. seq and ID both at or past the stored ones → write both;
//  2. otherwise, seq strictly past → write the seq only (the stored, newer ID
//     stays — the "New" divider watermark never regresses).
//
// Neither applying means the stored point is already past: ErrStaleReadPoint.
// A missing row (the caller isn't a member) is ErrNotFound; a follow-up
// GetItem tells the two apart without relying on
// ReturnValuesOnConditionCheckFailure support.
func (db *DB) setReadPoint(ctx context.Context, key map[string]types.AttributeValue, seq int64, msgID, label string) error {
	lastSeq := expression.Name("lastReadSeq")
	exists := expression.AttributeExists(expression.Name("PK"))
	seqOnly := expression.Set(lastSeq, expression.Value(seq)).
		Set(expression.Name("unreadNotifyCount"), expression.Value(0))
	seqAtOrPast := expression.Or(expression.AttributeNotExists(lastSeq), lastSeq.LessThanEqual(expression.Value(seq)))

	var attempts []readPointAttempt
	if msgID == "" {
		attempts = []readPointAttempt{{seqOnly, exists.And(seqAtOrPast)}}
	} else {
		lastID := expression.Name("lastReadMsgID")
		both := expression.Set(lastSeq, expression.Value(seq)).
			Set(expression.Name("unreadNotifyCount"), expression.Value(0)).
			Set(lastID, expression.Value(msgID))
		idAtOrPast := expression.Or(expression.AttributeNotExists(lastID), lastID.LessThanEqual(expression.Value(msgID)))
		attempts = []readPointAttempt{
			{both, exists.And(seqAtOrPast, idAtOrPast)},
			{seqOnly, exists.And(lastSeq.LessThan(expression.Value(seq)))},
		}
	}

	for _, a := range attempts {
		expr := mustExpr(expression.NewBuilder().WithUpdate(a.upd).WithCondition(a.cond).Build())
		_, err := db.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
			TableName:                 aws.String(db.Table),
			Key:                       key,
			UpdateExpression:          expr.Update(),
			ConditionExpression:       expr.Condition(),
			ExpressionAttributeNames:  expr.Names(),
			ExpressionAttributeValues: expr.Values(),
		})
		if err == nil {
			return nil
		}
		if !isConditionCheckFailed(err) {
			return fmt.Errorf("store: set %s last read: %w", label, err)
		}
	}
	out, getErr := db.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:            aws.String(db.Table),
		Key:                  key,
		ProjectionExpression: aws.String("PK"),
	})
	if getErr != nil {
		return fmt.Errorf("store: check %s last read row: %w", label, getErr)
	}
	if len(out.Item) == 0 {
		return ErrNotFound
	}
	return ErrStaleReadPoint
}
