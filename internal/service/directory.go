package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/store"
)

// DirectoryProfile is the slice of the employee directory the app enriches
// user profiles with at SSO login.
type DirectoryProfile struct {
	// ObjectID is the directory's canonical id for the user (AAD object id).
	ObjectID string
	Phone    string
	Manager  *model.UserManager
}

// DirectoryLookup resolves directory attributes (phone, manager) for a user.
// Implementations must treat "user not in the directory" as (nil, nil) — only
// transport/auth failures are errors. AuthService calls it fail-open: a
// directory outage degrades to an un-enriched login, never a failed one.
type DirectoryLookup interface {
	LookupProfile(ctx context.Context, email, objectID string) (*DirectoryProfile, error)
}

// GraphDirectory is the slice of the Microsoft Graph client the directory
// service uses, as an interface so tests stub it without HTTP.
type GraphDirectory interface {
	GetUserProfile(ctx context.Context, key string) (*msgraph.UserProfile, error)
	GetUserManager(ctx context.Context, key string) (*msgraph.UserProfile, error)
}

// MSDirectoryService reads phone + manager from Microsoft Graph and resolves
// the manager to an Ex user (by email) so profiles can link to them.
type MSDirectoryService struct {
	graph GraphDirectory
	users UserStore
}

// NewMSDirectoryService builds the Graph-backed directory lookup.
func NewMSDirectoryService(graph GraphDirectory, users UserStore) *MSDirectoryService {
	return &MSDirectoryService{graph: graph, users: users}
}

// LookupProfile fetches the user's directory profile keyed by AAD object id
// when known (robust against email != userPrincipalName), falling back to
// email. A user missing from the directory yields (nil, nil). A manager
// lookup failure degrades to a phone-only profile — half the enrichment beats
// failing the login sync entirely.
func (s *MSDirectoryService) LookupProfile(ctx context.Context, email, objectID string) (*DirectoryProfile, error) {
	key := objectID
	if key == "" {
		key = email
	}

	profile, err := s.graph.GetUserProfile(ctx, key)
	if err != nil {
		if errors.Is(err, msgraph.ErrNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("directory: get user profile: %w", err)
	}

	dp := &DirectoryProfile{ObjectID: profile.ID, Phone: profile.Phone()}

	manager, err := s.graph.GetUserManager(ctx, key)
	if err != nil {
		if !errors.Is(err, msgraph.ErrNotFound) {
			slog.Warn("directory: manager lookup failed; syncing phone only", "error", err)
		}
		return dp, nil
	}
	dp.Manager = s.managerRef(ctx, manager)
	return dp, nil
}

// managerRef converts a Graph profile into the stored manager reference,
// resolving the manager to an Ex user by email when they have an account.
func (s *MSDirectoryService) managerRef(ctx context.Context, manager *msgraph.UserProfile) *model.UserManager {
	ref := &model.UserManager{
		DisplayName: manager.DisplayName,
		Email:       manager.EmailAddress(),
	}
	if ref.Email != "" {
		if email, err := normalizeEmailAddress(ref.Email); err == nil {
			ref.Email = email
			existing, err := s.users.GetUserByEmail(ctx, email)
			switch {
			case err == nil:
				ref.UserID = existing.ID
			case !errors.Is(err, store.ErrNotFound):
				// Resolution is a nicety (it turns the name into a link);
				// a store hiccup must not drop the manager data itself.
				slog.Warn("directory: manager user resolution failed", "error", err)
			}
		}
	}
	return ref
}
