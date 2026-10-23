package store

import (
	"context"
	"fmt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Bulk removal helpers for undoing a history import. Like the bulk writes they
// are plain storage operations: no events, no counters, no search.

// deleteAll removes keys with BatchWriteItem in chunks of 25, draining
// UnprocessedItems like putAll. Missing keys are not an error; keys must be
// unique within a call.
func (db *DB) deleteAll(ctx context.Context, keys []map[string]types.AttributeValue) error {
	for i := 0; i < len(keys); i += batchWriteMax {
		chunk := keys[i:min(i+batchWriteMax, len(keys))]
		reqs := make([]types.WriteRequest, len(chunk))
		for j, k := range chunk {
			reqs[j] = types.WriteRequest{DeleteRequest: &types.DeleteRequest{Key: k}}
		}
		if err := db.drainBatch(ctx, reqs); err != nil {
			return err
		}
	}
	return nil
}

// primaryKeys strips fetched rows down to their PK/SK — a DeleteRequest key
// must carry the key attributes only.
func primaryKeys(items []map[string]types.AttributeValue) []map[string]types.AttributeValue {
	keys := make([]map[string]types.AttributeValue, len(items))
	for i, item := range items {
		keys[i] = map[string]types.AttributeValue{"PK": item["PK"], "SK": item["SK"]}
	}
	return keys
}

// partitionKeys returns the key of every item under pk.
func (db *DB) partitionKeys(ctx context.Context, pk string) ([]map[string]types.AttributeValue, error) {
	items, err := db.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                aws.String(db.Table),
		KeyConditionExpression:   aws.String("#pk = :pk"),
		ExpressionAttributeNames: map[string]string{"#pk": "PK", "#sk": "SK"},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk": &types.AttributeValueMemberS{Value: pk},
		},
		ProjectionExpression: aws.String("#pk, #sk"),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list partition: %w", err)
	}
	return items, nil
}

// deletePartitions removes every item under each pk, then the extra keys.
func (db *DB) deletePartitions(ctx context.Context, pks []string, extra ...map[string]types.AttributeValue) error {
	keys := extra
	for _, pk := range pks {
		ks, err := db.partitionKeys(ctx, pk)
		if err != nil {
			return err
		}
		keys = append(keys, ks...)
	}
	return db.deleteAll(ctx, keys)
}

// DeleteMessages hard-deletes message rows of one parent (thread index entries
// go with them, since they are GSI projections of the same rows).
func (s *MessageStoreImpl) DeleteMessages(ctx context.Context, parentID string, ids []string) error {
	keys := make([]map[string]types.AttributeValue, len(ids))
	for i, id := range ids {
		keys[i] = compositeKey(parentPK(parentID), msgSK(id))
	}
	return s.deleteAll(ctx, keys)
}

// DeleteIndexRows removes PIN# rows (by message ID) and FILE# rows (by
// attachment ID) of one parent in batches.
func (s *ParentIndexStoreImpl) DeleteIndexRows(ctx context.Context, parentID string, pinMsgIDs, fileAttIDs []string) error {
	keys := make([]map[string]types.AttributeValue, 0, len(pinMsgIDs)+len(fileAttIDs))
	for _, id := range pinMsgIDs {
		keys = append(keys, compositeKey(parentPK(parentID), pinSK(id)))
	}
	for _, id := range fileAttIDs {
		keys = append(keys, compositeKey(parentPK(parentID), fileSK(id)))
	}
	return s.deleteAll(ctx, keys)
}

// DeleteThreadFollows removes the given follow rows.
func (s *ThreadFollowStoreImpl) DeleteThreadFollows(ctx context.Context, follows []*model.ThreadFollow) error {
	keys := make([]map[string]types.AttributeValue, len(follows))
	for i, f := range follows {
		keys[i] = compositeKey(userPK(f.UserID), threadFollowSK(f.ParentID, f.ThreadRootID))
	}
	return s.deleteAll(ctx, keys)
}

