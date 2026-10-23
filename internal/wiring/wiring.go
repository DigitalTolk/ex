// Package wiring is the boot-time completeness check for setter-injected
// dependencies. Services and handlers take most of their collaborators through
// Set* methods after construction (so narrow tests can leave them out), which
// means a production wiring that forgets one compiles fine and then silently
// degrades — a message service with no notifier alerts nobody. Each such
// component reports what production needs through Wired, and the app refuses
// to boot while anything is missing, naming every gap.
package wiring

import (
	"errors"
	"fmt"
	"strings"
)

// Dep is one dependency a component needs in production, and whether it is
// set. Optional collaborators (those wired only when their backend is
// configured: S3, search, Microsoft Graph, mobile push) are not listed.
type Dep struct {
	Name string
	Set  bool
}

// Checker is a component that can report its own wiring.
type Checker interface {
	Wired() error
}

// Check returns an error naming every dependency of component that is not
// set, or nil when all are.
func Check(component string, deps ...Dep) error {
	var missing []string
	for _, d := range deps {
		if !d.Set {
			missing = append(missing, d.Name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	return fmt.Errorf("%s: not wired: %s", component, strings.Join(missing, ", "))
}

// All runs every checker and joins their errors (nil when all are wired).
func All(checkers ...Checker) error {
	errs := make([]error, 0, len(checkers))
	for _, c := range checkers {
		errs = append(errs, c.Wired())
	}
	return errors.Join(errs...)
}
