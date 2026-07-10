//go:build integration

package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func expressionBuilderEmpty() (expression.Expression, error) {
	return expression.NewBuilder().Build()
}

type marshalBomb struct{}

func (marshalBomb) MarshalDynamoDBAttributeValue() (types.AttributeValue, error) {
	return nil, errBomb
}

var errBomb = errors.New("marshal bomb")

func attributevalueMarshalChan() (map[string]types.AttributeValue, error) {
	return attributevalue.MarshalMap(map[string]any{"bad": marshalBomb{}})
}

// Unmarshal error arms: a corrupt (or foreign-written) row is the runtime
// condition those branches guard, and a healthy DynamoDB Local never produces
// one. The transform hooks rewrite the REAL container's output into a row no
// store struct can absorb, so each arm is exercised end-to-end through the
// actual SDK call.

func assertUnmarshalErr(t *testing.T, err error, op string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), "unmarshal") {
		t.Fatalf("%s: want unmarshal error, got %v", op, err)
	}
}

func TestCorruptRows_GetItemArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	faulted := withFault(db, func(f *faultClient) { f.transformGetItem = corruptGetItem })

	t.Run("user GetByID", func(t *testing.T) {
		_, err := NewUserStore(faulted).GetUser(ctx, "u-x")
		assertUnmarshalErr(t, err, "user GetByID")
	})
	t.Run("channel GetByID", func(t *testing.T) {
		_, err := NewChannelStore(faulted).GetChannel(ctx, "ch-x")
		assertUnmarshalErr(t, err, "channel GetByID")
	})
	t.Run("conversation GetByID", func(t *testing.T) {
		_, err := NewConversationStore(faulted).GetConversation(ctx, "conv-x")
		assertUnmarshalErr(t, err, "conversation GetByID")
	})
	t.Run("message GetByID", func(t *testing.T) {
		_, err := NewMessageStore(faulted).GetMessage(ctx, "ch-x", "m-x")
		assertUnmarshalErr(t, err, "message GetByID")
	})
	t.Run("membership GetChannelMembership", func(t *testing.T) {
		_, err := NewMembershipStore(faulted).GetMembership(ctx, "ch-x", "u-x")
		assertUnmarshalErr(t, err, "membership GetChannelMembership")
	})
	t.Run("attachment GetByID", func(t *testing.T) {
		_, err := NewAttachmentStore(faulted).GetByID(ctx, "att-x")
		assertUnmarshalErr(t, err, "attachment GetByID")
	})
	t.Run("category Get", func(t *testing.T) {
		_, err := NewCategoryStore(faulted).Get(ctx, "u-x", "cat-x")
		assertUnmarshalErr(t, err, "category Get")
	})
	t.Run("emoji GetByName", func(t *testing.T) {
		_, err := NewEmojiStore(faulted).GetByName(ctx, "parrot")
		assertUnmarshalErr(t, err, "emoji GetByName")
	})
	t.Run("invite GetByToken", func(t *testing.T) {
		_, err := NewInviteStore(faulted).GetInvite(ctx, "tok-x")
		assertUnmarshalErr(t, err, "invite GetByToken")
	})
	t.Run("settings GetSettings", func(t *testing.T) {
		_, err := NewSettingsStore(faulted).GetSettings(ctx)
		assertUnmarshalErr(t, err, "settings GetSettings")
	})
	t.Run("thread follow Get", func(t *testing.T) {
		_, err := NewThreadFollowStore(faulted).GetThreadFollow(ctx, "u-x", "ch-x", "m-x")
		assertUnmarshalErr(t, err, "thread follow Get")
	})
	t.Run("token GetByHash", func(t *testing.T) {
		_, err := NewTokenStore(faulted).GetRefreshToken(ctx, "hash-x")
		assertUnmarshalErr(t, err, "token GetByHash")
	})
	t.Run("webhook Get", func(t *testing.T) {
		_, err := NewIncomingWebhookStore(faulted).Get(ctx, "wh-x")
		assertUnmarshalErr(t, err, "webhook Get")
	})
	t.Run("user GetByEmail", func(t *testing.T) {
		_, err := NewUserStore(faulted).GetUserByEmail(ctx, "a@b.c")
		assertUnmarshalErr(t, err, "user GetByEmail")
	})
	t.Run("searchstatus GetSearchStatus", func(t *testing.T) {
		// dest mirrors real status structs (flat string fields); the corrupt
		// row's map-typed PK cannot land in a string field.
		var dest struct{ PK string }
		_, err := NewSearchStatusStore(faulted).GetSearchStatus(ctx, "reindex", &dest)
		assertUnmarshalErr(t, err, "searchstatus GetSearchStatus")
	})
}

