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

// TestIncomingWebhookStore_List_PaginatesAcrossScanPages guards the regression
// where webhooks functioned (resolved by ID, posted fine) but never appeared in
// the admin list because List ran a single un-paginated Scan. DynamoDB applies
// the 1MB read cap to raw items scanned *before* the filter, so on a busy
// shared table the webhooks beyond the first scanned page were dropped. Driving
// List through a one-item-per-page client forces the loop: all webhooks must
// come back regardless of how many pages the Scan spans.
func TestIncomingWebhookStore_List_PaginatesAcrossScanPages(t *testing.T) {
	db := setupDynamoDB(t)
	seed := NewIncomingWebhookStore(db)
	ctx := context.Background()
	now := time.Now().Truncate(time.Millisecond)

	ids := []string{"wh-page-a", "wh-page-b", "wh-page-c"}
	for _, id := range ids {
		if err := seed.Create(ctx, &model.IncomingWebhook{
			ID: id, Title: id, ChannelID: "ch-general", CreatedBy: "admin-1", CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}

	paged := &DB{Client: &pagedScanClient{DynamoAPI: db.Client}, Table: db.Table}
	s := NewIncomingWebhookStore(paged)

	items, err := s.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	got := make(map[string]bool, len(items))
	for _, it := range items {
		got[it.ID] = true
	}
	for _, id := range ids {
		if !got[id] {
			t.Fatalf("List dropped webhook %q across scan pages; got %d items %v", id, len(items), got)
		}
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
