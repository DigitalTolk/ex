//go:build integration

package store

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"
)

func TestSharePointLinks(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewSharePointStore(db)

	if _, err := s.GetSharePointLink(ctx, "ch-sp", "https://contoso.sharepoint.com/a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing link: err = %v, want ErrNotFound", err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	for _, url := range []string{"https://contoso.sharepoint.com/a", "https://contoso.sharepoint.com/b"} {
		if err := s.PutSharePointLink(ctx, &SharePointLink{
			ParentID: "ch-sp", URL: url, MessageIDs: []string{"m-1"}, PosterID: "u-1",
			Status: "pending", CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatalf("put link: %v", err)
		}
	}
	// Another parent's links stay out of the list.
	if err := s.PutSharePointLink(ctx, &SharePointLink{ParentID: "ch-other", URL: "https://contoso.sharepoint.com/a", Status: "pending"}); err != nil {
		t.Fatalf("put other: %v", err)
	}

	got, err := s.GetSharePointLink(ctx, "ch-sp", "https://contoso.sharepoint.com/a")
	if err != nil || got.PosterID != "u-1" || !slices.Equal(got.MessageIDs, []string{"m-1"}) || !got.CreatedAt.Equal(now) {
		t.Fatalf("get link = %+v, %v", got, err)
	}
	got.Status, got.ItemID, got.MessageIDs = "shared", "item-1", append(got.MessageIDs, "m-2")
	if err := s.PutSharePointLink(ctx, got); err != nil {
		t.Fatalf("update link: %v", err)
	}
	links, err := s.ListSharePointLinks(ctx, "ch-sp")
	if err != nil || len(links) != 2 {
		t.Fatalf("list links = %+v, %v", links, err)
	}
	for _, l := range links {
		if l.URL == "https://contoso.sharepoint.com/a" && (l.Status != "shared" || l.ItemID != "item-1" || len(l.MessageIDs) != 2) {
			t.Fatalf("updated link listed as %+v", l)
		}
	}

	if err := s.DeleteSharePointLink(ctx, "ch-sp", "https://contoso.sharepoint.com/a"); err != nil {
		t.Fatalf("delete link: %v", err)
	}
	if links, _ := s.ListSharePointLinks(ctx, "ch-sp"); len(links) != 1 || links[0].URL != "https://contoso.sharepoint.com/b" {
		t.Fatalf("after delete: %+v", links)
	}
}

func TestSharePointItems(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewSharePointStore(db)

	id := SharePointItemID("drive-1", "item-1")
	if id != SharePointItemID("drive-1", "item-1") || id == SharePointItemID("drive-1", "item-2") || len(id) != 32 {
		t.Fatalf("item id %q is not stable and distinct", id)
	}
	if _, err := s.GetSharePointItem(ctx, "ch-spi", id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing item: err = %v", err)
	}
	item := &SharePointItem{
		ParentID: "ch-spi", ID: id, DriveID: "drive-1", ItemID: "item-1", Name: "Plan.docx", Size: 42,
		WebURL: "https://contoso.sharepoint.com/Plan.docx", EditURL: "https://contoso.sharepoint.com/_layouts/15/Doc.aspx",
		DownloadURL: "https://contoso.sharepoint.com/_layouts/15/download.aspx?UniqueId=u",
		GrantorID:   "u-1", Grants: map[string]string{"u-2": "perm-2", "u-3": ""}, NotShared: []string{"u-4"},
		MessageID: "m-1", AuthorID: "u-1", SharedAt: time.Now().UTC().Truncate(time.Millisecond),
	}
	if err := s.PutSharePointItem(ctx, item); err != nil {
		t.Fatalf("put item: %v", err)
	}
	got, err := s.GetSharePointItem(ctx, "ch-spi", id)
	if err != nil || got.Name != "Plan.docx" || got.DownloadURL != item.DownloadURL || got.Grants["u-2"] != "perm-2" || got.Grants["u-3"] != "" || len(got.Grants) != 2 ||
		!slices.Equal(got.NotShared, []string{"u-4"}) || !got.SharedAt.Equal(item.SharedAt) {
		t.Fatalf("get item = %+v, %v", got, err)
	}
	items, err := s.ListSharePointItems(ctx, "ch-spi")
	if err != nil || len(items) != 1 || items[0].ID != id {
		t.Fatalf("list items = %+v, %v", items, err)
	}
	if links, _ := s.ListSharePointLinks(ctx, "ch-spi"); len(links) != 0 {
		t.Fatalf("items listed as links: %+v", links)
	}
	item.Retired = true
	if err := s.PutSharePointItem(ctx, item); err != nil {
		t.Fatalf("retire item: %v", err)
	}
	if got, err := s.GetSharePointItem(ctx, "ch-spi", id); err != nil || !got.Retired {
		t.Fatalf("retired item = %+v, %v", got, err)
	}
	if err := s.DeleteSharePointItem(ctx, "ch-spi", id); err != nil {
		t.Fatalf("delete item: %v", err)
	}
	if items, _ := s.ListSharePointItems(ctx, "ch-spi"); len(items) != 0 {
		t.Fatalf("after delete: %+v", items)
	}
}

func TestSharePointUnfinished(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewSharePointStore(db)

	for _, u := range []SharePointUnfinished{
		{UserID: "u-unf", ParentID: "ch-1", ParentType: "channel"},
		{UserID: "u-unf", ParentID: "conv-1", ParentType: "conversation"},
		{UserID: "u-other", ParentID: "ch-1", ParentType: "channel"},
	} {
		if err := s.PutSharePointUnfinished(ctx, &u); err != nil {
			t.Fatalf("put: %v", err)
		}
	}
	// The user's other rows stay out of the list.
	if err := NewDelegatedTokenStore(db).PutDelegatedToken(ctx, "u-unf", []byte{1}); err != nil {
		t.Fatalf("put token: %v", err)
	}
	got, err := s.ListSharePointUnfinished(ctx, "u-unf")
	if err != nil || len(got) != 2 || got[0].ParentID != "ch-1" || got[0].ParentType != "channel" ||
		got[1].ParentID != "conv-1" || got[1].ParentType != "conversation" || got[0].UpdatedAt.IsZero() {
		t.Fatalf("list = %+v, %v", got, err)
	}
	if err := s.DeleteSharePointUnfinished(ctx, "u-unf", "ch-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got, _ := s.ListSharePointUnfinished(ctx, "u-unf"); len(got) != 1 || got[0].ParentID != "conv-1" {
		t.Fatalf("after delete: %+v", got)
	}
	if got, _ := s.ListSharePointUnfinished(ctx, "u-other"); len(got) != 1 {
		t.Fatalf("other user's: %+v", got)
	}
}

func TestDelegatedTokens(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewDelegatedTokenStore(db)

	if _, err := s.GetDelegatedToken(ctx, "u-tok"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing token: err = %v", err)
	}
	if err := s.PutDelegatedToken(ctx, "u-tok", []byte{1, 2, 3}); err != nil {
		t.Fatalf("put: %v", err)
	}
	if err := s.PutDelegatedToken(ctx, "u-tok", []byte{4, 5}); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if got, err := s.GetDelegatedToken(ctx, "u-tok"); err != nil || !slices.Equal(got, []byte{4, 5}) {
		t.Fatalf("get = %v, %v", got, err)
	}
	if err := s.DeleteDelegatedToken(ctx, "u-tok"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.GetDelegatedToken(ctx, "u-tok"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after delete: err = %v", err)
	}
}

func TestSharePointStoreErrors(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	puts := NewSharePointStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	if err := puts.PutSharePointLink(ctx, &SharePointLink{ParentID: "p", URL: "u"}); !errors.Is(err, errInjected) {
		t.Fatalf("put link: %v", err)
	}
	if err := puts.PutSharePointItem(ctx, &SharePointItem{ParentID: "p", ID: "i"}); !errors.Is(err, errInjected) {
		t.Fatalf("put item: %v", err)
	}
	if err := NewDelegatedTokenStore(withFault(db, func(f *faultClient) { f.failPutItem = true })).PutDelegatedToken(ctx, "u", nil); !errors.Is(err, errInjected) {
		t.Fatalf("put token: %v", err)
	}
	deletes := NewSharePointStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
	if err := deletes.DeleteSharePointLink(ctx, "p", "u"); !errors.Is(err, errInjected) {
		t.Fatalf("delete link: %v", err)
	}
	if err := deletes.DeleteSharePointItem(ctx, "p", "i"); !errors.Is(err, errInjected) {
		t.Fatalf("delete item: %v", err)
	}
	if err := NewDelegatedTokenStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true })).DeleteDelegatedToken(ctx, "u"); !errors.Is(err, errInjected) {
		t.Fatalf("delete token: %v", err)
	}
	if _, err := NewDelegatedTokenStore(withFault(db, func(f *faultClient) { f.failGetItem = true })).GetDelegatedToken(ctx, "u"); !errors.Is(err, errInjected) {
		t.Fatalf("get token: %v", err)
	}
}
