package service

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

type recordingGroupSync struct {
	people []DirectoryPerson
	synced int
}

func (r *recordingGroupSync) SyncDirectoryGroups(_ context.Context, people []DirectoryPerson) {
	r.synced++
	r.people = people
}

// The status sweep hands the group sync every enabled account's department,
// after its own pass, with the ex member only for active, non-guest people
// (a reactivated one included, one it deactivated left out).
func TestDirectoryStatusDrivesUserGroups(t *testing.T) {
	guest := ssoUser("u-guest", "oid-guest", "active")
	guest.SystemRole = model.SystemRoleGuest
	adminOff := ssoUser("u-admin-off", "oid-admin-off", "deactivated")
	adminOff.DeactivatedBy = model.DeactivatedByAdmin
	svc, setter, lister, _ := statusSweepEnv(
		map[string]bool{"oid-on": true, "oid-off": false, "oid-back": true, "oid-guest": true, "oid-admin-off": true, "oid-new": true},
		ssoUser("u-on", "oid-on", "active"),
		ssoUser("u-off", "oid-off", "active"),
		ssoUser("u-back", "oid-back", "deactivated"),
		guest,
		adminOff,
		&model.User{ID: "u-local", Status: "active"},
	)
	lister.departments = map[string]string{
		"oid-on": "Engineering - DOPE", "oid-off": "Engineering", "oid-back": "Sales",
		"oid-guest": "Engineering", "oid-admin-off": "Engineering", "oid-new": "Engineering - Platform",
	}
	groups := &recordingGroupSync{}
	svc.SetUserGroupSync(groups)

	svc.SweepStatus(context.Background(), 30*time.Minute)

	if !setter.calls["u-off"] {
		t.Fatal("the status pass didn't run first")
	}
	if groups.synced != 1 {
		t.Fatalf("groups synced %d times, want once", groups.synced)
	}
	got := make([]string, 0, len(groups.people))
	for _, p := range groups.people {
		got = append(got, p.UserID+"|"+p.Department)
	}
	slices.Sort(got)
	// The disabled account is left out; the guest, the admin-deactivated
	// account and the one without an ex account count without a member.
	want := []string{"u-back|Sales", "u-on|Engineering - DOPE", "|Engineering", "|Engineering", "|Engineering - Platform"}
	if !slices.Equal(got, want) {
		t.Fatalf("people = %s, want %s", strings.Join(got, "; "), strings.Join(want, "; "))
	}
}
