package service

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// fakePeopleRanking records what sends feed the people ranking and serves
// a fixed ranking back.
type fakePeopleRanking struct {
	mu        sync.Mutex
	records   []peopleRecord
	recordErr error
	ranking   []string
	readErr   error
	gotLimit  int
}

type peopleRecord struct {
	userID  string
	weights map[string]float64
}

func (f *fakePeopleRanking) RecordPeopleContact(_ context.Context, userID string, weights map[string]float64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.records = append(f.records, peopleRecord{userID: userID, weights: maps.Clone(weights)})
	return f.recordErr
}

func (f *fakePeopleRanking) FrequentPeople(_ context.Context, _ string, limit int) ([]string, error) {
	f.gotLimit = limit
	return f.ranking, f.readErr
}

func TestMessageService_SendFeedsThePeopleRanking(t *testing.T) {
	svc, _, memberships, conversations, _ := setupMessageService()
	people := &fakePeopleRanking{}
	svc.SetPeopleFrequency(people)
	ctx := context.Background()
	conversations.conversations["conv-1"] = &model.Conversation{
		ID: "conv-1", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"user-1", "user-2", "user-3"},
	}
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember}

	// In a DM: everyone else in it, plus whoever is named (the author never).
	if _, err := svc.Send(ctx, "user-1", "conv-1", ParentConversation, "hey @[user-2|Bob] and @[user-1|me]", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	// In a channel: only who is named.
	if _, err := svc.Send(ctx, "user-1", "ch1", ParentChannel, "ping @[user-9|Zed]", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	// A channel post naming nobody adds nothing.
	if _, err := svc.Send(ctx, "user-1", "ch1", ParentChannel, "just text", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}

	want := []peopleRecord{
		{userID: "user-1", weights: map[string]float64{"user-2": dmContactWeight + mentionContactWeight, "user-3": dmContactWeight}},
		{userID: "user-1", weights: map[string]float64{"user-9": mentionContactWeight}},
		{userID: "user-1", weights: map[string]float64{}},
	}
	if len(people.records) != len(want) {
		t.Fatalf("records = %+v, want %+v", people.records, want)
	}
	for i := range want {
		if people.records[i].userID != want[i].userID || !maps.Equal(people.records[i].weights, want[i].weights) {
			t.Fatalf("record %d = %+v, want %+v", i, people.records[i], want[i])
		}
	}
}

func TestMessageService_AgentPostsDontFeedThePeopleRanking(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	people := &fakePeopleRanking{}
	svc.SetPeopleFrequency(people)
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember}

	if _, err := svc.SendAsAgent(context.Background(), "agent-1", "user-1", "ch1", ParentChannel, "done, @[user-2|Bob]", ""); err != nil {
		t.Fatalf("SendAsAgent: %v", err)
	}
	if len(people.records) != 0 {
		t.Fatalf("an agent's post fed the ranking: %+v", people.records)
	}
}

// The ranking only orders a list: a Redis failure is logged, never the send's.
func TestMessageService_PeopleRankingFailureDoesNotFailTheSend(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	svc.SetPeopleFrequency(&fakePeopleRanking{recordErr: errors.New("redis down")})
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember}

	if _, err := svc.Send(context.Background(), "user-1", "ch1", ParentChannel, "hi @[user-2|Bob]", ""); err != nil {
		t.Fatalf("Send = %v, want the message sent", err)
	}
}

func TestUserService_FrequentPeople(t *testing.T) {
	people := &fakePeopleRanking{ranking: []string{"u-2", "u-3"}}
	svc := &UserService{}
	svc.SetPeopleRanking(people)
	ctx := context.Background()

	got, err := svc.FrequentPeople(ctx, "u-1", 20)
	if err != nil || !slices.Equal(got, []string{"u-2", "u-3"}) || people.gotLimit != 20 {
		t.Fatalf("FrequentPeople = %v, %v (limit %d)", got, err, people.gotLimit)
	}
	for _, limit := range []int{0, -1, MaxFrequentPeople + 1} {
		if _, err := svc.FrequentPeople(ctx, "u-1", limit); err != nil || people.gotLimit != MaxFrequentPeople {
			t.Fatalf("limit %d asked for %d (%v), want the cap", limit, people.gotLimit, err)
		}
	}

	people.readErr = errors.New("redis down")
	if _, err := svc.FrequentPeople(ctx, "u-1", 5); err == nil || !strings.Contains(err.Error(), "frequent people") {
		t.Fatalf("err = %v", err)
	}
}
