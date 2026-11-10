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

// A message that alerts Bob reaches his phone with the icon set to his
// Activity bell's number: what was already unread plus this message, the
// unread reaction left out — the same number ex shows him everywhere else.
func TestMobilePush_SetsTheIconToTheActivityCount(t *testing.T) {
	svc, _, members, _, chans, users := setupNotifier(t)
	activityStore := listingActivityStore{newFakeActivityStore()}
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
	activityStore.items["u-bob"] = []*model.ActivityItem{
		{ID: "old-dm", Type: model.ActivityDM},
		{ID: "old-mention", Type: model.ActivityMention},
		{ID: "old-reaction", Type: model.ActivityReaction},
	}

	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "deploy done"}, ParentChannel, nil)

	mu.Lock()
	defer mu.Unlock()
	if got, ok := badges["u-bob"]; !ok || got != 3 {
		t.Fatalf("Bob's push badge = %v (sent: %v), want 3", got, ok)
	}
}
