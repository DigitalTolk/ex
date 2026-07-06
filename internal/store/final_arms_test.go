//go:build integration

package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/redis/go-redis/v9"
)

// Pagination continuations a small DynamoDB Local table never produces on its
// own: pageQueryOnce injects a synthetic LastEvaluatedKey once, so the drain
// loops run their second iteration against the real container.
func TestQueryPaginationContinuations(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("channel ListAll", func(t *testing.T) {
		if err := NewChannelStore(db).Create(ctx, makeChannel("ch-pg", "Pg", "pg", model.ChannelTypePublic)); err != nil {
			t.Fatalf("Create: %v", err)
		}
		faulted := withFault(db, func(f *faultClient) { f.pageScanOnce = true })
		got, err := NewChannelStore(faulted).ListAll(ctx)
		if err != nil || len(got) == 0 {
			t.Fatalf("ListAll: %v (%d)", err, len(got))
		}
	})

	t.Run("conversation ListAll", func(t *testing.T) {
		conv := &model.Conversation{ID: "conv-pg", Type: model.ConversationTypeDM, ParticipantIDs: []string{"a", "b"}, CreatedAt: time.Now()}
		if err := NewConversationStore(db).Create(ctx, conv, nil); err != nil {
			t.Fatalf("Create: %v", err)
		}
		faulted := withFault(db, func(f *faultClient) { f.pageScanOnce = true })
		got, err := NewConversationStore(faulted).ListAll(ctx)
		if err != nil || len(got) == 0 {
			t.Fatalf("ListAll: %v (%d)", err, len(got))
		}
	})

	t.Run("message ListThreadReplies", func(t *testing.T) {
		reply := &model.Message{ID: "m-pg-r", ParentID: "ch-pg", AuthorID: "u-1", Body: "r", ParentMessageID: "m-pg-root", CreatedAt: time.Now()}
		if err := NewMessageStore(db).Create(ctx, reply); err != nil {
			t.Fatalf("Create: %v", err)
		}
		faulted := withFault(db, func(f *faultClient) { f.pageQueryOnce = true })
		got, err := NewMessageStore(faulted).ListThreadReplies(ctx, "m-pg-root")
		if err != nil || len(got) != 1 {
			t.Fatalf("ListThreadReplies: %v (%d)", err, len(got))
		}
	})

	t.Run("parent index pin + file", func(t *testing.T) {
		pi := NewParentIndexStore(db)
		if err := pi.SetPinIndex(ctx, "ch-pg", "m-pin", "u-1", time.Now()); err != nil {
			t.Fatalf("SetPinIndex: %v", err)
		}
		if err := pi.SetFileIndex(ctx, "ch-pg", "att-pg", "m-pg", "u-1", time.Now()); err != nil {
			t.Fatalf("SetFileIndex: %v", err)
		}
		faulted := NewParentIndexStore(withFault(db, func(f *faultClient) { f.pageQueryOnce = true }))
		if rows, err := faulted.ListPinIndex(ctx, "ch-pg"); err != nil || len(rows) != 1 {
			t.Fatalf("ListPinIndex: %v (%d)", err, len(rows))
		}
		faulted2 := NewParentIndexStore(withFault(db, func(f *faultClient) { f.pageQueryOnce = true }))
		if rows, err := faulted2.ListFileIndex(ctx, "ch-pg"); err != nil || len(rows) != 1 {
			t.Fatalf("ListFileIndex: %v (%d)", err, len(rows))
		}
	})

	t.Run("membership notif prefs unprocessed continuation", func(t *testing.T) {
		ch := makeChannel("ch-pg2", "Pg2", "pg2", model.ChannelTypePublic)
		if err := NewChannelStore(db).Create(ctx, ch); err != nil {
			t.Fatalf("Create channel: %v", err)
		}
		ms := NewMembershipStore(db)
		err := ms.AddChannelMember(ctx, ch,
			&model.ChannelMembership{ChannelID: ch.ID, UserID: "u-pg", Role: model.ChannelRoleMember, JoinedAt: time.Now()},
			&model.UserChannel{UserID: "u-pg", ChannelID: ch.ID, ChannelName: ch.Name, ChannelType: ch.Type, Role: model.ChannelRoleMember, JoinedAt: time.Now()})
		if err != nil {
			t.Fatalf("AddChannelMember: %v", err)
		}
		fired := false
		faulted := withFault(db, func(f *faultClient) {
			f.transformBatchGetItem = func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
				if fired {
					return out
				}
				fired = true
				return &dynamodb.BatchGetItemOutput{
					Responses: map[string][]map[string]types.AttributeValue{},
					UnprocessedKeys: map[string]types.KeysAndAttributes{
						db.Table: {Keys: []map[string]types.AttributeValue{compositeKey(userPK("u-pg"), chanSK(ch.ID))}},
					},
				}
			}
		})
		prefs, err := NewMembershipStore(faulted).UserChannelNotifPrefs(ctx, ch.ID, []string{"u-pg"})
		if err != nil {
			t.Fatalf("UserChannelNotifPrefs: %v", err)
		}
		if _, ok := prefs["u-pg"]; !ok {
			t.Fatalf("prefs %v missing member from the unprocessed retry", prefs)
		}
	})
}

