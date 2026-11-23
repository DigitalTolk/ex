//go:build integration

package cache

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
)

func TestPeopleFrequency(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	if got, err := c.FrequentPeople(ctx, "u1", 10); err != nil || len(got) != 0 {
		t.Fatalf("no history: %v, %v", got, err)
	}
	// Nothing to record touches nothing.
	if err := c.RecordPeopleContact(ctx, "u1", nil); err != nil {
		t.Fatalf("empty record: %v", err)
	}
	if n, _ := plain.Exists(ctx, peopleFreqKeyPrefix+"u1").Result(); n != 0 {
		t.Fatal("an empty record must not create the key")
	}

	// bob is mentioned twice, carol is the DM partner of three sends.
	for _, w := range []map[string]float64{
		{"bob": 1, "carol": 0.5},
		{"carol": 0.5},
		{"bob": 1, "carol": 0.5},
		{"dave": 0.5},
	} {
		if err := c.RecordPeopleContact(ctx, "u1", w); err != nil {
			t.Fatalf("record: %v", err)
		}
	}
	got, err := c.FrequentPeople(ctx, "u1", 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !slices.Equal(got, []string{"bob", "carol", "dave"}) {
		t.Fatalf("ranking = %v, want [bob carol dave]", got)
	}
	if top, _ := c.FrequentPeople(ctx, "u1", 1); !slices.Equal(top, []string{"bob"}) {
		t.Fatalf("limit 1 = %v", top)
	}
	if zero, err := c.FrequentPeople(ctx, "u1", 0); err != nil || len(zero) != 0 {
		t.Fatalf("limit 0 = %v, %v", zero, err)
	}
	if ttl, err := plain.TTL(ctx, peopleFreqKeyPrefix+"u1").Result(); err != nil || ttl <= 0 {
		t.Fatalf("want a TTL, got %v (%v)", ttl, err)
	}
	// Someone the user keeps writing to overtakes an old habit.
	for range 30 {
		if err := c.RecordPeopleContact(ctx, "u1", map[string]float64{"erin": 0.5}); err != nil {
			t.Fatalf("record: %v", err)
		}
	}
	if top, _ := c.FrequentPeople(ctx, "u1", 1); !slices.Equal(top, []string{"erin"}) {
		t.Fatalf("after a run of DMs with erin the top is %v", top)
	}
}

func TestPeopleFrequency_KeepsOnlyTheTop(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()
	w := make(map[string]float64, peopleFreqKeep+20)
	for i := range peopleFreqKeep + 20 {
		w[fmt.Sprintf("p-%03d", i)] = float64(i + 1)
	}
	if err := c.RecordPeopleContact(ctx, "u-many", w); err != nil {
		t.Fatalf("record: %v", err)
	}
	if n, _ := plain.ZCard(ctx, peopleFreqKeyPrefix+"u-many").Result(); n != peopleFreqKeep {
		t.Fatalf("kept %d, want %d", n, peopleFreqKeep)
	}
	top, _ := c.FrequentPeople(ctx, "u-many", 1)
	if !slices.Equal(top, []string{fmt.Sprintf("p-%03d", peopleFreqKeep+19)}) {
		t.Fatalf("top = %v", top)
	}
}

func TestRecordPeopleContact_ScriptError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "evalsha", "eval")
	if err := c.RecordPeopleContact(context.Background(), "people-script-fail", map[string]float64{"bob": 1}); !errors.Is(err, errInjected) {
		t.Fatalf("err = %v, want errInjected", err)
	}
}

func TestFrequentPeople_ExpireError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "expire")
	if _, err := c.FrequentPeople(context.Background(), "people-read-expire-fail", 5); !errors.Is(err, errInjected) {
		t.Fatalf("err = %v, want errInjected", err)
	}
}
