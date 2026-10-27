//go:build integration

package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

func TestChannelStore_PatchChannel(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewChannelStore(db)
	ctx := context.Background()
	ch := makeChannel("ch-patch", "patch", "patch", model.ChannelTypePublic)
	if err := s.CreateChannel(ctx, ch); err != nil {
		t.Fatalf("Create: %v", err)
	}
	// A message lands while the edit is in flight: the patch must not roll
	// its MessageSeq back the way a whole-item write did.
	if _, err := s.IncrementMessageSeq(ctx, ch.ID); err != nil {
		t.Fatalf("IncrementMessageSeq: %v", err)
	}

	desc, archived := "the patch channel", true
	if err := s.PatchChannel(ctx, ch.ID, ChannelPatch{Description: &desc, Archived: &archived, UpdatedAt: time.Now()}); err != nil {
		t.Fatalf("PatchChannel: %v", err)
	}
	got, err := s.GetChannel(ctx, ch.ID)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if got.Description != desc || !got.Archived || got.MessageSeq != 1 || got.Name != "patch" {
		t.Errorf("channel = %+v, want description + archived set, MessageSeq 1 kept", got)
	}

	empty := ""
	if err := s.PatchChannel(ctx, ch.ID, ChannelPatch{Description: &empty, UpdatedAt: time.Now()}); err != nil {
		t.Fatalf("PatchChannel clear: %v", err)
	}
	if got, _ := s.GetChannel(ctx, ch.ID); got.Description != "" || !got.Archived {
		t.Errorf("after clearing the description: %+v", got)
	}

	if err := s.PatchChannel(ctx, "ch-none", ChannelPatch{UpdatedAt: time.Now()}); !errors.Is(err, ErrNotFound) {
		t.Errorf("PatchChannel on a missing channel = %v, want ErrNotFound", err)
	}
	fs := NewChannelStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if err := fs.PatchChannel(ctx, ch.ID, ChannelPatch{UpdatedAt: time.Now()}); !errors.Is(err, errInjected) {
		t.Errorf("PatchChannel fault = %v, want errInjected", err)
	}
}

func TestChannelStore_RenameChannel(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewChannelStore(db)
	ctx := context.Background()
	ch := makeChannel("ch-ren", "marketing", "marketing", model.ChannelTypePublic)
	other := makeChannel("ch-sales", "sales", "sales", model.ChannelTypePublic)
	for _, c := range []*model.Channel{ch, other} {
		if err := s.CreateChannel(ctx, c); err != nil {
			t.Fatalf("Create %s: %v", c.ID, err)
		}
	}
	if _, err := s.IncrementMessageSeq(ctx, ch.ID); err != nil {
		t.Fatalf("IncrementMessageSeq: %v", err)
	}

	if err := s.RenameChannel(ctx, ch.ID, "marketing", "growth", "growth", time.Now()); err != nil {
		t.Fatalf("RenameChannel: %v", err)
	}
	got, err := s.GetChannelBySlug(ctx, "growth")
	if err != nil || got.ID != ch.ID || got.Name != "growth" || got.Slug != "growth" || got.MessageSeq != 1 {
		t.Fatalf("by new slug = (%+v, %v), want the renamed channel with its MessageSeq", got, err)
	}
	// The old slug still finds it — links made before the rename work.
	if old, err := s.GetChannelBySlug(ctx, "marketing"); err != nil || old.ID != ch.ID || old.Slug != "growth" {
		t.Fatalf("by old slug = (%+v, %v), want the renamed channel", old, err)
	}

	// Another channel's name is taken.
	if err := s.RenameChannel(ctx, ch.ID, "growth", "sales", "sales", time.Now()); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("rename onto a taken slug = %v, want ErrAlreadyExists", err)
	}
	if got, _ := s.GetChannel(ctx, ch.ID); got.Slug != "growth" {
		t.Fatalf("a refused rename changed the channel: %+v", got)
	}

	// A stale old slug (renamed meanwhile) changes nothing.
	if err := s.RenameChannel(ctx, ch.ID, "marketing", "brand", "brand", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rename from a stale slug = %v, want ErrNotFound", err)
	}

	// A freed name can be taken by a new channel — its alias gives way.
	fresh := makeChannel("ch-new-mkt", "marketing", "marketing", model.ChannelTypePublic)
	if err := s.CreateChannel(ctx, fresh); err != nil {
		t.Fatalf("Create over an alias: %v", err)
	}
	if got, err := s.GetChannelBySlug(ctx, "marketing"); err != nil || got.ID != fresh.ID {
		t.Fatalf("by slug after takeover = (%+v, %v), want the new channel", got, err)
	}

	// Renaming back onto its own old name works too.
	if err := s.RenameChannel(ctx, ch.ID, "growth", "growth-2024", "growth-2024", time.Now()); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if err := s.RenameChannel(ctx, ch.ID, "growth-2024", "growth", "growth", time.Now()); err != nil {
		t.Fatalf("rename back: %v", err)
	}
	if got, err := s.GetChannelBySlug(ctx, "growth"); err != nil || got.ID != ch.ID || got.Slug != "growth" {
		t.Fatalf("after renaming back = (%+v, %v)", got, err)
	}

	// Only the case of the name: the slug stays, just the name changes.
	if err := s.RenameChannel(ctx, ch.ID, "growth", "growth", "growth", time.Now()); err != nil {
		t.Fatalf("same-slug rename: %v", err)
	}
	if err := s.RenameChannel(ctx, ch.ID, "stale", "growth", "stale", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("same-slug rename from a stale slug = %v, want ErrNotFound", err)
	}

	if _, err := s.GetChannelBySlug(ctx, "never-existed"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown slug = %v, want ErrNotFound", err)
	}
}

