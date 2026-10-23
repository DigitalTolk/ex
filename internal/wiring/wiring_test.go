package wiring

import (
	"errors"
	"testing"
)

func TestCheckNamesEveryMissingDependency(t *testing.T) {
	err := Check("message service",
		Dep{Name: "notifier", Set: false},
		Dep{Name: "indexer", Set: true},
		Dep{Name: "safety net", Set: false},
	)
	if err == nil {
		t.Fatal("Check = nil, want an error naming the missing dependencies")
	}
	if got, want := err.Error(), "message service: not wired: notifier, safety net"; got != want {
		t.Fatalf("Check = %q, want %q", got, want)
	}
}

func TestCheckPassesWhenEverythingIsSet(t *testing.T) {
	if err := Check("user service", Dep{Name: "cache", Set: true}); err != nil {
		t.Fatalf("Check = %v, want nil", err)
	}
	if err := Check("no deps"); err != nil {
		t.Fatalf("Check with no dependencies = %v, want nil", err)
	}
}

type checker struct{ err error }

func (c checker) Wired() error { return c.err }

func TestAllJoinsEveryComponent(t *testing.T) {
	a, b := errors.New("a: not wired: x"), errors.New("b: not wired: y")
	err := All(checker{}, checker{err: a}, checker{err: b})
	if !errors.Is(err, a) || !errors.Is(err, b) {
		t.Fatalf("All = %v, want both component errors", err)
	}
	if err := All(checker{}, checker{}); err != nil {
		t.Fatalf("All of wired components = %v, want nil", err)
	}
}
