package search

import (
	"encoding/json"
	"testing"
)

func TestMustJSON(t *testing.T) {
	if got := mustJSON(json.Marshal(map[string]string{"a": "b"})); string(got) != `{"a":"b"}` {
		t.Errorf("mustJSON = %s, want passthrough of the marshaled bytes", got)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on a marshal error")
		}
	}()
	mustJSON(json.Marshal(unmarshalable()))
}
