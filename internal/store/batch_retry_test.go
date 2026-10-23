//go:build integration

package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// retryWindow pins the shared batch retry policy for one test: exponential
// from base, capped at maxWait, for attempts tries.
func retryWindow(t *testing.T, base, maxWait time.Duration, attempts int) {
	t.Helper()
	b, m, n := batchRetryBase, batchRetryMax, batchRetryAttempts
	batchRetryBase, batchRetryMax, batchRetryAttempts = base, maxWait, attempts
	t.Cleanup(func() { batchRetryBase, batchRetryMax, batchRetryAttempts = b, m, n })
}

// minRetryWait is the shortest total wait the policy may take before its
// attempts-th try: each wait is randomized to at least half its interval.
func minRetryWait(base, maxWait time.Duration, attempts int) time.Duration {
	total, interval := time.Duration(0), base
	for i := 1; i < attempts; i++ {
		total += interval / 2
		interval = min(interval*2, maxWait)
	}
	return total
}

// throttledGets answers every BatchGetItem with all of its keys unprocessed
// (sustained throttling) — until spinGuard calls, after which it forwards to
// the real client so a loop with no cap terminates and the test can fail on
// its result instead of hanging.
type throttledGets struct {
	DynamoAPI
	calls     int
	spinGuard int
	// cancel, when set, is invoked on the first call: the wait before the
	// retry must notice the cancellation instead of sleeping it out.
	cancel context.CancelFunc
}

func (g *throttledGets) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, o ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	g.calls++
	if g.cancel != nil {
		g.cancel()
	}
	if g.calls > g.spinGuard {
		return g.DynamoAPI.BatchGetItem(ctx, in, o...)
	}
	return &dynamodb.BatchGetItemOutput{
		Responses:       map[string][]map[string]types.AttributeValue{},
		UnprocessedKeys: in.RequestItems,
	}, nil
}

// Every BatchGetItem drain shares one bounded, backed-off retry: a key DynamoDB
// keeps handing back must surface as an error after the attempt cap — never
// spin against a throttled partition, and never come back as "absent" (a
// member's notification prefs silently reverting to defaults, a channel
// missing from the sidebar).
func TestBatchGet_SustainedThrottlingIsCappedAndBackedOff(t *testing.T) {
	const attempts = 3
	base, maxWait := 10*time.Millisecond, 20*time.Millisecond
	retryWindow(t, base, maxWait, attempts)
	db := setupDynamoDB(t)
	ctx := context.Background()

	calls := map[string]func(*DB) error{
		"GetUsersByIDs": func(d *DB) error {
			_, err := NewUserStore(d).GetUsersByIDs(ctx, []string{"u1"})
			return err
		},
		"NotificationAccountsFor": func(d *DB) error {
			_, err := NewUserStore(d).NotificationAccountsFor(ctx, []string{"u1"})
			return err
		},
		"UserChannelNotifPrefs": func(d *DB) error {
			_, err := NewMembershipStore(d).UserChannelNotifPrefs(ctx, "c1", []string{"u1"})
			return err
		},
		"MembershipLastReadSeqs": func(d *DB) error {
			_, err := NewMembershipStore(d).LastReadSeqs(ctx, "c1", []string{"u1"})
			return err
		},
		"GetChannelsByIDs": func(d *DB) error {
			_, err := NewChannelStore(d).GetChannelsByIDs(ctx, []string{"c1"})
			return err
		},
		"GetConversationsByIDs": func(d *DB) error {
			_, err := NewConversationStore(d).GetConversationsByIDs(ctx, []string{"v1"})
			return err
		},
		"GetUserConversations": func(d *DB) error {
			_, err := NewConversationStore(d).GetUserConversations(ctx, "v1", []string{"u1"})
			return err
		},
		"GetMessagesByIDs": func(d *DB) error {
			_, err := NewMessageStore(d).GetMessagesByIDs(ctx, "c1", []string{"m1"})
			return err
		},
		"GetAttachmentsByIDs": func(d *DB) error {
			_, err := NewAttachmentStore(d).GetAttachmentsByIDs(ctx, []string{"a1"})
			return err
		},
		"webhook listByDirectory": func(d *DB) error {
			_, err := NewIncomingWebhookStore(d).listByDirectory(ctx, []string{"w1"})
			return err
		},
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			g := &throttledGets{DynamoAPI: db.Client, spinGuard: 20}
			start := time.Now()
			err := call(&DB{Client: g, Table: db.Table})
			elapsed := time.Since(start)
			if err == nil || !strings.Contains(err.Error(), "unprocessed after 3 attempts") {
				t.Fatalf("err = %v, want the capped unprocessed error", err)
			}
			if g.calls != attempts {
				t.Fatalf("BatchGetItem calls = %d, want %d (the attempt cap)", g.calls, attempts)
			}
			if want := minRetryWait(base, maxWait, attempts); elapsed < want {
				t.Fatalf("retried in %v, want at least %v of backoff between attempts", elapsed, want)
			}
		})
	}
}

