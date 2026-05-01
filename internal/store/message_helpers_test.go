package store

import (
	"reflect"
	"testing"
)

func TestMergeRecentAuthors(t *testing.T) {
	cases := []struct {
		name string
		prev []string
		next string
		want []string
	}{
		{"empty", nil, "u1", []string{"u1"}},
		{"prepend", []string{"u1"}, "u2", []string{"u2", "u1"}},
		{"trim to three", []string{"u1", "u2", "u3"}, "u4", []string{"u4", "u1", "u2"}},
		{"dedup duplicate front", []string{"u1", "u2"}, "u1", []string{"u1", "u2"}},
		{"dedup duplicate middle", []string{"u1", "u2", "u3"}, "u2", []string{"u2", "u1", "u3"}},
	}
	for _, tc := range cases {
		got := mergeRecentAuthors(tc.prev, tc.next)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}
