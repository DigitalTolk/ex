package main

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// fakeIdentityStore holds one account and applies patches the way the user
// store does (an empty string removes the attribute; ExpectOIDCSubject is a
// compare-and-swap on the bound subject).
type fakeIdentityStore struct {
	user     *model.User
	getErr   error
	patchErr error
	lookedUp string
	patches  []store.UserPatch
	// rebind, when set, re-binds the account just before a patch lands — a
	// login racing the clear.
	rebind string
}

func (f *fakeIdentityStore) GetUserByEmail(_ context.Context, email string) (*model.User, error) {
	f.lookedUp = email
	if f.getErr != nil {
		return nil, f.getErr
	}
	if f.user == nil || f.user.Email != email {
		return nil, store.ErrNotFound
	}
	cp := *f.user
	return &cp, nil
}

func (f *fakeIdentityStore) PatchUser(_ context.Context, _ string, p store.UserPatch) error {
	f.patches = append(f.patches, p)
	if f.patchErr != nil {
		return f.patchErr
	}
	if f.rebind != "" {
		f.user.OIDCSubject = f.rebind
	}
	if p.ExpectOIDCSubject != nil && *p.ExpectOIDCSubject != f.user.OIDCSubject {
		return store.ErrIdentityBound
	}
	if p.OIDCIssuer != nil {
		f.user.OIDCIssuer = *p.OIDCIssuer
	}
	if p.OIDCSubject != nil {
		f.user.OIDCSubject = *p.OIDCSubject
	}
	if p.MSObjectID != nil {
		f.user.MSObjectID = *p.MSObjectID
	}
	f.user.UpdatedAt = p.UpdatedAt
	return nil
}

func pinnedUser() *model.User {
	return &model.User{ID: "u-1", Email: "ada@example.com", AuthProvider: model.AuthProviderOIDC,
		OIDCIssuer: "https://idp.example.com", OIDCSubject: "sub-old", MSObjectID: "oid-old"}
}

// captureLogs routes slog to a buffer for the test.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

var unbindAt = time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)

// The escape hatch for an IdP whose issuer or subjects changed: the pinned
// identity is cleared (dry run first), so the account's next SSO login pins
// the new one. Every applied clear is logged with what it cleared.
func TestUnbindOIDCIdentity_ClearsThePinnedIdentity(t *testing.T) {
	ctx := context.Background()
	logs := captureLogs(t)
	users := &fakeIdentityStore{user: pinnedUser()}

	if code := unbindOIDCIdentity(ctx, users, " Ada@Example.com ", true, unbindAt); code != 0 {
		t.Fatalf("dry run exit = %d", code)
	}
	if len(users.patches) != 0 || users.user.OIDCSubject != "sub-old" {
		t.Fatalf("dry run wrote: %+v", users.patches)
	}
	if users.lookedUp != "ada@example.com" {
		t.Fatalf("looked up %q, want the normalized address", users.lookedUp)
	}
	if !strings.Contains(logs.String(), "sub-old") {
		t.Fatalf("dry run did not show the pinned identity: %s", logs)
	}

	if code := unbindOIDCIdentity(ctx, users, "ada@example.com", false, unbindAt); code != 0 {
		t.Fatalf("apply exit = %d", code)
	}
	u := users.user
	if u.OIDCIssuer != "" || u.OIDCSubject != "" || u.MSObjectID != "" || !u.UpdatedAt.Equal(unbindAt) {
		t.Fatalf("after apply: issuer=%q subject=%q oid=%q updated=%v", u.OIDCIssuer, u.OIDCSubject, u.MSObjectID, u.UpdatedAt)
	}
	if p := users.patches[0]; p.ExpectOIDCSubject == nil || *p.ExpectOIDCSubject != "sub-old" {
		t.Fatalf("the clear must be conditional on the identity it showed: %+v", p)
	}
	if !strings.Contains(logs.String(), "level=WARN") || !strings.Contains(logs.String(), "u-1") {
		t.Fatalf("applied clear not logged: %s", logs)
	}

	// Nothing pinned (any more): nothing to do.
	if code := unbindOIDCIdentity(ctx, users, "ada@example.com", false, unbindAt); code != 0 || len(users.patches) != 1 {
		t.Fatalf("second apply: exit=%d patches=%d, want a no-op", code, len(users.patches))
	}
}

func TestUnbindOIDCIdentity_Refusals(t *testing.T) {
	ctx := context.Background()
	captureLogs(t)
	cases := []struct {
		name  string
		users *fakeIdentityStore
		email string
	}{
		{"no email", &fakeIdentityStore{user: pinnedUser()}, "  "},
		{"unknown account", &fakeIdentityStore{user: pinnedUser()}, "bob@example.com"},
		{"lookup failure", &fakeIdentityStore{getErr: errors.New("throttled")}, "ada@example.com"},
		{"patch failure", &fakeIdentityStore{user: pinnedUser(), patchErr: errors.New("throttled")}, "ada@example.com"},
		// A login re-bound the account between the read and the clear: the
		// clear does not land on an identity nobody looked at.
		{"re-bound meanwhile", &fakeIdentityStore{user: pinnedUser(), rebind: "sub-new"}, "ada@example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if code := unbindOIDCIdentity(ctx, tc.users, tc.email, false, unbindAt); code == 0 {
				t.Fatal("exit 0, want a failure")
			}
			if tc.users.user != nil && tc.users.user.OIDCIssuer == "" {
				t.Fatal("the identity was cleared anyway")
			}
		})
	}
}

func TestOIDCUnbindIsRegistered(t *testing.T) {
	if _, ok := commands()["oidc-unbind"]; !ok {
		t.Fatal("oidc-unbind missing from the dispatcher")
	}
}