// DeleteChannel removes every item in the channel's partition (metadata,
// channel-side memberships, messages, pin and file index rows) and its slug
// lock. User-side membership rows live in user partitions: remove the members
// first (MembershipStore.RemoveMember).
func (s *ChannelStoreImpl) DeleteChannel(ctx context.Context, ch *model.Channel) error {
	return s.deletePartitions(ctx, []string{channelPK(ch.ID)}, compositeKey(chanSlugGSI1PK(ch.Slug), metaSK()))
}

// DeleteConversation removes a conversation: its metadata and member rows, each
// participant's sidebar row, and the partition holding its messages and index
// rows.
func (s *ConversationStoreImpl) DeleteConversation(ctx context.Context, conv *model.Conversation) error {
	extra := make([]map[string]types.AttributeValue, len(conv.ParticipantIDs))
	for i, uid := range conv.ParticipantIDs {
		extra[i] = compositeKey(userPK(uid), convSK(conv.ID))
	}
	return s.deletePartitions(ctx, []string{convPK(conv.ID), parentPK(conv.ID)}, extra...)
}

// DeleteUser removes a user's profile and email-index rows. Other rows in the
// user's partition (memberships, follows, state) are the caller's to clear.
func (s *UserStoreImpl) DeleteUser(ctx context.Context, u *model.User) error {
	return s.deleteAll(ctx, []map[string]types.AttributeValue{
		compositeKey(userPK(u.ID), profileSK()),
		compositeKey(userEmailPK(u.Email), profileSK()),
	})
}

// lastReadSeqs batch-reads lastReadSeq from user-side rows (userID → seq);
// rows that don't exist are absent from the result.
func (db *DB) lastReadSeqs(ctx context.Context, keys []map[string]types.AttributeValue) (map[string]int64, error) {
	type readStateRow struct {
		UserID      string `dynamodbav:"userID"`
		LastReadSeq int64  `dynamodbav:"lastReadSeq"`
	}
	rows, err := batchGetOf[readStateRow](ctx, db, keys, types.KeysAndAttributes{
		ProjectionExpression:     aws.String("#uid, #seq"),
		ExpressionAttributeNames: map[string]string{"#uid": "userID", "#seq": "lastReadSeq"},
	}, "read state")
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, row := range rows {
		out[row.UserID] = row.LastReadSeq
	}
	return out, nil
}

// LastReadSeqs returns the channel read watermark of each given member.
func (s *MembershipStoreImpl) LastReadSeqs(ctx context.Context, channelID string, userIDs []string) (map[string]int64, error) {
	keys := make([]map[string]types.AttributeValue, len(userIDs))
	for i, uid := range userIDs {
		keys[i] = compositeKey(userPK(uid), chanSK(channelID))
	}
	return s.lastReadSeqs(ctx, keys)
}

// LastReadSeqs returns the conversation read watermark of each participant.
func (s *ConversationStoreImpl) LastReadSeqs(ctx context.Context, convID string, userIDs []string) (map[string]int64, error) {
	keys := make([]map[string]types.AttributeValue, len(userIDs))
	for i, uid := range userIDs {
		keys[i] = compositeKey(userPK(uid), convSK(convID))
	}
	return s.lastReadSeqs(ctx, keys)
}

// ClearReplyMetadata removes a thread root's reply count, last reply time and
// recent reply authors (the root has no replies left). ErrNotFound when the
// message doesn't exist.
func (s *MessageStoreImpl) ClearReplyMetadata(ctx context.Context, parentID, msgID string) error {
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                aws.String(s.Table),
		Key:                      compositeKey(parentPK(parentID), msgSK(msgID)),
		UpdateExpression:         aws.String("REMOVE #rc, #lr, #ra"),
		ConditionExpression:      aws.String("attribute_exists(PK)"),
		ExpressionAttributeNames: map[string]string{"#rc": "replyCount", "#lr": "lastReplyAt", "#ra": "recentReplyAuthorIDs"},
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: clear reply metadata: %w", err)
	}
	return nil
}
