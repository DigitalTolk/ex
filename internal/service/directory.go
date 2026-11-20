package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/store"
)

// DirectoryProfile is the slice of the employee directory the app enriches
// user profiles with at SSO login and in the periodic sweep.
type DirectoryProfile struct {
	// ObjectID is the directory's canonical id for the user (AAD object id).
	ObjectID string
	// DisplayName is the directory's name for the user. "" means the
	// directory reported none, which never blanks the stored name.
	DisplayName string
	Phone       string
	Department  string
	JobTitle    string
	Manager     *model.UserManager
}

// fields is the directory-owned attribute set a profile writes.
func (dp *DirectoryProfile) fields() store.UserDirectoryFields {
	return store.UserDirectoryFields{Phone: dp.Phone, Department: dp.Department, JobTitle: dp.JobTitle, Manager: dp.Manager}
}

// differsFrom reports whether applying dp would change anything on user —
// the directory-owned attributes, the name, or the object id.
func (dp *DirectoryProfile) differsFrom(user *model.User) bool {
	return user.Phone != dp.Phone ||
		user.Department != dp.Department ||
		user.JobTitle != dp.JobTitle ||
		!user.Manager.Equal(dp.Manager) ||
		(dp.DisplayName != "" && user.DisplayName != dp.DisplayName) ||
		(dp.ObjectID != "" && user.MSObjectID != dp.ObjectID)
}

// DirectoryLookup resolves directory attributes (name, phone, department,
// job title, manager) for a user.
// Implementations must treat "user not in the directory" as (nil, nil) — only
// transport/auth failures are errors. AuthService calls it fail-open: a
// directory outage degrades to an un-enriched login, never a failed one.
type DirectoryLookup interface {
	LookupProfile(ctx context.Context, email, objectID string) (*DirectoryProfile, error)
}

// GraphDirectory is the slice of the Microsoft Graph client the directory
// service uses, as an interface so tests stub it without HTTP.
// ResolveUserByEmail covers tenants where mail != userPrincipalName (a plain
// /users/{email} lookup would 404 there).
type GraphDirectory interface {
	GetUserProfile(ctx context.Context, key string) (*msgraph.UserProfile, error)
	ResolveUserByEmail(ctx context.Context, email string) (*msgraph.UserProfile, error)
	GetUserManager(ctx context.Context, key string) (*msgraph.UserProfile, error)
	ListUserAccounts(ctx context.Context) ([]msgraph.UserAccount, error)
}

// MSDirectoryService reads the profile + manager from Microsoft Graph and resolves
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
// lookup failure degrades to a manager-less profile — half the enrichment beats
// failing the login sync entirely.
func (s *MSDirectoryService) LookupProfile(ctx context.Context, email, objectID string) (*DirectoryProfile, error) {
	var profile *msgraph.UserProfile
	var err error
	if objectID != "" {
		profile, err = s.graph.GetUserProfile(ctx, objectID)
	} else {
		// No stored oid yet (user hasn't logged in since oid capture) — an
		// email key must tolerate mail != UPN tenants.
		profile, err = s.graph.ResolveUserByEmail(ctx, email)
	}
	if err != nil {
		if errors.Is(err, msgraph.ErrNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("directory: get user profile: %w", err)
	}

	dp := &DirectoryProfile{
		ObjectID:    profile.ID,
		DisplayName: strings.TrimSpace(profile.DisplayName),
		Phone:       profile.Phone(),
		Department:  strings.TrimSpace(profile.Department),
		JobTitle:    strings.TrimSpace(profile.JobTitle),
	}

	// Key the manager read by the profile's canonical object id — the input
	// key may have been an email, which /users/{key}/manager would treat as
	// a UPN.
	manager, err := s.graph.GetUserManager(ctx, profile.ID)
	if err != nil {
		if !errors.Is(err, msgraph.ErrNotFound) {
			slog.WarnContext(ctx, "directory: manager lookup failed; syncing profile without manager", "error", err)
		}
		return dp, nil
	}
	dp.Manager = s.managerRef(ctx, manager)
	return dp, nil
}

// ListAccounts reports every directory account's standing, keyed by AAD
// object id: true while it can sign in, false once it is disabled. An
// account deleted upstream is absent.
func (s *MSDirectoryService) ListAccounts(ctx context.Context) (map[string]bool, error) {
	accounts, err := s.graph.ListUserAccounts(ctx)
	if err != nil {
		return nil, fmt.Errorf("directory: list accounts: %w", err)
	}
	enabled := make(map[string]bool, len(accounts))
	for _, a := range accounts {
		enabled[a.ID] = a.Enabled()
	}
	return enabled, nil
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
				slog.WarnContext(ctx, "directory: manager user resolution failed", "error", err)
			}
		}
	}
	return ref
}
