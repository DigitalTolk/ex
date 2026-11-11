package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hibiken/asynq"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// listingActivityStore lists back what the fan-out wrote, every item unread.
type listingActivityStore struct{ *fakeActivityStore }

func (s listingActivityStore) ListActivity(_ context.Context, userID string) ([]*model.ActivityFeedItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*model.ActivityFeedItem, 0, len(s.items[userID]))
	for _, it := range s.items[userID] {
		out = append(out, &model.ActivityFeedItem{ActivityItem: *it})
	}
	return out, nil
}

// runNowScheduler runs each scheduled push at once through the real push
// task handler, as the durable worker would when the task comes due.
type runNowScheduler struct {
	handle func(context.Context, *asynq.Task) error
}

func (s runNowScheduler) SchedulePush(ctx context.Context, userID string, n Notification, _ time.Duration) error {
	payload := mustJSONBody(json.Marshal(mobilePushTaskPayload{RecipientUserID: userID, Notification: n}))
	return s.handle(ctx, asynq.NewTask(TaskTypeMobilePush, payload))
}

// slowWriteActivityStore lands activity writes the way a loaded box does:
// after a beat, not instantly. The badge must still count this message's own
// row, so the fan-out has to WAIT for the write before the push leaves; the
// old detached write made the badge one short whenever the push won the race
// (the CI failure this reproduces deterministically).
type slowWriteActivityStore struct{ listingActivityStore }

func (s slowWriteActivityStore) AddActivityMany(ctx context.Context, adds []store.ActivityAdd) []store.ActivityAdded {
	time.Sleep(30 * time.Millisecond)
	return s.listingActivityStore.AddActivityMany(ctx, adds)
}

// bobsBadgeAfterChannelPost posts a channel message that alerts Bob (offline,
// so his push leaves at once) and returns the ios_badgeCount his push carried.
// Bob starts with three unread items: a DM, a mention and a reaction.
func bobsBadgeAfterChannelPost(t *testing.T, activityStore ActivityStore, seed *listingActivityStore) (float64, bool) {
	t.Helper()
	svc, _, members, _, chans, users := setupNotifier(t)
	activity := NewActivityService(activityStore, newMockPublisher())
	svc.SetActivityRecorder(activity)
	svc.SetPresence(&stubPresence{online: map[string]bool{}}) // offline: pushed at once

	var mu sync.Mutex
	badges := map[string]float64{}
	sender, err := NewOneSignalPushSender(OneSignalConfig{
		AppID: "app", APIKey: "key", PublicURL: "https://chat.example.com/", APIURL: "https://api.onesignal.test/notifications",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			var body struct {
				Aliases map[string][]string `json:"include_aliases"`
				Badge   float64             `json:"ios_badgeCount"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			badges[body.Aliases["external_id"][0]] = body.Badge
			mu.Unlock()
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"id":"n"}`)), Header: make(http.Header)}, nil
		})},
		BadgeCount: activity.BadgeCount,
	})
	if err != nil {
		t.Fatal(err)
	}
	svc.SetMobilePushScheduler(runNowScheduler{NewMobilePushTaskHandler(nil, sender)})

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-bob")
	for _, uid := range []string{"u-author", "u-bob"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	seed.items["u-bob"] = []*model.ActivityItem{
		{ID: "old-dm", Type: model.ActivityDM},
		{ID: "old-mention", Type: model.ActivityMention},
		{ID: "old-reaction", Type: model.ActivityReaction},
	}

	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "deploy done"}, ParentChannel, nil)

	mu.Lock()
	defer mu.Unlock()
	got, ok := badges["u-bob"]
	return got, ok
}

// A message that alerts Bob reaches his phone with the icon set to his
// Activity bell's number: what was already unread plus this message, the
// unread reaction left out — the same number ex shows him everywhere else.
func TestMobilePush_SetsTheIconToTheActivityCount(t *testing.T) {
	activityStore := listingActivityStore{newFakeActivityStore()}
	if got, ok := bobsBadgeAfterChannelPost(t, activityStore, &activityStore); !ok || got != 3 {
		t.Fatalf("Bob's push badge = %v (sent: %v), want 3", got, ok)
	}
}

// The same message through a store that lands writes after a beat, as a
// loaded box does. The push must still count this message's own row: the
// fan-out waits for the activity write before scheduling the push, instead
// of racing a detached goroutine (which sent badge 2 on busy CI runners).
func TestMobilePush_BadgeWaitsForTheActivityWrite(t *testing.T) {
	activityStore := listingActivityStore{newFakeActivityStore()}
	slow := slowWriteActivityStore{activityStore}
	if got, ok := bobsBadgeAfterChannelPost(t, slow, &activityStore); !ok || got != 3 {
		t.Fatalf("Bob's push badge = %v (sent: %v), want 3", got, ok)
	}
}
