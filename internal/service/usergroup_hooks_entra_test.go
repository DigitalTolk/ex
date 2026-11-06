package service

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

type recordingLinkedSync struct {
	index    map[string]string
	deadline time.Time
	synced   int
}

func (r *recordingLinkedSync) ReplaceEntraIndex(_ context.Context, m map[string]string) { r.index = m }

func (r *recordingLinkedSync) SyncLinkedGroups(_ context.Context, deadline time.Time) {
	r.synced++
	r.deadline = deadline
}

// The status sweep rebuilds the object-ID index from the accounts it already
// read, then syncs linked groups within its budget — after its own pass.
func TestDirectoryStatusDrivesLinkedUserGroups(t *testing.T) {
	svc, setter, _, _ := statusSweepEnv(
		map[string]bool{"oid-on": true, "oid-off": false},
		ssoUser("u-on", "oid-on", "active"),
		ssoUser("u-off", "oid-off", "active"),
		&model.User{ID: "u-local", Status: "active"},
	)
	groups := &recordingLinkedSync{}
	svc.SetUserGroupSync(groups)

	start := time.Now()
	svc.SweepStatus(context.Background(), time.Hour)

	if !setter.calls["u-off"] {
		t.Fatal("the status pass didn't run first")
	}
	if groups.synced != 1 {
		t.Fatalf("linked groups synced %d times, want once", groups.synced)
	}
	if want := map[string]string{"oid-on": "u-on", "oid-off": "u-off"}; len(groups.index) != 2 || groups.index["oid-on"] != want["oid-on"] || groups.index["oid-off"] != want["oid-off"] {
		t.Fatalf("index = %v, want %v", groups.index, want)
	}
	budget := groups.deadline.Sub(start)
	if budget < 47*time.Minute || budget > 49*time.Minute {
		t.Fatalf("budget = %v, want 80%% of the hour", budget)
	}
}

type recordingEntraNoter struct{ objectID, userID string }

func (r *recordingEntraNoter) NoteEntraUser(_ context.Context, objectID, userID string) {
	r.objectID, r.userID = objectID, userID
}

// A sign-in records the user's Entra object ID for linked groups.
func TestOIDCLoginRecordsTheEntraUser(t *testing.T) {
	env := setupSecurityAuth(t)
	u := addUser(env, &model.User{ID: "u-pin", Email: "oidc@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	env.oidc.userInfo.ObjectID = "oid-token"
	noter := &recordingEntraNoter{}
	env.svc.SetEntraUserNoter(noter)
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if noter.objectID != "oid-token" || noter.userID != u.ID {
		t.Fatalf("noted %q → %q, want oid-token → %s", noter.objectID, noter.userID, u.ID)
	}
}
