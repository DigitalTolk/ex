package service

import (
	"context"
	"errors"
	"testing"

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
}

func (s *stubGraph) GetUserProfile(_ context.Context, key string) (*msgraph.UserProfile, error) {
	s.profileKeys = append(s.profileKeys, key)
	return s.profile, s.profileErr
}

func (s *stubGraph) GetUserManager(_ context.Context, key string) (*msgraph.UserProfile, error) {
	s.managerKeys = append(s.managerKeys, key)
	return s.manager, s.managerErr
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
	if graph.profileKeys[0] != "oid-1" || graph.profileKeys[1] != "alice@example.com" {
		t.Errorf("profile keys = %v, want object id then email fallback", graph.profileKeys)
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
