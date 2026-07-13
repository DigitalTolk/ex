package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// stubDirectoryLookup is a programmable DirectoryLookup recording its input.
type stubDirectoryLookup struct {
	profile     *DirectoryProfile
	err         error
	gotEmail    string
	gotObjectID string
}

func (s *stubDirectoryLookup) LookupProfile(_ context.Context, email, objectID string) (*DirectoryProfile, error) {
	s.gotEmail, s.gotObjectID = email, objectID
	return s.profile, s.err
}

func userUpdatedEvents(t *testing.T, pub *mockPublisher) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, p := range pub.published {
		if p.event.Type != events.EventUserUpdated {
			continue
		}
		if p.channel != pubsub.UserEvents() {
			t.Errorf("user.updated published to %q, want %q", p.channel, pubsub.UserEvents())
		}
		var data map[string]any
		if err := json.Unmarshal(p.event.Data, &data); err != nil {
			t.Fatalf("unmarshal user.updated payload: %v", err)
		}
		out = append(out, data)
	}
	return out
}

func TestOIDCCallbackNewUserDirectoryEnrichment(t *testing.T) {
	env := setupAuthService()
	env.users.hasUsersVal = true
	env.oidc.userInfo.ObjectID = "oid-token"
	dir := &stubDirectoryLookup{profile: &DirectoryProfile{
		ObjectID: "oid-graph",
		Phone:    "+46 70 123 45 67",
		Manager:  &model.UserManager{DisplayName: "Boss", Email: "boss@example.com", UserID: "boss-1"},
	}}
	env.svc.SetDirectory(dir)

	_, _, user, err := env.svc.HandleOIDCCallback(context.Background(), "auth-code", "state", "nonce")
	if err != nil {
		t.Fatalf("HandleOIDCCallback: %v", err)
	}

	if dir.gotEmail != "oidc@example.com" || dir.gotObjectID != "oid-token" {
		t.Errorf("directory looked up (%q, %q), want normalized email + token oid", dir.gotEmail, dir.gotObjectID)
	}
	if user.Phone != "+46 70 123 45 67" {
		t.Errorf("Phone = %q, want synced phone", user.Phone)
	}
	if !user.Manager.Equal(dir.profile.Manager) {
		t.Errorf("Manager = %+v, want synced manager", user.Manager)
	}
	// The directory's canonical object id wins over the token claim.
	if user.MSObjectID != "oid-graph" {
		t.Errorf("MSObjectID = %q, want directory object id", user.MSObjectID)
	}
	if stored := env.users.users[user.ID]; stored == nil || stored.Phone != user.Phone {
		t.Error("enriched fields were not persisted with the created user")
	}
}

func TestOIDCCallbackExistingUserDirectoryChangePublishes(t *testing.T) {
	env := setupAuthService()
	pub := newMockPublisher()
	env.svc.SetPublisher(pub)
	existing := &model.User{
		ID:          "existing-user",
		Email:       "oidc@example.com",
		DisplayName: "Old Name",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
		Phone:       "+46 8 111 11 11",
	}
	env.users.users[existing.ID] = existing
	env.users.emailIndex[existing.Email] = existing
	// Seed the profile cache to prove the sync evicts it.
	_ = env.cache.Set(context.Background(), "user:existing-user", existing, 0)

	env.svc.SetDirectory(&stubDirectoryLookup{profile: &DirectoryProfile{
		Phone:   "+46 70 999 88 77",
		Manager: &model.UserManager{DisplayName: "Boss"},
	}})

	_, _, user, err := env.svc.HandleOIDCCallback(context.Background(), "auth-code", "state", "nonce")
	if err != nil {
		t.Fatalf("HandleOIDCCallback: %v", err)
	}
	if user.Phone != "+46 70 999 88 77" || user.Manager == nil {
		t.Errorf("user not enriched: phone=%q manager=%+v", user.Phone, user.Manager)
	}

	updates := userUpdatedEvents(t, pub)
	if len(updates) != 1 {
		t.Fatalf("user.updated events = %d, want 1", len(updates))
	}
	if updates[0]["phone"] != "+46 70 999 88 77" {
		t.Errorf("event phone = %v", updates[0]["phone"])
	}
	if updates[0]["id"] != "existing-user" {
		t.Errorf("event id = %v", updates[0]["id"])
	}
	if _, still := env.cache.values["user:existing-user"]; still {
		t.Error("cached profile was not evicted after the directory sync")
	}
}