func TestAttachmentRemoveRefCorruptAttributes(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	att := &model.Attachment{ID: "att-rr", SHA256: "sha-rr", S3Key: "attachments/att-rr", Filename: "f.png", ContentType: "image/png", Size: 1, CreatedBy: "u-1", CreatedAt: time.Now(), MessageIDs: []string{"m-1", "m-2"}}
	if err := NewAttachmentStore(db).Create(ctx, att); err != nil {
		t.Fatalf("Create: %v", err)
	}
	faulted := withFault(db, func(f *faultClient) {
		f.transformUpdateItem = func(out *dynamodb.UpdateItemOutput) *dynamodb.UpdateItemOutput {
			out.Attributes = corruptRow()
			return out
		}
	})
	_, err := NewAttachmentStore(faulted).RemoveRef(ctx, att.ID, "m-1")
	assertUnmarshalErr(t, err, "attachment RemoveRef")
}

func TestTokenMarkRotatedGenericError(t *testing.T) {
	db := setupDynamoDB(t)
	faulted := withFault(db, func(f *faultClient) { f.failUpdateItem = true })
	err := NewTokenStore(faulted).MarkRotated(context.Background(), "hash-x", time.Now(), "succ")
	if !errors.Is(err, errInjected) {
		t.Fatalf("MarkRotated: want errInjected, got %v", err)
	}
}

func TestNewDBRejectsBrokenAWSEnv(t *testing.T) {
	// An unparsable AWS env var fails config.LoadDefaultConfig — the only
	// runtime way store.New's config arm fires.
	t.Setenv("AWS_MAX_ATTEMPTS", "not-a-number")
	_, err := New(context.Background(), DBConfig{Region: "us-east-1", Endpoint: "http://localhost:1", Table: "t"})
	if err == nil || !strings.Contains(err.Error(), "load aws config") {
		t.Fatalf("New: want aws-config error, got %v", err)
	}
}

func TestEnsureTableWaiterFailure(t *testing.T) {
	db := setupDynamoDB(t)
	// Fresh table name: existence probe (call 1) legitimately misses, the
	// create succeeds, then the post-create waiter's DescribeTable fails.
	faulted := withFault(db, func(f *faultClient) { f.failDescribeTableFromCall = 2 })
	faulted.Table = "waiter-fail-" + time.Now().Format("150405.000")
	err := faulted.EnsureTable(context.Background())
	if err == nil || !strings.Contains(err.Error(), "wait for table") {
		t.Fatalf("EnsureTable: want waiter error, got %v", err)
	}
}

