package search

import (
	"encoding/json"
	"testing"
)

func TestMust(t *testing.T) {
	if got := must(json.Marshal(map[string]string{"a": "b"})); string(got) != `{"a":"b"}` {
		t.Errorf("must = %s, want passthrough of the marshaled bytes", got)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on an error")
		}
	}()
	must(json.Marshal(unmarshalable()))
}
