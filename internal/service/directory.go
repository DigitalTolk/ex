package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"unicode/utf8"

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
	// Squad is the user's squad (several joined with ", "), from their
	// security groups.
	Squad    string
	JobTitle string
	Manager  *model.UserManager
	// squadUnread marks a profile whose groups could not be read: the
	// stored squad stands rather than being cleared.
	squadUnread bool
}

// squadFor is the squad applying dp leaves on user.
func (dp *DirectoryProfile) squadFor(user *model.User) string {
	if dp.squadUnread {
		return user.Squad
	}
	return dp.Squad
}

// fields is the directory-owned attribute set a profile writes over user.
func (dp *DirectoryProfile) fields(user *model.User) store.UserDirectoryFields {
	return store.UserDirectoryFields{Phone: dp.Phone, Department: dp.Department, Squad: dp.squadFor(user), JobTitle: dp.JobTitle, Manager: dp.Manager}
}

// differsFrom reports whether applying dp would change anything on user —
// the directory-owned attributes, the name, or the object id.
func (dp *DirectoryProfile) differsFrom(user *model.User) bool {
	return user.Phone != dp.Phone ||
		user.Department != dp.Department ||
		user.Squad != dp.squadFor(user) ||
		user.JobTitle != dp.JobTitle ||
		!user.Manager.Equal(dp.Manager) ||
		(dp.DisplayName != "" && user.DisplayName != dp.DisplayName) ||
		(dp.ObjectID != "" && user.MSObjectID != dp.ObjectID)
}

// DirectoryLookup resolves directory attributes (name, phone, department,
// squad, job title, manager) for a user.
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
	ListUserGroups(ctx context.Context, key string) ([]msgraph.Group, error)
	ListUserAccounts(ctx context.Context) ([]msgraph.UserAccount, error)
}

// MSDirectoryService reads the profile, groups and manager from Microsoft Graph and resolves
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
		DisplayName: directoryName(profile.DisplayName),
		Phone:       profile.Phone(),
		Department:  strings.TrimSpace(profile.Department),
		JobTitle:    strings.TrimSpace(profile.JobTitle),
	}
	groups, err := s.graph.ListUserGroups(ctx, profile.ID)
	switch {
	case err == nil:
		dp.Squad = squadsOf(dp.Department, groups)
	case !errors.Is(err, msgraph.ErrNotFound):
		slog.WarnContext(ctx, "directory: group lookup failed; keeping the stored squad", "error", err)
		dp.squadUnread = true
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

// directoryName is the directory's name for a user under the app's own rule
// for names: trimmed, and at most MaxUserDisplayNameLen characters.
func directoryName(name string) string {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > MaxUserDisplayNameLen {
		name = strings.TrimSpace(string([]rune(name)[:MaxUserDisplayNameLen]))
	}
	return name
}

// squadsOf is the user's squads: the security groups named
// "<department>-<squad>" for their own department (case and spaces around
// the hyphen don't matter), sorted and joined with ", ". The department is
// matched whole, so a hyphen inside it or inside a squad is no separator, and
// another department's groups never count.
func squadsOf(department string, groups []msgraph.Group) string {
	if department == "" {
		return ""
	}
	var squads []string
	for _, g := range groups {
		name := strings.TrimSpace(g.DisplayName)
		if !g.SecurityEnabled || len(name) < len(department) || !strings.EqualFold(name[:len(department)], department) {
			continue
		}
		rest, ok := strings.CutPrefix(strings.TrimSpace(name[len(department):]), "-")
		if squad := strings.TrimSpace(rest); ok && squad != "" && !slices.Contains(squads, squad) {
			squads = append(squads, squad)
		}
	}
	slices.Sort(squads)
	return strings.Join(squads, ", ")
}
