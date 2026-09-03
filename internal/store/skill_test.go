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

func mkSkillFixture(id, name string) *model.Skill {
	now := time.Now().Truncate(time.Millisecond).UTC()
	return &model.Skill{
		ID:           id,
		Name:         name,
		Description:  "workspace instruction pack",
		Instructions: "Always answer with a TL;DR first.",
		CreatedBy:    "u-seed",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

func TestSkillStore_CRUD(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAgentStore(db)

	sk := mkSkillFixture("sk-1", "TLDR-first")
	if err := s.PutSkill(ctx, sk); err != nil {
		t.Fatalf("put: %v", err)
	}

	got, err := s.GetSkill(ctx, "sk-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Name != sk.Name || got.Instructions != sk.Instructions || got.CreatedBy != sk.CreatedBy {
		t.Fatalf("get mismatch: %+v", got)
	}

	// Put with the same ID replaces, not duplicates.
	sk.Description = "updated"
	if err := s.PutSkill(ctx, sk); err != nil {
		t.Fatalf("re-put: %v", err)
	}

	if err := s.PutSkill(ctx, mkSkillFixture("sk-2", "Reviewer")); err != nil {
		t.Fatalf("put 2: %v", err)
	}
	all, err := s.ListSkills(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("list: want 2 skills, got %d", len(all))
	}

	if err := s.DeleteSkill(ctx, "sk-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.GetSkill(ctx, "sk-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete: want ErrNotFound, got %v", err)
	}
	// Deleting an absent skill is a no-op, not an error.
	if err := s.DeleteSkill(ctx, "sk-1"); err != nil {
		t.Fatalf("delete absent: %v", err)
	}
}

func TestSkillStore_PutSkill_IDRequired(t *testing.T) {
	db := setupDynamoDB(t)
	if err := NewAgentStore(db).PutSkill(context.Background(), &model.Skill{Name: "no-id"}); err == nil {
		t.Fatal("PutSkill with empty id: want error, got nil")
	}
}

// SDK-call error arms: seeds go through the real db; the op under test runs
// through a faultClient (same pattern as category_error_test.go).
func TestSkillStore_SDKErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("Put PutItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.PutSkill(ctx, mkSkillFixture("sk-e", "E")); !errors.Is(err, errInjected) {
			t.Fatalf("PutSkill: want errInjected, got %v", err)
		}
	})
	t.Run("Get GetItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetSkill(ctx, "sk-e"); !errors.Is(err, errInjected) {
			t.Fatalf("GetSkill: want errInjected, got %v", err)
		}
	})
	t.Run("List QueryError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListSkills(ctx); !errors.Is(err, errInjected) {
			t.Fatalf("ListSkills: want errInjected, got %v", err)
		}
	})
	t.Run("Delete DeleteItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
		if err := s.DeleteSkill(ctx, "sk-e"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteSkill: want errInjected, got %v", err)
		}
	})
}

// Unmarshal error arms via transform hooks feeding a row no struct can absorb.
func TestSkillStore_CorruptRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("GetSkill", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) {
			f.transformGetItem = func(o *dynamodb.GetItemOutput) *dynamodb.GetItemOutput {
				o.Item = corruptRow()
				return o
			}
		})
		_, err := NewAgentStore(faulted).GetSkill(ctx, "sk-x")
		assertUnmarshalErr(t, err, "GetSkill")
	})
	t.Run("ListSkills", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) {
			f.transformQuery = func(o *dynamodb.QueryOutput) *dynamodb.QueryOutput {
				o.Items = []map[string]types.AttributeValue{corruptRow()}
				return o
			}
		})
		_, err := NewAgentStore(faulted).ListSkills(ctx)
		assertUnmarshalErr(t, err, "ListSkills")
	})
}
