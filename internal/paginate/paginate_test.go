package paginate

import (
	"context"
	"errors"
	"testing"
)

func TestAll_AccumulatesUntilNextIsEmpty(t *testing.T) {
	pages := [][]int{
		{1, 2, 3},
		{4, 5, 6},
		{7, 8},
	}
	cursors := []string{"a", "b", ""}
	calls := 0
	got, err := All(context.Background(), func(_ context.Context, cursor string) ([]int, string, error) {
		if calls == 0 && cursor != "" {
			t.Errorf("first call cursor = %q, want empty", cursor)
		}
		page := pages[calls]
		next := cursors[calls]
		calls++
		return page, next, nil
	}, 100)
	if err != nil {
		t.Fatal(err)
	}
	want := []int{1, 2, 3, 4, 5, 6, 7, 8}
	if !equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestAll_StopsAtMaxRounds(t *testing.T) {
	calls := 0
	got, err := All(context.Background(), func(_ context.Context, _ string) ([]int, string, error) {
		calls++
		return []int{calls}, "always-more", nil
	}, 3)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Errorf("calls = %d, want 3", calls)
	}
	if len(got) != 3 {
		t.Errorf("len(got) = %d, want 3", len(got))
	}
}

func TestAll_UncappedRunsUntilEnd(t *testing.T) {
	calls := 0
	_, err := All(context.Background(), func(_ context.Context, _ string) ([]int, string, error) {
		calls++
		if calls < 5 {
			return []int{calls}, "more", nil
		}
		return []int{calls}, "", nil
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 5 {
		t.Errorf("calls = %d, want 5", calls)
	}
}

func TestAll_PropagatesError(t *testing.T) {
	want := errors.New("boom")
	_, err := All(context.Background(), func(_ context.Context, _ string) ([]int, string, error) {
		return nil, "", want
	}, 100)
	if !errors.Is(err, want) {
		t.Errorf("err = %v, want %v", err, want)
	}
}

func TestAll_EmptyFirstPageIsAllowed(t *testing.T) {
	// An empty page with empty next is a legitimate "no results"
	// answer (e.g. a fresh workspace before the first user signs up).
	got, err := All(context.Background(), func(_ context.Context, _ string) ([]int, string, error) {
		return []int{}, "", nil
	}, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("len(got) = %d, want 0", len(got))
	}
}

func equal(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
