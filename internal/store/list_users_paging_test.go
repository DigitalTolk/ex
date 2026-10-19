//go:build integration

package store

import (
	"context"
	"testing"
	"time"
)

// Paging through ListUsers one user at a time must visit every user exactly
// once and terminate: the continuation key has to address the last item by
// its real table key (USER#<id>), not by its index sort key.
func TestUserStore_ListUsers_PagesThroughEveryUser(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewUserStore(db)
	ctx := context.Background()
	base := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	for i, id := range []string{"pa", "pb", "pc"} {
		u := makeUser(id, id+"@example.com", id)
		u.CreatedAt = base.Add(time.Duration(i) * time.Minute)
		if err := s.CreateUser(ctx, u); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]int{}
	cursor := ""
	for pages := 0; ; pages++ {
		if pages > 10 {
			t.Fatalf("pagination does not terminate; seen %v", seen)
		}
		page, next, err := s.ListUsers(ctx, 1, cursor)
		if err != nil {
			t.Fatal(err)
		}
		for _, u := range page {
			seen[u.ID]++
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if len(seen) != 3 || seen["pa"] != 1 || seen["pb"] != 1 || seen["pc"] != 1 {
		t.Fatalf("seen = %v", seen)
	}
}
