//go:build integration

package store

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// These tests drive the SDK-call error branches in the category store. Seeds go
// through the real db; the op under test runs through a faultClient.

func TestCategoryStore_Create_TransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewCategoryStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.Create(ctx, makeCategory("u-cat-e", "cat-e", "Eng", 1))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Create: want errInjected, got %v", err)
	}
}

func TestCategoryStore_Get_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewCategoryStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.Get(ctx, "u-cat-e", "cat-e")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Get: want errInjected, got %v", err)
	}
}

func TestCategoryStore_List_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewCategoryStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.List(ctx, "u-cat-e")
	if !errors.Is(err, errInjected) {
		t.Fatalf("List: want errInjected, got %v", err)
	}
}

// Update's same-name path issues a single UpdateItem; faulting it exercises the
// non-condition error branch.
func TestCategoryStore_Update_SameName_UpdateItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	c := makeCategory("u-cat-u", "cat-u", "Engineering", 1)
	if err := NewCategoryStore(db).Create(ctx, c); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewCategoryStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	c.Position = 5 // same name → UpdateItem path
	err := s.Update(ctx, c)
	if !errors.Is(err, errInjected) {
		t.Fatalf("Update same-name: want errInjected, got %v", err)
	}
}

// Update's rename path issues a TransactWriteItems; faulting it exercises the
// non-condition error branch.
func TestCategoryStore_Update_Rename_TransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	c := makeCategory("u-cat-r", "cat-r", "Engineering", 1)
	if err := NewCategoryStore(db).Create(ctx, c); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewCategoryStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	c.Name = "Design" // different name → transaction path
	err := s.Update(ctx, c)
	if !errors.Is(err, errInjected) {
		t.Fatalf("Update rename: want errInjected, got %v", err)
	}
}

func TestCategoryStore_Delete_TransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	c := makeCategory("u-cat-d", "cat-d", "Engineering", 1)
	if err := NewCategoryStore(db).Create(ctx, c); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewCategoryStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.Delete(ctx, "u-cat-d", "cat-d")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Delete: want errInjected, got %v", err)
	}
}

// Delete's Get pre-read surfaces a non-NotFound error directly.
func TestCategoryStore_Delete_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewCategoryStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	err := s.Delete(ctx, "u-cat-x", "cat-x")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Delete Get: want errInjected, got %v", err)
	}
}

// Update's Get pre-read surfaces a non-NotFound error directly.
func TestCategoryStore_Update_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewCategoryStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	err := s.Update(ctx, makeCategory("u-cat-ug", "cat-ug", "Eng", 1))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Update Get: want errInjected, got %v", err)
	}
}

// List sorts by Position then by ID as a stable tiebreaker. Two categories with
// the same Position exercise the ID comparison.
func TestCategoryStore_List_SortsByIDTiebreaker(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewCategoryStore(db)
	// Same Position (0) for both, so the sort falls through to the ID compare.
	if err := s.Create(ctx, makeCategory("u-cat-sort", "cat-b", "Beta", 0)); err != nil {
		t.Fatalf("seed b: %v", err)
	}
	if err := s.Create(ctx, makeCategory("u-cat-sort", "cat-a", "Alpha", 0)); err != nil {
		t.Fatalf("seed a: %v", err)
	}
	cats, err := s.List(ctx, "u-cat-sort")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(cats) != 2 {
		t.Fatalf("List: want 2, got %d", len(cats))
	}
	if cats[0].ID != "cat-a" || cats[1].ID != "cat-b" {
		t.Fatalf("List sort order: got [%s, %s], want [cat-a, cat-b]", cats[0].ID, cats[1].ID)
	}
}

// deleteOnUpdateClient delegates every call to the real client, except it
// deletes the target row immediately BEFORE the first UpdateItem runs. This
// reproduces the TOCTOU window where Update's Get pre-read succeeds but the
// subsequent conditional UpdateItem fails its attribute_exists(PK) guard.
type deleteOnUpdateClient struct {
	DynamoAPI
	table  string
	pk, sk string
	fired  bool
}

func (c *deleteOnUpdateClient) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if !c.fired {
		c.fired = true
		_, _ = c.DynamoAPI.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName: aws.String(c.table),
			Key:       compositeKey(c.pk, c.sk),
		})
	}
	return c.DynamoAPI.UpdateItem(ctx, in, opts...)
}

// Update's same-name path returns ErrNotFound when the row vanishes between the
// Get pre-read and the conditional UpdateItem.
func TestCategoryStore_Update_SameName_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	real := NewCategoryStore(db)
	c := makeCategory("u-cat-nf", "cat-nf", "Engineering", 1)
	if err := real.Create(ctx, c); err != nil {
		t.Fatalf("seed: %v", err)
	}
	doc := &deleteOnUpdateClient{
		DynamoAPI: db.Client,
		table:     db.Table,
		pk:        userPK("u-cat-nf"),
		sk:        categorySK("cat-nf"),
	}
	s := NewCategoryStore(&DB{Client: doc, Table: db.Table})
	c.Position = 9 // same name → single UpdateItem path
	err := s.Update(ctx, c)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Update same-name on vanished row: want ErrNotFound, got %v", err)
	}
}
