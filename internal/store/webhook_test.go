//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// pagedScanClient forces DynamoDB Scan to return one item per page so the
// store's pagination loop is exercised deterministically. On the first call it
// runs the real (filtered) Scan to collect every matching item, then serves
// them one at a time, attaching a synthetic LastEvaluatedKey until the final
// item. A store that issues a single Scan with no ExclusiveStartKey loop sees
// only the first page and silently drops the rest — the exact "webhook works
// but is missing from the admin list" bug.
type pagedScanClient struct {
	DynamoAPI
	remaining []map[string]types.AttributeValue
	primed    bool
}

func (c *pagedScanClient) Scan(ctx context.Context, in *dynamodb.ScanInput, opts ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error) {
	if !c.primed {
		out, err := c.DynamoAPI.Scan(ctx, in, opts...)
		if err != nil {
			return nil, err
		}
		c.remaining = out.Items
		c.primed = true
	}
	if len(c.remaining) == 0 {
		return &dynamodb.ScanOutput{}, nil
	}
	item := c.remaining[0]
	c.remaining = c.remaining[1:]
	out := &dynamodb.ScanOutput{Items: []map[string]types.AttributeValue{item}}
	if len(c.remaining) > 0 {
		// More pages remain — hand back a cursor so the store must loop.
		out.LastEvaluatedKey = map[string]types.AttributeValue{"PK": item["PK"], "SK": item["SK"]}
	}
	return out, nil
}

func TestIncomingWebhookStore_CreateListGetDelete(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewIncomingWebhookStore(db)
	ctx := context.Background()
	now := time.Now().Truncate(time.Millisecond)

	wh := &model.IncomingWebhook{
		ID:              "wh-store",
		Title:           "CI",
		Description:     "Build notifications",
		ChannelID:       "ch-general",
		ChannelName:     "General",
		ChannelSlug:     "general",
		LockToChannel:   true,
		Username:        "ci-bot",
		ProfileImageURL: "/api/v1/media/proxied/avatar",
		CreatedBy:       "admin-1",
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := s.Create(ctx, wh); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := s.Get(ctx, wh.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Title != wh.Title || got.ChannelSlug != wh.ChannelSlug || !got.LockToChannel {
		t.Fatalf("Get = %#v", got)
	}

	items, err := s.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(items) != 1 || items[0].ID != wh.ID {
		t.Fatalf("List = %#v", items)
	}

	wh.Title = "CI Renamed"
	wh.LockToChannel = false
	if err := s.Update(ctx, wh); err != nil {
		t.Fatalf("Update: %v", err)
	}
	updated, err := s.Get(ctx, wh.ID)
	if err != nil {
		t.Fatalf("Get after update: %v", err)
	}
	if updated.Title != "CI Renamed" || updated.LockToChannel {
		t.Fatalf("Update not persisted: %#v", updated)
	}

	if err := s.Delete(ctx, wh.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get(ctx, wh.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete err = %v, want ErrNotFound", err)
	}
}

func TestIncomingWebhookStore_CreateDuplicate(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewIncomingWebhookStore(db)
	ctx := context.Background()
	now := time.Now().Truncate(time.Millisecond)
	wh := &model.IncomingWebhook{
		ID:        "wh-duplicate",
		Title:     "CI",
		ChannelID: "ch-general",
		CreatedBy: "admin-1",
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := s.Create(ctx, wh); err != nil {
		t.Fatalf("Create first: %v", err)
	}
	if err := s.Create(ctx, wh); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("Create duplicate err = %v, want ErrAlreadyExists", err)
	}
}

func TestIncomingWebhookStore_UpdateMissing(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewIncomingWebhookStore(db)
	ctx := context.Background()
	now := time.Now().Truncate(time.Millisecond)
	wh := &model.IncomingWebhook{
		ID:        "wh-missing-update",
		Title:     "CI",
		ChannelID: "ch-general",
		CreatedBy: "admin-1",
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.Update(ctx, wh); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Update missing err = %v, want ErrNotFound", err)
	}
}
