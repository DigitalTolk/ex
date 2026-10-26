package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// identityUnbinder is the slice of the user store oidc-unbind drives.
type identityUnbinder interface {
	GetUserByEmail(ctx context.Context, email string) (*model.User, error)
	PatchUser(ctx context.Context, id string, p store.UserPatch) error
}

// runOIDCUnbind is the deliberate escape hatch for an account locked out of
// SSO. The first SSO login pins an account to the provider's issuer + subject
// (and, on Entra, the directory object id), and every later login presenting
// another identity for the address is refused. When the identity provider
// itself changes them — a new issuer URL, re-keyed subjects, a move to
// another IdP — that refuses the rightful owner too, and outside Entra there
// is no object id to re-bind on. Clearing the pin lets the account's next SSO
// login pin the identity it presents.
//
// Clear it only once you are sure who will sign in next with the address:
// until that login, any identity the configured provider vouches for at the
// address gets the account. Sessions already signed in are untouched.
func runOIDCUnbind(ctx context.Context, db *store.DB, args []string) int {
	var email string
	dryRun, _, mode := migrateFlags("oidc-unbind", args, func(fs *flag.FlagSet) {
		fs.StringVar(&email, "email", "", "email address of the account to unpin (required)")
	})
	slog.Info("starting oidc-unbind", "mode", mode, "table", db.Table)
	return unbindOIDCIdentity(ctx, store.NewUserStore(db), email, dryRun, time.Now())
}

func unbindOIDCIdentity(ctx context.Context, users identityUnbinder, email string, dryRun bool, now time.Time) int {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		slog.Error("oidc-unbind: --email is required")
		return 2
	}
	u, err := users.GetUserByEmail(ctx, email)
	if errors.Is(err, store.ErrNotFound) {
		slog.Error("oidc-unbind: no account has this email address", "email", email)
		return 1
	}
	if err != nil {
		slog.Error("oidc-unbind: account lookup failed", "email", email, "error", err)
		return 1
	}
	pinned := []any{"userID", u.ID, "email", email,
		"oidcIssuer", u.OIDCIssuer, "oidcSubject", u.OIDCSubject, "msObjectID", u.MSObjectID}
	if u.OIDCIssuer == "" && u.OIDCSubject == "" && u.MSObjectID == "" {
		slog.Info("oidc-unbind: the account has no pinned SSO identity; nothing to clear", "userID", u.ID, "email", email)
		return 0
	}
	if dryRun {
		slog.Info("oidc-unbind: would clear this pinned SSO identity (re-run with --apply)", pinned...)
		return 0
	}
	cleared, bound := "", u.OIDCSubject
	err = users.PatchUser(ctx, u.ID, store.UserPatch{
		OIDCIssuer:  &cleared,
		OIDCSubject: &cleared,
		MSObjectID:  &cleared,
		// Only the identity shown above is cleared: a login that re-bound
		// the account in the meantime is left in place.
		ExpectOIDCSubject: &bound,
		UpdatedAt:         now,
	})
	if errors.Is(err, store.ErrIdentityBound) {
		slog.Error("oidc-unbind: the pinned identity changed while clearing it; nothing was cleared — re-run to see the current one", pinned...)
		return 1
	}
	if err != nil {
		slog.Error("oidc-unbind: clearing the pinned identity failed", append(pinned, "error", err)...)
		return 1
	}
	slog.Warn("oidc-unbind: cleared the pinned SSO identity; the next SSO login for this address pins the account again", pinned...)
	return 0
}
