//go:build integration

package store

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

func setupRedisDraftStore(t *testing.T) (*RedisDraftStore, *redis.Client) {
	t.Helper()
	client := storeRedisClient(t)
	return NewRedisDraftStore(client), client
}

func draftWith(id, user, body, gen string) *model.MessageDraft {
	return &model.MessageDraft{ID: id, UserID: user, ParentID: "ch-1", ParentType: "channel", Body: body, Gen: gen}
}

func mustUpsert(t *testing.T, s *RedisDraftStore, draft *model.MessageDraft, basisGen string) {
	t.Helper()
	res, err := s.Upsert(context.Background(), draft, basisGen)
	if err != nil || !res.OK {
		t.Fatalf("Upsert(%q, basis=%q) = %+v, err=%v; want accepted", draft.Body, basisGen, res, err)
	}
}

func TestRedisDraftStore_UpsertGetListDelete(t *testing.T) {
	s, _ := setupRedisDraftStore(t)
	ctx := context.Background()

	if _, err := s.Get(ctx, "u-1", "d-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing = %v, want ErrNotFound", err)
	}

	// First save: the scope has no draft, so the empty basis is accepted.
	mustUpsert(t, s, draftWith("d-1", "u-1", "hello", NewID()), "")
	got, err := s.Get(ctx, "u-1", "d-1")
	if err != nil || got.Body != "hello" || got.Gen == "" {
		t.Fatalf("Get = %#v, err=%v", got, err)
	}

	// A follow-up save presenting the stored generation is accepted.
	mustUpsert(t, s, draftWith("d-1", "u-1", "hello world", NewID()), got.Gen)
	got2, err := s.Get(ctx, "u-1", "d-1")
	if err != nil || got2.Body != "hello world" || got2.Gen == got.Gen {
		t.Fatalf("Get after update = %#v, err=%v (want new body and a fresh gen)", got2, err)
	}

	mustUpsert(t, s, draftWith("d-2", "u-1", "other scope", NewID()), "")
	list, err := s.List(ctx, "u-1")
	if err != nil || len(list) != 2 {
		t.Fatalf("List = %#v, err=%v", list, err)
	}
	if other, _ := s.List(ctx, "u-other"); len(other) != 0 {
		t.Fatalf("List for another user should be empty, got %#v", other)
	}

	// Clearing with the current generation removes the draft.
	res, err := s.Delete(ctx, "u-1", "d-1", got2.Gen)
	if err != nil || !res.OK {
		t.Fatalf("Delete = %+v, err=%v", res, err)
	}
	if _, err := s.Get(ctx, "u-1", "d-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete = %v, want ErrNotFound", err)
	}
}

func TestRedisDraftStore_StaleBasisIsRejectedWithCurrent(t *testing.T) {
	s, _ := setupRedisDraftStore(t)
	ctx := context.Background()

	mustUpsert(t, s, draftWith("d-1", "u-2", "v1", NewID()), "")
	v1, _ := s.Get(ctx, "u-2", "d-1")
	mustUpsert(t, s, draftWith("d-1", "u-2", "v2", NewID()), v1.Gen)

	// A save presenting the superseded generation is rejected and handed the
	// stored row to reconcile against; nothing is written.
	res, err := s.Upsert(ctx, draftWith("d-1", "u-2", "zombie", NewID()), v1.Gen)
	if err != nil || res.OK {
		t.Fatalf("stale Upsert = %+v, err=%v; want rejection", res, err)
	}
	if res.Current == nil || res.Current.Body != "v2" {
		t.Fatalf("rejection must carry the current draft, got %#v", res.Current)
	}
	if got, _ := s.Get(ctx, "u-2", "d-1"); got.Body != "v2" {
		t.Fatalf("stale write must not apply, got %q", got.Body)
	}

	// Same for a save that believes no draft exists.
	res, err = s.Upsert(ctx, draftWith("d-1", "u-2", "blind", NewID()), "")
	if err != nil || res.OK || res.Current == nil || res.Current.Body != "v2" {
		t.Fatalf("blind Upsert = %+v (current %#v), err=%v; want rejection with current", res, res.Current, err)
	}

	// And for a stale delete: it must not remove a draft it never saw.
	dres, err := s.Delete(ctx, "u-2", "d-1", v1.Gen)
	if err != nil || dres.OK || dres.Current == nil || dres.Current.Body != "v2" {
		t.Fatalf("stale Delete = %+v (current %#v), err=%v; want rejection with current", dres, dres.Current, err)
	}
	if got, _ := s.Get(ctx, "u-2", "d-1"); got.Body != "v2" {
		t.Fatalf("stale delete must be rejected, got %q", got.Body)
	}
}

