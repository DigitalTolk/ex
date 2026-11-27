package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
)

// stubGraph is a programmable GraphDirectory recording the lookup keys used.
type stubGraph struct {
	profile     *msgraph.UserProfile
	profileErr  error
	manager     *msgraph.UserProfile
	managerErr  error
	profileKeys []string
	managerKeys []string
	accounts    []msgraph.UserAccount
	accountsErr error
	groups      []msgraph.Group
	groupsErr   error
	groupKeys   []string
}

func (s *stubGraph) GetUserProfile(_ context.Context, key string) (*msgraph.UserProfile, error) {
	s.profileKeys = append(s.profileKeys, key)
	return s.profile, s.profileErr
}

func (s *stubGraph) ResolveUserByEmail(_ context.Context, email string) (*msgraph.UserProfile, error) {
	s.profileKeys = append(s.profileKeys, "email:"+email)
	return s.profile, s.profileErr
}

func (s *stubGraph) GetUserManager(_ context.Context, key string) (*msgraph.UserProfile, error) {
	s.managerKeys = append(s.managerKeys, key)
	return s.manager, s.managerErr
}

func (s *stubGraph) ListUserGroups(_ context.Context, key string) ([]msgraph.Group, error) {
	s.groupKeys = append(s.groupKeys, key)
	return s.groups, s.groupsErr
}

func (s *stubGraph) ListUserAccounts(context.Context) ([]msgraph.UserAccount, error) {
	return s.accounts, s.accountsErr
}

func TestListAccountsMapsObjectIDToEnabled(t *testing.T) {
	off := false
	graph := &stubGraph{accounts: []msgraph.UserAccount{{ID: "oid-on"}, {ID: "oid-off", AccountEnabled: &off}}}
	svc := NewMSDirectoryService(graph, newMockUserStore())

	got, err := svc.ListAccounts(context.Background())
	if err != nil {
		t.Fatalf("ListAccounts: %v", err)
	}
	if len(got) != 2 || !got["oid-on"] || got["oid-off"] {
		t.Errorf("accounts = %v, want oid-on enabled and oid-off disabled", got)
	}
}

func TestListAccountsError(t *testing.T) {
	svc := NewMSDirectoryService(&stubGraph{accountsErr: errors.New("graph down")}, newMockUserStore())
	if _, err := svc.ListAccounts(context.Background()); err == nil {
		t.Fatal("expected the Graph error")
	}
}

func TestLookupProfileKeysByObjectIDThenEmail(t *testing.T) {
	graph := &stubGraph{
		profile:    &msgraph.UserProfile{ID: "oid-1", MobilePhone: "+46 70 111 22 33"},
		managerErr: msgraph.ErrNotFound,
	}
	svc := NewMSDirectoryService(graph, newMockUserStore())

	if _, err := svc.LookupProfile(context.Background(), "alice@example.com", "oid-1"); err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	if _, err := svc.LookupProfile(context.Background(), "alice@example.com", ""); err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	// An oid key hits the direct lookup; an email key routes through the
	// mail!=UPN-tolerant resolver.
	if graph.profileKeys[0] != "oid-1" || graph.profileKeys[1] != "email:alice@example.com" {
		t.Errorf("profile keys = %v, want object id then email resolver", graph.profileKeys)
	}
}

func TestLookupProfileUserNotInDirectory(t *testing.T) {
	graph := &stubGraph{profileErr: msgraph.ErrNotFound}
	svc := NewMSDirectoryService(graph, newMockUserStore())

	dp, err := svc.LookupProfile(context.Background(), "alice@example.com", "")
	if err != nil || dp != nil {
		t.Fatalf("LookupProfile = (%+v, %v), want (nil, nil) for a user outside the directory", dp, err)
	}
}

func TestLookupProfileProfileError(t *testing.T) {
	graph := &stubGraph{profileErr: errors.New("graph down")}
	svc := NewMSDirectoryService(graph, newMockUserStore())

	if _, err := svc.LookupProfile(context.Background(), "alice@example.com", ""); err == nil {
		t.Fatal("expected error when the profile read fails")
	}
}

func TestLookupProfileNoManagerAssigned(t *testing.T) {
	graph := &stubGraph{
		profile:    &msgraph.UserProfile{ID: "oid-1", BusinessPhones: []string{"+46 8 000 00 00"}},
		managerErr: msgraph.ErrNotFound,
	}
	svc := NewMSDirectoryService(graph, newMockUserStore())

	dp, err := svc.LookupProfile(context.Background(), "alice@example.com", "")
	if err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	if dp.Phone != "+46 8 000 00 00" || dp.Manager != nil || dp.ObjectID != "oid-1" {
		t.Errorf("profile = %+v, want phone only", dp)
	}
}

func TestLookupProfileManagerErrorDegradesToPhoneOnly(t *testing.T) {
	graph := &stubGraph{
		profile:    &msgraph.UserProfile{ID: "oid-1", MobilePhone: "+1"},
		managerErr: errors.New("manager read timed out"),
	}
	svc := NewMSDirectoryService(graph, newMockUserStore())

	dp, err := svc.LookupProfile(context.Background(), "alice@example.com", "")
	if err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	if dp.Phone != "+1" || dp.Manager != nil {
		t.Errorf("profile = %+v, want phone with no manager on lookup failure", dp)
	}
}

