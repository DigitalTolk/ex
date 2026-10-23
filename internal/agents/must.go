package agents

import (
	"crypto/rand"
	"fmt"
)

// randRead is a seam over crypto/rand.Read so tests can exercise the
// entropy-failure arms of token minting.
var randRead = rand.Read

// mustJSONBody unwraps json.Marshal of values composed solely of strings,
// numbers and string maps/slices — a failure would be a programmer error (the
// template.Must idiom; see internal/service/must.go for the same policy).
func mustJSONBody(b []byte, err error) []byte {
	if err != nil {
		panic(fmt.Sprintf("agents: static struct failed to marshal to JSON: %v", err))
	}
	return b
}
