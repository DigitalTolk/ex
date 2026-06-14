package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestConv_ListUserConversations_ListError(t *testing.T) {
	svc, convs, _, _, _ := setupConversationService()
	convs.listErr = errors.New("boom")
	if _, err := svc.ListUserConversations(context.Background(), "u1"); err == nil {
		t.Fatal("expected list error")
	}
}

func TestConv_Activate_GetError(t *testing.T) {
	svc, convs, _, _, _ := setupConversationService()
	convs.getErr = errors.New("boom")
	if err := svc.Activate(context.Background(), "conv1"); err == nil {
		t.Fatal("expected get error")
	}
}

func TestConv_Activate_ActivateError(t *testing.T) {
	svc, convs, _, _, _ := setupConversationService()
	convs.conversations["conv1"] = &model.Conversation{ID: "conv1", ParticipantIDs: []string{"u1", "u2"}}
	convs.activateErr = errors.New("boom")
	if err := svc.Activate(context.Background(), "conv1"); err == nil {
		t.Fatal("expected activate error")
	}
}

func TestConv_SetFavorite_NotParticipant(t *testing.T) {
	svc, convs, _, _, _ := setupConversationService()
	convs.conversations["conv1"] = &model.Conversation{ID: "conv1", ParticipantIDs: []string{"other"}}
	if err := svc.SetFavorite(context.Background(), "u1", "conv1", true); err == nil {
		t.Fatal("expected not-a-participant error")
	}
}

func TestConv_GetOrCreateGroup_GetErrorPropagates(t *testing.T) {
	svc, convs, _, _, _ := setupConversationService()
	// A non-NotFound get error must propagate rather than fall through to create.
	convs.getErr = errors.New("dynamo unavailable")
	if _, err := svc.GetOrCreateGroup(context.Background(), "creator", []string{"u2"}, "Group"); err == nil {
		t.Fatal("expected get error to propagate")
	}
}

func TestConv_enrichDMProfile_StableAvatarURL(t *testing.T) {
	svc, _, users, _, _ := setupConversationService()
	svc.SetMediaURLCache(newFakeMediaCache())
	users.users["other"] = &model.User{ID: "other", AvatarKey: "avatars/other.png"}
	c := &model.UserConversation{Type: model.ConversationTypeDM, ParticipantIDs: []string{"me", "other"}}
	svc.enrichDMProfile(context.Background(), "me", c)
	if !c.ProfileResolved {
		t.Fatal("expected ProfileResolved")
	}
	if c.AvatarURL == "" {
		t.Fatal("expected stable media avatar URL")
	}
}

func TestConv_enrichDMProfile_SelfDMFallback(t *testing.T) {
	svc, _, users, _, _ := setupConversationService()
	users.users["me"] = &model.User{ID: "me", AvatarURL: "https://cdn/me.png"}
	// Only the caller is a participant — otherID resolution falls back to
	// ParticipantIDs[0].
	c := &model.UserConversation{Type: model.ConversationTypeDM, ParticipantIDs: []string{"me"}}
	svc.enrichDMProfile(context.Background(), "me", c)
	if c.AvatarURL != "https://cdn/me.png" {
		t.Fatalf("AvatarURL=%q, want resolved self avatar", c.AvatarURL)
	}
}

func TestConv_SetFavorite_StoreError(t *testing.T) {
	// Participant check passes (conversation lists the user), but no
	// user-side row exists, so the store SetFavorite returns ErrNotFound.
	svc, convs, _, _, _ := setupConversationService()
	convs.conversations["conv1"] = &model.Conversation{ID: "conv1", ParticipantIDs: []string{"u1", "u2"}}
	if err := svc.SetFavorite(context.Background(), "u1", "conv1", true); err == nil {
		t.Fatal("expected store set-favorite error")
	}
}

func TestConv_SetCategory_NotSupported(t *testing.T) {
	svc, _, _, _, _ := setupConversationService()
	if err := svc.SetCategory(context.Background(), "u1", "conv1", "cat-1", nil); err == nil {
		t.Fatal("expected categories-not-supported error")
	}
}

func TestConv_SetCategory_NotParticipant(t *testing.T) {
	svc, convs, _, _, _ := setupConversationService()
	convs.conversations["conv1"] = &model.Conversation{ID: "conv1", ParticipantIDs: []string{"other"}}
	if err := svc.SetCategory(context.Background(), "u1", "conv1", "", nil); err == nil {
		t.Fatal("expected not-a-participant error")
	}
}

type fakeProfileResolver struct {
	u   *model.User
	err error
}

func (f fakeProfileResolver) GetByID(_ context.Context, _ string) (*model.User, error) {
	return f.u, f.err
}

func TestConv_GetUserProfile_ViaResolver(t *testing.T) {
	svc, _, _, _, _ := setupConversationService()
	svc.SetUserProfileResolver(fakeProfileResolver{u: &model.User{ID: "u1", DisplayName: "X"}})
	got, err := svc.getUserProfile(context.Background(), "u1")
	if err != nil || got == nil || got.ID != "u1" {
		t.Fatalf("resolver path: got=%v err=%v", got, err)
	}
}

func TestConv_GetUserProfile_ResolverError(t *testing.T) {
	svc, _, _, _, _ := setupConversationService()
	svc.SetUserProfileResolver(fakeProfileResolver{err: errors.New("boom")})
	if _, err := svc.getUserProfile(context.Background(), "u1"); err == nil {
		t.Fatal("expected resolver error")
	}
}