func TestCorruptRows_QueryArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	faulted := withFault(db, func(f *faultClient) { f.transformQuery = corruptQuery })

	t.Run("channel GetBySlug", func(t *testing.T) {
		_, err := NewChannelStore(faulted).GetChannelBySlug(ctx, "eng")
		assertUnmarshalErr(t, err, "channel GetBySlug")
	})
	t.Run("channel GetByName", func(t *testing.T) {
		_, err := NewChannelStore(faulted).GetByName(ctx, "Eng")
		assertUnmarshalErr(t, err, "channel GetByName")
	})
	t.Run("channel ListPublic", func(t *testing.T) {
		_, _, err := NewChannelStore(faulted).ListPublicChannels(ctx, 10, "")
		assertUnmarshalErr(t, err, "channel ListPublic")
	})
	t.Run("message List", func(t *testing.T) {
		_, _, err := NewMessageStore(faulted).ListMessages(ctx, "ch-x", "", 10)
		assertUnmarshalErr(t, err, "message List")
	})
	t.Run("message ListThreadReplies", func(t *testing.T) {
		_, err := NewMessageStore(faulted).ListThreadReplies(ctx, "root-x")
		assertUnmarshalErr(t, err, "message ListThreadReplies")
	})
	t.Run("message ListAfter", func(t *testing.T) {
		_, _, err := NewMessageStore(faulted).ListMessagesAfter(ctx, "ch-x", "m-0", 10)
		assertUnmarshalErr(t, err, "message ListAfter")
	})
	t.Run("membership ListChannelMembers", func(t *testing.T) {
		_, err := NewMembershipStore(faulted).ListMembers(ctx, "ch-x")
		assertUnmarshalErr(t, err, "membership ListChannelMembers")
	})
	t.Run("membership ListUserChannels", func(t *testing.T) {
		_, err := NewMembershipStore(faulted).ListUserChannels(ctx, "u-x")
		assertUnmarshalErr(t, err, "membership ListUserChannels")
	})
	t.Run("conversation ListUserConversations", func(t *testing.T) {
		_, err := NewConversationStore(faulted).ListUserConversations(ctx, "u-x")
		assertUnmarshalErr(t, err, "conversation ListUserConversations")
	})
	t.Run("category List skips unreadable rows", func(t *testing.T) {
		// Unlike the strict stores, category List tolerates a corrupt row by
		// skipping it — sidebar categories are cosmetic, not load-bearing.
		cats, err := NewCategoryStore(faulted).List(ctx, "u-x")
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		if len(cats) != 0 {
			t.Fatalf("cats = %v, want the corrupt row skipped", cats)
		}
	})
	t.Run("thread follow ListThread", func(t *testing.T) {
		_, err := NewThreadFollowStore(faulted).ListThreadFollows(ctx, "ch-x", "m-x")
		assertUnmarshalErr(t, err, "thread follow ListThread")
	})
	t.Run("thread follow ListUser", func(t *testing.T) {
		_, err := NewThreadFollowStore(faulted).ListUserThreadFollows(ctx, "u-x")
		assertUnmarshalErr(t, err, "thread follow ListUser")
	})
	t.Run("parent index ListPinIndex", func(t *testing.T) {
		_, err := NewParentIndexStore(faulted).ListPinIndex(ctx, "ch-x")
		assertUnmarshalErr(t, err, "parent index ListPinIndex")
	})
	t.Run("parent index ListFileIndex", func(t *testing.T) {
		_, err := NewParentIndexStore(faulted).ListFileIndex(ctx, "ch-x")
		assertUnmarshalErr(t, err, "parent index ListFileIndex")
	})
	t.Run("user state List", func(t *testing.T) {
		_, err := NewUserStateStore(faulted).ListUserState(ctx, "u-x")
		assertUnmarshalErr(t, err, "user state List")
	})
	t.Run("attachment GetByHash", func(t *testing.T) {
		_, err := NewAttachmentStore(faulted).GetByHash(ctx, "sha-x")
		assertUnmarshalErr(t, err, "attachment GetByHash")
	})
	t.Run("user List", func(t *testing.T) {
		_, _, err := NewUserStore(faulted).ListUsers(ctx, 10, "")
		assertUnmarshalErr(t, err, "user List")
	})
	t.Run("emoji List", func(t *testing.T) {
		_, err := NewEmojiStore(faulted).List(ctx)
		assertUnmarshalErr(t, err, "emoji List")
	})
	t.Run("user findByEmailScan fallback", func(t *testing.T) {
		// The email pointer row misses (real GetItem), so GetByEmail falls
		// back to the fallback query — which returns a corrupt row. The
		// fallback projects only id+email, so the corruption must hit a
		// projected field to reach its unmarshal arm.
		emailCorrupt := withFault(db, func(f *faultClient) {
			f.transformQuery = func(out *dynamodb.QueryOutput) *dynamodb.QueryOutput {
				out.Items = []map[string]types.AttributeValue{{
					"email": &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{}},
				}}
				out.Count = 1
				out.LastEvaluatedKey = nil
				return out
			}
		})
		_, err := NewUserStore(emailCorrupt).GetUserByEmail(ctx, "missing@x.io")
		assertUnmarshalErr(t, err, "user findByEmailScan")
	})
}

