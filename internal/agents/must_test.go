package agents

import (
	"errors"
	"testing"
)

func TestMustJSONBody(t *testing.T) {
	if got := string(mustJSONBody([]byte("j"), nil)); got != "j" {
		t.Fatalf("mustJSONBody = %q", got)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("mustJSONBody must panic on error")
		}
	}()
	mustJSONBody(nil, errors.New("boom"))
}
