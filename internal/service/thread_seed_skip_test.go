package service

import (
	"context"
	"crypto/rand"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/oklog/ulid/v2"
)

// signupUser is an account as ex's own sign-up writes it: a ULID minted at
// creation, CreatedAt = that moment, and seeded notification settings.
func signupUser(at time.Time) *model.User {
	ns := model.DefaultNotificationSettings()
	return &model.User{
		ID:                   ulid.MustNew(ulid.Timestamp(at), rand.Reader).String(),
		CreatedAt:            at,
		NotificationSettings: &ns,
		AuthProvider:         model.AuthProviderOIDC,
	}
}

func seedSkipService(t *testing.T, u *model.User) (*MessageService, *batchMockMessageStore, *indexedThreadFollowStore) {
	t.Helper()
	svc, messages, memberships, _, follows := threadIndexService()
	users := newMockUserStore()
	users.users[u.ID] = u
	svc.SetThreadSeedUsers(users)
	// A few parents with history: the legacy scan would page each of them.
	memberships.userChannels = []*model.UserChannel{{UserID: u.ID, ChannelID: "ch-1"}, {UserID: u.ID, ChannelID: "ch-2"}}
	messages.messages["ch-1#m1"] = &model.Message{ID: "m1", ParentID: "ch-1", AuthorID: "someone", Body: "hi"}
	return svc, messages, follows
}

// Regression: the first /threads visit ran the legacy seed scan (up to
// 25×200 messages per parent) even for an account created after the
// write-time index existed — whose participation is all in follow rows
// already. Such an account is marked seeded and served from the index.
func TestListUserThreads_NewAccountSkipsSeedScan(t *testing.T) {
	u := signupUser(threadIndexEpoch.Add(30 * 24 * time.Hour))
	svc, messages, follows := seedSkipService(t, u)

	if _, err := svc.ListUserThreads(context.Background(), u.ID); err != nil {
		t.Fatalf("ListUserThreads: %v", err)
	}
	if messages.listCalls.Load() != 0 {
		t.Fatalf("legacy scan pages = %d, want 0 for a post-index account", messages.listCalls.Load())
	}
	if !follows.seeded {
		t.Fatal("post-index account not marked seeded")
	}
}

// Everything that cannot prove "signed up in ex after the index" keeps the
// one-time scan: pre-index accounts, and imported accounts — the importer
// creates them with caller-chosen IDs, the source system's creation time, and
// no notification settings.
func TestListUserThreads_SeedScanStillRunsForOldOrImportedAccounts(t *testing.T) {
	after := threadIndexEpoch.Add(30 * 24 * time.Hour)
	old := signupUser(threadIndexEpoch.Add(-24 * time.Hour))
	importedID := &model.User{ID: "slack-U123", CreatedAt: after}
	importedLate := signupUser(threadIndexEpoch.Add(-24 * time.Hour)) // ID minted earlier than…
	importedLate.CreatedAt = after                                    // …the source's creation time
	noSettings := signupUser(after)
	noSettings.NotificationSettings = nil

	for name, u := range map[string]*model.User{
		"pre-index account":      old,
		"non-ULID imported id":   importedID,
		"id/creation mismatch":   importedLate,
		"no settings (imported)": noSettings,
	} {
		t.Run(name, func(t *testing.T) {
			svc, messages, _ := seedSkipService(t, u)
			if _, err := svc.ListUserThreads(context.Background(), u.ID); err != nil {
				t.Fatalf("ListUserThreads: %v", err)
			}
			if messages.listCalls.Load() == 0 {
				t.Fatal("seed scan skipped for an account that may have unindexed history")
			}
		})
	}
}

// An account lookup that fails, or no account reader wired, keeps the scan
// (correct, just slower); a failed seed marker still serves the index.
func TestListUserThreads_SeedSkipDegradesToScan(t *testing.T) {
	u := signupUser(threadIndexEpoch.Add(30 * 24 * time.Hour))

	svc, messages, _ := seedSkipService(t, u)
	users := newMockUserStore() // the account is missing here
	svc.SetThreadSeedUsers(users)
	if _, err := svc.ListUserThreads(context.Background(), u.ID); err != nil {
		t.Fatalf("ListUserThreads: %v", err)
	}
	if messages.listCalls.Load() == 0 {
		t.Fatal("seed scan skipped although the account could not be read")
	}

	svc2, messages2, follows2 := seedSkipService(t, u)
	follows2.markErr = errors.New("dynamo down")
	if _, err := svc2.ListUserThreads(context.Background(), u.ID); err != nil {
		t.Fatalf("ListUserThreads: %v", err)
	}
	if messages2.listCalls.Load() != 0 {
		t.Fatalf("legacy scan pages = %d, want 0 even when the marker write fails", messages2.listCalls.Load())
	}
}
