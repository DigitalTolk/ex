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

func mkConnectorFixture(slug string, fileNames ...string) *model.Connector {
	now := time.Now().Truncate(time.Millisecond).UTC()
	return &model.Connector{
		Slug:      slug,
		Title:     "Test Service",
		BaseURL:   "https://api.example.net",
		AuthKind:  model.ConnectorAuthPaste,
		FileNames: fileNames,
		CreatedBy: "u-admin",
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func mkConnFiles(slug string, names ...string) []model.ConnectorFile {
	out := make([]model.ConnectorFile, 0, len(names))
	for _, n := range names {
		out = append(out, model.ConnectorFile{Slug: slug, Name: n, Content: "docs for " + n})
	}
	return out
}

func TestConnectorStore_PutGetListDelete(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewConnectorStore(db)

	c := mkConnectorFixture("svc", "index.yml", "api.yaml")
	if err := s.PutConnector(ctx, c, mkConnFiles("svc", "index.yml", "api.yaml")); err != nil {
		t.Fatalf("put: %v", err)
	}

	got, err := s.GetConnector(ctx, "svc")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Title != c.Title || len(got.FileNames) != 2 {
		t.Fatalf("get mismatch: %+v", got)
	}
	if _, err := s.GetConnector(ctx, "absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get absent: want ErrNotFound, got %v", err)
	}

	files, err := s.GetConnectorFiles(ctx, "svc")
	if err != nil {
		t.Fatalf("files: %v", err)
	}
	if len(files) != 2 || files[0].Slug != "svc" || files[0].Content == "" {
		t.Fatalf("files mismatch: %+v", files)
	}

	// Re-put with a smaller manifest: the dropped file must be pruned.
	c2 := mkConnectorFixture("svc", "index.yml")
	if err := s.PutConnector(ctx, c2, mkConnFiles("svc", "index.yml")); err != nil {
		t.Fatalf("re-put: %v", err)
	}
	files, err = s.GetConnectorFiles(ctx, "svc")
	if err != nil {
		t.Fatalf("files after prune: %v", err)
	}
	if len(files) != 1 || files[0].Name != "index.yml" {
		t.Fatalf("prune failed: %+v", files)
	}

	if err := s.PutConnector(ctx, mkConnectorFixture("svc2", "a.yaml"), mkConnFiles("svc2", "a.yaml")); err != nil {
		t.Fatalf("put svc2: %v", err)
	}
	all, err := s.ListConnectors(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("list: want 2 connectors, got %d", len(all))
	}

	if err := s.DeleteConnector(ctx, "svc"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.GetConnector(ctx, "svc"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete: want ErrNotFound, got %v", err)
	}
	files, err = s.GetConnectorFiles(ctx, "svc")
	if err != nil || len(files) != 0 {
		t.Fatalf("files after delete: want none, got %v (%v)", files, err)
	}
	// Deleting a missing connector surfaces the lookup error.
	if err := s.DeleteConnector(ctx, "svc"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete absent: want ErrNotFound, got %v", err)
	}
}

func TestConnectorStore_Put_Validation(t *testing.T) {
	db := setupDynamoDB(t)
	if err := NewConnectorStore(db).PutConnector(context.Background(), &model.Connector{}, nil); err == nil {
		t.Fatal("put without slug: want error")
	}
}

func TestConnectorStore_FilePut_RealSizeError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewConnectorStore(db)
	// Meta row writes fine; the >400KB FILE row is rejected by DynamoDB itself,
	// exercising the per-file put error arm with a genuine SDK error.
	big := []model.ConnectorFile{{Slug: "svc-big", Name: "huge.yaml", Content: strings.Repeat("x", 450*1024)}}
	err := s.PutConnector(ctx, mkConnectorFixture("svc-big", "huge.yaml"), big)
	if err == nil || !strings.Contains(err.Error(), "put connector file") {
		t.Fatalf("oversized file: want file-put error, got %v", err)
	}
}

func TestConnectorStore_SDKErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	// Seed a connector with two files so prune/delete paths have work to do.
	real := NewConnectorStore(db)
	if err := real.PutConnector(ctx, mkConnectorFixture("svc-e", "a.yaml", "b.yaml"), mkConnFiles("svc-e", "a.yaml", "b.yaml")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// And one with no files, so DeleteConnector's meta-delete arm is reachable
	// with every DeleteItem faulted (the file loop is empty).
	if err := real.PutConnector(ctx, mkConnectorFixture("svc-nofiles"), nil); err != nil {
		t.Fatalf("seed nofiles: %v", err)
	}

	t.Run("PutConnector meta PutItemError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		err := s.PutConnector(ctx, mkConnectorFixture("svc-x", "a.yaml"), mkConnFiles("svc-x", "a.yaml"))
		if !errors.Is(err, errInjected) {
			t.Fatalf("PutConnector: want errInjected, got %v", err)
		}
	})
	t.Run("PutConnector prune DeleteItemError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
		// Shrinking svc-e's manifest forces a prune delete, which fails first.
		err := s.PutConnector(ctx, mkConnectorFixture("svc-e", "a.yaml"), mkConnFiles("svc-e", "a.yaml"))
		if !errors.Is(err, errInjected) {
			t.Fatalf("prune: want errInjected, got %v", err)
		}
	})
	t.Run("GetConnector GetItemError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetConnector(ctx, "svc-e"); !errors.Is(err, errInjected) {
			t.Fatalf("GetConnector: want errInjected, got %v", err)
		}
	})
	t.Run("ListConnectors QueryError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListConnectors(ctx); !errors.Is(err, errInjected) {
			t.Fatalf("ListConnectors: want errInjected, got %v", err)
		}
	})
	t.Run("GetConnectorFiles QueryError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.GetConnectorFiles(ctx, "svc-e"); !errors.Is(err, errInjected) {
			t.Fatalf("GetConnectorFiles: want errInjected, got %v", err)
		}
	})
	t.Run("DeleteConnector file DeleteItemError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
		if err := s.DeleteConnector(ctx, "svc-e"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteConnector files: want errInjected, got %v", err)
		}
	})
	t.Run("DeleteConnector meta DeleteItemError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
		if err := s.DeleteConnector(ctx, "svc-nofiles"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteConnector meta: want errInjected, got %v", err)
		}
	})
	t.Run("DeleteConnector lookup GetItemError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if err := s.DeleteConnector(ctx, "svc-e"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteConnector lookup: want errInjected, got %v", err)
		}
	})
}