func TestCorruptRows_ScanArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	faulted := withFault(db, func(f *faultClient) { f.transformScan = corruptScan })

	t.Run("channel ListAll", func(t *testing.T) {
		_, err := NewChannelStore(faulted).ListAllChannels(ctx)
		assertUnmarshalErr(t, err, "channel ListAll")
	})
	t.Run("conversation ListAll", func(t *testing.T) {
		_, err := NewConversationStore(faulted).ListAllConversations(ctx)
		assertUnmarshalErr(t, err, "conversation ListAll")
	})
	t.Run("attachment ListAll", func(t *testing.T) {
		_, err := NewAttachmentStore(faulted).ListAll(ctx)
		assertUnmarshalErr(t, err, "attachment ListAll")
	})
	t.Run("webhook List", func(t *testing.T) {
		_, err := NewIncomingWebhookStore(faulted).List(ctx)
		assertUnmarshalErr(t, err, "webhook List")
	})
}

func TestCorruptRows_BatchGetArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("user GetUsersByIDs corrupt", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) {
			f.transformBatchGetItem = func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
				out.Responses = map[string][]map[string]types.AttributeValue{db.Table: {corruptRow()}}
				out.UnprocessedKeys = nil
				return out
			}
		})
		_, err := NewUserStore(faulted).GetUsersByIDs(ctx, []string{"u-1"})
		assertUnmarshalErr(t, err, "user GetUsersByIDs")
	})

	t.Run("user NotificationSettingsFor corrupt", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) {
			f.transformBatchGetItem = func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
				// The settings row projects only id + notificationSettings, so
				// the corruption must hit a projected field.
				out.Responses = map[string][]map[string]types.AttributeValue{db.Table: {{
					"id": &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{}},
				}}}
				out.UnprocessedKeys = nil
				return out
			}
		})
		_, err := NewUserStore(faulted).NotificationSettingsFor(ctx, []string{"u-1"})
		assertUnmarshalErr(t, err, "user NotificationSettingsFor")
	})
}

