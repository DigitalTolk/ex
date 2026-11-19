//go:build integration

package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/hibiken/asynq"
)

// A queued SharePoint job lands in Redis with its payload, retries and
// timeout.
func TestEnqueueSharePoint(t *testing.T) {
	rdb := newAudienceRedis(t)
	sched := NewAsynqPushScheduler(rdb)
	t.Cleanup(func() { _ = sched.Close() })
	task := SharePointTask{Kind: sharePointJoined, ParentID: "ch-1", ParentType: ParentChannel, UserIDs: []string{"u-1"}}
	if err := sched.EnqueueSharePoint(context.Background(), task); err != nil {
		t.Fatalf("EnqueueSharePoint: %v", err)
	}
	pending, err := asynq.NewInspectorFromRedisClient(rdb).ListPendingTasks(SharePointTaskQueue)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending = %+v, %v", pending, err)
	}
	var got SharePointTask
	if err := json.Unmarshal(pending[0].Payload, &got); err != nil || got.ParentID != "ch-1" || got.UserIDs[0] != "u-1" {
		t.Fatalf("payload = %+v, %v", got, err)
	}
	if pending[0].Type != TaskTypeSharePointSync || pending[0].MaxRetry != sharePointMaxRetry || pending[0].Timeout != sharePointTaskTimeout {
		t.Fatalf("task = %+v", pending[0])
	}
}