func TestLookupProfileManagerResolvedToExUser(t *testing.T) {
	users := newMockUserStore()
	boss := &model.User{ID: "boss-1", Email: "boss@example.com"}
	users.users[boss.ID] = boss
	users.emailIndex[boss.Email] = boss

	graph := &stubGraph{
		profile: &msgraph.UserProfile{ID: "oid-1"},
		manager: &msgraph.UserProfile{ID: "oid-9", DisplayName: "Boss", Mail: "Boss@Example.com"},
	}
	svc := NewMSDirectoryService(graph, users)

	dp, err := svc.LookupProfile(context.Background(), "alice@example.com", "")
	if err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	want := &model.UserManager{DisplayName: "Boss", Email: "boss@example.com", UserID: "boss-1"}
	if !dp.Manager.Equal(want) {
		t.Errorf("manager = %+v, want %+v", dp.Manager, want)
	}
}

func TestLookupProfileManagerWithoutExAccount(t *testing.T) {
	graph := &stubGraph{
		profile: &msgraph.UserProfile{ID: "oid-1"},
		manager: &msgraph.UserProfile{DisplayName: "Boss", UserPrincipalName: "boss@corp.example.com"},
	}
	svc := NewMSDirectoryService(graph, newMockUserStore())

	dp, err := svc.LookupProfile(context.Background(), "alice@example.com", "")
	if err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	// Mail empty → UPN fallback; no Ex account → no UserID link.
	if dp.Manager.Email != "boss@corp.example.com" || dp.Manager.UserID != "" {
		t.Errorf("manager = %+v, want UPN email and no user link", dp.Manager)
	}
}

func TestLookupProfileManagerResolutionFailureKeepsManager(t *testing.T) {
	users := newMockUserStore()
	users.getEmailErr = errors.New("store down")
	graph := &stubGraph{
		profile: &msgraph.UserProfile{ID: "oid-1"},
		manager: &msgraph.UserProfile{DisplayName: "Boss", Mail: "boss@example.com"},
	}
	svc := NewMSDirectoryService(graph, users)

	dp, err := svc.LookupProfile(context.Background(), "alice@example.com", "")
	if err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	if dp.Manager == nil || dp.Manager.DisplayName != "Boss" || dp.Manager.UserID != "" {
		t.Errorf("manager = %+v, want manager kept without a user link", dp.Manager)
	}
}

func TestLookupProfileManagerInvalidEmailSkipsResolution(t *testing.T) {
	graph := &stubGraph{
		profile: &msgraph.UserProfile{ID: "oid-1"},
		manager: &msgraph.UserProfile{DisplayName: "Boss", Mail: "not an email"},
	}
	svc := NewMSDirectoryService(graph, newMockUserStore())

	dp, err := svc.LookupProfile(context.Background(), "alice@example.com", "")
	if err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	if dp.Manager.Email != "not an email" || dp.Manager.UserID != "" {
		t.Errorf("manager = %+v, want raw email kept and no resolution attempted", dp.Manager)
	}
}

func TestLookupProfileManagerWithoutAnyEmail(t *testing.T) {
	graph := &stubGraph{
		profile: &msgraph.UserProfile{ID: "oid-1"},
		manager: &msgraph.UserProfile{DisplayName: "Boss"},
	}
	svc := NewMSDirectoryService(graph, newMockUserStore())

	dp, err := svc.LookupProfile(context.Background(), "alice@example.com", "")
	if err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	if dp.Manager.DisplayName != "Boss" || dp.Manager.Email != "" || dp.Manager.UserID != "" {
		t.Errorf("manager = %+v, want name only", dp.Manager)
	}
}

func TestLookupProfileMapsNameDepartmentAndTitle(t *testing.T) {
	graph := &stubGraph{
		profile: &msgraph.UserProfile{
			ID: "oid-1", DisplayName: " Alice Andersson ", Department: " Engineering ", JobTitle: "Developer ",
		},
		managerErr: msgraph.ErrNotFound,
	}
	dp, err := NewMSDirectoryService(graph, newMockUserStore()).LookupProfile(context.Background(), "a@example.com", "oid-1")
	if err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	if dp.DisplayName != "Alice Andersson" || dp.Department != "Engineering" || dp.JobTitle != "Developer" {
		t.Errorf("profile = %+v, want trimmed name, department and title", dp)
	}
}

// A directory name obeys the same length rule as a rename in the app.
func TestLookupProfileCapsTheDirectoryName(t *testing.T) {
	long := strings.Repeat("ä", MaxUserDisplayNameLen+20)
	graph := &stubGraph{profile: &msgraph.UserProfile{ID: "oid-1", DisplayName: long}, managerErr: msgraph.ErrNotFound}
	dp, err := NewMSDirectoryService(graph, newMockUserStore()).LookupProfile(context.Background(), "a@example.com", "oid-1")
	if err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	if got := utf8.RuneCountInString(dp.DisplayName); got != MaxUserDisplayNameLen {
		t.Errorf("name is %d runes, want %d", got, MaxUserDisplayNameLen)
	}
}

