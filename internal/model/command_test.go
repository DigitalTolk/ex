package model

import "testing"

func TestExternalCommandNormalizedMethod(t *testing.T) {
	tests := map[string]string{
		// Mattermost's single-letter field; anything unrecognized (or empty) is a
		// POST, which is what an integration expects by default.
		"":     CommandMethodPost,
		"P":    CommandMethodPost,
		"G":    CommandMethodGet,
		"g":    CommandMethodGet,
		" g ":  CommandMethodGet,
		"POST": CommandMethodPost,
		"x":    CommandMethodPost,
	}
	for method, want := range tests {
		cmd := &ExternalCommand{Method: method}
		if got := cmd.NormalizedMethod(); got != want {
			t.Errorf("Method %q → %q, want %q", method, got, want)
		}
	}
}