// Regression for the draft-resurrection bug: once a scope is cleared by its
// send (DeleteUnconditional), NO stale writer — a delayed keystroke save, a
// zombie tab flushed days later — may bring the content back. Absence only
// accepts writes that believe the scope is empty, so the stale basis is
// rejected forever; there is no tombstone TTL to outwait.
func TestRedisDraftStore_SendFoldBlocksResurrection(t *testing.T) {
	s, _ := setupRedisDraftStore(t)
	ctx := context.Background()

	mustUpsert(t, s, draftWith("d-1", "u-3", "typed before send", NewID()), "")
	preSend, _ := s.Get(ctx, "u-3", "d-1")

	if err := s.DeleteUnconditional(ctx, "u-3", "d-1"); err != nil {
		t.Fatalf("DeleteUnconditional: %v", err)
	}
	if _, err := s.Get(ctx, "u-3", "d-1"); !errors.Is(err, ErrNotFound) {
		t.Fatal("send fold must remove the draft")
	}

	// The delayed keystroke save (still carrying the pre-send generation)
	// arrives after the send: rejected, scope stays empty.
	res, err := s.Upsert(ctx, draftWith("d-1", "u-3", "typed before send", NewID()), preSend.Gen)
	if err != nil || res.OK {
		t.Fatalf("post-send stale save = %+v, err=%v; want rejection", res, err)
	}
	if res.Current != nil {
		t.Fatalf("scope is empty; rejection must carry nil current, got %#v", res.Current)
	}
	if _, err := s.Get(ctx, "u-3", "d-1"); !errors.Is(err, ErrNotFound) {
		t.Fatal("a pre-send save must not resurrect a sent draft")
	}

	// Genuinely new typing (a fresh composer session, empty basis) works.
	mustUpsert(t, s, draftWith("d-1", "u-3", "new draft", NewID()), "")
	if got, err := s.Get(ctx, "u-3", "d-1"); err != nil || got.Body != "new draft" {
		t.Fatalf("post-send fresh draft = %#v, err=%v", got, err)
	}
}

func TestRedisDraftStore_ClearAbsentScope(t *testing.T) {
	s, _ := setupRedisDraftStore(t)
	ctx := context.Background()

	// "My composer is empty" against an empty scope is an accepted no-op —
	// clients report the event unconditionally; the server decides.
	res, err := s.Delete(ctx, "u-4", "d-none", "")
	if err != nil || !res.OK {
		t.Fatalf("clear absent = %+v, err=%v; want accepted no-op", res, err)
	}
	// A clear presenting a generation for an absent draft is stale (the scope
	// moved on, e.g. a send removed it): rejected with nil current.
	res, err = s.Delete(ctx, "u-4", "d-none", "01OLDGEN")
	if err != nil || res.OK || res.Current != nil {
		t.Fatalf("stale clear of absent = %+v (current %#v), err=%v; want rejection", res, res.Current, err)
	}
}

// Pre-gen rows (raw JSON, no prefix) surface as the "legacy" generation and
// migrate lazily: the first accepted write rewrites them in the new format
// and drops the retired draftts hash.
func TestRedisDraftStore_LegacyRows(t *testing.T) {
	s, client := setupRedisDraftStore(t)
	ctx := context.Background()

	legacyJSON := `{"id":"d-1","userID":"u-5","parentID":"ch-1","parentType":"channel","body":"old format"}`
	if err := client.HSet(ctx, "draft:u-5", "d-1", legacyJSON).Err(); err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}
	if err := client.HSet(ctx, "draftts:u-5", "d-1", "1700000000000").Err(); err != nil {
		t.Fatalf("seed legacy ts row: %v", err)
	}

	got, err := s.Get(ctx, "u-5", "d-1")
	if err != nil || got.Body != "old format" || got.Gen != "legacy" {
		t.Fatalf("legacy Get = %#v, err=%v", got, err)
	}
	list, err := s.List(ctx, "u-5")
	if err != nil || len(list) != 1 || list[0].Gen != "legacy" {
		t.Fatalf("legacy List = %#v, err=%v", list, err)
	}

	// The empty basis does NOT match a legacy row — the client must read it
	// first (a blind write may not clobber content it never saw).
	res, err := s.Upsert(ctx, draftWith("d-1", "u-5", "blind", NewID()), "")
	if err != nil || res.OK || res.Current == nil || res.Current.Gen != "legacy" {
		t.Fatalf("blind write over legacy = %+v (current %#v), err=%v; want rejection", res, res.Current, err)
	}

	// Presenting "legacy" is accepted and rewrites the row in the new format;
	// the accepted write also drops the retired draftts hash.
	mustUpsert(t, s, draftWith("d-1", "u-5", "migrated", NewID()), "legacy")
	got, err = s.Get(ctx, "u-5", "d-1")
	if err != nil || got.Body != "migrated" || got.Gen == "legacy" || got.Gen == "" {
		t.Fatalf("migrated Get = %#v, err=%v", got, err)
	}
	if n := client.Exists(ctx, "draftts:u-5").Val(); n != 0 {
		t.Fatal("accepted write must drop the retired draftts hash")
	}
}