func TestConnectorInstallStore_CRUD(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewConnectorStore(db)

	in := &model.ConnectorInstall{UserID: "u-1", ConnectorSlug: "svc", Token: "tok", Status: "connected"}
	if err := s.PutInstall(ctx, in); err != nil {
		t.Fatalf("put: %v", err)
	}
	got, err := s.GetInstall(ctx, "u-1", "svc")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Token != "tok" || got.Status != "connected" {
		t.Fatalf("get mismatch: %+v", got)
	}
	if _, err := s.GetInstall(ctx, "u-1", "absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get absent: want ErrNotFound, got %v", err)
	}

	if err := s.PutInstall(ctx, &model.ConnectorInstall{UserID: "u-1", ConnectorSlug: "svc2", Token: "t2", Status: "unverified"}); err != nil {
		t.Fatalf("put 2: %v", err)
	}
	all, err := s.ListInstalls(ctx, "u-1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("list: want 2 installs, got %d", len(all))
	}

	if err := s.DeleteInstall(ctx, "u-1", "svc"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	all, err = s.ListInstalls(ctx, "u-1")
	if err != nil || len(all) != 1 {
		t.Fatalf("list after delete: want 1, got %d (%v)", len(all), err)
	}
}

func TestConnectorInstallStore_ValidationAndFaults(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	if err := NewConnectorStore(db).PutInstall(ctx, &model.ConnectorInstall{UserID: "u-1"}); err == nil {
		t.Fatal("install without slug: want error")
	}

	t.Run("Put PutItemError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		err := s.PutInstall(ctx, &model.ConnectorInstall{UserID: "u", ConnectorSlug: "s"})
		if !errors.Is(err, errInjected) {
			t.Fatalf("PutInstall: want errInjected, got %v", err)
		}
	})
	t.Run("Get GetItemError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetInstall(ctx, "u", "s"); !errors.Is(err, errInjected) {
			t.Fatalf("GetInstall: want errInjected, got %v", err)
		}
	})
	t.Run("List QueryError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListInstalls(ctx, "u"); !errors.Is(err, errInjected) {
			t.Fatalf("ListInstalls: want errInjected, got %v", err)
		}
	})
	t.Run("Delete DeleteItemError", func(t *testing.T) {
		s := NewConnectorStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
		if err := s.DeleteInstall(ctx, "u", "s"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteInstall: want errInjected, got %v", err)
		}
	})
}

func TestConnectorStore_CorruptAndForeignRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	corruptQ := func(f *faultClient) {
		f.transformQuery = func(o *dynamodb.QueryOutput) *dynamodb.QueryOutput {
			o.Items = []map[string]types.AttributeValue{corruptRow()}
			return o
		}
	}

	t.Run("GetConnector", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) { f.transformGetItem = corruptGetItem })
		_, err := NewConnectorStore(faulted).GetConnector(ctx, "svc-x")
		assertUnmarshalErr(t, err, "GetConnector")
	})
	t.Run("GetInstall", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) { f.transformGetItem = corruptGetItem })
		_, err := NewConnectorStore(faulted).GetInstall(ctx, "u-x", "svc-x")
		assertUnmarshalErr(t, err, "GetInstall")
	})
	t.Run("ListConnectors", func(t *testing.T) {
		_, err := NewConnectorStore(withFault(db, corruptQ)).ListConnectors(ctx)
		assertUnmarshalErr(t, err, "ListConnectors")
	})
	t.Run("GetConnectorFiles", func(t *testing.T) {
		_, err := NewConnectorStore(withFault(db, corruptQ)).GetConnectorFiles(ctx, "svc-x")
		assertUnmarshalErr(t, err, "GetConnectorFiles")
	})
	t.Run("ListInstalls corrupt", func(t *testing.T) {
		_, err := NewConnectorStore(withFault(db, corruptQ)).ListInstalls(ctx, "u-x")
		assertUnmarshalErr(t, err, "ListInstalls")
	})
	t.Run("ListInstalls skips non-install rows", func(t *testing.T) {
		// A row that unmarshals fine but whose SK is not CONNINST# must be
		// skipped by the defensive prefix check, not returned.
		faulted := withFault(db, func(f *faultClient) {
			f.transformQuery = func(o *dynamodb.QueryOutput) *dynamodb.QueryOutput {
				o.Items = append(o.Items, map[string]types.AttributeValue{
					"PK":            &types.AttributeValueMemberS{Value: "USER#u-skip"},
					"SK":            &types.AttributeValueMemberS{Value: "OTHER#row"},
					"userID":        &types.AttributeValueMemberS{Value: "u-skip"},
					"connectorSlug": &types.AttributeValueMemberS{Value: "ghost"},
				})
				return o
			}
		})
		got, err := NewConnectorStore(faulted).ListInstalls(ctx, "u-skip")
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		if len(got) != 0 {
			t.Fatalf("foreign row not skipped: %+v", got)
		}
	})
}