// The department field holds the department alone; the squads come from the
// user's security groups, named "<Department>-<Squad>".
func TestLookupProfileReadsSquadsFromSecurityGroups(t *testing.T) {
	sec := func(name string) msgraph.Group { return msgraph.Group{DisplayName: name, SecurityEnabled: true} }
	for _, c := range []struct {
		name       string
		department string
		groups     []msgraph.Group
		squad      string
	}{
		{"one squad", "Engineering", []msgraph.Group{sec("Engineering-Platform")}, "Platform"},
		{"several, sorted", "Engineering", []msgraph.Group{sec("Engineering-SRE"), sec("Engineering-Platform")}, "Platform, SRE"},
		{"spaces and case", "Engineering", []msgraph.Group{sec(" engineering - Platform ")}, "Platform"},
		{"duplicates once", "Engineering", []msgraph.Group{sec("Engineering-Platform"), sec("Engineering-Platform")}, "Platform"},
		{"a hyphen in the department", "Sales-Ops", []msgraph.Group{sec("Sales-Ops-North")}, "North"},
		{"a hyphen in the squad", "Engineering", []msgraph.Group{sec("Engineering-Data-Ingest")}, "Data-Ingest"},
		{"another department's group", "Engineering", []msgraph.Group{sec("Sales-North")}, ""},
		{"a shorter group name", "Engineering", []msgraph.Group{sec("SRE")}, ""},
		{"a longer department's group", "Eng", []msgraph.Group{sec("Engineering-Platform")}, ""},
		{"no squad after the hyphen", "Engineering", []msgraph.Group{sec("Engineering-")}, ""},
		{"not a security group", "Engineering", []msgraph.Group{{DisplayName: "Engineering-Platform"}}, ""},
		{"no department", "", []msgraph.Group{sec("-Platform"), sec("Engineering-Platform")}, ""},
		{"no groups", "Engineering", nil, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			graph := &stubGraph{
				profile:    &msgraph.UserProfile{ID: "oid-1", Department: " " + c.department + " "},
				managerErr: msgraph.ErrNotFound,
				groups:     c.groups,
			}
			dp, err := NewMSDirectoryService(graph, newMockUserStore()).LookupProfile(context.Background(), "a@example.com", "")
			if err != nil {
				t.Fatalf("LookupProfile: %v", err)
			}
			if dp.Department != c.department || dp.Squad != c.squad {
				t.Errorf("department %q squad %q, want %q / %q", dp.Department, dp.Squad, c.department, c.squad)
			}
			if len(graph.groupKeys) != 1 || graph.groupKeys[0] != "oid-1" {
				t.Errorf("group keys = %v, want the profile's object id", graph.groupKeys)
			}
		})
	}
}

// A user Graph no longer finds has no groups: the squad clears.
func TestLookupProfileGroupsNotFoundClearsTheSquad(t *testing.T) {
	graph := &stubGraph{profile: &msgraph.UserProfile{ID: "oid-1", Department: "Engineering"}, managerErr: msgraph.ErrNotFound, groupsErr: msgraph.ErrNotFound}
	dp, err := NewMSDirectoryService(graph, newMockUserStore()).LookupProfile(context.Background(), "a@example.com", "oid-1")
	if err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	user := &model.User{Department: "Engineering", Squad: "Platform"}
	if !dp.differsFrom(user) || dp.fields(user).Squad != "" {
		t.Errorf("squad kept after a not-found group read; want it cleared")
	}
}

// A failed group read (an outage, or the app missing GroupMember.Read.All)
// keeps the stored squad and still syncs the rest of the profile.
func TestLookupProfileGroupReadFailureKeepsTheStoredSquad(t *testing.T) {
	graph := &stubGraph{profile: &msgraph.UserProfile{ID: "oid-1", Department: "Engineering", JobTitle: "Dev"}, managerErr: msgraph.ErrNotFound, groupsErr: errors.New("status 403")}
	dp, err := NewMSDirectoryService(graph, newMockUserStore()).LookupProfile(context.Background(), "a@example.com", "oid-1")
	if err != nil {
		t.Fatalf("LookupProfile: %v", err)
	}
	user := &model.User{MSObjectID: "oid-1", Department: "Engineering", Squad: "Platform", JobTitle: "Dev"}
	if dp.differsFrom(user) {
		t.Error("an unread squad counts as a change")
	}
	if got := dp.fields(user).Squad; got != "Platform" {
		t.Errorf("written squad = %q, want the stored Platform kept", got)
	}
	applyDirectoryProfile(user, dp)
	if user.Squad != "Platform" {
		t.Errorf("applied squad = %q, want the stored Platform kept", user.Squad)
	}
	user.JobTitle = "Lead"
	if !dp.differsFrom(user) {
		t.Error("a changed title no longer counts once the squad is unread")
	}
}