func TestCorruptRows_ListAround(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	anchor := &model.Message{ID: "m-around", ParentID: "ch-around", AuthorID: "u-1", Body: "b", CreatedAt: time.Now()}
	if err := NewMessageStore(db).CreateMessage(ctx, anchor); err != nil {
		t.Fatalf("Create: %v", err)
	}
	// The anchor GetItem stays real; the older/newer window queries return
	// corrupt rows.
	faulted := withFault(db, func(f *faultClient) { f.transformQuery = corruptQuery })
	_, _, _, err := NewMessageStore(faulted).ListMessagesAround(ctx, anchor.ParentID, anchor.ID, 3, 3)
	assertUnmarshalErr(t, err, "message ListAround")
}

// 7. membership notif prefs is BatchGet-backed
func TestCorruptRows_MembershipNotifPrefs(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	faulted := withFault(db, func(f *faultClient) {
		f.transformBatchGetItem = func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
			// The prefs row projects specific attributes into model.UserChannel
			// — corrupt one of the projected fields.
			out.Responses = map[string][]map[string]types.AttributeValue{db.Table: {{
				"userID": &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{}},
			}}}
			out.UnprocessedKeys = nil
			return out
		}
	})
	_, err := NewMembershipStore(faulted).UserChannelNotifPrefs(ctx, "ch-x", []string{"u-1"})
	assertUnmarshalErr(t, err, "membership UserChannelNotifPrefs")
}

// Unprocessed-keys continuations: DynamoDB may return a subset and ask the
// caller to re-request the rest — Local never does, so the drain loops'
// second iterations are forced here: the FIRST response reports everything
// unprocessed, the retry passes through to the real container.
func TestBatchGetUnprocessedContinuations(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	users := NewUserStore(db)

	u := &model.User{ID: "u-unproc", Email: "unproc@x.io", DisplayName: "U", SystemRole: model.SystemRoleMember, Status: "active", CreatedAt: time.Now()}
	if err := users.CreateUser(ctx, u); err != nil {
		t.Fatalf("Create: %v", err)
	}

	unprocOnce := func() func(*dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
		fired := false
		return func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
			if fired {
				return out
			}
			fired = true
			return &dynamodb.BatchGetItemOutput{
				Responses: map[string][]map[string]types.AttributeValue{},
				UnprocessedKeys: map[string]types.KeysAndAttributes{
					db.Table: {Keys: []map[string]types.AttributeValue{compositeKey(userPK(u.ID), profileSK())}},
				},
			}
		}
	}

	t.Run("GetUsersByIDs drains unprocessed keys", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) { f.transformBatchGetItem = unprocOnce() })
		got, err := NewUserStore(faulted).GetUsersByIDs(ctx, []string{u.ID})
		if err != nil {
			t.Fatalf("GetUsersByIDs: %v", err)
		}
		if len(got) != 1 || got[0].ID != u.ID {
			t.Fatalf("got %v, want the seeded user via the unprocessed retry", got)
		}
	})

	t.Run("NotificationSettingsFor drains unprocessed keys", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) { f.transformBatchGetItem = unprocOnce() })
		got, err := NewUserStore(faulted).NotificationSettingsFor(ctx, []string{u.ID})
		if err != nil {
			t.Fatalf("NotificationSettingsFor: %v", err)
		}
		if _, ok := got[u.ID]; !ok {
			t.Fatalf("settings map %v missing seeded user", got)
		}
	})

	t.Run("NotificationSettingsFor skips a row with no user ID", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) {
			f.transformBatchGetItem = func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
				// Well-typed row that unmarshals fine but carries no user id.
				out.Responses = map[string][]map[string]types.AttributeValue{db.Table: {{
					"PK": &types.AttributeValueMemberS{Value: "USER#ghost"},
					"SK": &types.AttributeValueMemberS{Value: "PROFILE"},
				}}}
				out.UnprocessedKeys = nil
				return out
			}
		})
		got, err := NewUserStore(faulted).NotificationSettingsFor(ctx, []string{"ghost"})
		if err != nil {
			t.Fatalf("NotificationSettingsFor: %v", err)
		}
		if len(got) != 0 {
			t.Fatalf("got %v, want empty (id-less rows skipped)", got)
		}
	})
}