func TestOIDCCallbackExistingUserDirectoryUnchangedStaysQuiet(t *testing.T) {
	env := setupAuthService()
	pub := newMockPublisher()
	env.svc.SetPublisher(pub)
	manager := &model.UserManager{DisplayName: "Boss", Email: "boss@example.com"}
	existing := &model.User{
		ID:         "existing-user",
		Email:      "oidc@example.com",
		SystemRole: model.SystemRoleMember,
		Status:     "active",
		Phone:      "+46 70 999 88 77",
		Manager:    &model.UserManager{DisplayName: "Boss", Email: "boss@example.com"},
	}
	env.users.users[existing.ID] = existing
	env.users.emailIndex[existing.Email] = existing

	env.svc.SetDirectory(&stubDirectoryLookup{profile: &DirectoryProfile{
		Phone:   "+46 70 999 88 77",
		Manager: manager,
	}})

	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "auth-code", "state", "nonce"); err != nil {
		t.Fatalf("HandleOIDCCallback: %v", err)
	}
	if got := userUpdatedEvents(t, pub); len(got) != 0 {
		t.Errorf("user.updated events = %d, want 0 when the directory data is unchanged", len(got))
	}
}

func TestOIDCCallbackDirectoryFailureFailsOpen(t *testing.T) {
	env := setupAuthService()
	existing := &model.User{
		ID:         "existing-user",
		Email:      "oidc@example.com",
		SystemRole: model.SystemRoleMember,
		Status:     "active",
		Phone:      "+46 70 000 00 00",
	}
	env.users.users[existing.ID] = existing
	env.users.emailIndex[existing.Email] = existing
	env.svc.SetDirectory(&stubDirectoryLookup{err: errors.New("graph down")})

	_, _, user, err := env.svc.HandleOIDCCallback(context.Background(), "auth-code", "state", "nonce")
	if err != nil {
		t.Fatalf("login must succeed when the directory is down, got %v", err)
	}
	if user.Phone != "+46 70 000 00 00" {
		t.Errorf("Phone = %q, want previously synced value kept", user.Phone)
	}
}

func TestOIDCCallbackUserOutsideDirectoryKeepsSyncedData(t *testing.T) {
	env := setupAuthService()
	existing := &model.User{
		ID:         "existing-user",
		Email:      "oidc@example.com",
		SystemRole: model.SystemRoleMember,
		Status:     "active",
		Phone:      "+46 70 000 00 00",
		Manager:    &model.UserManager{DisplayName: "Boss"},
	}
	env.users.users[existing.ID] = existing
	env.users.emailIndex[existing.Email] = existing
	// A nil profile (user not in the directory) must not wipe synced data.
	env.svc.SetDirectory(&stubDirectoryLookup{})

	_, _, user, err := env.svc.HandleOIDCCallback(context.Background(), "auth-code", "state", "nonce")
	if err != nil {
		t.Fatalf("HandleOIDCCallback: %v", err)
	}
	if user.Phone != "+46 70 000 00 00" || user.Manager == nil {
		t.Errorf("synced data wiped: phone=%q manager=%+v", user.Phone, user.Manager)
	}
}

func TestOIDCCallbackStoresObjectIDWithoutDirectory(t *testing.T) {
	env := setupAuthService()
	env.oidc.userInfo.ObjectID = "oid-42"

	t.Run("new user", func(t *testing.T) {
		env.users.hasUsersVal = true
		_, _, user, err := env.svc.HandleOIDCCallback(context.Background(), "auth-code", "state", "nonce")
		if err != nil {
			t.Fatalf("HandleOIDCCallback: %v", err)
		}
		if user.MSObjectID != "oid-42" {
			t.Errorf("MSObjectID = %q, want token oid", user.MSObjectID)
		}
	})

	t.Run("existing user refreshes oid from the claim", func(t *testing.T) {
		env.oidc.userInfo.ObjectID = "oid-43"
		_, _, user, err := env.svc.HandleOIDCCallback(context.Background(), "auth-code", "state", "nonce")
		if err != nil {
			t.Fatalf("HandleOIDCCallback: %v", err)
		}
		if user.MSObjectID != "oid-43" {
			t.Errorf("MSObjectID = %q, want refreshed oid", user.MSObjectID)
		}
	})

	t.Run("existing user keeps oid when claim is absent", func(t *testing.T) {
		env.oidc.userInfo.ObjectID = ""
		_, _, user, err := env.svc.HandleOIDCCallback(context.Background(), "auth-code", "state", "nonce")
		if err != nil {
			t.Fatalf("HandleOIDCCallback: %v", err)
		}
		if user.MSObjectID != "oid-43" {
			t.Errorf("MSObjectID = %q, want previously stored oid kept", user.MSObjectID)
		}
	})
}