// The wait between rounds honours cancellation: a request that gives up must
// not sit out the backoff.
func TestBatchGet_WaitHonoursCancellation(t *testing.T) {
	retryWindow(t, time.Hour, time.Hour, 5)
	db := setupDynamoDB(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	g := &throttledGets{DynamoAPI: db.Client, spinGuard: 20, cancel: cancel}
	_, err := NewUserStore(&DB{Client: g, Table: db.Table}).GetUsersByIDs(ctx, []string{"u1"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if g.calls != 1 {
		t.Fatalf("BatchGetItem calls = %d, want 1", g.calls)
	}
}

// A chunk of more than 100 keys is split at DynamoDB's BatchGetItem limit and
// every chunk's results are merged.
func TestBatchGet_ChunksAtTheBatchLimit(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	us := NewUserStore(db)
	ids := make([]string, 0, 130)
	for i := range 130 {
		u := makeUser(NewID(), "chunk"+string(rune('a'+i%26))+NewID()+"@example.com", "U")
		if err := us.CreateUser(ctx, u); err != nil {
			t.Fatalf("seed: %v", err)
		}
		ids = append(ids, u.ID)
	}
	got, err := us.GetUsersByIDs(ctx, ids)
	if err != nil || len(got) != len(ids) {
		t.Fatalf("GetUsersByIDs = %d users (err %v), want %d", len(got), err, len(ids))
	}
}

// The write drains (token revocation on deactivation, run-event cleanup,
// mention auto-follows) share putAll/deleteAll's policy: they wait between
// rounds and give up only at the shared attempt cap — they used to retry
// three times back-to-back, hammering the throttled partition.
func TestBatchWrite_DrainsShareTheBackedOffPolicy(t *testing.T) {
	const attempts = 4
	base, maxWait := 10*time.Millisecond, 20*time.Millisecond
	retryWindow(t, base, maxWait, attempts)
	db := setupDynamoDB(t)
	ctx := context.Background()

	cases := map[string]func(*DB) error{
		"token revocation": func(d *DB) error {
			if err := NewTokenStore(db).StoreRefreshToken(ctx, makeRefreshToken("hash-pol", "u-pol")); err != nil {
				t.Fatalf("seed: %v", err)
			}
			return NewTokenStore(d).DeleteAllRefreshTokensForUser(ctx, "u-pol")
		},
		"run events": func(d *DB) error {
			if err := NewRunStore(db).AppendRunEvent(ctx, &model.RunEvent{RunID: "run-pol", Seq: 1, Type: "turn"}); err != nil {
				t.Fatalf("seed: %v", err)
			}
			return NewRunStore(d).DeleteRunEvents(ctx, "run-pol")
		},
		"thread follows": func(d *DB) error {
			return NewThreadFollowStore(d).SetThreadFollowMany(ctx, []*model.ThreadFollow{makeThreadFollow("u-pol", "ch-pol", "root-pol")})
		},
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			c := &unprocessedDynamo{DynamoAPI: db.Client, keep: 99}
			start := time.Now()
			err := run(&DB{Client: c, Table: db.Table})
			elapsed := time.Since(start)
			if err == nil || !strings.Contains(err.Error(), "unprocessed after 4 attempts") {
				t.Fatalf("err = %v, want the capped unprocessed error", err)
			}
			if c.calls != attempts {
				t.Fatalf("BatchWriteItem calls = %d, want %d", c.calls, attempts)
			}
			if want := minRetryWait(base, maxWait, attempts); elapsed < want {
				t.Fatalf("retried in %v, want at least %v of backoff between attempts", elapsed, want)
			}
		})
	}
}
