package store

import (
	"context"
	"fmt"
	"slices"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// ListTopLevelMessages returns up to limit of a parent's top-level messages,
// newest first — strictly older than `before` when it is set — from the GSI2
// top-level index: one bounded read of exactly the rows the page shows, where
// filtering ListMessages pages past every thread reply in between. hasMore
// reports older top-level messages beyond the page. Like every GSI the index
// is eventually consistent; live messages reach clients over the WebSocket.
func (s *MessageStoreImpl) ListTopLevelMessages(ctx context.Context, parentID, before string, limit int) ([]*model.Message, bool, error) {
	pk := expression.Key("GSI2PK").Equal(expression.Value(topLevelGSI2PK(parentID)))
	keyCond := expression.KeyAnd(pk, expression.Key("GSI2SK").BeginsWith("MSG#"))
	if before != "" {
		keyCond = expression.KeyAnd(pk, expression.Key("GSI2SK").LessThan(expression.Value(msgSK(before))))
	}
	return s.queryTopLevel(ctx, keyCond, false, limit)
}

// ListTopLevelMessagesAfter is ListTopLevelMessages scrolling the other way:
// up to limit of a parent's top-level messages strictly newer than `after`,
// the ones nearest the cursor, returned newest first like every message page.
// hasMore reports newer top-level messages beyond the page. An empty cursor
// lists nothing (as ListMessagesAfter).
func (s *MessageStoreImpl) ListTopLevelMessagesAfter(ctx context.Context, parentID, after string, limit int) ([]*model.Message, bool, error) {
	if after == "" {
		return nil, false, nil
	}
	keyCond := expression.KeyAnd(
		expression.Key("GSI2PK").Equal(expression.Value(topLevelGSI2PK(parentID))),
		expression.Key("GSI2SK").GreaterThan(expression.Value(msgSK(after))),
	)
	messages, hasMore, err := s.queryTopLevel(ctx, keyCond, true, limit)
	slices.Reverse(messages)
	return messages, hasMore, err
}

// queryTopLevel reads up to limit rows of the top-level index in key order
// (oldest first when forward), plus one look-ahead row for hasMore.
func (s *MessageStoreImpl) queryTopLevel(ctx context.Context, keyCond expression.KeyConditionBuilder, forward bool, limit int) ([]*model.Message, bool, error) {
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	in := &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ScanIndexForward:          aws.Bool(forward),
	}
	// One row past the page detects "has more". A response comes back short
	// of Limit only at DynamoDB's 1MB cap (long bodies): keep reading, so a
	// capped page is neither short nor mistaken for the end of history.
	messages := make([]*model.Message, 0, limit+1)
	for {
		in.Limit = aws.Int32(int32(limit + 1 - len(messages)))
		out, err := s.Client.Query(ctx, in)
		if err != nil {
			return nil, false, fmt.Errorf("store: list top-level messages: %w", err)
		}
		for _, item := range out.Items {
			var mi messageItem
			if err := attributevalue.UnmarshalMap(item, &mi); err != nil {
				return nil, false, fmt.Errorf("store: unmarshal message: %w", err)
			}
			messages = append(messages, &mi.Message)
		}
		if len(messages) > limit || len(out.LastEvaluatedKey) == 0 {
			break
		}
		in.ExclusiveStartKey = out.LastEvaluatedKey
	}
	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}
	return messages, hasMore, nil
}