func TestRedisDraftStore_LegacyClear(t *testing.T) {
	s, client := setupRedisDraftStore(t)
	ctx := context.Background()

	legacyJSON := `{"id":"d-1","userID":"u-6","parentID":"ch-1","parentType":"channel","body":"old"}`
	if err := client.HSet(ctx, "draft:u-6", "d-1", legacyJSON).Err(); err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}
	res, err := s.Delete(ctx, "u-6", "d-1", "legacy")
	if err != nil || !res.OK {
		t.Fatalf("legacy Delete = %+v, err=%v", res, err)
	}
	if _, err := s.Get(ctx, "u-6", "d-1"); !errors.Is(err, ErrNotFound) {
		t.Fatal("legacy draft must be cleared")
	}
}

func TestRedisDraftStore_DeleteUnconditionalDropsRetiredTsHash(t *testing.T) {
	s, client := setupRedisDraftStore(t)
	ctx := context.Background()

	mustUpsert(t, s, draftWith("d-1", "u-7", "wip", NewID()), "")
	if err := client.HSet(ctx, "draftts:u-7", "d-1", "1700000000000").Err(); err != nil {
		t.Fatalf("seed retired ts row: %v", err)
	}
	if err := s.DeleteUnconditional(ctx, "u-7", "d-1"); err != nil {
		t.Fatalf("DeleteUnconditional: %v", err)
	}
	if _, err := s.Get(ctx, "u-7", "d-1"); !errors.Is(err, ErrNotFound) {
		t.Fatal("draft must be gone")
	}
	if n := client.Exists(ctx, "draftts:u-7").Val(); n != 0 {
		t.Fatal("send fold must drop the retired draftts hash")
	}
}

func TestRedisDraftStore_CorruptRows(t *testing.T) {
	s, client := setupRedisDraftStore(t)
	ctx := context.Background()

	if err := client.HSet(ctx, "draft:u-8", "d-bad", "not json at all").Err(); err != nil {
		t.Fatalf("seed corrupt row: %v", err)
	}
	if _, err := s.Get(ctx, "u-8", "d-bad"); err == nil {
		t.Error("Get of a corrupt row should error")
	}
	if _, err := s.List(ctx, "u-8"); err == nil {
		t.Error("List over a corrupt row should error")
	}
	// A rejected CAS write that must hand back a corrupt current row also
	// surfaces the decode error instead of fabricating state.
	if _, err := s.Upsert(ctx, draftWith("d-bad", "u-8", "x", NewID()), "mismatch"); err == nil {
		t.Error("Upsert conflict over a corrupt row should error")
	}
	if _, err := s.Delete(ctx, "u-8", "d-bad", "mismatch"); err == nil {
		t.Error("Delete conflict over a corrupt row should error")
	}
}

func TestRedisDraftStore_ClientErrors(t *testing.T) {
	s, mrClient := setupRedisDraftStore(t)
	ctx := context.Background()
	_ = mrClient.Close() // closed client: every command now errors
	if _, err := s.Upsert(ctx, draftWith("d-1", "u-9", "x", NewID()), ""); err == nil {
		t.Error("Upsert should error when Redis is down")
	}
	if _, err := s.Get(ctx, "u-9", "d-1"); err == nil {
		t.Error("Get should error when Redis is down")
	}
	if _, err := s.List(ctx, "u-9"); err == nil {
		t.Error("List should error when Redis is down")
	}
	if _, err := s.Delete(ctx, "u-9", "d-1", ""); err == nil {
		t.Error("Delete should error when Redis is down")
	}
	if err := s.DeleteUnconditional(ctx, "u-9", "d-1"); err == nil {
		t.Error("DeleteUnconditional should error when Redis is down")
	}
}