// Redis error and corrupt-payload arms, against the real container. Errors are
// injected at the go-redis client boundary (Limiter) so the command path all
// the way to the wire stays real.
func TestRedisStoreArms(t *testing.T) {
	ctx := context.Background()

	t.Run("activity ListActivity corrupt payload", func(t *testing.T) {
		client := storeRedisClient(t)
		if err := client.ZAdd(ctx, activityKey("u-c"), redisZ(float64(time.Now().UnixMilli()), "not-json")).Err(); err != nil {
			t.Fatalf("seed: %v", err)
		}
		_, err := NewRedisActivityStore(client).ListActivity(ctx, "u-c")
		assertUnmarshalErr(t, err, "activity ListActivity")
	})

	t.Run("activity MarkActivitySeen set error", func(t *testing.T) {
		client := storeRedisClientFailingOn(t, "set")
		err := NewRedisActivityStore(client).MarkActivitySeen(ctx, "u-c")
		if !errors.Is(err, errInjected) {
			t.Fatalf("MarkActivitySeen: want errInjected, got %v", err)
		}
	})

	t.Run("draft Get corrupt payload", func(t *testing.T) {
		client := storeRedisClient(t)
		if err := client.HSet(ctx, draftHashKey("u-d"), "scope-x", "not-json").Err(); err != nil {
			t.Fatalf("seed: %v", err)
		}
		_, err := NewRedisDraftStore(client).Get(ctx, "u-d", "scope-x")
		assertUnmarshalErr(t, err, "draft Get")
	})

	t.Run("draft List corrupt payload", func(t *testing.T) {
		client := storeRedisClient(t)
		if err := client.HSet(ctx, draftHashKey("u-d2"), "scope-x", "not-json").Err(); err != nil {
			t.Fatalf("seed: %v", err)
		}
		_, err := NewRedisDraftStore(client).List(ctx, "u-d2")
		assertUnmarshalErr(t, err, "draft List")
	})

	t.Run("reminder getReminder corrupt payload", func(t *testing.T) {
		client := storeRedisClient(t)
		if err := client.Set(ctx, reminderPayloadKey("r-c"), "not-json", 0).Err(); err != nil {
			t.Fatalf("seed: %v", err)
		}
		_, err := NewRedisReminderStore(client).getReminder(ctx, "r-c")
		assertUnmarshalErr(t, err, "reminder getReminder")
	})

	t.Run("reminder ListPendingReminders mget error", func(t *testing.T) {
		seed := storeRedisClient(t)
		if err := seed.ZAdd(ctx, reminderUserKey("u-r"), redisZ(1, "r-1")).Err(); err != nil {
			t.Fatalf("seed: %v", err)
		}
		client := storeRedisClientFailingOn(t, "mget")
		_, err := NewRedisReminderStore(client).ListPendingReminders(ctx, "u-r")
		if err == nil || !strings.Contains(err.Error(), "mget") {
			t.Fatalf("ListPendingReminders: want mget error, got %v", err)
		}
	})
}

// redisZ builds a redis.Z member for seeding.
func redisZ(score float64, member string) redis.Z {
	return redis.Z{Score: score, Member: member}
}

func TestMustJSONPanicsOnImpossibleFailure(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic from an unmarshalable value")
		}
	}()
	_ = mustJSON(json.Marshal(make(chan int)))
}

func TestClaimDueRemindersArms(t *testing.T) {
	ctx := context.Background()

	t.Run("mget error fails the claim", func(t *testing.T) {
		seed := storeRedisClient(t)
		seedStore := NewRedisReminderStore(seed)
		if err := seedStore.ScheduleReminder(ctx, &model.Reminder{ID: "r-mg", UserID: "u-cl", MessageID: "m-1", ParentID: "ch-1", ParentType: "channel", RemindAt: time.Now().Add(-time.Minute), CreatedAt: time.Now()}); err != nil {
			t.Fatalf("ScheduleReminder: %v", err)
		}
		client := storeRedisClientFailingOn(t, "mget")
		_, err := NewRedisReminderStore(client).ClaimDueReminders(ctx, 10)
		if err == nil || !strings.Contains(err.Error(), "mget") {
			t.Fatalf("ClaimDueReminders: want mget error, got %v", err)
		}
	})

	t.Run("post-claim cleanup failure is non-fatal", func(t *testing.T) {
		seed := storeRedisClient(t)
		seedStore := NewRedisReminderStore(seed)
		if err := seedStore.ScheduleReminder(ctx, &model.Reminder{ID: "r-cl", UserID: "u-cl2", MessageID: "m-1", ParentID: "ch-1", ParentType: "channel", RemindAt: time.Now().Add(-time.Minute), CreatedAt: time.Now()}); err != nil {
			t.Fatalf("ScheduleReminder: %v", err)
		}
		// The atomic claim (Lua) and the payload MGET pass; only the cleanup
		// pipeline (ZREM/DEL) fails — claimed reminders must still be
		// returned, the sweep happens on a later pass.
		client := storeRedisClientFailingOn(t, "zrem")
		got, err := NewRedisReminderStore(client).ClaimDueReminders(ctx, 10)
		if err != nil {
			t.Fatalf("ClaimDueReminders: %v", err)
		}
		if len(got) != 1 || got[0].ID != "r-cl" {
			t.Fatalf("got %v, want the claimed reminder despite cleanup failure", got)
		}
	})
}