// A channel from before slug locks existed has no lock to turn into an alias;
// renaming it still works.
func TestChannelStore_RenameChannelWithoutASlugLock(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewChannelStore(db)
	ctx := context.Background()
	ch := makeChannel("ch-legacy", "legacy", "legacy", model.ChannelTypePublic)
	if err := s.CreateChannel(ctx, ch); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := db.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(db.Table),
		Key:       compositeKey(chanSlugGSI1PK("legacy"), metaSK()),
	}); err != nil {
		t.Fatalf("drop the lock: %v", err)
	}
	if err := s.RenameChannel(ctx, ch.ID, "legacy", "modern", "modern", time.Now()); err != nil {
		t.Fatalf("RenameChannel: %v", err)
	}
	if got, err := s.GetChannelBySlug(ctx, "legacy"); err != nil || got.ID != ch.ID {
		t.Fatalf("old slug = (%+v, %v), want an alias to the channel", got, err)
	}
}

func TestChannelStore_RenameChannelFaults(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ch := makeChannel("ch-rf", "faulty", "faulty", model.ChannelTypePublic)
	if err := NewChannelStore(db).CreateChannel(ctx, ch); err != nil {
		t.Fatalf("Create: %v", err)
	}
	tx := NewChannelStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	if err := tx.RenameChannel(ctx, ch.ID, "faulty", "sound", "sound", time.Now()); !errors.Is(err, errInjected) {
		t.Errorf("rename transaction fault = %v, want errInjected", err)
	}
	upd := NewChannelStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if err := upd.RenameChannel(ctx, ch.ID, "faulty", "faulty", "faulty", time.Now()); !errors.Is(err, errInjected) {
		t.Errorf("same-slug rename fault = %v, want errInjected", err)
	}
	get := NewChannelStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	if _, err := get.GetChannelBySlug(ctx, "no-such-slug"); !errors.Is(err, errInjected) {
		t.Errorf("alias lookup fault = %v, want errInjected", err)
	}
}

// Paging through public channels visits each one once: the cursor carries
// the last row's position, archived and private channels are left out.
func TestChannelStore_ListPublicChannelsPages(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewChannelStore(db)
	ctx := context.Background()
	want := map[string]bool{}
	base := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	for i := range 7 {
		ch := makeChannel(fmt.Sprintf("ch-page-%d", i), fmt.Sprintf("page-%d", i), fmt.Sprintf("page-%d", i), model.ChannelTypePublic)
		ch.CreatedAt = base.Add(time.Duration(i) * time.Minute)
		if err := s.CreateChannel(ctx, ch); err != nil {
			t.Fatalf("Create: %v", err)
		}
		want[ch.ID] = true
	}
	archived := makeChannel("ch-page-arch", "page-arch", "page-arch", model.ChannelTypePublic)
	archived.Archived = true
	private := makeChannel("ch-page-priv", "page-priv", "page-priv", model.ChannelTypePrivate)
	for _, ch := range []*model.Channel{archived, private} {
		if err := s.CreateChannel(ctx, ch); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	seen := map[string]int{}
	cursor := ""
	for range 20 {
		page, next, err := s.ListPublicChannels(ctx, 2, cursor)
		if err != nil {
			t.Fatalf("ListPublicChannels: %v", err)
		}
		for _, ch := range page {
			seen[ch.ID]++
		}
		if next == "" {
			break
		}
		cursor = next
	}
	for id := range want {
		if seen[id] != 1 {
			t.Errorf("%s seen %d times, want once", id, seen[id])
		}
	}
	if seen["ch-page-arch"] != 0 || seen["ch-page-priv"] != 0 {
		t.Errorf("archived or private channel listed: %v", seen)
	}
}

// Making a channel private takes it out of the public listing.
func TestChannelStore_PatchChannelMakePrivate(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewChannelStore(db)
	ctx := context.Background()
	ch := makeChannel("ch-to-priv", "to-priv", "to-priv", model.ChannelTypePublic)
	if err := s.CreateChannel(ctx, ch); err != nil {
		t.Fatalf("Create: %v", err)
	}
	listed := func() bool {
		page, _, err := s.ListPublicChannels(ctx, 100, "")
		if err != nil {
			t.Fatalf("ListPublicChannels: %v", err)
		}
		for _, c := range page {
			if c.ID == ch.ID {
				return true
			}
		}
		return false
	}
	if !listed() {
		t.Fatal("the public channel should be listed before")
	}
	if err := s.PatchChannel(ctx, ch.ID, ChannelPatch{MakePrivate: true, UpdatedAt: time.Now()}); err != nil {
		t.Fatalf("PatchChannel: %v", err)
	}
	if listed() {
		t.Error("a private channel must leave the public listing")
	}
	if got, err := s.GetChannelBySlug(ctx, "to-priv"); err != nil || got.Type != model.ChannelTypePrivate {
		t.Errorf("by slug = (%+v, %v), want it private and still found", got, err)
	}
}