// UpdateItem-returned attribute corruption: the seq counters and the reply
// metadata bump unmarshal ReturnValues — feed them attributes of the wrong
// type.
func TestCorruptRows_UpdateItemArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	corruptSeq := func(out *dynamodb.UpdateItemOutput) *dynamodb.UpdateItemOutput {
		out.Attributes = map[string]types.AttributeValue{
			"messageSeq": &types.AttributeValueMemberSS{Value: []string{"x"}},
		}
		return out
	}

	t.Run("channel IncrementMessageSeq", func(t *testing.T) {
		ch := makeChannel("ch-seq-c", "SeqC", "seq-c", model.ChannelTypePublic)
		if err := NewChannelStore(db).CreateChannel(ctx, ch); err != nil {
			t.Fatalf("Create: %v", err)
		}
		faulted := withFault(db, func(f *faultClient) { f.transformUpdateItem = corruptSeq })
		_, err := NewChannelStore(faulted).IncrementMessageSeq(ctx, ch.ID)
		assertUnmarshalErr(t, err, "channel IncrementMessageSeq")
	})

	t.Run("conversation IncrementMessageSeq", func(t *testing.T) {
		conv := &model.Conversation{ID: "conv-seq", Type: model.ConversationTypeDM, ParticipantIDs: []string{"a", "b"}, CreatedAt: time.Now()}
		if err := NewConversationStore(db).CreateConversation(ctx, conv, nil); err != nil {
			t.Fatalf("Create: %v", err)
		}
		faulted := withFault(db, func(f *faultClient) { f.transformUpdateItem = corruptSeq })
		_, err := NewConversationStore(faulted).IncrementMessageSeq(ctx, conv.ID)
		assertUnmarshalErr(t, err, "conversation IncrementMessageSeq")
	})

	t.Run("message IncrementReplyMetadata", func(t *testing.T) {
		root := &model.Message{ID: "m-root-corrupt", ParentID: "ch-seq-c", AuthorID: "u-1", Body: "r", CreatedAt: time.Now()}
		if err := NewMessageStore(db).CreateMessage(ctx, root); err != nil {
			t.Fatalf("Create root: %v", err)
		}
		faulted := withFault(db, func(f *faultClient) {
			f.transformUpdateItem = func(out *dynamodb.UpdateItemOutput) *dynamodb.UpdateItemOutput {
				out.Attributes = corruptRow()
				return out
			}
		})
		_, err := NewMessageStore(faulted).IncrementReplyMetadata(ctx, root.ParentID, root.ID, time.Now(), "u-2")
		assertUnmarshalErr(t, err, "message IncrementReplyMetadata")
	})
}

// must-helper panic arms: the "impossible" branches panic with context.
func TestMustHelpersPanicOnImpossibleFailure(t *testing.T) {
	t.Run("mustExpr", func(t *testing.T) {
		defer func() {
			if r := recover(); r == nil {
				t.Fatal("expected panic from an unbuildable expression")
			}
		}()
		// An empty builder cannot Build — the only way to reach the arm.
		_ = mustExpr(expressionBuilderEmpty())
	})
	t.Run("mustAttrs", func(t *testing.T) {
		defer func() {
			if r := recover(); r == nil {
				t.Fatal("expected panic from an unmarshalable value")
			}
		}()
		_ = mustAttrs(attributevalueMarshalChan())
	})
}
