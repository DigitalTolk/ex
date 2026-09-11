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

func mkAgentTemplateFixture(slug string) *model.AgentTemplate {
	now := time.Now().Truncate(time.Millisecond).UTC()
	return &model.AgentTemplate{
		Slug:        slug,
		DisplayName: slug,
		Harness:     model.HarnessClaude,
		Model:       "claude-opus-5",
		Persona:     "You are " + slug + ".",
		Limits:      model.DefaultAgentLimits(),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

func mkAgentUserFixture(id, slug string) *model.User {
	now := time.Now().Truncate(time.Millisecond).UTC()
	return &model.User{
		ID:           id,
		DisplayName:  slug,
		SystemRole:   model.SystemRoleMember,
		AuthProvider: model.AuthProviderAgent,
		Status:       "active",
		Kind:         model.UserKindAgent,
		AgentConfig:  &model.AgentConfig{TemplateSlug: slug},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

func mkRunnerFixture(ownerID, runnerID string) *model.RunnerRegistration {
	return &model.RunnerRegistration{
		RunnerID:       runnerID,
		OwnerID:        ownerID,
		LeaseExpiresAt: time.Now().Add(time.Minute).Truncate(time.Millisecond).UTC(),
	}
}

func TestAgentTemplateStore_CRUD(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAgentStore(db)

	tpl := mkAgentTemplateFixture("gg")
	if err := s.PutTemplate(ctx, tpl); err != nil {
		t.Fatalf("put: %v", err)
	}
	if err := s.PutTemplate(ctx, &model.AgentTemplate{}); err == nil {
		t.Fatal("put without slug: want error")
	}

	// Seed path: absent → written, present → ErrAlreadyExists (no clobber).
	if err := s.CreateTemplateIfAbsent(ctx, mkAgentTemplateFixture("qib")); err != nil {
		t.Fatalf("seed absent: %v", err)
	}
	if err := s.CreateTemplateIfAbsent(ctx, mkAgentTemplateFixture("gg")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("seed present: want ErrAlreadyExists, got %v", err)
	}

	got, err := s.GetTemplate(ctx, "gg")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Persona != tpl.Persona {
		t.Fatalf("get mismatch: %+v", got)
	}
	if _, err := s.GetTemplate(ctx, "absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get absent: want ErrNotFound, got %v", err)
	}

	all, err := s.ListTemplates(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("list: want 2 templates, got %d", len(all))
	}
}

func TestAgentUserStore_Create(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAgentStore(db)

	// Only agent-kind users belong here.
	if err := s.CreateAgentUser(ctx, &model.User{ID: "u-human"}); err == nil {
		t.Fatal("non-agent user: want error")
	}

	u := mkAgentUserFixture("u-agent-gg", "gg")
	if err := s.CreateAgentUser(ctx, u); err != nil {
		t.Fatalf("create: %v", err)
	}
	// Concurrent boots converge: the second write loses the conditional.
	if err := s.CreateAgentUser(ctx, mkAgentUserFixture("u-agent-gg", "gg")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("re-create: want ErrAlreadyExists, got %v", err)
	}
}

func TestAgentPrefsStore_RoundTrip(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAgentStore(db)

	if err := s.PutAgentPrefs(ctx, &model.UserAgentPrefs{UserID: "u-1"}); err == nil {
		t.Fatal("prefs without slug: want error")
	}

	p := &model.UserAgentPrefs{UserID: "u-1", Slug: "gg"}
	if err := s.PutAgentPrefs(ctx, p); err != nil {
		t.Fatalf("put: %v", err)
	}
	got, err := s.GetAgentPrefs(ctx, "u-1", "gg")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.UserID != "u-1" || got.Slug != "gg" {
		t.Fatalf("get mismatch: %+v", got)
	}
	// Never customized → ErrNotFound → caller inherits everything.
	if _, err := s.GetAgentPrefs(ctx, "u-1", "qib"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get absent: want ErrNotFound, got %v", err)
	}
}

func TestRunnerStore_CRUD(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAgentStore(db)

	if err := s.PutRunner(ctx, &model.RunnerRegistration{RunnerID: "r-1"}); err == nil {
		t.Fatal("runner without owner: want error")
	}

	if err := s.PutRunner(ctx, mkRunnerFixture("u-1", "r-1")); err != nil {
		t.Fatalf("put 1: %v", err)
	}
	// Heartbeat is an upsert refreshing the lease.
	if err := s.PutRunner(ctx, mkRunnerFixture("u-1", "r-1")); err != nil {
		t.Fatalf("re-put: %v", err)
	}
	if err := s.PutRunner(ctx, mkRunnerFixture("u-1", "r-2")); err != nil {
		t.Fatalf("put 2: %v", err)
	}

	runners, err := s.ListRunners(ctx, "u-1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(runners) != 2 {
		t.Fatalf("list: want 2 runners, got %d", len(runners))
	}

	if err := s.DeleteRunner(ctx, "u-1", "r-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	runners, err = s.ListRunners(ctx, "u-1")
	if err != nil || len(runners) != 1 {
		t.Fatalf("list after delete: want 1, got %d (%v)", len(runners), err)
	}
}

func TestAgentStore_SDKErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("PutTemplate PutItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.PutTemplate(ctx, mkAgentTemplateFixture("e")); !errors.Is(err, errInjected) {
			t.Fatalf("PutTemplate: want errInjected, got %v", err)
		}
	})
	t.Run("CreateTemplateIfAbsent PutItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.CreateTemplateIfAbsent(ctx, mkAgentTemplateFixture("e")); !errors.Is(err, errInjected) {
			t.Fatalf("CreateTemplateIfAbsent: want errInjected, got %v", err)
		}
	})
	t.Run("GetTemplate GetItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetTemplate(ctx, "e"); !errors.Is(err, errInjected) {
			t.Fatalf("GetTemplate: want errInjected, got %v", err)
		}
	})
	t.Run("ListTemplates QueryError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListTemplates(ctx); !errors.Is(err, errInjected) {
			t.Fatalf("ListTemplates: want errInjected, got %v", err)
		}
	})
	t.Run("CreateAgentUser PutItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.CreateAgentUser(ctx, mkAgentUserFixture("u-e", "e")); !errors.Is(err, errInjected) {
			t.Fatalf("CreateAgentUser: want errInjected, got %v", err)
		}
	})
	t.Run("PutAgentPrefs PutItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.PutAgentPrefs(ctx, &model.UserAgentPrefs{UserID: "u", Slug: "s"}); !errors.Is(err, errInjected) {
			t.Fatalf("PutAgentPrefs: want errInjected, got %v", err)
		}
	})
	t.Run("GetAgentPrefs GetItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetAgentPrefs(ctx, "u", "s"); !errors.Is(err, errInjected) {
			t.Fatalf("GetAgentPrefs: want errInjected, got %v", err)
		}
	})
	t.Run("PutRunner PutItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.PutRunner(ctx, mkRunnerFixture("u", "r")); !errors.Is(err, errInjected) {
			t.Fatalf("PutRunner: want errInjected, got %v", err)
		}
	})
	t.Run("ListRunners QueryError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListRunners(ctx, "u"); !errors.Is(err, errInjected) {
			t.Fatalf("ListRunners: want errInjected, got %v", err)
		}
	})
	t.Run("DeleteRunner DeleteItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
		if err := s.DeleteRunner(ctx, "u", "r"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteRunner: want errInjected, got %v", err)
		}
	})
}

func TestAgentStore_CorruptRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	corruptQ := func(f *faultClient) {
		f.transformQuery = func(o *dynamodb.QueryOutput) *dynamodb.QueryOutput {
			o.Items = []map[string]types.AttributeValue{corruptRow()}
			return o
		}
	}

	t.Run("GetTemplate", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) { f.transformGetItem = corruptGetItem })
		_, err := NewAgentStore(faulted).GetTemplate(ctx, "x")
		assertUnmarshalErr(t, err, "GetTemplate")
	})
	t.Run("GetAgentPrefs", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) { f.transformGetItem = corruptGetItem })
		_, err := NewAgentStore(faulted).GetAgentPrefs(ctx, "u-x", "x")
		assertUnmarshalErr(t, err, "GetAgentPrefs")
	})
	t.Run("ListTemplates", func(t *testing.T) {
		_, err := NewAgentStore(withFault(db, corruptQ)).ListTemplates(ctx)
		assertUnmarshalErr(t, err, "ListTemplates")
	})
	t.Run("ListRunners", func(t *testing.T) {
		_, err := NewAgentStore(withFault(db, corruptQ)).ListRunners(ctx, "u-x")
		assertUnmarshalErr(t, err, "ListRunners")
	})
}
